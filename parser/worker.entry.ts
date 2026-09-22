/**
 * Browser worker entry for mwarc.
 *
 * Built by Bun.build (target: "browser") at webserver boot and served from
 * /api/warcs/parser/index.js. The frontend fetches it, makes a blob URL and
 * spawns it as a dedicated Worker.
 *
 * This works only because mwarc.ts has no Bun or Node dependencies — no imports
 * at all, just TextEncoder/TextDecoder/ArrayBuffer, with every read injected
 * through a callback. Adding a `Bun.file` or `node:` import to mwarc.ts breaks
 * this entire feature, so keep it clean.
 *
 * PROTOCOL — matches what components/Offline/cactions.tsx listens for:
 *
 *   main -> worker   { action: "parseStream",
 *                      handle: { name, size, parsedOffset, file,
 *                                chunkSize?, batchRecords?, batchMs? } }
 *
 *   worker -> main   { action: "progress",   name, parsedOffset, size, percent,
 *                                            status: "parsing", records, responses }
 *                    { action: "newRecords", name, records[], parsedOffset, size,
 *                                            status: "parsing" }
 *                    { action: "parsed",     name, parsedOffset, size, status: "parsed",
 *                                            records, responses }
 *                    { action: "error",      name, parsedOffset, size, status: "error",
 *                                            stage, errorName, message, records }
 *
 * PROGRESS IS SEPARATE FROM RECORDS, and that separation is the point. Batching
 * records made the bar lurch: it only advanced when a batch shipped, so it moved
 * in 256-record steps, and a single record that takes a while — a chunked body
 * whose framing has to be walked — held it still for all of that. A progress
 * message is two numbers, so it costs nothing to send it at a much finer
 * granularity than records, which are expensive to move. Each now runs at the
 * cadence that suits it: records when 256 accumulate or 50ms passes, progress
 * whenever the whole percent changes.
 *
 * Failure used to ride in on the record message with status:"error" and no
 * record, which meant the one message carrying no record was also the one the
 * record handler had to special-case. It is its own action now, and it says which
 * file, how far it got, and why.
 *
 * `name` is on EVERY message. The main thread parses several files at once and
 * hands a worker its next file the moment one finishes, so "which file is this
 * worker on" is a moving target there — the worker is the only side that can
 * answer it without a race.
 *
 * RECORDS ARE BATCHED. This used to post one message per record, and a profile
 * said that was costing more than the parsing: postMessage was 42% of all worker
 * working time, and on the busiest worker it beat the decode loop outright (634ms
 * against 404ms). Each message carries a fixed structured-clone and dispatch cost
 * that an array of records pays once instead of 256 times.
 */

/*
 * The worker globals this file uses, declared locally rather than pulled from
 * the DOM/WebWorker libs.
 *
 * backend/tsconfig.json sets "lib": ["ESNext"], so DedicatedWorkerGlobalScope and
 * MessageEvent do not exist here. Widening that lib would fix the error and
 * simultaneously let every server-side file reference `document` or `window`
 * without complaint, which is a worse trade. This file is the only browser
 * target in the backend, so it carries its own declarations — and they double as
 * documentation of the entire surface it touches.
 */
declare const self: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage(message: unknown): void;
};

import { mWarcDecode, mWarcFindRecordStart, type WarcRecord } from "../mwarc";
import { buildView, readPayload, type ResolveOutcome, type ViewRecord } from "./view";
import {
    createGzipWarcReader,
    looksGzipped,
    type GzipLocation,
    type GzipWarcReader,
} from "./gzip";
import { absoluteLocation, looksZipped, waczArchives } from "./wacz";
// Everything the tests need lives in wire.ts, NOT here — a runtime export from
// this file becomes a top-level `export` in the bundle, which is a SyntaxError in
// the classic worker it is loaded as. See the header of wire.ts.
import { resolveSources, toWire, type ParseSource, type WireWarcRecord } from "./wire";
import {
    planDownload,
    writeDownload,
    type DownloadNotice,
    type ZipSink,
} from "./download";
/*
 * storedsink, not zipsink.
 *
 * Same interface, no zip.js. The library was 131 KB minified of a 190 KB bundle —
 * two thirds of what every reader of the viewer downloads — to store bytes it
 * does not compress. See the header of storedsink.ts for the measurements, and
 * zipsink.ts, which is still here, for the version that can deflate.
 */
import { createStoredZipSink } from "./storedsink";

/**
 * Blob and URL, declared locally for the same reason as `self` above: the backend
 * tsconfig loads no DOM lib, and this file is its only browser target.
 */
declare const Blob: { new(parts: unknown[], options?: { type?: string }): unknown };
declare const URL: { createObjectURL(object: unknown): string };

/**
 * The bit of Blob/File this worker touches. Declared for the same reason as the
 * globals above — `Blob` lives in the DOM lib, which the backend does not load.
 * A File satisfies this structurally, so the posted handle fits without a cast.
 */
interface BlobLike {
    readonly size: number;
    slice(start?: number, end?: number): BlobLike;
    arrayBuffer(): Promise<ArrayBuffer>;
}

/** The cloneable subset of WarcFileHande that actually crosses the boundary. */
interface PostedHandle {
    name: string;
    size?: number;
    parsedOffset: number;
    /** A File/Blob, never a function — see cactions.tsx parseNextHandle. */
    file: BlobLike;

    /**
     * The slice of this file the worker owns, when several are sharing it.
     *
     * Absent means the whole file, which is the single-worker path and must stay
     * byte-identical to what it was before segmentation existed.
     *
     * Ownership is by RECORD START: this worker parses every record beginning in
     * [start, end) and reads past `end` to finish the last one. So adjacent
     * segments neither skip a record nor parse one twice, and never have to talk to
     * each other — see mwarc's `end` option and segments.plan.md §1.
     */
    segment?: {
        /** 0..count-1. Echoed on every message so the main thread can attribute it. */
        index: number;
        count: number;
        start: number;
        end: number;
    };

    /** Bytes per read. See DEFAULT_CHUNK_SIZE. */
    chunkSize?: number;
    /** Records per message. See DEFAULT_BATCH_RECORDS. */
    batchRecords?: number;
    /** Milliseconds before a partial batch is posted anyway. See DEFAULT_BATCH_MS. */
    batchMs?: number;
}

/**
 * Bytes per read while scanning for headers.
 *
 * 8 KiB rather than mwarc's 1 KiB default, and deliberately not more. Only two
 * header blocks are ever READ per record — the WARC header (~400-600 bytes) and,
 * on a response, the HTTP header (~200-800 bytes); the payload is skipped by
 * moving the file offset, not by reading it. 8 KiB covers both in a single read
 * for essentially every record, which is the win, while 64 KiB would read tens of
 * KiB per record only to discard it.
 */
const DEFAULT_CHUNK_SIZE = 8 * 1024;

/**
 * Records per message.
 *
 * Header-only records run 1-2 KB each once cloned, so 256 is a few hundred KB per
 * message — comfortable for structured clone, and it caps how much sits in worker
 * memory waiting to be posted.
 */
const DEFAULT_BATCH_RECORDS = 256;

/**
 * Milliseconds before a partial batch is posted anyway.
 *
 * This is the latency bound, and 50ms is chosen against what the UI can actually
 * show: the listing repaints at most once a frame and only when its whole-percent
 * figure moves, so delivering sooner changes nothing on screen. It is the cap that
 * binds on a slow parse — a small file, or one still reading 1 KiB at a time,
 * finishes before 256 records accumulate and would otherwise report nothing until
 * it was done.
 */
const DEFAULT_BATCH_MS = 50;

/**
 * The segment being parsed right now, and how far it may still claim.
 *
 * Module-level because the message handler and the parse loop live in different
 * scopes: `resegment` arrives on `self.onmessage` while parseSource is mid-await,
 * and this is how the one reaches the other.
 *
 * `limit` starts at the segment's end and only ever SHRINKS — the main thread cuts
 * it when another worker runs out of work, and the tail becomes that worker's task.
 * Only ever shrinks because growing it would need the other worker to give a range
 * back, and nothing does that.
 */
let activeClaim: { index: number; limit: number } | null = null;



/** Where a failure happened, so the UI can say more than "it broke". */
export type WarcParseStage =
    /** The posted message was unusable — no File, wrong shape. */
    | "handle"
    /** mwarc threw partway through the archive. */
    | "decode";

function postError(
    name: string,
    stage: WarcParseStage,
    error: unknown,
    parsedOffset: number,
    size: number,
    records: number,
    /** Which segment failed, when the file is being parsed by several workers. */
    segment?: number,
): void {
    self.postMessage({
        action: "error",
        ...(segment !== undefined ? { segment } : {}),
        name,
        parsedOffset,
        size,
        status: "error",
        stage,
        // WarcParseError vs TypeError vs DOMException tells you a lot at a
        // glance — a NotReadableError means the file moved on disk mid-parse,
        // which is a completely different conversation to a malformed record.
        errorName: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        records,
    });
}


async function parseStream(handle: PostedHandle): Promise<void> {
    const file = handle.file;
    const size = handle.size ?? file.size;

    /**
     * The archive(s) this one selected file contains.
     *
     * A .warc or .warc.gz is one. A .wacz is a zip of several, each a contiguous
     * STORED byte range, so each becomes a slice — see wacz.ts. Everything below
     * loops over these and does not care which case it got.
     */
    let sources: ParseSource[];

    try {
        sources = await resolveSources(file, handle.name);
    } catch (error) {
        // A container we cannot open is a "handle" failure, not a decode failure:
        // nothing was malformed inside an archive, we could not find the archives.
        postError(handle.name, "handle", error, 0, size, 0);
        return;
    }

    /** The reader for the archive currently being parsed, for progress. */
    let reader: GzipWarcReader | null = null;
    /** Where the current archive starts in the selected file. 0 unless .wacz. */
    let sourceBase = 0;
    /** Archives that turned out not to be record-compressed. See parseSource. */
    const singleMemberArchives: string[] = [];

    /** This worker's slice of the file, when it is sharing it. See PostedHandle. */
    const segment = handle.segment;

    /**
     * How far through its OWN segment this worker has got, absolutely.
     *
     * Reported instead of a whole-file position because the main thread sums the
     * segments to draw one bar — summing raw positions would show a worker starting
     * at 1.2 GB as having parsed 1.2 GB. See segments.plan.md §6.
     */
    let segmentAt = segment ? segment.start : 0;

    /**
     * Where this segment stopped claiming, when it was cut short.
     *
     * Null for a segment that ran to its own end. Set to the record start we handed
     * over, which is what the `parsed` message must report as this segment's extent
     * — reporting the ORIGINAL end would credit this worker with the tail another
     * worker is about to parse, and the progress sum would exceed the file size.
     */
    let handedOffAt: number | null = null;

    let parsedOffset = 0;
    let records = 0;
    let responses = 0;

    const batchRecords = handle.batchRecords && handle.batchRecords > 0 ? handle.batchRecords : DEFAULT_BATCH_RECORDS;
    const batchMs = handle.batchMs && handle.batchMs > 0 ? handle.batchMs : DEFAULT_BATCH_MS;

    let batch: WireWarcRecord[] = [];
    let batchOpenedAt = 0;

    // -1 rather than 0, so that 0% is itself a change and gets reported. That
    // first message is what flips the row from "Pending" to "Parsing" — without it
    // a big file looks untouched until it crosses 1%.
    let lastPercent = -1;

    /**
     * Post progress, but only when the figure a reader can actually see has moved.
     *
     * Whole percent is that figure: the listing renders `${percent}%` and a bar
     * that many pixels wide, so a report at 41.3% and one at 41.4% draw the same
     * thing. A 122 MB file has 101 visible states and this sends exactly that many
     * — the main thread gates on the same rule, so anything finer would be
     * discarded there anyway, having already paid for the message.
     */
    /**
     * How far through the SELECTED FILE we physically are, in the same coordinate
     * space as `size`.
     *
     * THIS is what every progress figure must report, and it is not `parsedOffset`.
     * For a plain .warc they are the same number. For a .warc.gz they are wildly
     * different: `size` is the file on disk while `parsedOffset` is a position in
     * the archive as DECOMPRESSED, so at 50.8 MB compressed to 77.5 MB the ratio
     * crosses 1.0 about two thirds of the way in — the bar reaches 100% and then
     * sits there, still parsing, which is exactly what it did.
     *
     * The compressed position is monotonic, bounded by `size` by construction, and
     * the truer measure anyway: work done, not position reached.
     *
     * `sourceBase` extends that across a .wacz. Each archive's reader counts from
     * zero, so adding where the archive begins in the zip keeps the figure rising
     * through all of them instead of snapping back to 0% at every boundary.
     */
    const physicalOffset = () => (reader ? sourceBase + reader.compressedPosition : parsedOffset);

    const reportProgress = () => {
        const through = physicalOffset();

        /*
         * A segmented worker throttles on its OWN share, not on the file.
         *
         * Gating on whole percent of the file would make a worker owning a quarter
         * of it send 25 messages instead of 101 — and the main thread, which is
         * summing four segments, would draw a bar that moved in 1% steps four times
         * as coarsely as it could. Percent of the segment gives each worker its full
         * resolution and costs the same number of messages.
         */
        const span = segment ? segment.end - segment.start : size;
        const done = segment ? segmentAt - segment.start : through;
        const percent = span > 0 ? Math.min(100, Math.floor((done / span) * 100)) : 0;

        if (percent === lastPercent) return;

        lastPercent = percent;

        self.postMessage({
            action: "progress",
            name: handle.name,
            ...(segment ? { segment: segment.index, segmentAt } : {}),
            // The physical figure, NOT the logical one. The main thread does not
            // read `percent` below — progress.ts recomputes it as
            // parsedOffset / size — so sending a logical offset here is what put
            // the bar past 100%. `percent` stays only as the worker's own
            // send-throttle.
            parsedOffset: through,
            size,
            percent,
            status: "parsing",
            // Free to include and useful live: the listing can count records up as
            // they are found rather than only revealing a total at the end.
            records,
            responses,
        });
    };

    /**
     * Post whatever has accumulated. Safe to call with an empty batch, which is
     * what lets the completion and failure paths simply call it first rather than
     * each having to reason about whether anything is outstanding — dropping the
     * final partial batch would silently lose up to 255 records per file.
     */
    const flush = () => {
        if (batch.length === 0) return;

        self.postMessage({
            action: "newRecords",
            name: handle.name,
            ...(segment ? { segment: segment.index, segmentAt } : {}),
            records: batch,
            // Physical, for the same reason as reportProgress — and it has to
            // AGREE with it, because both messages land in applyProgress and
            // overwrite handle.parsedOffset. Two different coordinate spaces
            // arriving on alternate messages makes the bar jitter as well as
            // overrun.
            parsedOffset: physicalOffset(),
            size,
            status: "parsing",
        });

        // A fresh array, not batch.length = 0 — the old one has been handed to
        // structured clone and must not be mutated out from under it.
        batch = [];
    };

    /**
     * Parse one archive. Counters, batching and progress are the enclosing
     * handle's, so N archives report as one file rather than N.
     */
    const parseSource = async (source: ParseSource): Promise<void> => {
        // A .warc.gz is one gzip member per record, so it can be read as if it
        // were a plain .warc — the reader translates logical offsets to members
        // and mwarc never learns the difference.
        reader = source.gzipped ? createGzipWarcReader(source.file) : null;
        sourceBase = source.dataOffset;

        // The reader mwarc wants, built here rather than passed in: mwarc reads in
        // 1 KiB chunks and probes 64 bytes at a time for chunk framing, so routing
        // every read back to the main thread would be ~1M round trips per
        // gigabyte. Blob.slice is a view, so this allocates only the range asked
        // for.
        const read: (start: number, length: number) => Promise<ArrayBuffer | null> = reader
            ? reader.read
            : (start, length) => source.file.slice(start, start + length).arrayBuffer();

        /*
         * Where this worker's share of the file begins.
         *
         * A segment boundary is a byte count, so it lands mid-record almost every
         * time. Resync scans forward to the next record header before parsing — and
         * `null` is a legitimate answer, not a failure: one record can span an
         * entire segment, in which case this worker owns nothing and the segment
         * before it is parsing that record.
         *
         * Only for a segmented plain .warc. Segment 0 starts at 0, which is a record
         * boundary by definition, so it skips the scan.
         */
        let from = segment ? segment.start : 0;

        if (segment && segment.start > 0) {
            const found = await mWarcFindRecordStart(read, segment.start, segment.end, size);

            if (found === null) {
                // Nothing of ours here. Report the whole segment as done so the
                // aggregate progress still reaches 100%.
                segmentAt = segment.end;
                reportProgress();
                return;
            }

            from = found;
            segmentAt = found;
        }

        // content:false is not negotiable here — see toWire.
        const parser = mWarcDecode(read, {
            content: false,
            returnChunkSizes: true,
            returnFullSize: true,
            chunkSize: handle.chunkSize && handle.chunkSize > 0 ? handle.chunkSize : DEFAULT_CHUNK_SIZE,
            ...(segment ? { start: from, end: segment.end } : {}),
        });

        // Published so `resegment` can find it. mwarc's own `end` still bounds the
        // static case; this is the same bound made mutable.
        if (segment) activeClaim = { index: segment.index, limit: segment.end };

        try {
            for await (const record of parser) {
                const offset = record["header-warc"]?.["offset"];

                /*
                 * Handed off. Another worker ran dry, the main thread cut this
                 * segment short, and everything from here on is now that worker's.
                 *
                 * Checked BEFORE the record is claimed, and `offset` is a real
                 * record start — so it is exactly the boundary to hand over, and
                 * the receiving worker does not even need to resync to it. Breaking
                 * after processing would parse one record twice.
                 */
                if (segment && activeClaim && typeof offset === "number" && offset >= activeClaim.limit) {
                    segmentAt = offset;
                    handedOffAt = offset;

                    /*
                     * The offset we ACTUALLY stopped at, not the one we were asked
                     * for. Between the main thread choosing a cut point and this
                     * loop seeing it, we may already have parsed past it — so the
                     * request is a request, and this is the answer. The main thread
                     * hands the idle worker THIS, which is why no record can be
                     * dropped or claimed twice.
                     */
                    self.postMessage({
                        action: "resegmented",
                        name: handle.name,
                        segment: segment.index,
                        stoppedAt: offset,
                        records,
                        responses,
                    });

                    break;
                }

                if (typeof offset === "number") {
                    parsedOffset = offset;
                    // Our own position within our own segment, for the aggregate.
                    if (segment) segmentAt = offset;
                }

                // For a .warc.gz, resolve where this record's payload physically
                // lives before the record leaves the worker. Cheap: the member
                // table is built by the same pass, so this is a binary search, and
                // at worst it inflates one member further to learn where the
                // current member ends.
                const payloadOffset = record["header-content"]?.["offset"];
                const found = reader && typeof payloadOffset === "number"
                    ? await reader.locate(payloadOffset)
                    : undefined;

                // Rebased onto the SELECTED FILE, not the archive. The reader sees
                // a slice starting at zero; a ViewRecord carries the file the user
                // picked. For a .wacz those differ by dataOffset, and an unbiased
                // location would read from inside the previous entry — silently,
                // because the bytes there are still a valid-looking gzip member.
                const gzip = found && source.dataOffset > 0
                    ? absoluteLocation(found, source)
                    : found;

                const wire = toWire(record, gzip);

                records++;
                // Counted here rather than derived on the main thread because a
                // WARC pairs every response with a request, so "records" is roughly
                // double what a reader would call the number of captured pages.
                if (wire.type === "response") responses++;

                reportProgress();

                if (batch.length === 0) batchOpenedAt = Date.now();
                batch.push(wire);

                // The clock is read on every record. An earlier version only
                // checked it every 16, to keep Date.now() off the hot path — but
                // that put a 16-record floor on the time cap, so slow records (a
                // chunked body being walked) could hold a batch far past 50ms.
                // Date.now() is a handful of nanoseconds against a record that
                // costs microseconds at best; the mask was saving nothing and
                // costing latency.
                if (batch.length >= batchRecords || Date.now() - batchOpenedAt >= batchMs) {
                    flush();
                }
            }
        } finally {
            // Let the generator run its cleanup rather than abandoning it mid-read,
            // on the way out of a failure as well as a clean finish.
            await parser.return?.(undefined);

            // No longer claiming anything. A late `resegment` for a segment that has
            // finished must not shrink whatever this worker picks up next.
            activeClaim = null;
        }

        // Someone ran `gzip whole.warc` instead of compressing per record, so the
        // archive has no seek points: every record's member is the entire file.
        //
        // Not fatal, and deliberately not refused — the parse itself is correct and
        // runs at normal speed, so the record listing is perfectly usable. What is
        // ruined is READING a payload, which has to re-inflate the whole archive to
        // extract a few kilobytes: measured 31 ms for 6,260 bytes out of 8 MB, and
        // it scales linearly, so a 5 GB archive costs roughly 20 seconds per page.
        // Better to say so than to let someone conclude the viewer is just slow.
        if (reader?.singleMember) singleMemberArchives.push(source.name);
    };

    try {
        // Before the first record: says "Parsing, 0%" the moment the file is
        // picked up, rather than leaving the row on "Pending" until a batch ships.
        reportProgress();

        // Sequential, not concurrent. Each archive's reader inflates forward and
        // holds a window; running four at once would multiply peak memory by four
        // for no gain, since a single reader already saturates on inflate.
        for (const source of sources) {
            await parseSource(source);
        }

        flush();

        // parsedOffset is deliberately `size`, not the last record's offset. The
        // main thread drives a progress bar off it, and the last record starts
        // some distance before the end of the file — so reporting that would
        // park a finished parse at 99%, which is exactly what it used to do.
        self.postMessage({
            action: "parsed",
            name: handle.name,
            parsedOffset: size,
            size,
            status: "parsed",
            records,
            responses,
            /*
             * A segmented worker finishing means ITS SEGMENT is done, not the file.
             *
             * `segmentAt` is pinned to the segment's end for the same reason
             * parsedOffset is pinned to `size` above: the last record it claimed
             * starts some distance before the boundary, so reporting that would park
             * this segment's share short of complete forever. The main thread only
             * marks the file parsed once every segment has said this.
             */
            //
            // `handedOffAt` when this segment was cut short, so the sum credits it
            // only with what it actually parsed — the tail belongs to whichever
            // worker took it.
            ...(segment
                ? {
                    segment: segment.index,
                    segmentAt: handedOffAt ?? segment.end,
                    segments: segment.count,
                    ...(handedOffAt !== null ? { handedOffAt } : {}),
                }
                : {}),
            // Rendered under the row as ordinary text, not as a failure: the parse
            // succeeded and every record is there. It is the reading that will be
            // slow, and the reader deserves to know why before they blame the
            // viewer. Absent — not empty — when there is nothing to say, so it does
            // not overwrite a message some other path set.
            ...(singleMemberArchives.length > 0
                ? {
                    message:
                        `${singleMemberArchives.length === 1 ? "This archive is" : `${singleMemberArchives.length} archives are`}` +
                        ` compressed as a single gzip stream rather than per record, so viewing a page` +
                        ` has to decompress the whole file each time. Recompressing per record, or` +
                        ` decompressing it outright, will make browsing fast.`,
                }
                : {}),
        });
    } catch (error) {
        // Records parsed before the failure are real and are kept — the batch they
        // were sitting in has not been posted yet, so it goes out before the error.
        flush();

        // A malformed record ends this FILE, not the worker — it stays alive for
        // the next handle, so one bad archive in a selection of five does not
        // cost you the other four. mwarc's WarcParseError is an Error subclass,
        // so postError reports its class through errorName without a special case.
        //
        // For a .wacz this also ends the remaining archives inside it, which is the
        // conservative choice: the records already found are posted above, and a
        // container whose third archive is malformed is more likely truncated than
        // selectively corrupt.
        //
        // `parsedOffset` here is LOGICAL on purpose, unlike every progress message
        // above. The listing renders it as "last good record at byte N", which
        // names a RECORD, and a record's position is its offset in the archive as
        // decompressed. The physical figure would point at a gzip member boundary
        // instead — a different and less useful answer to "which record died".
        //
        // For a segmented parse this ends only THIS SEGMENT. The others keep going
        // and their records are real, which is why the segment index travels with
        // the error — a file with one bad segment is not a failed file.
        postError(handle.name, "decode", error, parsedOffset, size, records, segment?.index);
    }
}

// ---------------------------------------------------------------------------
// Viewing
//
// The other half of what this worker does. Parsing streams records OUT; viewing
// pulls records IN, one url at a time, because the record index lives on the main
// thread and shipping it would cost ~408ms of blocking clone at 33k records.
//
//   main -> worker   { action: "viewRecord", id, record }
//   worker -> main   { action: "resolve",    requestId, url, nearArchived, referrer }
//   main -> worker   { action: "resolved",   requestId, record | null, reason?, redirects? }
//   worker -> main   { action: "viewProgress", id, stage, url, resolved, total }
//   worker -> main   { action: "viewed",     id, url, documentUrl, type, blobUrls, missing }
//   worker -> main   { action: "viewFatal",  id, reason, url, errorName, message }
//
// And, for requests the page itself makes at runtime through the fetch/XHR shim:
//
//   main -> worker   { action: "readRecord",      id, record }
//   worker -> main   { action: "readRecord:done", id, bytes | null }
// ---------------------------------------------------------------------------

/** In-flight resolve requests, keyed by the id the main thread echoes back. */
const pendingResolves = new Map<number, (outcome: ResolveOutcome) => void>();
let nextResolveId = 1;

/**
 * Ask the main thread for the capture of `url` nearest `nearArchived`.
 *
 * No timeout on purpose. The only way a reply never comes is the main thread
 * being gone, at which point the whole worker is going away with it — a timeout
 * would just convert that into a spurious "not archived" on a page nobody is
 * waiting for any more.
 */
const requestRecord = (viewId: number) =>
    (url: string, nearArchived: string, referrer: string): Promise<ResolveOutcome> =>
        new Promise<ResolveOutcome>(resolve => {
            const requestId = nextResolveId++;
            pendingResolves.set(requestId, resolve);

            // viewId is echoed so the main thread answers out of the record store
            // the view was STARTED from. Without it, two views in flight at once
            // would each be answered from whichever happened to be first in the
            // pending map — usually right, silently wrong when it is not.
            self.postMessage({ action: "resolve", requestId, viewId, url, nearArchived, referrer });
        });

const handleResolved = (data: {
    requestId?: number;
    record?: ViewRecord | null;
    reason?: string;
    redirects?: string[];
}) => {
    const requestId = data.requestId;
    if (typeof requestId !== "number") return;

    const settle = pendingResolves.get(requestId);
    if (!settle) return; // a late reply for a view that has already finished

    pendingResolves.delete(requestId);

    settle({
        record: data.record ?? null,
        reason: data.reason as ResolveOutcome["reason"],
        // The main thread follows redirects itself — it is the side holding the
        // index — so this arrives already walked. Kept only as the receipt.
        redirects: data.redirects,
    });
};

const handleViewRecord = async (id: number, record: ViewRecord) => {
    const result = await buildView(record, {
        resolve: requestRecord(id),
        // Minted HERE rather than on the main thread: the rewriter needs the url
        // as a string to substitute into the document, so a round trip per asset
        // just to obtain it would double the message count for no gain.
        createObjectURL: (bytes, type) => URL.createObjectURL(new Blob([bytes], { type })),

        // Not batched, unlike the parse path. Parsing emits one of these per
        // record and there are tens of thousands; a view emits one per
        // subresource, which is hundreds at the very worst, and batching would
        // trade a responsive overlay for nothing measurable.
        onProgress: (progress) => self.postMessage({ action: "viewProgress", id, ...progress }),
    });

    if (result.ok) {
        self.postMessage({
            action: "viewed",
            id,
            url: result.url,
            // The archived address of what rendered, so the main thread can name
            // it when reporting. `url` above is a blob uuid and says nothing.
            documentUrl: result.documentUrl,
            type: result.type,
            blobUrls: result.blobUrls,
            missing: result.missing,
            // What DID resolve, and to what. A url answered by the wrong record
            // is otherwise invisible: it looks like a success here and surfaces
            // much later as the browser choking on bytes, in a message with no
            // url in it.
            resolved: result.resolved,
        });
        return;
    }

    self.postMessage({
        action: "viewFatal",
        id,
        reason: result.reason,
        url: result.url,
        errorName: result.errorName,
        message: result.message,
    });
};

// ---------------------------------------------------------------------------
// Downloading a page as a zip
// ---------------------------------------------------------------------------
//
//   main -> worker   { action: "download", id, record, sink, scope, options?, limits? }
//   main -> worker   { action: "cancelDownload", id }
//   worker -> main   { action: "downloadProgress",  id, stage, url, entries, discovered, bytes }
//   worker -> main   { action: "downloadNotice",    id, kind, url, detail?, reason? }
//   worker -> main   { action: "downloaded",        id, entries, bytes, missing, notices, name?, blob? }
//   worker -> main   { action: "downloadFatal",     id, reason, url, errorName, message }
//   worker -> main   { action: "downloadCancelled", id, entries, bytes }
//
// EXACTLY ONE of downloaded / downloadFatal / downloadCancelled is sent per id,
// always. The resolve and readRecord round trips above are reused unchanged: the
// worker still cannot reach the archive, so a download looks records up the same
// way a view does.

/**
 * The bits of the File System Access API this touches.
 *
 * Declared here rather than pulled from lib.dom, which the backend tsconfig does
 * not include — see the note at the top of view.ts. The handle is the only part
 * that crosses from the main thread, because a FileSystemWritableFileStream is
 * not structured-cloneable and the handle is.
 */
interface WritableFileHandle {
    createWritable(options?: { keepExistingData?: boolean }): Promise<{
        write(data: unknown): Promise<void>;
        close(): Promise<void>;
        abort(reason?: unknown): Promise<void>;
    }>;
}

/** What a Blob will accept as a part. Same reason as above. */
type BlobPiece = string | Uint8Array | ArrayBuffer | { size: number };

interface DownloadRequest {
    action: "download";
    id?: number;
    record?: ViewRecord;
    sink?: { kind: "file"; handle: WritableFileHandle } | { kind: "blob" };
    options?: { includeRedirects?: boolean; idPolicy?: "on-collision" | "always" };
    limits?: { maxEntries?: number; maxBytes?: number };
}

/**
 * The one download this worker is running, if any.
 *
 * One at a time, deliberately. The reader picked a file for this one, and a
 * queued second would have nowhere of its own to write — so a second request is
 * refused with `busy` rather than held.
 */
let activeDownload: DownloadEntrySession | null = null;

/**
 * The state one download needs to be stoppable.
 *
 * `cancelled` is polled by writeDownload between entries; `abort` cuts across
 * whatever is compressing RIGHT NOW. Both, because they stop different things:
 * without the flag a cancel would not end the loop, and without the signal a
 * cancel arriving during a 28 MB entry waits for that entry to deflate before
 * anything visible happens.
 */
interface DownloadEntrySession {
    id: number;
    cancelled: boolean;
    abort: AbortController;
}

/**
 * Entries in flight at once, for the writer and the sink alike.
 *
 * One constant, passed to both, because they have to agree: writeDownload decides
 * how many overlap and createZipSink decides whether to stage them, and a sink
 * that thinks it is sequential while the writer runs four would drop entries.
 *
 * One, because entries are stored rather than deflated — there is no CPU work to
 * overlap, and overlapping would add a staging write per entry. See ENTRY_LEVEL
 * in download.ts.
 */
const DOWNLOAD_CONCURRENCY = 1;

const handleDownload = (data: DownloadRequest): void => {
    const id = data.id ?? 0;

    const fatal = (reason: string, url: string, error: unknown) => {
        self.postMessage({
            action: "downloadFatal", id, reason, url,
            errorName: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
        });
    };

    if (activeDownload) {
        fatal("busy", data.record?.url ?? "",
            new Error(`A download is already running (#${activeDownload.id}).`));
        return;
    }

    const record = data.record;

    if (!record) {
        fatal("unreadable", "", new TypeError("download was sent without a record."));
        return;
    }

    if (!record.payload) {
        fatal("no-payload", record.url,
            new Error("This capture stored no body, so there is nothing to save."));
        return;
    }

    const session: DownloadEntrySession = { id, cancelled: false, abort: new AbortController() };
    activeDownload = session;

    void runDownload(session, data, record)
        // The catch-all. Every branch inside runDownload reports for itself, so
        // reaching here means something threw where nothing was expected to —
        // and a download that reports nothing is an overlay stuck at 40% over a
        // file handle that never closes.
        .catch(error => fatal("write-failed", record.url, error))
        .finally(() => { if (activeDownload === session) activeDownload = null; });
};

const runDownload = async (
    session: DownloadEntrySession,
    data: DownloadRequest,
    record: ViewRecord,
): Promise<void> => {
    const id = session.id;

    let discovered = 0;
    let lastPercent = -1;

    const progress = (stage: string, url: string, entries: number, bytes: number) => {
        // Gated the way the parse and view protocols already are: an entry lands
        // every few milliseconds and a message each would swamp the port.
        const percent = discovered > 0 ? Math.floor((entries / discovered) * 100) : -1;
        if (stage === "walking" || percent !== lastPercent) {
            lastPercent = percent;
            self.postMessage({
                action: "downloadProgress", id, stage, url, entries, discovered, bytes,
            });
        }
    };

    const notice = (item: DownloadNotice) => {
        self.postMessage({ action: "downloadNotice", id, ...item });
    };

    const plan = await planDownload(record, {
        resolve: requestRecord(id),
        // A download mints no blob urls at all. Named rather than omitted so the
        // shape stays the one ViewDeps declares, and so this throws loudly if the
        // walk ever tries.
        createObjectURL: () => {
            throw new Error("A download must not mint blob urls.");
        },
        onProgress: (report) => {
            discovered = report.total;
            progress("walking", report.url, report.resolved, 0);
        },
    }, {
        includeRedirects: data.options?.includeRedirects,
        idPolicy: data.options?.idPolicy,
        maxEntries: data.limits?.maxEntries,
        maxBytes: data.limits?.maxBytes,
        // Read off the record, never looked up by url: two captures of one page
        // are two records with one url, and a url-keyed table would hand both the
        // same id.
        namer: (target) => ({
            file: target.warcFile ?? "archive",
            uuid: target.uuid ?? target.url,
        }),
        onNotice: notice,
    });

    if (!plan.ok) {
        self.postMessage({
            action: "downloadFatal", id, reason: plan.reason, url: plan.url,
            errorName: plan.errorName, message: plan.message,
        });
        return;
    }

    if (session.cancelled) {
        self.postMessage({ action: "downloadCancelled", id, entries: 0, bytes: 0 });
        return;
    }

    discovered = plan.entries.length;

    const sink = await openSink(data.sink, session.abort.signal, DOWNLOAD_CONCURRENCY);

    if (!sink) {
        self.postMessage({
            action: "downloadFatal", id, reason: "no-sink", url: record.url,
            errorName: "TypeError", message: "No writable destination was provided.",
        });
        return;
    }

    try {
        const result = await writeDownload(plan, sink.zip, {
            onProgress: (report) =>
                progress(report.stage, report.path, report.entries, report.bytes),
            cancelled: () => session.cancelled,
            onNotice: notice,
            concurrency: DOWNLOAD_CONCURRENCY,
        });

        if (result.cancelled) {
            self.postMessage({
                action: "downloadCancelled", id, entries: result.entries, bytes: result.bytes,
            });
            return;
        }

        const blob = await sink.finish?.();

        self.postMessage({
            action: "downloaded", id,
            entries: result.entries,
            bytes: result.bytes,
            missing: plan.missing,
            notices: plan.notices,
            // Where the page sits INSIDE the zip. Deliberately not called
            // `name`: it used to be, and the card then displayed
            // "…/garden.html" for a file actually saved as "….zip", because
            // the frontend preferred it over the name the reader picked.
            rootPath: plan.root.path,
            ...(blob ? { blob } : {}),
        });
    } catch (error) {
        // The write failed partway. The file is discarded rather than finalised:
        // a valid zip holding half a page is worse than none, because nothing
        // about it looks wrong.
        await sink.zip.abort(error).catch(() => undefined);

        const quota = error instanceof Error && /quota|space/i.test(error.name + error.message);

        self.postMessage({
            action: "downloadFatal", id,
            reason: quota ? "quota" : "write-failed",
            url: record.url,
            errorName: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
        });
    }
};

/** Open whichever destination the main thread chose, or null if it chose none. */
const openSink = async (
    sink: DownloadRequest["sink"],
    signal: AbortSignal,
    concurrency: number,
): Promise<{ zip: ZipSink; finish?: () => Promise<unknown> } | null> => {
    if (sink?.kind === "file") {
        // createWritable is what actually takes the lock on the file. It can fail
        // here — the file open in another program, permission revoked since the
        // picker — and that failure is the caller's to report.
        const writable = await sink.handle.createWritable();

        return {
            zip: createStoredZipSink({
                writable: writable as unknown as WritableStream<Uint8Array>,
                blob: (parts, options) => new Blob(parts as BlobPiece[], options),
                signal,
                concurrency,
            }),
        };
    }

    if (sink?.kind === "blob") {
        // No picker in this browser. The whole archive is built in memory and
        // handed back on the `downloaded` message — bounded by memory, but
        // correct, and the only option Firefox and Safari have.
        const stream = new TransformStream<Uint8Array, Uint8Array>();

        // The catch is attached HERE, at construction, not where the blob is
        // read. Cancelling aborts the writable, which rejects this promise — and
        // on the cancel path nothing ever awaits it, so the rejection was
        // unhandled. In a worker that is an uncaught error on every cancelled
        // download, loud enough to trip error reporting and mean nothing.
        //
        // Resolving to undefined rather than rethrowing: there IS no archive
        // after an abort, and the caller already knows why.
        const collected = new Response(stream.readable).blob()
            .catch(() => undefined);

        return {
            zip: createStoredZipSink({
                writable: stream.writable,
                blob: (parts, options) => new Blob(parts as BlobPiece[], options),
                signal,
                concurrency,
            }),
            finish: () => collected,
        };
    }

    return null;
};

self.onmessage = (event: { data: unknown }) => {
    const data = event.data as {
        action?: string;
        handle?: PostedHandle;
        id?: number;
        record?: ViewRecord;
        requestId?: number;
        /** "listArchives" only: the container to enumerate. */
        file?: BlobLike;
        /** "resegment" only: which segment, and the new end it may claim to. */
        segment?: number;
        end?: number;
    } | undefined;

    if (data?.action === "resolved") {
        handleResolved(data);
        return;
    }

    // A payload, raw, for the fetch/XHR shim. No rewriting: the page asked for
    // these bytes itself and is going to parse them itself, so handing back a
    // document with blob urls substituted into it would corrupt exactly the JSON
    // or text it was expecting.
    //
    // De-chunking still happens — that is transport framing, not content, and a
    // caller reading `5f\r\n...` instead of its own JSON has been handed the
    // wire, not the resource.
    if (data?.action === "readRecord") {
        const id = data.id ?? 0;
        const record = data.record;

        if (!record) {
            self.postMessage({ action: "readRecord:done", id, bytes: null });
            return;
        }

        readPayload(record)
            .then(bytes => {
                // Copied rather than transferred. A transfer list would need this
                // file's local `self` declaration widened, and these are single
                // resources a page asked for at runtime — a JSON feed, an image —
                // not the gigabyte payloads that made transfer worth having on
                // the parse path.
                const buffer = bytes.buffer.slice(
                    bytes.byteOffset,
                    bytes.byteOffset + bytes.byteLength,
                ) as ArrayBuffer;

                self.postMessage({ action: "readRecord:done", id, bytes: buffer });
            })
            .catch(() => self.postMessage({ action: "readRecord:done", id, bytes: null }));

        return;
    }

    if (data?.action === "viewRecord") {
        const id = data.id ?? 0;
        const record = data.record;

        if (!record) {
            self.postMessage({
                action: "viewFatal", id, reason: "not-archived", url: "",
                errorName: "TypeError", message: "viewRecord was sent without a record.",
            });
            return;
        }

        handleViewRecord(id, record).catch(error => {
            self.postMessage({
                action: "viewFatal", id, reason: "unreadable", url: record.url,
                errorName: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error),
            });
        });
        return;
    }

    if (data?.action === "download") {
        handleDownload(data as DownloadRequest);
        return;
    }

    if (data?.action === "cancelDownload") {
        // Silently for an unknown id: it races a download that already finished,
        // which is not an error and has nothing left to cancel.
        // Read into a local first: `activeDownload` is a mutable module binding,
        // so narrowing it through an optional chain does not survive the
        // assignment on the next line.
        const running = activeDownload;

        if (running && data.id === running.id) {
            running.cancelled = true;

            // The flag ends the loop between entries; the signal ends whatever is
            // deflating right now. Without the second one, cancelling during a
            // large entry does nothing visible until that entry finishes.
            running.abort.abort();
        }

        return;
    }

    /*
     * Enumerate the archives inside a container, so the main thread can split it
     * into one handle per archive and let its worker pool parse them in parallel.
     *
     * Answered here rather than by duplicating zip central-directory parsing on the
     * frontend: wacz.ts already does it, already validates that entries are STORED,
     * and already produces a readable message when they are not. One source of
     * truth, at the cost of one worker round trip before parsing starts.
     *
     * Only offsets and sizes cross back. The Blob slices waczArchives builds are
     * cloneable, but the main thread can cut its own from the File it already holds,
     * and shipping four of them would be four more references to the same bytes.
     */
    /*
     * Give up the tail of the segment being parsed, so an idle worker can take it.
     *
     * A REQUEST, not an instruction, and that distinction is the whole safety of
     * this. The main thread picks a cut point from a progress figure that is already
     * stale by a frame, so by the time this lands the loop may be past it. Shrinking
     * the limit is therefore all this does: the loop notices at its next record
     * boundary and answers with the offset it actually stopped at.
     *
     * Silently ignored when the segment does not match, or when nothing is being
     * claimed — both mean the segment finished on its own while the message was in
     * flight, and there is nothing left to give up.
     */
    if (data?.action === "resegment") {
        const claim = activeClaim;
        const wanted = data.end;

        if (claim && typeof wanted === "number" && claim.index === data.segment) {
            // Never grows. A higher `end` than we already hold would be the main
            // thread handing back a range it has given to somebody else.
            claim.limit = Math.min(claim.limit, wanted);
        }

        return;
    }

    if (data?.action === "listArchives") {
        const file = data.file;
        const id = data.id;

        if (!file) {
            self.postMessage({ action: "archives", id, error: "no file posted" });
            return;
        }

        (async () => {
            if (!(await looksZipped(file))) {
                // Not a container. An empty list means "parse it as one file",
                // which is what the caller does with it.
                self.postMessage({ action: "archives", id, archives: [] });
                return;
            }

            const archives = await waczArchives(file);

            self.postMessage({
                action: "archives",
                id,
                archives: archives.map(archive => ({
                    name: archive.name,
                    dataOffset: archive.dataOffset,
                    size: archive.size,
                })),
            });
        })().catch(error => {
            // Reported, not thrown. A container we cannot enumerate is still worth
            // handing to the parser as a single file — it will fail there with the
            // same message, in the place the UI already shows failures.
            self.postMessage({
                action: "archives",
                id,
                error: error instanceof Error ? error.message : String(error),
            });
        });

        return;
    }

    if (data?.action !== "parseStream") return;

    const handle = data.handle;

    if (!handle?.file) {
        postError(
            handle?.name ?? "(unknown file)",
            "handle",
            new TypeError(
                "handle.file is missing — the File itself must be posted, not a read function. " +
                "structured clone throws DataCloneError on a function, so a closure never survives postMessage.",
            ),
            0,
            handle?.size ?? 0,
            0,
        );
        return;
    }

    // Nothing above can throw, but parseStream's own rejection would otherwise
    // be an unhandled promise inside a worker — invisible from the page, and the
    // file would sit at "Parsing" forever with no message ever arriving.
    parseStream(handle).catch(error => {
        postError(handle.name, "decode", error, handle.parsedOffset ?? 0, handle.size ?? 0, 0);
    });
};
