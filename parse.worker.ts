// Parse worker. One of these runs per thread; parse.ts (the main thread) owns
// the file list, the progress bar and the error log, and this file does nothing
// but decode the file it is handed and insert the rows.
//
// Protocol — every message is a flat object of primitives, which is what keeps
// postMessage on Bun's "simple object" fast path (no structured clone):
//
//   main -> worker   { type: "parse", index, filePath }
//                    { type: "shutdown" }
//
//   worker -> main   { type: "progress", index, offset, records }
//                    { type: "error",    index, line, summary }
//                    { type: "done",     index, records }
//
// `index` is the position in the main thread's file list and is echoed back on
// every message, so the main thread never has to guess which assignment a
// message belongs to.

declare var self: Worker;

import { mWarcDecode } from "./mwarc";
import { formatWarcComposite, insert_warc_files, insert_warc_response_bulk, recursionLevel } from "./db";
import { formatParseError } from "./log";
import type { WarcFile, WarcResponseBulkInput } from "./db.types";

/**
 * A header date as an ISO string, or null.
 *
 * `new Date(x).toISOString()` THROWS RangeError on an unparseable date rather
 * than returning something falsy, so a single odd `WARC-Date` or `Last-Modified`
 * took down the whole file. WARC 1.1 widened what a valid date looks like —
 * fractional seconds, the spec's own Annex A example being
 * `2016-01-11T23:24:25.412030Z` — and while V8 does accept six and even nine
 * fractional digits, it rejects the comma decimal separator that ISO 8601 allows.
 *
 * A record with an unreadable date is still a record worth having, so this
 * degrades to null instead of throwing.
 */
const isoOrNull = (raw: string | number | null | undefined): string | null => {
    if (raw === null || raw === undefined) return null;

    const at = new Date(String(raw));

    return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

const UUID_RE = /<urn:uuid:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>/i;

const RECORD_BATCH_SIZE = Number(Bun.env.RECORD_BATCH_SIZE ?? 1024);

/** Which worker this is, for error attribution. Set by the first "parse" message. */
let workerId: number | null = null;

function extractUuid(input: string): string | null {
    return UUID_RE.exec(input)?.[1] ?? null;
}

// WARC-Target-URI is a bare URI ("http://example.com/") in most crawls, but some
// tools wrap it in angle brackets ("<http://example.com/>"). Handle both, and
// return null only when there is genuinely nothing to store.
function extractUri(input: string | null | undefined): string | null {
    if (input == null) return null;
    const s = String(input).trim();
    if (!s) return null;
    const bracketed = /^<(.+)>$/.exec(s);
    return (bracketed ? bracketed[1].trim() : s) || null;
}

/**
 * Format an error here and ship the two strings to the main thread to write.
 *
 * Workers must not append to parse-errors.log themselves — eight threads writing
 * to one file interleave. Formatting is pure, so it stays on this side.
 */
function reportError(
    index: number,
    context: { file?: string | null; offset?: number | null; uri?: string | null; warcRecordId?: string | null; warcType?: string | null; stage?: string },
    err: unknown,
): void {
    const { line, summary } = formatParseError({ ...context, worker: workerId }, err);
    postMessage({ type: "error", index, line, summary });
}

/**
 * Fire one bulk insert and track it in `inflight` until it settles.
 *
 * The .catch() is what keeps a failed batch visible: the caller only awaits
 * Promise.allSettled(), which discards rejections, so without reporting here a
 * rejected batch would silently drop up to RECORD_BATCH_SIZE records. It also
 * means nothing in `inflight` can reject, so the throwaway promise from
 * .finally() has no rejection left to leak as an unhandled one.
 */
const flushBatch = (
    index: number,
    file: WarcFile,
    rows: string[],
    offset: number,
    inflight: Set<Promise<unknown>>,
    /*
     * Where this batch STARTS, and the id under which that is remembered.
     *
     * The start, not the end, because the resume point has to be a place from
     * which nothing is missing. A batch covering records [a..b] that has not
     * committed means the archive lacks everything from `a` onward — so while it
     * is in flight the checkpoint may not pass `a`, whatever later batches have
     * managed to land.
     */
    pending?: { starts: Map<number, number>; id: number; start: number },
): void => {
    if (pending) pending.starts.set(pending.id, pending.start);

    const insert = insert_warc_response_bulk(rows)
        .catch(err => reportError(index, {
            file: file.file_path,
            offset,
            warcType: "response",
            stage: "insert",
        }, err));

    inflight.add(insert);
    insert.finally(() => {
        inflight.delete(insert);
        // Removed only once the rows are actually in, which is what makes the
        // minimum below mean "committed up to here".
        if (pending) pending.starts.delete(pending.id);
    });
};

const parseOneFile = async (
    index: number,
    file: WarcFile,
    /**
     * Byte offset to start reading at. Zero is a fresh parse.
     *
     * MUST be a record boundary. Every value that reaches here came out of the
     * decoder as a `header-warc.offset`, so it is one — mWarcDecode's `start`
     * does not go looking for a boundary and would happily begin mid-payload.
     */
    start = 0,
    /** Records this file already contributed on a previous run, for the totals. */
    priorRecords = 0,
): Promise<{ records: number; checkpoint: number; error?: string }> => {
    const fh = Bun.file(file.file_path);
    const read = (from: number, size: number) => fh.slice(from, from + size).arrayBuffer();
    const parser = mWarcDecode(read, {
        returnChunkSizes: true,
        ...(start > 0 ? { start } : {}),
    });

    // Seeded with `start`, so a file that yields nothing new still reports a
    // checkpoint that does not move backwards.
    let lastOffset = start;
    let records_found = priorRecords;
    let seen = 0;       // records of any type, used to throttle progress messages
    let posted = 0;     // Date.now() of the last progress message

    // Inserts fired for this file that haven't settled yet; drained at the end.
    const inflight = new Set<Promise<unknown>>();
    const records: string[] = [];

    /** Start offset of every batch still in flight, keyed by batch id. */
    const pendingStarts = new Map<number, number>();
    let nextBatchId = 1;
    /** Offset of the first record of the batch being filled, or null when empty. */
    let batchStart: number | null = null;

    /*
     * The furthest offset it is SAFE to resume from.
     *
     * The oldest thing not yet known to be in the database: the start of the
     * earliest in-flight batch, or — with none in flight — the start of the batch
     * currently being filled. Batches settle out of order, so taking the newest
     * committed one would skip the gaps behind it.
     *
     * With nothing in flight and nothing buffered it falls back to the last
     * record seen, which re-reads exactly one record on resume. That is free:
     * insert_warc_responses_full is ON CONFLICT DO NOTHING the whole way down.
     */
    const checkpoint = (): number => {
        let at = batchStart ?? lastOffset;

        for (const offset of pendingStarts.values()) if (offset < at) at = offset;

        return at;
    };

    try {
        /*
         * Register the file first, and skip the warcinfo record only on a fresh
         * parse.
         *
         * These used to be one step — `await parser.next()` threw away the first
         * record because on a fresh parse it is the warcinfo, which carries no
         * response. Resuming, the first record at `start` is an ordinary response,
         * and discarding it would silently lose one record per restart.
         *
         * Reads MUST stay sequential either way — the decoder is a stateful
         * generator.
         */
        await insert_warc_files([file]);

        if (start === 0) await parser.next();

        for await (const data of parser) {
            const off = data['header-warc']?.['offset'];
            if (typeof off === "number") {
                lastOffset = off;

                // Report position by byte offset rather than logging records.
                // Throttled on a clock, not a record count: at 50k records/sec a
                // "every 256th record" rule would post ~200 messages/sec that the
                // main thread's bar (which only repaints once a second) throws
                // away. The cheap mask keeps Date.now() off the per-record path.
                seen++;
                if ((seen & 0x1F) === 0) {
                    const now = Date.now();
                    if (now - posted >= 250) {
                        posted = now;
                        postMessage({
                            type: "progress",
                            index,
                            offset: off,
                            records: records_found,
                            // Persisted by the main thread. Distinct from `offset`,
                            // which is where the READER is: this is how far the
                            // DATABASE is, and it lags by whatever is in flight.
                            checkpoint: checkpoint(),
                        });
                    }
                }
            }

            if (data['header-warc']['WARC-Type'] !== "response") continue; // skip non-response

            const uri = extractUri(data['header-warc']['WARC-Target-URI']);
            const recordId = extractUuid(data['header-warc']['WARC-Record-ID']);
            const recordOffset = typeof off === "number" ? off : null;

            if (recordId === null || uri === null || recordOffset === null) {
                reportError(index, {
                    file: file.file_path,
                    offset: recordOffset,
                    uri,
                    warcRecordId: recordId,
                    warcType: "response",
                    stage: "decode",
                }, new Error("Missing required fields in WARC response record"));
                continue;
            }

            const record: WarcResponseBulkInput = {
                warc_custom_id: file.file_path + "::" + uri + "::" + recordId,
                warc_record_id: recordId,
                warc_archived_date: isoOrNull(data['header-warc']['WARC-Date']),
                file_path: file.file_path,
                ip: data['header-warc']['WARC-IP-Address'] ?? null,
                uri,
                http_content_type: (data['header-meta']['content-type'] ?? data['header-meta']['Content-Type'])
                    ?.toString()
                    .split(";")
                    .map(c => c.trim())
                    .join("; "),
                http_headers: data['header-meta'] ?? {},
                http_status: data['header-meta']['statusCode'] ?? null,
                http_last_modified: isoOrNull(
                    data['header-meta']['last-modified'] ?? data['header-meta']['Last-Modified'],
                ),
                payload_byte_offset: data['header-content']?.['offset'] ?? null,
                payload_byte_length: data['header-content']?.['size'] ?? null,
                payload_chunks: data['header-content']?.['chunks'],
                payload_digest: data['header-warc']['WARC-Payload-Digest'] ?? null,
                // Path depth, the first sort key for search/browse results.
                // insert_warc_responses_full derives this itself with
                // uri_recursion_level(), so this value is not what ends up in the
                // database — it's sent so the composite isn't carrying a lie. It
                // used to be a hardcoded 0, which left every URI at level 0 and
                // silently disabled homepages-first ordering.
                recursion_level: recursionLevel(uri),
            };

            // The first record of a batch fixes where that batch begins, which is
            // the only offset the resume point may safely fall back to.
            if (batchStart === null) batchStart = recordOffset;

            records.push(formatWarcComposite(record));
            records_found++;

            if (records.length >= RECORD_BATCH_SIZE) {
                const recordsToInsert = [...records];
                const from = batchStart;

                records.length = 0; // clear the array for the next batch
                batchStart = null;

                flushBatch(index, file, recordsToInsert, lastOffset, inflight, {
                    starts: pendingStarts,
                    id: nextBatchId++,
                    start: from,
                });
            }
        }

        // Flush the tail, then let this file's inserts finish before reporting
        // done. This await is what bounds the work in flight: the main thread
        // hands this worker its next file only after "done", so at most
        // PARSE_WORKERS files' worth of rows and connections are ever live.
        if (records.length > 0) {
            flushBatch(index, file, records, lastOffset, inflight, {
                starts: pendingStarts,
                id: nextBatchId++,
                start: batchStart ?? lastOffset,
            });
            batchStart = null;
        }
        await Promise.allSettled([...inflight]);

    } catch (err) {
        // A decode failure loses the rest of this file, not the run. Drain
        // whatever was already queued so those rows still land.
        await Promise.allSettled([...inflight]);
        reportError(index, { file: file.file_path, offset: lastOffset, stage: "decode" }, err);

        /*
         * Reported as an error WITH its checkpoint.
         *
         * The offset is the valuable part: everything before it is in the
         * database, so the retry starts from there rather than from zero. A file
         * that dies 90% of the way through a 6 GB archive should cost the last
         * 10% on the next run, not all of it.
         */
        return {
            records: records_found,
            checkpoint: checkpoint(),
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        };
    }

    // Reached the end. Everything queued has settled, so the checkpoint is the
    // whole file — the caller turns that into `parsed` with the file's size.
    return { records: records_found, checkpoint: checkpoint() };
};

self.onmessage = (event: MessageEvent) => {
    const msg = event.data as
        | {
            type: "parse";
            index: number;
            filePath: string;
            worker: number;
            /** Resume point. Absent or 0 means read from the top. */
            start?: number;
            /** Records already banked for this file on a previous run. */
            records?: number;
        }
        | { type: "shutdown" }
        | undefined;

    if (!msg) return;

    if (msg.type === "shutdown") {
        // Ends this thread only; the main process keeps running.
        process.exit(0);
    }

    if (msg.type === "parse") {
        workerId = msg.worker;

        // Not awaited: returning immediately keeps the message handler free, and
        // the main thread never sends a second assignment before "done".
        const start = typeof msg.start === "number" && msg.start > 0 ? msg.start : 0;

        void parseOneFile(msg.index, { file_path: msg.filePath }, start, msg.records ?? 0)
            .then(result => {
                postMessage({
                    type: "done",
                    index: msg.index,
                    records: result.records,
                    checkpoint: result.checkpoint,
                    error: result.error,
                });
            })
            .catch(err => {
                // parseOneFile catches its own failures, so reaching here means
                // something outside the decode loop broke. Still report done, or
                // the main thread would wait on this slot forever.
                reportError(msg.index, { file: msg.filePath, stage: "worker" }, err);
                postMessage({
                    type: "done",
                    index: msg.index,
                    records: 0,
                    // The resume point it was GIVEN, so a crash outside the decode
                    // loop cannot push the file back to zero on the next run.
                    checkpoint: start,
                    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
                });
            });
    }
};
