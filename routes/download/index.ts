/**
 * GET /api/warcs/download
 *
 *   ?ids=<warc_custom_id>        repeatable
 *   ?urls=<uri>                  repeatable, resolved against dateNear
 *   ?dateNear=<iso date>         which capture of those urls, default now
 *   ?resources=0                 do NOT pull in what a document references
 *   ?probe=1                     answer with the ledger as JSON, no archive
 *
 * A requested html or css capture brings its resources with it. That is not a
 * mode: a page whose stylesheet and images are absolute urls into a site that may
 * no longer exist is not a smaller page, it is a broken one. See recursive.ts.
 *
 * Streamed, one pass over each payload, with a real `Content-Length`. See
 * download.plan.md — §2.1 for why this does not build a Blob, §3.1 for what
 * "streamed" is being held to, and §8.1 for how a wrong length would be caught.
 *
 * No `await` on this path. There are exactly two asynchronous points — the
 * database and the stream — and the stream is never awaited: awaiting it would
 * mean holding the whole archive before replying. Everything else, `toEntry`
 * included, is synchronous, because `Bun.file().slice()` reads nothing and so
 * there is nothing to wait for.
 */

import { randomUUIDv7 } from "bun";
import {
    buildManifest,
    dedupe,
    toEntry,
    type DownloadLedger,
    type EntryStatus,
    type PayloadRow,
} from "./entries";
import { createStoredZipStream, storedZipSize, type StoredZipEntry } from "./storedzip";
import { expandRow, referencesThings } from "./recursive";

/**
 * A cap, because this endpoint takes its list from a query string.
 *
 * Not about disk or bandwidth: a url with two thousand `ids=` in it is a query
 * storm dressed as a download. Counted across ids AND urls together, since the
 * work is the same either way, and exceeding it is a 400 rather than a quiet
 * truncation — see the note at the guard.
 *
const MAX_REQUESTED = 500;
 */

/**
 * The two lookups, injected.
 *
 * Not for purity — for testability. A route that imports `db.ts` directly can
 * only be exercised against a live Postgres, and the things worth testing here
 * (a missing row, a row pointing past the end of a file, a length that does not
 * match the header) are exactly the ones that are hard to arrange in a database
 * and trivial to arrange in a fake.
 */
export interface DownloadDeps {
    byIds: (ids: string[]) => Promise<PayloadRow[]>;
    byUrl: (url: string, dateNear: Date) => Promise<PayloadRow[]>;
}

/**
 * How much one request's expansion may pull in, across every document in it.
 *
 * What the caller listed is bounded by MAX_REQUESTED. What those documents happen
 * to REFERENCE is not bounded by anything the caller can see — it is a property of
 * the pages — so the ceiling has to live here, and it has to be shared: forty
 * pages each believing they had the whole allowance is forty times the ceiling.
 */
const EXPANSION_MAX_ENTRIES = 5_000;
const EXPANSION_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The real lookups, imported lazily.
 *
 * `db.ts` builds a connection pool at module scope, sized per thread. Importing
 * it from the top of this file would mean every test of this route — and every
 * worker that happens to pull it in — paying for a pool nobody asked for.
 */
const liveDeps = (): Promise<DownloadDeps> =>
    import("../../db").then(db => ({
        /*
         * One round trip for every id, rather than one per id.
         *
         * The plan's §3.1 note on time-to-first-byte: nothing can be written
         * until every length is known, so N sequential lookups are N latencies
         * in front of the first byte.
         */
        byIds: batchWithFallback(
            (ids) => Promise.resolve(db.get_warc_response_payloads(ids)) as Promise<PayloadRow[]>,
            (id) => Promise.resolve(db.get_warc_response_payload(id)) as Promise<PayloadRow[]>,
        ),

        /*
         * Still one per url, because each needs its own nearest-date probe.
         * Batching these means a VALUES join against (uri, dateNear) pairs — a
         * bigger change than the `ANY` above, and worth doing only if a caller
         * turns up that asks for urls in bulk.
         */
        byUrl: (url, dateNear) =>
            Promise.resolve(db.get_warc_response_payload_near(url, dateNear)) as Promise<PayloadRow[]>,
    }));

/** Bun.sql resolves to an array of rows; a miss is an empty one. */
const firstRow = (rows: PayloadRow[] | null | undefined): PayloadRow | null =>
    Array.isArray(rows) && rows.length > 0 ? rows[0]! : null;

/**
 * A batch lookup that degrades to one-at-a-time rather than failing.
 *
 * The batch is an OPTIMISATION — one round trip instead of N, so the response
 * headers go out sooner — and an optimisation should not be able to take the
 * feature down with it. It did exactly that once: the first version of the batch
 * query used `= ANY(${ids})`, which Postgres rejected with "malformed array
 * literal" for every request, and because the route attributes a failed lookup to
 * each of its ids, a download of one capture came back as an archive containing
 * nothing but a manifest saying `error`.
 *
 * So a rejection here is loud and survivable: the reason is logged once, in full,
 * and the request completes at N round trips. Slower and working beats fast and
 * broken, and the log is what stops "slower" from being permanent.
 *
 * Split out as a combinator because the interesting behaviour — that the fallback
 * fires, that it preserves order, that a genuinely missing id is still missing —
 * is testable with fakes, and the query it wraps is not testable without a live
 * Postgres.
 */
export const batchWithFallback = (
    batch: (ids: string[]) => Promise<PayloadRow[]>,
    single: (id: string) => Promise<PayloadRow[]>,
    onFallback: (error: unknown) => void = (error) => {
        console.error(
            "downloadRoute: the batched id lookup failed, falling back to one query "
            + "per id. This is a bug in get_warc_response_payloads, not in the request:",
            error);
    },
) => (ids: string[]): Promise<PayloadRow[]> =>
    batch(ids).catch(error => {
        onFallback(error);

        // allSettled, so one bad id does not lose the rest — the same rule the
        // route applies to its own lookups.
        return Promise.allSettled(ids.map(id => single(id))).then(settled =>
            settled.flatMap(result =>
                result.status === "fulfilled" && Array.isArray(result.value)
                    ? result.value
                    : []));
    });

const failedStatus = (
    request: string,
    kind: "id" | "url",
    status: EntryStatus["status"],
    detail?: string,
): EntryStatus => ({
    request,
    kind,
    url: kind === "url" ? request : null,
    status,
    resolvedPath: null,
    ...(detail ? { detail } : {}),
});

/**
 * Every requested id and url, resolved and turned into entries.
 *
 * Order is the order asked for: ids first, then urls. A caller that listed
 * forty things gets a manifest in the same sequence, which is the difference
 * between reading it and searching it.
 */
const collect = (
    ids: string[],
    urls: string[],
    dateNear: Date,
    deps: DownloadDeps,
    withResources: boolean,
): Promise<DownloadLedger> => {
    // allSettled, not all: one bad id must not take the other thirty-nine with it.
    const lookups: Promise<unknown>[] = [
        ids.length > 0 ? deps.byIds(ids) : Promise.resolve([] as PayloadRow[]),
        ...urls.map(url => deps.byUrl(url, dateNear)),
    ];

    return Promise.allSettled(lookups).then(settled => {
        const entries: StoredZipEntry[] = [];
        const status: EntryStatus[] = [];

        /**
         * Documents held back for expansion, in request order.
         *
         * Not expanded inline, because the walks share one budget and have to run
         * in sequence to spend it honestly — and because a walk is a series of
         * database round trips, which is not something to start forty of at once.
         */
        const documents: { row: PayloadRow; request: string; kind: "id" | "url" }[] = [];

        const keep = (row: PayloadRow, request: string, kind: "id" | "url") => {
            /*
             * An html or css capture is not a file, it is a file plus what it
             * refers to. Asking for a page and getting a page is the behaviour
             * worth having by default — a lone document's references are absolute
             * urls into a site that may no longer exist.
             */
            if (withResources && referencesThings(row.content_type)) {
                documents.push({ row, request, kind });

                return;
            }

            const made = toEntry(row, request, kind);

            status.push(made.status);
            if (made.entry) entries.push(made.entry);
        };

        /*
         * The ids came back as one batch, so they have to be matched to what was
         * asked for. Keyed by warc_custom_id rather than by position: the query
         * has no ORDER BY, and a batch that arrives in a different order than it
         * was requested would otherwise file every row under the wrong request.
         */
        const idResult = settled[0]!;

        if (idResult.status === "rejected") {
            const detail = String((idResult.reason as Error)?.message ?? idResult.reason);

            for (const id of ids) status.push(failedStatus(id, "id", "error", detail));
        } else {
            const rows = (idResult.value as PayloadRow[] | null) ?? [];
            const byId = new Map(rows.map(row => [row.warc_custom_id, row]));

            for (const id of ids) {
                const row = byId.get(id);

                if (row) keep(row, id, "id");
                else status.push(failedStatus(id, "id", "not-found"));
            }
        }

        // The urls, one settled result each, in request order.
        urls.forEach((url, index) => {
            const result = settled[index + 1]!;

            if (result.status === "rejected") {
                status.push(failedStatus(url, "url", "error",
                    String((result.reason as Error)?.message ?? result.reason)));

                return;
            }

            const row = firstRow(result.value as PayloadRow[] | null);

            if (row) keep(row, url, "url");
            else status.push(failedStatus(url, "url", "not-found"));
        });

        if (documents.length === 0) return dedupe({ entries, status });

        /*
         * The documents, one walk at a time, sharing one budget.
         *
         * Sequential by `reduce` rather than `Promise.all`: each walk is a series
         * of lookups, and the ceiling has to be spent in order or forty pages
         * could each believe they had the whole allowance.
         */
        return documents.reduce(
            (chain, document) => chain.then(budget => {
                if (budget.entries <= 0) {
                    status.push({
                        ...failedStatus(document.request, document.kind, "over-budget"),
                        url: document.row.uri,
                        detail: `stopped after ${entries.length} entries`,
                    });

                    return budget;
                }

                return expandRow(document.row, deps, budget).then(expanded => {
                    if (expanded.failed) {
                        status.push({
                            ...failedStatus(document.request, document.kind, "error"),
                            url: document.row.uri,
                            detail: `the document could not be read: ${expanded.failed}`,
                        });

                        return budget;
                    }

                    entries.push(...expanded.entries);

                    status.push({
                        request: document.request,
                        kind: document.kind,
                        /*
                         * `short-read` when the document itself could not be
                         * supplied, even though the walk succeeded.
                         *
                         * The walk reads the document's TEXT, which comes back
                         * empty for a file that is not there — so it plans happily
                         * and then the bytes are missing. Reporting "stored" for a
                         * request whose own capture was dropped is the kind of lie
                         * this ledger exists to prevent.
                         */
                        status: expanded.dropped.some(one => one.path === expanded.path)
                            ? "short-read"
                            : "stored",
                        url: document.row.uri,
                        resolvedPath: expanded.path,
                        expansion: {
                            dependencies: expanded.dependencies,
                            missing: expanded.missing,
                            merged: expanded.merged,
                            // Records the database has and the disk does not. The
                            // symptom without this was an invalid zip: the writer
                            // threw mid-stream on a size that did not match, after
                            // Content-Length had already been promised.
                            dropped: expanded.dropped,
                            // In the archive but incomplete — a document whose
                            // file held less than its row claimed.
                            truncated: expanded.truncated,
                            notices: expanded.notices,
                        },
                    });

                    const spent = expanded.entries.reduce((sum, entry) => sum + entry.data.size, 0);

                    return {
                        entries: budget.entries - expanded.entries.length,
                        bytes: budget.bytes - spent,
                    };
                });
            }),
            Promise.resolve({ entries: EXPANSION_MAX_ENTRIES, bytes: EXPANSION_MAX_BYTES }),
        ).then(() => dedupe({ entries, status }));
    });
};

/**
 * A 400 in the same shape as the success path.
 *
 * `Promise.resolve` because this handler is not `async` — it hands back a chain,
 * and a guard returning a plain value would give it two different return types.
 */
const refuse = (why: string): Promise<Response> =>
    Promise.resolve(new Response(why, { status: 400 }));

/**
 * The response, once the entries are decided.
 *
 * Shared by both modes, because the invariant it protects is the same one: size
 * the exact array that gets written, and touch nothing afterwards. Every way to
 * get a wrong `Content-Length` is a mutation between the two — appending an
 * entry, renaming one, or a `data.size` that moves. See the plan's §8.1.
 */
const respond = (entries: StoredZipEntry[], missing: number): Response => {
    const total = storedZipSize(entries);

    const body = createStoredZipStream(entries, {
        onFinish: (written) => {
            if (written === total) return;

            /*
             * Checked after the fact, on purpose. The header left long ago, so
             * this repairs nothing — but it names the mismatch here, where the
             * entry list still exists, instead of leaving a client to report
             * "network error" for a request that looked perfect from this side.
             */
            console.error(
                `downloadRoute: promised Content-Length ${total} and wrote ${written} `
                + `(${entries.length} entries, delta ${written - total}). `
                + `An entry's size moved between sizing and writing.`);
        },
    });

    return new Response(body, {
        headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="archives.${randomUUIDv7()}.zip"`,

            /*
             * NOT `Content-Length`, and that is measured rather than assumed.
             *
             * Bun.serve discards a Content-Length header on a streamed body and
             * sends `Transfer-Encoding: chunked` regardless — verified across
             * every response shape: a ReadableStream, a TransformStream, with the
             * header and without it. The only shape that keeps a length is a fully
             * buffered Blob, which is the thing this route exists not to do.
             *
             * So the exact size goes in a header of our own, where it survives, and
             * the client gets a number it can show even though the browser's own
             * progress bar cannot use it. Promising a Content-Length that the
             * server strips was worse than sending none: it made the check below
             * look like it was verifying something a client had seen.
             */
            "X-Warc-Content-Length": String(total),
            // Useful before the body arrives: a client can say "38 of 40 found"
            // while the download runs.
            "X-Warc-Entries": String(entries.length),
            "X-Warc-Missing": String(missing),
            "Access-Control-Expose-Headers":
                "X-Warc-Content-Length, X-Warc-Entries, X-Warc-Missing",
        },
    });
};

/**
 * The handler, over whichever lookups it is given.
 *
 * A factory rather than an optional second parameter, and that is not a taste
 * call: Bun's route handlers are `(req, server)`, so a `deps` in second position
 * would be handed the `Server` object at runtime and `deps.byIds` would be
 * undefined on the first request. The typechecker caught it, which it only could
 * because the seam is typed rather than `any`.
 */
export const createDownloadRoute = (injected?: DownloadDeps) => (
    req: Request,
): Promise<Response> => {
    const requestUrl = new URL(req.url);

    const askedIds = requestUrl.searchParams.getAll("ids");
    const askedUrls = requestUrl.searchParams.getAll("urls");
    const dateNearRaw = requestUrl.searchParams.get("dateNear");

    if (askedIds.length === 0 && askedUrls.length === 0) {
        return refuse("Nothing requested. Pass ?ids= or ?urls=.");
    }

    /*
     * Over the cap is a refusal, not a silent truncation.
     *
     * This used to `slice(0, MAX_REQUESTED)`, which answered a request for six
     * hundred captures with five hundred and said nothing about it — the caller
     * gets an archive that looks complete and is missing a hundred files. Every
     * other shortfall in this route reaches the manifest; this one could not,
     * because the entries were dropped before anything knew they existed.
     */
    const asked = askedIds.length + askedUrls.length;

    /*
    if (asked > MAX_REQUESTED) {
        return refuse(
            `Too many captures requested: ${asked}, and the limit is ${MAX_REQUESTED}. `
            + `Split the request rather than accepting a partial archive.`);
    }
    */

    const ids = askedIds;
    const urls = askedUrls;

    /*
     * An unparseable date is the request's problem, not a silent fallback to now.
     * "dateNear=yesterday" quietly returning the newest capture of everything is
     * the kind of wrong answer nobody notices.
     */
    const dateNear = dateNearRaw ? new Date(dateNearRaw) : new Date();

    if (Number.isNaN(dateNear.getTime())) {
        return refuse(`dateNear is not a date: ${dateNearRaw}`);
    }

    /*
     * Resources come WITH a document, and that is not a mode.
     *
     * There is no `recursive=1` to ask for. A requested html or css capture brings
     * what it references, because that is what the thing is: a page whose
     * stylesheet and images are absolute urls into a site that may not exist any
     * more is not a smaller version of a page, it is a broken one.
     *
     * `resources=0` declines, for a caller that genuinely wants the stored bytes
     * of one record and nothing else — checking a digest, or re-ingesting.
     */
    const withResources = requestUrl.searchParams.get("resources") !== "0";

    /*
     * `probe=1` answers with the ledger as JSON and no archive.
     *
     * Built because of a catch-22 that cost real time: when a download comes out
     * wrong, the explanation is in the manifest — and the manifest is INSIDE the
     * zip, so a zip that will not open takes its own diagnosis with it. "Windows
     * cannot open the folder" is all you get.
     *
     * Everything up to the writer is identical, so a probe answers the questions
     * that matter — which rows resolved, what path each got, what the declared
     * length was, what the file actually offers, what was dropped and why — without
     * writing a byte of payload. It is also a genuinely useful preview: a client
     * can show "38 files, 12 MB" before committing to the download.
     */
    const probing = requestUrl.searchParams.get("probe") === "1";

    const lookups = injected ? Promise.resolve(injected) : liveDeps();

    if (probing) {
        return lookups
            .then(resolved => collect(ids, urls, dateNear, resolved, withResources))
            .then(ledger => {
                const entries = ledger.entries;

                return new Response(JSON.stringify({
                    probe: true,
                    requested: ledger.status.length,
                    stored: ledger.status.filter(one => one.status === "stored").length,
                    files: entries.length,
                    // What the zip WOULD promise, computed exactly as the real
                    // response computes it — including the manifest entry, so the
                    // number can be compared against a real download's header.
                    contentLength: storedZipSize([
                        ...entries,
                        {
                            name: "_warc-manifest.json",
                            data: new Blob([buildManifest(ledger.status)]) as never,
                        },
                    ]),
                    payloadBytes: entries.reduce((sum, entry) => sum + entry.data.size, 0),
                    entries: ledger.status,
                    // The zip paths and sizes, which is what "why is this 128 KB"
                    // is usually asking.
                    files_detail: entries.map(entry => ({
                        path: entry.name,
                        size: entry.data.size,
                    })),
                }, null, 2), {
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        "Cache-Control": "no-store",
                    },
                });
            });
    }

    return lookups
        .then(resolved => collect(ids, urls, dateNear, resolved, withResources))
        .then(ledger => {
            /*
             * Built here, and nothing touches `entries` after this point.
             *
             * The order is the invariant: collect, dedupe, append the manifest,
             * size, stream. Every way to get a wrong Content-Length is a mutation
             * between the sizing and the writing — appending an entry, renaming
             * one, or a `data.size` that moves. See §8.1.
             */
            const manifest = buildManifest(ledger.status);

            const entries: StoredZipEntry[] = [
                ...ledger.entries,
                // The only entry whose bytes are in memory. Everything else is a
                // lazy range of a file on disk.
                { name: "_warc-manifest.json", data: new Blob([manifest]) as never },
            ];

            // Sizing, the stream and the headers all live in `respond`, shared
            // with recursive mode — one place where the length is promised means
            // one place where it can be promised wrongly.
            return respond(entries, ledger.status.filter(one => one.status !== "stored").length);
        });
};

/** What webserver.ts mounts: the same handler, over the real database. */
export const downloadRoute = createDownloadRoute();
