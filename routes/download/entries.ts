/**
 * Database rows to zip entries, and an honest account of what happened to each
 * request.
 *
 * The ledger is the point. A download of forty urls where two are missing should
 * produce thirty-eight files and a manifest that names the two — not a 500, and
 * not a silently short archive.
 *
 * See download.plan.md §4.1 for the reasoning, and §2.5 for the measurements
 * behind `fixedRange`, which is the least obvious thing in this file.
 */

import { parseChunkSizes } from "../view/chunks";
import type { StoredZipEntry, ZipSource } from "./storedzip";

/** The columns `response_payloads` exposes that this route needs. */
export interface PayloadRow {
    warc_custom_id: string;
    uri: string;
    file_path: string | null;
    byte_offset: string | number | null;
    byte_length: string | number | null;
    /** Decoded chunk sizes, when the response was Transfer-Encoding: chunked. */
    chunks: unknown;
    content_type?: string | null;
    archived_date?: string | Date | null;
}

/** What was asked for, and what became of it. One per requested id or url. */
export interface EntryStatus {
    /** The id or url as the caller wrote it. */
    request: string;
    kind: "id" | "url";
    /** The archived url, whichever way it was requested. Null when unresolved. */
    url: string | null;
    status: "stored" | "not-found" | "no-payload" | "short-read" | "over-budget" | "error";
    /** Where it landed inside the zip. Null unless status is "stored". */
    resolvedPath: string | null;
    size?: number;
    archivedDate?: string;
    detail?: string;
    /**
     * What a document brought with it. Absent for a leaf.
     *
     * Nested rather than flattened onto this row, because it is the account of a
     * WALK and not of a lookup: `merged` in particular is the only visible
     * evidence that the digest reached the planner, and the way that fails is by
     * being an empty array nobody looks at.
     *
     * A document reporting `dependencies: 0` is one whose references were all
     * missing, which is worth being able to tell from a document with none.
     */
    expansion?: {
        dependencies: number;
        /** References the archive does not hold. */
        missing: unknown[];
        /** Byte-identical captures that collapsed into one entry. */
        merged: unknown[];
        /**
         * Records the database has and the disk does not.
         *
         * Different from `missing`, and worth its own field: a missing reference is
         * something the crawl never captured, while this is something it captured
         * and the bytes are no longer where the row says. Before this existed the
         * symptom was an INVALID ARCHIVE — the writer threw mid-stream on a size
         * that did not match, after Content-Length had been promised.
         */
        dropped: unknown[];
        /** In the archive, but shorter than what was captured. */
        truncated: unknown[];
        notices: unknown[];
    };
}

export interface DownloadLedger {
    entries: StoredZipEntry[];
    status: EntryStatus[];
}

const numeric = (value: string | number | null | undefined): number | null => {
    if (value === null || value === undefined) return null;

    /*
     * Postgres bigint arrives as a string through Bun.sql, and Number() on a
     * 15-digit offset is still exact. Checked rather than trusted: a NaN here
     * would become a slice at NaN, which reads as empty rather than as an error.
     */
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
};

/**
 * A safe path inside the archive.
 *
 * `<host>/<pathname>/<name>.<warc_custom_id>.<ext>` — the id is in the filename
 * rather than appended to a directory, so two captures of the same url sit beside
 * each other and sort together.
 *
 * Every segment is sanitised, because an archived url can contain anything: `..`,
 * a null byte, a colon that Windows will not accept, or four kilobytes of query
 * string. The allowlist is deliberately narrow — this decides where a file lands
 * on a stranger's disk when they extract the archive.
 */
export const pathForEntry = (uri: string, warcCustomId: string): string => {
    let host = "unknown-host";
    let pathname = "/";
    let query = "";

    try {
        const parsed = new URL(uri);
        host = parsed.host || host;
        pathname = parsed.pathname;
        // Folded into the filename, not dropped: two urls differing only by query
        // are two different captures and must not collide.
        query = parsed.search;
    } catch {
        // Not a url. It still needs somewhere to go.
    }

    const clean = (segment: string) =>
        segment.replace(/[^A-Za-z0-9._~@-]+/g, "-").replace(/^\.+/, "").slice(0, 80);

    const segments = pathname.split("/").filter(Boolean).map(clean).filter(Boolean);
    const last = segments.pop() ?? "index";
    const dot = last.lastIndexOf(".");

    const stem = (dot > 0 ? last.slice(0, dot) : last) || "index";
    const ext = dot > 0 ? last.slice(dot + 1) : "html";
    const q = query ? `-${clean(query)}` : "";

    return [clean(host) || "unknown-host", ...segments, `${stem}${q}.${warcCustomId}.${ext}`]
        .join("/");
};

/**
 * A byte range whose size cannot change after it has been measured.
 *
 * `Bun.file(p).slice(a, b).size` is lazy — it re-stats, and clamps to whatever the
 * file is when asked. Measured: a slice created when the file was 10 bytes
 * reported `.size` 100 after an append, having reported 10 before it.
 *
 * That is fatal for `Content-Length`, which is summed from every entry's size
 * before the first byte is written and cannot be revised. WARCs are append-only
 * and are indexed while still being written, so "the file grew between sizing and
 * writing" is the ordinary case, not an exotic one: we would promise the clamped
 * length and then write the full one.
 *
 * So the size is taken ONCE, here, and every read is clamped to it. What this
 * returns is boring by design — a `ZipSource` whose `size` is a number rather
 * than a question.
 */
export const fixedRange = (
    path: string,
    offset: number,
    length: number,
): { source: ZipSource; available: number } => {
    const file = Bun.file(path);

    // Clamped against the file as it is NOW. A missing file stats as 0, which is
    // why the caller compares this against what the database claimed.
    const available = Math.max(0, Math.min(length, file.size - offset));

    const clamp = (at: number) => offset + Math.max(0, Math.min(at, available));

    return {
        available,
        source: {
            size: available,
            slice: (from = 0, to = available) => file.slice(clamp(from), clamp(to)),
            stream: () => file.slice(offset, offset + available).stream(),
        },
    };
};

/**
 * A chunked body, de-framed as it streams.
 *
 * ## The problem
 *
 * A `Transfer-Encoding: chunked` response is stored as the server sent it:
 *
 *     4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n
 *
 * so the payload is not a byte range. There is no offset in the archive that
 * corresponds to byte 5,000 of the body, which is why these were skipped with a
 * `chunked-skipped` row until now.
 *
 * ## Why this is not `dechunkBody(await slice.arrayBuffer())`
 *
 * `parser/view.ts` already de-chunks, and doing it that way here would be four
 * lines. It would also buffer the whole decoded body — and the corpus's largest
 * chunked response is not small, so that reintroduces exactly the memory profile
 * this route exists to avoid, for the one entry shape that cannot be sliced.
 *
 * So the framing is walked as the bytes go past. The stored chunk sizes make that
 * cheap: the hex length prefix does not even need parsing, because the decoded
 * size of each chunk is already known — the parser only has to find the end of
 * each size line, count out that many bytes, and step over the trailing CRLF.
 *
 * State lives across window boundaries, which is the whole difficulty: a size
 * line, a chunk's data, or even the CRLF between them can be split by a read.
 */
export const dechunkingStream = (
    encoded: { stream(): ReadableStream<Uint8Array> },
    sizes: readonly number[],
): ReadableStream<Uint8Array> => {
    const reader = encoded.stream().getReader();

    /** Which chunk we are in, and what we are doing inside it. */
    let index = 0;
    let phase: "size-line" | "data" | "trailer" = "size-line";
    let remaining = 0;
    let trailerLeft = 0;
    /** A `\r` seen at the very end of a window, whose `\n` is in the next one. */
    let sawCR = false;

    /** Set when the last known chunk has been emitted. */
    let finished = false;

    /**
     * Consume one window, enqueueing whatever body it contained.
     *
     * Returns the number of bytes produced, which the caller needs — see the loop
     * in `pull`.
     */
    const consume = (
        value: Uint8Array,
        controller: ReadableStreamDefaultController<Uint8Array>,
    ): number => {
            let produced = 0;
            let at = 0;

            // One window can span several chunks, so this loops rather than
            // handling a single phase per read.
            while (at < value.length) {
                if (phase === "size-line") {
                    /*
                     * Everything up to and including the CRLF is framing.
                     *
                     * Incidentally forgiving: because this skips to the NEXT
                     * CRLF rather than counting bytes, a stray leading byte —
                     * from a trailer that was one short, or a size line with an
                     * extension on it — is absorbed instead of corrupting the
                     * body. Not a guarantee to rely on, but the reason a
                     * mutation of trailerLeft does not show up in the tests.
                     */
                    while (at < value.length) {
                        const byte = value[at]!;
                        at++;

                        if (sawCR && byte === 0x0a) {
                            sawCR = false;
                            remaining = sizes[index] ?? 0;
                            phase = remaining > 0 ? "data" : "trailer";
                            trailerLeft = 2;
                            break;
                        }

                        sawCR = byte === 0x0d;
                    }

                    continue;
                }

                if (phase === "data") {
                    const take = Math.min(remaining, value.length - at);

                    /*
                     * A view, not a copy. `subarray` shares the window's buffer,
                     * which is what keeps this allocation-free per chunk — the
                     * window itself is the only buffer in play.
                     */
                    if (take > 0) {
                        controller.enqueue(value.subarray(at, at + take));
                        produced += take;
                    }

                    at += take;
                    remaining -= take;

                    if (remaining === 0) {
                        phase = "trailer";
                        trailerLeft = 2;
                    }

                    continue;
                }

                // The CRLF after a chunk's data, which may be split across reads.
                const skip = Math.min(trailerLeft, value.length - at);
                at += skip;
                trailerLeft -= skip;

                if (trailerLeft === 0) {
                    index++;
                    phase = "size-line";

                    // Past the last known chunk: what follows is the terminating
                    // "0\r\n\r\n" and any trailer headers, none of which is body.
                    if (index >= sizes.length) {
                        finished = true;

                        return produced;
                    }
                }
            }

        return produced;
    };

    return new ReadableStream<Uint8Array>({
        /**
         * Keep consuming source windows until this pull has produced something.
         *
         * The loop is not an optimisation, it is the only correct shape.
         * **A `pull()` that enqueues nothing is never called again in Bun 1.4.0 —
         * the stream simply hangs**, and a de-framer produces nothing whenever a
         * window happened to hold only framing. Returning after one read therefore
         * deadlocks the response for any payload whose first window is a size
         * line, which is every payload if the windows are small enough.
         *
         * Found by mutation, and only because the test supplies its own windows:
         * reading from a real file gives 64 KB at a time, so a window of pure
         * framing never occurs and the file-backed tests all passed against the
         * broken version.
         */
        async pull(controller) {
            for (;;) {
                if (finished) {
                    controller.close();
                    void reader.cancel();

                    return;
                }

                const { done, value } = await reader.read();

                if (done) {
                    controller.close();

                    return;
                }

                if (consume(value, controller) > 0) return;
            }
        },

        cancel() {
            void reader.cancel();
        },
    });
};

/**
 * A chunked payload as a sequential ZipSource.
 *
 * `size` is the DECODED length — the sum of the stored chunk sizes — because that
 * is what goes into the archive and therefore what `Content-Length` is summed
 * from. The encoded length is only used to bound the read.
 */
export const chunkedRange = (
    path: string,
    offset: number,
    encodedSize: number,
    sizes: readonly number[],
): { source: ZipSource; available: number; decoded: number } => {
    const file = Bun.file(path);
    const available = Math.max(0, Math.min(encodedSize, file.size - offset));
    const decoded = sizes.reduce((sum, size) => sum + size, 0);

    return {
        available,
        decoded,
        source: {
            size: decoded,
            sequential: true,
            /*
             * Never called: `sequential` sends the writer down the stream path.
             * Throwing rather than returning something plausible, because a
             * silently wrong range here would produce an archive full of framing
             * bytes that still opens.
             */
            slice: () => {
                throw new Error("chunkedRange is sequential — read it with stream()");
            },
            stream: () => dechunkingStream(file.slice(offset, offset + available), sizes),
        },
    };
};

/** One row to one entry, or a reason it could not be. */
export const toEntry = (
    row: PayloadRow,
    request: string,
    kind: "id" | "url",
): { entry: StoredZipEntry | null; status: EntryStatus } => {
    const offset = numeric(row.byte_offset);
    const length = numeric(row.byte_length);
    const archivedDate = row.archived_date
        ? new Date(row.archived_date).toISOString()
        : undefined;

    const base: EntryStatus = {
        request,
        kind,
        url: row.uri ?? null,
        status: "stored",
        resolvedPath: null,
        ...(archivedDate ? { archivedDate } : {}),
    };

    if (!row.file_path || offset === null || length === null) {
        return { entry: null, status: { ...base, status: "no-payload" } };
    }

    const chunks = parseChunkSizes(row.chunks);
    const resolvedPathEarly = pathForEntry(row.uri, row.warc_custom_id);

    /*
     * A chunked body is de-framed as it streams, rather than skipped.
     *
     * The stored bytes are interleaved with chunk-length lines, so this is the one
     * entry shape that is not a byte range — see chunkedRange. What goes in the
     * archive is the DECODED length, which is why the size check below compares
     * the encoded length against the file and the entry carries the decoded one.
     */
    if (chunks.length > 0) {
        const chunked = chunkedRange(row.file_path, offset, length, chunks);

        if (chunked.available !== length) {
            return {
                entry: null,
                status: {
                    ...base,
                    status: "short-read",
                    detail: `database says ${length} encoded bytes at ${offset}; `
                        + `${row.file_path} currently offers ${chunked.available}`,
                },
            };
        }

        return {
            entry: {
                name: resolvedPathEarly,
                data: chunked.source,
                ...(archivedDate ? { lastModDate: new Date(archivedDate) } : {}),
            },
            status: {
                ...base,
                resolvedPath: resolvedPathEarly,
                // The decoded size, which is what the reader gets. Reporting the
                // encoded one would make the manifest disagree with the zip.
                size: chunked.decoded,
                detail: `de-chunked from ${length} encoded bytes in ${chunks.length} chunks`,
            },
        };
    }

    const { source, available } = fixedRange(row.file_path, offset, length);

    /*
     * The database said one length and the file offers another.
     *
     * Filed as a failure rather than shipped, because both ways of getting here
     * are silent: a missing archive stats as 0, and a row whose range runs past
     * the end of a still-growing WARC clamps short. Either way the zip would hold
     * a plausible-looking file with the wrong number of bytes in it, and
     * `Content-Length` would agree with the mistake.
     *
     * One comparison catches both, which is why it is worth making explicitly
     * rather than waiting for an exception that never comes.
     */
    if (available !== length) {
        return {
            entry: null,
            status: {
                ...base,
                status: "short-read",
                detail: `database says ${length} bytes at ${offset}; `
                    + `${row.file_path} currently offers ${available}`,
            },
        };
    }

    const resolvedPath = pathForEntry(row.uri, row.warc_custom_id);

    return {
        entry: {
            name: resolvedPath,
            // Lazy, and now fixed: nothing is read until the writer pulls a chunk,
            // and the size cannot move under Content-Length while it waits.
            data: source,
            ...(archivedDate ? { lastModDate: new Date(archivedDate) } : {}),
        },
        status: { ...base, resolvedPath, size: length },
    };
};

/**
 * Collapse two entries that would land on the same path.
 *
 * Two requests can resolve to one capture — the same id twice, or a url and the
 * id it resolves to. A zip with a duplicate name is legal and confusing: most
 * extractors write the last one, some write both.
 *
 * The ledger keeps both rows. They were both asked for and both answered; it is
 * only the bytes that are shared.
 */
export const dedupe = (ledger: DownloadLedger): DownloadLedger => {
    const seen = new Set<string>();
    const entries: StoredZipEntry[] = [];

    for (const entry of ledger.entries) {
        if (seen.has(entry.name)) continue;

        seen.add(entry.name);
        entries.push(entry);
    }

    return { entries, status: ledger.status };
};

/** The account that ships inside the archive. */
export const buildManifest = (status: EntryStatus[]): string =>
    JSON.stringify({
        generated: new Date().toISOString(),
        requested: status.length,
        stored: status.filter(one => one.status === "stored").length,
        entries: status,
    }, null, 2);
