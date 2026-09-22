/**
 * The zip.js half of a download.
 *
 * Kept apart from download.ts so that everything with a decision in it — paths,
 * duplicates, redirect stubs, token substitution — is testable without the
 * library, and so that the failure modes that matter can be simulated. This file
 * is the only place zip.js is named.
 *
 * Two sinks, one interface. A file handle streams to disk and never holds the
 * archive in memory; a blob builds it up and hands it back at the end, for
 * browsers with no save picker.
 */

import {
    BlobReader,
    ZipWriter,
    configure,
    createSyncAccessHandleTempStream,
    createOPFSTempStream,
    type TempStream,
} from "@zip.js/zip.js";
import { readPayload, type ViewRecord } from "./view";
import type { ZipContent, ZipEntryOptions, ZipSink } from "./download";

/**
 * zip.js spawns its own workers for deflate unless told not to.
 *
 * Told not to. This already runs inside a worker that Bun bundles, and a nested
 * worker url is the kind of thing that resolves in dev and breaks in the bundle.
 * Native CompressionStream does the same job without a second bundling story,
 * and it is the default engine anyway.
 *
 * "Same thread" is not quite right and the distinction now matters: a
 * CompressionStream does its deflate in native code off the JS thread, which is
 * what makes running several of them at once worth doing at all.
 *
 * Called once at module load rather than per download: configure is global, and
 * calling it repeatedly would tear down and rebuild the pool between downloads.
 */
configure({
    useWebWorkers: false,
    useCompressionStream: true,

    /*
     * 1 MB instead of the 64 KB default.
     *
     * This is the size of the pieces an entry travels through the pipeline in.
     * Nothing is compressed any more, so a big entry is a read, a CRC and a
     * write — pure per-chunk overhead, paid 450 times for the 28.8 MB entry in
     * the measured corpus and 29 times at this size.
     *
     * Costs nothing on small entries, which are most of them: a chunk is never
     * bigger than the data, and 54% of responses are under 16 KB. At concurrency
     * 1 there is exactly one of these in flight.
     */
    chunkSize: 1024 * 1024,
});

/** Minimal shape of the Blob constructor, so this file names no DOM global. */
type BlobFactory = (parts: unknown[], options?: { type?: string }) => unknown;

/**
 * Where a buffered entry's compressed bytes live while it waits its turn.
 *
 * Writing entries in parallel means zip.js has to stage each one somewhere until
 * the entry ahead of it has finished — `bufferedWrite` is forced on the moment
 * more than one entry is in flight. Staging in memory is the default and is what
 * made parallelism look unaffordable when this file was first written.
 *
 * It is not the only option. `createTempStream` decides where the staging goes,
 * and `createSyncAccessHandleTempStream` puts it in OPFS via
 * `FileSystemSyncAccessHandle` — the fastest disk-backed staging on the platform,
 * and available only inside a dedicated worker, which is exactly what this is.
 * Entries under its threshold (1 MB by default) stay in memory anyway; measured
 * across four archives that is 97.4% of them, so the spill path is reserved for
 * the 2.6% where it matters.
 *
 * Three tiers, because none of this is guaranteed to exist. The builder throws in
 * an unsupported context rather than failing later, so the probe is the
 * construction itself. Falling all the way through leaves zip.js staging in
 * memory, which is bounded by the concurrency cap and is what it did before.
 */
const resolveTempStream = (): (() => TempStream | Promise<TempStream>) | undefined => {
    try {
        return createSyncAccessHandleTempStream();
    } catch { /* not a dedicated worker, or no OPFS */ }

    try {
        return createOPFSTempStream();
    } catch { /* no OPFS at all */ }

    return undefined;
};

/**
 * Probed once, on first use — NOT at module load.
 *
 * Deliberate. This module is bundled into the parser worker, so anything it does
 * at import time runs before the first byte of the first WARC is read. A download
 * dependency has already taken parsing down once that way, when zip.js's
 * `import.meta.url` made the whole bundle unparseable; the lesson was not "catch
 * that one error" but "do not let the download path run at import time at all".
 *
 * The answer cannot change within a session, and the sync-access variant opens a
 * handle per staged entry rather than per factory, so caching it costs nothing.
 */
let tempStream: (() => TempStream | Promise<TempStream>) | undefined;
let tempStreamProbed = false;

const getTempStream = () => {
    if (!tempStreamProbed) {
        tempStreamProbed = true;
        tempStream = resolveTempStream();
    }

    return tempStream;
};

export interface ZipSinkDeps {
    /** Where the bytes go. A FileSystemWritableFileStream, or a blob writer. */
    writable: WritableStream<Uint8Array>;
    /** Injected for the same reason view.ts injects createObjectURL: no globals. */
    blob: BlobFactory;
    /**
     * Cancels work already inside the writer.
     *
     * Without it a cancel has to wait for the entry being written to finish
     * before the abort is seen — on a 28 MB entry that is a visible pause between
     * pressing Cancel and the card saying so.
     */
    signal?: AbortSignal;
    /**
     * How many entries writeDownload will have in flight. Must match the value it
     * is given, because it is what decides whether staging is needed at all.
     *
     * @defaultValue 1
     */
    concurrency?: number;
}

/**
 * Wrap a writable in the interface download.ts writes through.
 *
 * The interesting part is `add`. A text entry is a string zip.js can take
 * directly. A binary entry is NOT read here — the record is sliced out of the
 * WARC and handed over as a Blob, so zip.js streams it and the bytes never exist
 * as one buffer. That is the difference between a 200 MB download costing 200 MB
 * of memory and costing almost none.
 */
export const createZipSink = (deps: ZipSinkDeps): ZipSink => {
    /*
     * Staging follows the concurrency, and by default there is none.
     *
     * More than one entry in flight forces zip.js to hold each one until the entry
     * ahead of it lands. That was worth paying for when entries were deflated —
     * `createTempStream` puts the held bytes on disk instead of in memory, so
     * parallel compression cost no RAM. With every entry stored it buys nothing
     * and costs a second write per entry, so at concurrency 1 the writer goes
     * straight through: WARC slice → CRC → output, one pass.
     *
     * Both stated rather than left to zip.js's own inference, so the file says
     * what it is doing.
     */
    const parallel = (deps.concurrency ?? 1) > 1;
    const staging = parallel ? getTempStream() : undefined;

    const writer = new ZipWriter(deps.writable, {
        bufferedWrite: parallel,
        ...(staging ? { createTempStream: staging } : {}),
        /*
         * Entries may land in whatever order they finish, when several can be in
         * flight. Physical order inside a zip is not meaningful to anything that
         * reads this one: paths are absolute within the archive, the manifest
         * names them explicitly, and every extractor works from the central
         * directory. Pointless at concurrency 1, where there is only ever one
         * candidate to write next.
         */
        keepOrder: !parallel,
        /*
         * Now MORE important than it was, not less: nothing is compressed, so the
         * archive is 1.56x the size it would have been (see ENTRY_LEVEL), and 4 GB
         * is that much closer.
         */
        zip64: true,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });

    return {
        add: async (path, content: ZipContent, options: ZipEntryOptions = {}) => {
            const reader = content.kind === "text"
                ? new BlobReader(deps.blob([content.text], { type: "text/plain" }) as Blob)
                : new BlobReader(await sliceOf(content.record, deps));

            return writer.add(path, reader, {
                lastModDate: options.lastModDate,
                level: options.level,
            });
        },

        // Closes the underlying writable too — preventClose defaults to false —
        // so nothing else should close it afterwards.
        close: () => writer.close(),

        abort: async (reason) => {
            // The ZipWriter first, so it stops trying to write into a stream that
            // is about to go away, then the stream itself. Both wrapped: aborting
            // something already broken is not a new problem, and the caller is
            // already on its way to reporting the original failure.
            try { await writer.close(undefined, { preventClose: true }); } catch { /* ignore */ }
            try { await deps.writable.abort(reason); } catch { /* ignore */ }
        },
    };
};

/**
 * The bytes of one record, as a Blob, read once.
 *
 * A non-chunked body is a plain slice of the WARC — no copy at all, and zip.js
 * reads it lazily. A chunked one has to be de-chunked first, which means it does
 * become a buffer; there is no way around that, and chunked bodies are the
 * minority.
 */
const sliceOf = async (record: ViewRecord, deps: ZipSinkDeps): Promise<Blob> => {
    const payload = record.payload;

    if (!payload) return deps.blob([]) as Blob;

    const chunked = payload.chunks !== undefined && payload.chunks.length > 0;

    if (!chunked) {
        return record.file.slice(payload.offset, payload.offset + payload.size) as unknown as Blob;
    }

    return deps.blob([await readPayload(record)]) as Blob;
};
