/**
 * Recursive mode: a page and everything it needs to work offline.
 *
 * The walk itself is NOT here. `parser/download.ts` already does it — follow the
 * document's references, descend into css, dedupe by payload digest, assign
 * collision-free paths, rewrite every href to point inside the archive, and report
 * what it could not find. It is browser code only by accident: its inputs are
 * structural, and `Bun.file()` satisfies the `BlobLike` it wants.
 *
 * So this file is the adapter, and it is deliberately thin. Two implementations of
 * path assignment would disagree, and the disagreement would only ever show up in
 * a downloaded archive — long after the download, on someone else's disk.
 *
 * See download.plan.md §5.
 */

import {
    planDownload,
    resolveTokens,
    type DownloadNotice,
    type DownloadPlan,
    type IdPolicy,
} from "../../parser/download";
import { isCss, isHtml, type MissingRef, type ResolveOutcome, type ViewRecord } from "../../parser/view";
import { fixedRange, type PayloadRow } from "./entries";
import { parseChunkSizes } from "../view/chunks";
import type { StoredZipEntry } from "./storedzip";

/**
 * Bun's SQL client usually decodes JSONB into objects, but can hand back a
 * string. Same accommodation routes/view/index.tsx makes, for the same reason: a
 * JSON.parse on an object throws, and the failure would look like a missing
 * header rather than a type confusion.
 */
const asObject = (value: unknown): Record<string, unknown> => {
    if (!value) return {};
    if (typeof value === "string") {
        try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
    }

    return typeof value === "object" ? value as Record<string, unknown> : {};
};

const headerValue = (headers: Record<string, unknown>, name: string): string | null => {
    // Case is not guaranteed: what is stored is what the server sent.
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === name) return typeof value === "string" ? value : null;
    }

    return null;
};

const numeric = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
};

/**
 * A database row as the record the walker expects.
 *
 * Four of these fields exist only for the download path and are worth naming,
 * because leaving any of them out produces a plausible archive with a specific
 * flaw:
 *
 *   digest           without it, byte-identical captures at two urls are stored
 *                    twice and half the references point at each copy
 *   status           without it, a crawler's stored 404 PAGE looks like real html
 *                    and the walk descends into the error page's own assets
 *   contentEncoding  without it, a gzip-encoded document is parsed as binary — no
 *                    links found, so nothing it references is included
 *   uuid / warcFile  what a colliding filename is disambiguated by
 */
export const toViewRecord = (row: PayloadRow & {
    status?: number | string | null;
    headers?: unknown;
    payload_digest?: string | null;
}): ViewRecord => {
    const headers = asObject(row.headers);
    const offset = numeric(row.byte_offset);
    const size = numeric(row.byte_length);

    return {
        url: row.uri,
        contentType: row.content_type ?? "",
        dateArchived: row.archived_date
            ? new Date(row.archived_date).toISOString()
            : new Date(0).toISOString(),

        // BlobLike: size, slice, arrayBuffer. A BunFile has all three, and reads
        // nothing until something asks it to.
        file: Bun.file(row.file_path ?? "/nonexistent") as unknown as ViewRecord["file"],

        payload: row.file_path !== null && offset !== null && size !== null
            ? {
                offset,
                size,
                /*
                 * Through `parseChunkSizes`, not `Array.isArray`.
                 *
                 * `payloads.chunks` is a Postgres `BIGINT[]`, and Bun hands that
                 * back as the literal string `"{4,5}"` as often as an array —
                 * routes/view/index.tsx has the same helper for the same reason.
                 * An `Array.isArray` test drops the string form silently, and a
                 * chunked record that looks unchunked is read WITH its framing:
                 * the document parses as junk, so nothing it references is found,
                 * and a binary entry gets chunk-length lines embedded in it.
                 */
                ...(parseChunkSizes(row.chunks).length > 0
                    ? { chunks: parseChunkSizes(row.chunks) }
                    : {}),
                ...(row.payload_digest ? { digest: row.payload_digest } : {}),
            }
            : null,

        uuid: row.warc_custom_id,
        ...(row.file_path ? { warcFile: row.file_path } : {}),
        ...(numeric(row.status) !== null ? { status: numeric(row.status) } : {}),

        httpContentType: headerValue(headers, "content-type"),
        contentEncoding: headerValue(headers, "content-encoding"),
    };
};

/** What recursive mode needs from the database. */
export interface RecursiveDeps {
    /** The nearest capture of `url` to `dateNear`, as rows. */
    byUrl: (url: string, dateNear: Date) => Promise<PayloadRow[]>;
}

/**
 * The walker's lookup, backed by the database.
 *
 * The only piece the server has to supply. Everything the walk decides is shared
 * with the browser path.
 *
 * `.then` rather than `await`, like the rest of this route: the asynchronous
 * points stay countable, and there is exactly one here.
 */
export const dbResolve = (deps: RecursiveDeps) =>
    (url: string, nearArchived: string): Promise<ResolveOutcome> => {
        const dateNear = new Date(nearArchived);

        return deps.byUrl(url, Number.isNaN(dateNear.getTime()) ? new Date() : dateNear)
            .then(rows => {
                const row = Array.isArray(rows) && rows.length > 0 ? rows[0]! : null;

                return row
                    ? { record: toViewRecord(row) }
                    : { record: null, reason: "not-archived" as const };
            })
            /*
             * A failed lookup is a missing reference, not a failed download.
             *
             * The walk asks for dozens of urls; one of them timing out should cost
             * that one image, and the plan already has a vocabulary for a
             * reference it could not resolve.
             */
            .catch(() => ({ record: null, reason: "not-archived" as const }));
    };

/** Plan a recursive download from a root row. */
export const planFromRow = (
    root: PayloadRow,
    deps: RecursiveDeps,
    limits: { maxEntries?: number; maxBytes?: number; idPolicy?: IdPolicy } = {},
    onNotice?: (notice: DownloadNotice) => void,
) => planDownload(
    toViewRecord(root),
    {
        resolve: dbResolve(deps),
        /*
         * Never called on this path: planDownload rewrites text and does not build
         * blob urls. A throwing stub rather than a plausible one, so that a future
         * use of it fails here instead of producing a url that means nothing on a
         * server.
         */
        createObjectURL: () => { throw new Error("createObjectURL is browser-only"); },
    },
    {
        /*
         * Named after the archive the record came out of, which is what the
         * browser path does. A download can pull from more than one WARC — the
         * nearest capture of a subresource may live in a different file from the
         * page — so the name has to say which.
         */
        namer: (record) => ({
            file: (record.warcFile ?? "archive").split("/").pop() ?? "archive",
            uuid: record.uuid ?? "",
        }),
        maxEntries: limits.maxEntries ?? 5_000,
        maxBytes: limits.maxBytes ?? 2 * 1024 * 1024 * 1024,
        ...(limits.idPolicy ? { idPolicy: limits.idPolicy } : {}),
        ...(onNotice ? { onNotice } : {}),
    },
);

/** An entry the plan wanted that the file on disk could not supply. */
export interface DroppedEntry {
    path: string;
    url: string;
    expected: number;
    available: number;
    file: string | null;
}

/**
 * A plan's entries as zip entries.
 *
 * Two kinds, and the distinction is the whole point of planning first:
 *
 *   text     html and css the walk REWROTE. The string it produced, with its
 *            tokens resolved — its links now point inside the archive. In memory,
 *            necessarily, and bounded by the text rather than by the images.
 *   binary   never read. A lazy range of the WARC, streamed a chunk at a time by
 *            the writer.
 *
 * Two ledgers come out alongside the entries, and they are different outcomes:
 *
 *   dropped     a binary entry left OUT, because its declared length and the file
 *               disagree. Including it would abort the write mid-stream.
 *   truncated   a text entry left IN but short, because the walk could only read
 *               part of the document. Half a page beats no page — but not silently.
 */
export const entriesFromPlan = (
    plan: DownloadPlan,
    dropped: DroppedEntry[] = [],
    truncated: DroppedEntry[] = [],
): StoredZipEntry[] =>
    plan.entries.flatMap((entry): StoredZipEntry[] => {
        const path = entry.path;

        // No path means the entry was dropped during assignment — over a limit, or
        // a collision that could not be resolved. It is in the notices already.
        if (!path) return [];

        if (entry.text !== null) {
            const resolved = resolveTokens(entry.text, path, plan.entries, plan.linkUrls);

            /*
             * A text entry is never DROPPED for a short file, and that is a
             * deliberate difference from the binary branch below.
             *
             * Its bytes are the rewritten string, not a range of the WARC, so
             * there is no length for the writer to disagree with — which means a
             * document whose file is shorter than its row does not fail, it
             * quietly becomes a shorter document. The walk read what was there,
             * rewrote it, and stored it.
             *
             * Half a page is worth more than no page, so it stays. What it must
             * not do is stay SILENTLY: `truncated` is how the manifest says the
             * document in the archive is not the whole of what was captured.
             */
            const payload = entry.record.payload;

            if (payload && entry.record.warcFile) {
                const available = fixedRange(
                    entry.record.warcFile, payload.offset, payload.size).available;

                if (available !== payload.size) {
                    truncated.push({
                        path,
                        url: entry.url,
                        expected: payload.size,
                        available,
                        file: entry.record.warcFile,
                    });
                }
            }

            return [{
                name: path,
                data: new Blob([resolved]) as unknown as StoredZipEntry["data"],
                lastModDate: new Date(entry.record.dateArchived),
            }];
        }

        const payload = entry.record.payload;

        if (!payload) {
            return [{ name: path, data: new Blob([]) as unknown as StoredZipEntry["data"] }];
        }

        /*
         * Through `fixedRange`, exactly like the flat path — and this was a bug
         * until a real download proved it.
         *
         * The earlier version sliced `entry.record.file` directly, on the argument
         * that the walk had already read this record so the file must exist and be
         * long enough. That argument is wrong in a way that produces an INVALID
         * ARCHIVE rather than a missing file:
         *
         *   - the length comes from the database; the file is whatever is on disk
         *   - a `file_path` that does not resolve stats as 0 (see §2.5)
         *   - so the entry declares N bytes and yields fewer
         *   - the writer's size check throws MID-STREAM, `writeStoredZip` aborts,
         *     and the client has already been promised a Content-Length
         *
         * The result is a truncated response that Windows reports as "The
         * compressed (zipped) Folder is invalid" and every other tool reports as
         * something equally unhelpful. Dropping the entry instead costs one file
         * and keeps the archive openable, which is the whole point of the ledger.
         */
        const range = fixedRange(
            entry.record.warcFile ?? "",
            payload.offset,
            payload.size,
        );

        if (range.available !== payload.size) {
            dropped.push({
                path,
                url: entry.url,
                expected: payload.size,
                available: range.available,
                file: entry.record.warcFile ?? null,
            });

            return [];
        }

        return [{
            name: path,
            data: range.source as unknown as StoredZipEntry["data"],
            lastModDate: new Date(entry.record.dateArchived),
        }];
    });

/**
 * Does this capture reference anything?
 *
 * Only html and css do — the same two the walk itself descends into. Everything
 * else is a leaf: an image references nothing, and a script's `import` statements
 * are not something an archive can resolve.
 *
 * Reusing `isHtml`/`isCss` from view.ts rather than matching the string here, so
 * that "is this a document" has one answer. They handle the cases a bare
 * comparison does not — `text/html; charset=utf-8`, `application/xhtml+xml`.
 */
export const referencesThings = (contentType: string | null | undefined): boolean => {
    const type = contentType ?? "";

    return isHtml(type) || isCss(type);
};

/** One requested row, and what came with it. */
export interface Expanded {
    entries: StoredZipEntry[];
    /** The requested capture's own path inside the archive. */
    path: string | null;
    /** How many extra entries it pulled in. */
    dependencies: number;
    missing: MissingRef[];
    merged: ReturnType<typeof planSummary>["merged"];
    notices: DownloadNotice[];
    /**
     * Entries the plan wanted that the file on disk could not supply.
     *
     * Distinct from `missing`, which is a reference the ARCHIVE does not hold.
     * These are records the database has and the bytes are not there for — a
     * moved WARC, a relative `file_path` resolving against the wrong directory,
     * or a row written before the payload was flushed.
     */
    dropped: DroppedEntry[];
    /**
     * Documents that are in the archive but incomplete.
     *
     * A short file cannot fail a text entry — its bytes are the rewritten string,
     * so there is no length for the writer to disagree with. The page just comes
     * out shorter than it was captured, which is worth having and not worth
     * hiding.
     */
    truncated: DroppedEntry[];
    /** Null when the walk could not read the document at all. */
    failed?: string;
}

/**
 * A document plus the resources it needs, as zip entries.
 *
 * ## Why this is not opt-in
 *
 * A downloaded `.html` on its own is close to useless: its `<link>` and `<img>`
 * references are absolute urls into a site that may not exist any more, so
 * opening it either shows an unstyled page or quietly fetches from the live web.
 * Asking for a page and getting a page is the behaviour worth having, so the
 * resources come by default and `?resources=0` is how to decline them.
 *
 * ## idPolicy: "always", which is load-bearing
 *
 * Several documents in one request are several walks, and their outputs get merged
 * into one archive. Under the default "on-collision" policy a path only carries
 * the record id when it clashes with something in the SAME plan — so
 * `style.css` might be plain in one walk and `style.<id>.css` in another, and the
 * first document's rewritten href would point at a name the merged archive does
 * not contain. "always" makes every path a pure function of the record, which is
 * what lets two plans agree without consulting each other.
 */
export const expandRow = (
    row: PayloadRow,
    deps: RecursiveDeps,
    budget: { entries: number; bytes: number },
): Promise<Expanded> => {
    const notices: DownloadNotice[] = [];

    return planFromRow(
        row,
        deps,
        {
            maxEntries: budget.entries,
            maxBytes: budget.bytes,
            idPolicy: "always",
        },
        (notice) => { notices.push(notice); },
    ).then((plan): Expanded => {
        if (!plan.ok) {
            return {
                entries: [],
                path: null,
                dependencies: 0,
                missing: [],
                merged: [],
                dropped: [],
                truncated: [],
                notices,
                failed: plan.reason ?? "unreadable",
            };
        }

        const summary = planSummary(plan);
        const dropped: DroppedEntry[] = [];
        const truncated: DroppedEntry[] = [];
        const entries = entriesFromPlan(plan, dropped, truncated);

        return {
            entries,
            dropped,
            truncated,
            path: summary.root,
            // Counted from what actually SHIPPED, not from what the plan wanted:
            // an entry the disk could not supply is in `dropped`, and reporting it
            // as a dependency would make the manifest disagree with the zip.
            dependencies: Math.max(0, entries.length - 1),
            missing: summary.missing,
            merged: summary.merged,
            notices: [...summary.notices, ...notices],
        };
    });
};

/** What the manifest says about a recursive download, beyond the entry list. */
export const planSummary = (plan: DownloadPlan) => ({
    root: plan.root.path ?? null,
    entries: plan.entries.length,
    merged: plan.entries.filter(entry => entry.mergedBy).map(entry => ({
        path: entry.path ?? null,
        url: entry.url,
        by: entry.mergedBy,
        aliases: entry.aliases,
    })),
    missing: plan.missing,
    notices: plan.notices,
});
