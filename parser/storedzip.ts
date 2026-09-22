/**
 * A zip writer that only knows how to STORE.
 *
 * ## Why this exists next to zip.js
 *
 * Nothing in a download is compressed. zipsink.ts already turns deflate off, and
 * with it off zip.js is a general-purpose library doing a specific job: read a
 * blob, CRC it, write a header, write the bytes. Everything else it carries —
 * the reader/writer abstractions, the entry queue, the temp-stream staging, the
 * worker pool, the encryption, the deflate engines — is machinery for the case
 * that no longer applies.
 *
 * The zip format is cooperative about this. An entry stored with method 0 is:
 *
 *     local file header
 *     the bytes, unchanged
 *     data descriptor          (when the crc is not known in advance)
 *
 * and the archive is those, back to back, followed by a central directory that
 * repeats each header with its offset. That is the whole specification for what
 * this file does, and it is short enough to write out rather than depend on.
 *
 * ## What it buys, and what it costs
 *
 * See storedzip.bench.ts for the numbers rather than a claim. The costs are
 * stated up front: zip64 and the data descriptor are hand-rolled here, and a zip
 * that is subtly wrong still opens in most readers — which is why the tests
 * validate every archive with Python's zipfile, an implementation with no shared
 * code or shared assumptions.
 *
 * ## What it deliberately does not do
 *
 * No compression, no encryption, no zip comments, no directory entries, no
 * out-of-order writing. A caller that needs any of those wants zip.js.
 */

import { crc32 } from "./crc32";

/* ---- the four-byte signatures, from APPNOTE.TXT ------------------------- */

const LOCAL_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const ZIP64_END_OF_CENTRAL = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;

/** Zip64 extended information, the only extra field written here. */
const ZIP64_EXTRA_ID = 0x0001;

/* ---- flags and versions ------------------------------------------------- */

/** Bit 3: the sizes and crc follow the data instead of preceding it. */
const FLAG_DESCRIPTOR = 0x0008;

/**
 * Bit 11: the name is UTF-8.
 *
 * Always set. The alternative is CP437, which cannot spell most of the paths in
 * a web archive — and an archived url is exactly where a non-ASCII byte turns up.
 */
const FLAG_UTF8 = 0x0800;

const VERSION_STORE = 20;
const VERSION_ZIP64 = 45;

/** Method 0. The one this file implements. */
const METHOD_STORE = 0;

/*
 * The sentinels that mean "the real value is in the zip64 extra field".
 *
 * Fixed by the format, and therefore SEPARATE from the threshold below. Writing
 * the threshold into these fields instead is a mistake that survives casual
 * testing: at the real 0xFFFFFFFF the two happen to be the same number, so it
 * only shows up when the threshold is lowered — where it produced "Bad magic
 * number for file header", because an offset field reading 64 sent the reader
 * looking for a local header at byte 64.
 */
const SENTINEL_32 = 0xffffffff;
const SENTINEL_16 = 0xffff;

/**
 * When to switch an entry to zip64.
 *
 * Injectable in tests. A file has to exceed four gigabytes to take the zip64
 * path, so testing it honestly would mean writing four gigabytes; lowering the
 * threshold instead exercises the same branches on a hundred bytes.
 */
export interface StoredZipLimits {
    /** Sizes and offsets at or above this go to a zip64 extra field. */
    maxSize: number;
    /** Entry counts at or above this need a zip64 end record. */
    maxEntries: number;
}

const DEFAULT_LIMITS: StoredZipLimits = {
    maxSize: 0xffffffff,
    maxEntries: 0xffff,
};

/**
 * How much of an entry is read at once.
 *
 * 1 MB, matching the chunkSize zipsink.ts configures zip.js with, so the two are
 * comparable. Bigger chunks mean fewer awaits and fewer writes per megabyte;
 * smaller ones mean less memory in flight. The benchmark sweeps this.
 */
const CHUNK = 1024 * 1024;

/**
 * The bit of Blob/File this module touches; the backend tsconfig has no DOM lib.
 *
 * Same reason gzip.ts and view.ts each declare their own: with `lib: ["ESNext"]`
 * the ambient `Blob` is Bun's, and Bun's does not even declare `slice`. A local
 * structural type is what lets a real File, a BunFile and a test double all pass
 * without any of them being imported from anywhere.
 */
export interface ZipSource {
    readonly size: number;
    slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
    stream(): ReadableStream<Uint8Array>;
    /**
     * True when `slice` cannot answer an arbitrary range.
     *
     * A file can be read at any offset; a DECODED view of one often cannot. The
     * case this exists for is a chunked HTTP body, where the bytes in the archive
     * are interleaved with chunk-length lines: byte 5,000 of the decoded body is
     * at no computable offset in the stored bytes, so the only way to reach it is
     * to walk the framing from the start.
     *
     * Such a source implements `stream()` and nothing else, and the reader below
     * takes that path regardless of the configured strategy. Marked on the source
     * rather than chosen per call because it is a property of the data, and a
     * chunkSize sweep should not be able to turn it into a bug.
     */
    readonly sequential?: boolean;
}

/** One entry to store. `data.size` is read before anything else. */
export interface StoredZipEntry {
    /** Path inside the archive. Forward slashes, no leading slash. */
    name: string;
    /** The bytes, unread. A Blob, a BunFile, or a File — anything sliceable. */
    data: ZipSource;
    lastModDate?: Date;
    /**
     * The crc, if it is already known.
     *
     * The interesting optimisation, and the one this signature exists to allow:
     * with the crc known there is nothing to compute while streaming and no data
     * descriptor to write, so the hot path is header, bytes, header, bytes. The
     * WARC index is the natural place to keep it — it is already touching every
     * payload once, at parse time, and a download reads the same bytes again.
     */
    crc32?: number;
}

/** What the central directory has to remember about an entry until close. */
interface WrittenEntry {
    name: Uint8Array;
    crc: number;
    size: number;
    offset: number;
    modified: number;
    time: number;
    zip64: boolean;
    descriptor: boolean;
}

const encoder = new TextEncoder();

/* ---- little-endian writing --------------------------------------------- */

/**
 * A fixed-size record, built once and written whole.
 *
 * Deliberately not a stream of small writes: a local header is 30 bytes plus a
 * name, and pushing that through a WritableStream in six pieces is six awaits
 * and six chunks on the wire for something that fits in one.
 */
const record = (length: number) => {
    const bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    let at = 0;

    return {
        u16: (value: number) => { view.setUint16(at, value, true); at += 2; },
        u32: (value: number) => { view.setUint32(at, value >>> 0, true); at += 4; },
        u64: (value: number) => { view.setBigUint64(at, BigInt(value), true); at += 8; },
        bytes: (source: Uint8Array) => { bytes.set(source, at); at += source.length; },
        done: () => {
            // A record that is not exactly full is a record whose length was
            // computed wrong, and the resulting zip would be unreadable in a way
            // that points nowhere near here.
            if (at !== length) throw new Error(`storedzip: wrote ${at} of ${length} bytes`);
            return bytes;
        },
    };
};

/** MS-DOS date and time, which is what a zip's mtime field holds. */
const dosDateTime = (date: Date): { date: number; time: number } => {
    const year = date.getFullYear();

    // 1980 is the epoch, and there is no representation for anything before it.
    if (year < 1980) return { date: 0x0021, time: 0 };

    return {
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    };
};

/* ---- sizes, so Content-Length can be known in advance ------------------ */

/*
 * A zip64 entry ALWAYS carries the extra field in its local header, descriptor or
 * not: the 32-bit size fields hold a sentinel, and the extra is the only place
 * the real value can be. Writing the sentinel without the field is what made a
 * known-crc zip64 entry unreadable — the sizes pointed nowhere.
 */
const localHeaderSize = (name: Uint8Array, zip64: boolean): number =>
    30 + name.length + (zip64 ? 4 + 8 + 8 : 0);

const descriptorSize = (zip64: boolean): number => (zip64 ? 24 : 16);

const centralHeaderSize = (name: Uint8Array, zip64: boolean): number =>
    46 + name.length + (zip64 ? 4 + 8 + 8 + 8 : 0);

/**
 * Exactly how many bytes the archive will be, before writing any of them.
 *
 * Possible only because nothing is compressed: every entry contributes its own
 * size plus a header whose length is a function of its name. That makes
 * `Content-Length` available on the response, which turns a download with an
 * unknown duration into one with a progress bar.
 *
 * Requires the crc for every entry — without it the entry needs a data
 * descriptor, which is still a known size, so the total is computable either
 * way; this returns the honest figure for whichever mode each entry will use.
 */
export const storedZipSize = (
    entries: readonly StoredZipEntry[],
    limits: StoredZipLimits = DEFAULT_LIMITS,
): number => {
    let total = 0;
    let central = 0;
    let anyZip64 = false;

    for (const entry of entries) {
        const name = encoder.encode(entry.name);
        const descriptor = entry.crc32 === undefined;
        const zip64 = entry.data.size >= limits.maxSize || total >= limits.maxSize;

        anyZip64 ||= zip64;

        total += localHeaderSize(name, zip64) + entry.data.size
            + (descriptor ? descriptorSize(zip64) : 0);

        central += centralHeaderSize(name, zip64);
    }

    const needsZip64End = anyZip64
        || entries.length >= limits.maxEntries
        || total >= limits.maxSize
        || central >= limits.maxSize;

    return total + central + (needsZip64End ? 56 + 20 : 0) + 22;
};

/* ---- reading an entry -------------------------------------------------- */

/**
 * An entry's bytes, a chunk at a time, one chunk read ahead.
 *
 * The lookahead is the point. Without it the pipeline alternates — read, wait,
 * write, wait — and the socket sits idle for the length of every read. With one
 * chunk in flight the next read overlaps the current write, which is as much
 * concurrency as a sequential zip stream can use: the output has one position
 * and one crc, so there is nothing further to parallelise.
 *
 * Deeper than one buys little and costs memory per concurrent download. The
 * benchmark sweeps it.
 */
const chunksOf = async function* (
    data: ZipSource,
    chunkSize: number,
    lookahead: number,
    read: ReadStrategy,
): AsyncGenerator<Uint8Array> {
    const size = data.size;

    if (size === 0) return;

    /*
     * The source's own stream, when asked for.
     *
     * Worth having as an option rather than a preference: `slice().arrayBuffer()`
     * gives exact control over chunk size and read-ahead, and `stream()` gives
     * the platform's own reader — which for a file-backed source may hold one
     * handle open across the whole entry instead of resolving a range per chunk.
     * Which of those wins is a property of the environment, not of this file, so
     * storedzip.bench.ts measures both. See its "from disk" section.
     */
    /*
     * `sequential` overrides the strategy, and is not merely a default.
     *
     * A source that cannot seek has no `slice` worth calling; honouring
     * `read: "slice"` for one would read the wrong bytes rather than fail, which
     * is the worst of the available outcomes.
     */
    if (read === "stream" || data.sequential === true) {
        const reader = data.stream().getReader();

        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value.length > 0) yield value;
            }
        } finally {
            reader.releaseLock();
        }

        return;
    }

    /*
     * The width each read was ASKED for, carried alongside it.
     *
     * Kept because a read is not required to hand back the width it was asked
     * for, and this generator is the only place that still knows what that width
     * was. See the trim below.
     */
    const pending: { want: number; buffer: Promise<ArrayBuffer> }[] = [];
    let next = 0;

    const fill = () => {
        while (pending.length <= lookahead && next < size) {
            const from = next;
            const to = Math.min(from + chunkSize, size);
            next = to;
            pending.push({ want: to - from, buffer: data.slice(from, to).arrayBuffer() });
        }
    };

    fill();

    while (pending.length > 0) {
        const { want, buffer } = pending.shift()!;
        const chunk = await buffer;

        fill();

        /*
         * Trimmed to what was asked for, because a slice can hand back MORE.
         *
         * `Blob.slice(a, b).arrayBuffer()` returns exactly b-a bytes in the
         * browser, and this generator was written against that guarantee. Bun
         * reading a file over a Docker Desktop bind mount on Windows does not
         * honour it: a read wider than 64 KiB comes back rounded up to the next
         * multiple of 65,512, so a 94,840-byte payload arrives as 131,024. The
         * leading bytes are correct — it is purely an over-read past the end of
         * the requested range.
         *
         * Untrimmed, those extra bytes went straight into the archive. The entry
         * then overran the length already written into its local header, the
         * `streamed !== size` guard below caught it, and the whole download died
         * on the first payload over 64 KiB — a 19 MB zip arriving as 131 KB.
         *
         * A view, not a copy: no bytes move.
         *
         * Deliberately only an upper bound. A read that comes back SHORT still
         * yields short and still trips the guard below, because that is a real
         * truncation and the archive must not claim otherwise.
         */
        yield new Uint8Array(chunk, 0, Math.min(chunk.byteLength, want));
    }
};

/**
 * How an entry's bytes are pulled out of its Blob.
 *
 * `slice` reads explicit ranges, which is what zip.js's BlobReader does and what
 * makes chunkSize and lookahead mean anything. `stream` hands the job to the
 * platform. Measured, not assumed — see storedzip.bench.ts.
 */
export type ReadStrategy = "slice" | "stream";

export interface StoredZipOptions {
    limits?: StoredZipLimits;
    chunkSize?: number;
    /** Chunks kept in flight beyond the one being written. Default 1. */
    lookahead?: number;
    /** @defaultValue "slice" */
    read?: ReadStrategy;
    /**
     * The total, once the archive is finished. Only fired on success.
     *
     * For the one thing a caller cannot check any other way: a route that has
     * already promised a `Content-Length` can compare it against what was
     * actually written. That cannot repair the response — the header left long
     * ago — but it turns a client-side "network error" into a server-side log
     * with the entry list still in scope.
     */
    onFinish?: (written: number) => void;
}

/* ---- the writer -------------------------------------------------------- */

/**
 * An open stored zip, written one entry at a time.
 *
 * Incremental rather than iterable-driven because that is the shape the download
 * path needs: entries are chosen and their tokens resolved one at a time, in plan
 * order, and the caller wants each `add` to resolve when that entry is actually
 * in the archive. See storedsink.ts.
 *
 * Every `add` is SERIALISED against the ones before it, whatever the caller does.
 * A zip has one write position and each header records where its entry starts, so
 * two entries cannot be in flight without buffering one — that buffering is
 * exactly what zip.js's temp-stream staging exists to manage, and with nothing to
 * compress there is nothing to overlap. Queueing here rather than trusting the
 * caller means a concurrency setting somewhere else cannot corrupt an archive; it
 * just fails to make it faster.
 */
export interface StoredZipWriter {
    /** Resolves once the entry's bytes and trailer are on the wire. */
    add(entry: StoredZipEntry): Promise<void>;
    /** Writes the central directory and closes the output. Returns total bytes. */
    close(): Promise<number>;
    /** Discards. A truncated-but-finalised zip looks complete, so never close. */
    abort(reason?: unknown): Promise<void>;
}

export const createStoredZipWriter = (
    writable: WritableStream<Uint8Array>,
    options: StoredZipOptions = {},
): StoredZipWriter => {
    const limits = options.limits ?? DEFAULT_LIMITS;
    const chunkSize = options.chunkSize ?? CHUNK;
    const lookahead = options.lookahead ?? 1;
    const read = options.read ?? "slice";

    const writer = writable.getWriter();
    const written: WrittenEntry[] = [];

    let at = 0;
    let closed = false;

    /** The serialisation. Every add chains onto whatever is already queued. */
    let queue: Promise<unknown> = Promise.resolve();

    const put = async (bytes: Uint8Array) => {
        // `ready` is the backpressure. Without it a fast source and a slow socket
        // queue the whole archive in the stream's internal buffer, which is the
        // memory this design exists to avoid.
        await writer.ready;
        await writer.write(bytes);
        at += bytes.length;
    };

    const writeEntry = async (entry: StoredZipEntry): Promise<void> => {
        const name = encoder.encode(entry.name);
        const size = entry.data.size;
        const known = entry.crc32;
        const descriptor = known === undefined;
        const zip64 = size >= limits.maxSize || at >= limits.maxSize;
        const modified = dosDateTime(entry.lastModDate ?? new Date());
        const offset = at;

        const header = record(localHeaderSize(name, zip64));

        header.u32(LOCAL_HEADER);
        header.u16(zip64 ? VERSION_ZIP64 : VERSION_STORE);
        header.u16(FLAG_UTF8 | (descriptor ? FLAG_DESCRIPTOR : 0));
        header.u16(METHOD_STORE);
        header.u16(modified.time);
        header.u16(modified.date);

        /*
         * Three ways to fill these in, and they are not interchangeable.
         *
         * Descriptor mode zeroes them: that is what bit 3 means, and a reader
         * that ignores the flag sees an empty entry rather than a corrupt one.
         * A known crc writes the real values. And zip64 replaces the two size
         * fields with a sentinel, with the true 8-byte figures in the extra
         * field below.
         */
        header.u32(descriptor ? 0 : known!);
        header.u32(descriptor ? 0 : (zip64 ? SENTINEL_32 : size));
        header.u32(descriptor ? 0 : (zip64 ? SENTINEL_32 : size));

        header.u16(name.length);
        header.u16(zip64 ? 4 + 8 + 8 : 0);
        header.bytes(name);

        if (zip64) {
            header.u16(ZIP64_EXTRA_ID);
            header.u16(16);
            // Zeros in descriptor mode, for the same reason the 32-bit fields
            // are zero: the sizes are not known yet and the descriptor is
            // where they will be.
            header.u64(descriptor ? 0 : size);
            header.u64(descriptor ? 0 : size);
        }

        await put(header.done());

        let crc = 0;
        let streamed = 0;

        for await (const chunk of chunksOf(entry.data, chunkSize, lookahead, read)) {
            // Skipped entirely when the crc was known: this is the only work
            // the download does over the bytes, so not doing it is the whole
            // value of keeping a crc in the index.
            if (descriptor) crc = crc32(chunk, crc);

            streamed += chunk.length;
            await put(chunk);
        }

        /*
         * A Blob whose size disagrees with what it produced.
         *
         * Worth catching rather than trusting: the sizes are already in the
         * headers by now, and a zip whose central directory does not match its
         * data is the kind of corruption that survives being opened.
         */
        if (streamed !== size) {
            throw new Error(
                `storedzip: ${entry.name} declared ${size} bytes and produced ${streamed}`);
        }

        if (descriptor) {
            const trailer = record(descriptorSize(zip64));

            trailer.u32(DATA_DESCRIPTOR);
            trailer.u32(crc);

            if (zip64) {
                trailer.u64(streamed);
                trailer.u64(streamed);
            } else {
                trailer.u32(streamed);
                trailer.u32(streamed);
            }

            await put(trailer.done());
        }

        written.push({
            name,
            crc: descriptor ? crc : known!,
            size,
            offset,
            modified: modified.date,
            time: modified.time,
            zip64,
            descriptor,
        });
    };

    const finalise = async (): Promise<number> => {

        const centralAt = at;

        for (const entry of written) {
            const zip64 = entry.zip64 || entry.offset >= limits.maxSize;
            const central = record(centralHeaderSize(entry.name, zip64));

            central.u32(CENTRAL_HEADER);
            // Version made by: 45 or 20, and 0 for "MS-DOS" as the host system,
            // which is what every writer uses for a portable archive.
            central.u16(zip64 ? VERSION_ZIP64 : VERSION_STORE);
            central.u16(zip64 ? VERSION_ZIP64 : VERSION_STORE);
            central.u16(FLAG_UTF8 | (entry.descriptor ? FLAG_DESCRIPTOR : 0));
            central.u16(METHOD_STORE);
            central.u16(entry.time);
            central.u16(entry.modified);
            central.u32(entry.crc);
            central.u32(zip64 ? SENTINEL_32 : entry.size);
            central.u32(zip64 ? SENTINEL_32 : entry.size);
            central.u16(entry.name.length);
            central.u16(zip64 ? 4 + 8 + 8 + 8 : 0);
            central.u16(0);   // no comment
            central.u16(0);   // disk 0
            central.u16(0);   // internal attributes
            central.u32(0);   // external attributes
            central.u32(zip64 ? SENTINEL_32 : entry.offset);
            central.bytes(entry.name);

            if (zip64) {
                central.u16(ZIP64_EXTRA_ID);
                central.u16(24);
                central.u64(entry.size);
                central.u64(entry.size);
                central.u64(entry.offset);
            }

            await put(central.done());
        }

        const centralSize = at - centralAt;

        /* ---- end records ---- */

        const needsZip64End = written.some(entry => entry.zip64)
            || written.length >= limits.maxEntries
            || centralAt >= limits.maxSize
            || centralSize >= limits.maxSize;

        if (needsZip64End) {
            const end = record(56);

            end.u32(ZIP64_END_OF_CENTRAL);
            end.u64(44);                    // size of this record, less 12
            end.u16(VERSION_ZIP64);
            end.u16(VERSION_ZIP64);
            end.u32(0);                     // this disk
            end.u32(0);                     // disk with the central directory
            end.u64(written.length);
            end.u64(written.length);
            end.u64(centralSize);
            end.u64(centralAt);

            await put(end.done());

            const locator = record(20);

            locator.u32(ZIP64_LOCATOR);
            locator.u32(0);
            locator.u64(centralAt + centralSize);
            locator.u32(1);                 // total disks

            await put(locator.done());
        }

        const end = record(22);

        end.u32(END_OF_CENTRAL);
        end.u16(0);
        end.u16(0);

        /*
         * Sentinels when zip64 is in play: 0xFFFF and 0xFFFFFFFF are how the
         * classic record says "the real value is in the zip64 record above". A
         * reader too old to know that sees a plausible-looking empty archive
         * rather than a corrupt one.
         */
        const count = Math.min(written.length, SENTINEL_16);

        end.u16(count);
        end.u16(count);
        end.u32(centralSize >= limits.maxSize ? SENTINEL_32 : centralSize);
        end.u32(centralAt >= limits.maxSize ? SENTINEL_32 : centralAt);
        end.u16(0);                         // no archive comment

        await put(end.done());

        await writer.close();

        return at;
    };

    const fail = async (reason?: unknown): Promise<void> => {
        closed = true;

        // The writer, not the stream: aborting through the writer is what
        // propagates to whatever is reading, and it is already broken by now.
        try { await writer.abort(reason); } catch { /* already gone */ }
    };

    return {
        add: (entry) => {
            if (closed) return Promise.reject(new Error("storedzip: writer is closed"));

            const next = queue.then(() => writeEntry(entry));

            // The QUEUE swallows, the CALLER does not. Without this a rejected
            // add poisons every later one with the same error, and the entry that
            // actually failed is reported once for each entry that followed it.
            queue = next.catch(() => undefined);

            return next;
        },

        close: () => {
            if (closed) return Promise.reject(new Error("storedzip: writer is closed"));

            const done = queue.then(finalise);
            queue = done.catch(() => undefined);

            return done.then(total => { closed = true; return total; });
        },

        abort: (reason) => fail(reason),
    };
};

/**
 * Write a whole set of entries and close, in one call.
 *
 * The convenience form, and what the tests and the benchmark drive. Note the
 * abort on failure: the headers for earlier entries are already on the wire by
 * the time a later one fails, so finalising would produce a valid zip with a hole
 * in it.
 */
export const writeStoredZip = async (
    writable: WritableStream<Uint8Array>,
    entries: AsyncIterable<StoredZipEntry> | Iterable<StoredZipEntry>,
    options: StoredZipOptions = {},
): Promise<number> => {
    const zip = createStoredZipWriter(writable, options);

    try {
        for await (const entry of entries) await zip.add(entry);

        return await zip.close();
    } catch (error) {
        await zip.abort(error);
        throw error;
    }
};

/**
 * The same thing as something a Response can be constructed from.
 *
 * The generator form rather than a pull-based ReadableStream on purpose: the
 * writer above is a straight line of awaits, and expressing it as `pull()`
 * callbacks would mean hand-rolling a state machine across entry boundaries for
 * no gain — the transform's own queue provides the backpressure either way.
 */
export const createStoredZipStream = (
    entries: AsyncIterable<StoredZipEntry> | Iterable<StoredZipEntry>,
    options: StoredZipOptions = {},
): ReadableStream<Uint8Array> => {
    const pipe = new TransformStream<Uint8Array, Uint8Array>();

    void writeStoredZip(pipe.writable, entries, options)
        .then(written => { options.onFinish?.(written); })
        .catch((error: unknown) => {
            /*
             * LOGGED, not swallowed.
             *
             * The consumer does learn about this — the stream errors, so a reader
             * sees a truncated body — but that is all it learns. From the outside a
             * mid-write failure is indistinguishable from a network hiccup: the
             * browser saves a partial file and says "the compressed folder is
             * invalid", and the server says nothing at all.
             *
             * This cost hours once. The archive had aborted three entries in and
             * every layer downstream reported the symptom rather than the cause,
             * because the only place that knew was this catch block, and it was
             * empty.
             *
             * onFinish deliberately does NOT fire here: it exists to confirm a
             * length, and there is no length to confirm for an abandoned archive.
             */
            /*
             * Worded for both cases, because they arrive here identically: a
             * genuine write failure, and a reader that hung up. Either way the
             * archive stops mid-stream, and either way the only place that knows
             * why is this line.
             */
            console.error(
                "storedzip: the archive did not complete, so what reached the client "
                + "is a truncated zip. Reason (undefined means the reader cancelled):",
                error);
        });

    return pipe.readable;
};
