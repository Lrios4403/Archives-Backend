// Reading a record-compressed .warc.gz as if it were a plain .warc.
//
// A .warc.gz is not one gzip stream. It is one gzip MEMBER per record,
// concatenated — that is what the WARC spec's record-at-a-time compression means,
// and it is the only reason random access is possible at all. Verified on real
// Browsertrix output: rec-…-0.warc.gz is 1,624 members and 1,624 records, every
// record starting exactly on a member boundary.
//
// Two things live here, and they are deliberately different shapes because
// indexing and retrieval have opposite access patterns:
//
//   createGzipWarcReader()   forward, whole file, stateful — feeds mWarcDecode
//   readGzipPayloadSlice()   one member, cold, stateless  — serves one payload
//
// See fflate.warc.gz.md for the measurements behind every constant in this file.

import { Gunzip, gunzipSync } from "fflate";

/**
 * The bit of Blob/File this module touches.
 *
 * Declared here rather than imported from view.ts, which declares its own: view.ts
 * imports from this file, so importing back would be a cycle. Structural typing
 * makes the two interchangeable at every call site, so the duplication costs
 * nothing and buys an acyclic graph.
 */
export interface BlobLike {
    readonly size: number;
    slice(start?: number, end?: number): BlobLike;
    arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Bytes of decoded history the reader keeps behind the consumer.
 *
 * Sized to mwarc's FRAMING_BLOCK_SIZE, because the chunked-framing cursor is the
 * only thing in the parser that seeks backward by more than an unconsumed buffer
 * tail, and it never re-reads further back than one of its own blocks. Measured
 * worst case across four archives is 1,020 bytes, so this is ~250x headroom.
 *
 * A 6 MB chunked body parses correctly on a 64 KB window, so this is not
 * load-bearing against large bodies — see §7.6. It is sized for the provable
 * bound, not the observed one.
 */
const HISTORY_BYTES = 256 * 1024;

/**
 * Compressed bytes per push into the inflater.
 *
 * This, not HISTORY_BYTES, is what sets peak memory: fflate emits output during
 * push(), and the window cannot trim until the push returns, so a highly
 * compressible member can arrive all at once. A 6 MB body at 762:1 peaked at
 * 6,163 KB with 64 KB pushes and 3,585 KB with 4 KB pushes. 64 KB is the
 * throughput/memory balance; lower it if a worker's budget is tight.
 */
const PUSH_BYTES = 64 * 1024;

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** One gzip member — in a record-compressed WARC, one record. */
export interface GzipMember {
    /** Offset of the member in the COMPRESSED file. A complete gzip stream starts here. */
    readonly compressedOffset: number;
    readonly compressedLength: number;
    /** Where this member's output begins in the virtual decompressed .warc. */
    readonly uncompressedOffset: number;
    readonly uncompressedLength: number;
}

/**
 * Where a payload's bytes are, and everything a cold read needs.
 *
 * Self-contained on purpose: no member table, no index, no prior state. That is
 * what lets this cross postMessage and (later) a database row — a view request may
 * be served by a worker that never parsed the file, and the server has no index at
 * all. Because a member is a complete gzip stream, these three numbers stay valid
 * forever.
 *
 * Plain data — no methods, no class — because it is structured-cloned.
 */
export interface GzipLocation {
    /** Start inflating here. */
    readonly compressedOffset: number;
    readonly compressedLength: number;
    /**
     * Payload start relative to this member's DECODED output.
     *
     * Never a "compressed offset of the payload" — that is not a resumable point.
     * Mid-member you would need the live Huffman tables, the bit alignment and the
     * 32 KB history window, none of which are recoverable from a byte offset.
     */
    readonly payloadOffsetInMember: number;
}

export interface GzipWarcReader {
    /**
     * Drop-in for the plain-file reader mWarcDecode already takes. `start` and
     * `size` are LOGICAL — positions in the archive as if decompressed, which is
     * exactly what mwarc's own file.offset already means.
     */
    read(start: number, size: number): Promise<ArrayBuffer | null>;

    /**
     * The member containing a logical offset, or undefined past the end.
     *
     * Async because it may have to inflate a little further to learn where the
     * member ENDS: a member's length is only known once the next one opens. The
     * extra work is bounded by one member and is work the parse would do anyway.
     */
    memberAt(offset: number): Promise<GzipMember | undefined>;

    /** A record's payload location, ready to store. */
    locate(payloadOffset: number): Promise<GzipLocation | undefined>;

    /** Members discovered so far. Grows as the file is read. */
    readonly members: readonly GzipMember[];

    /** Compressed bytes consumed. Use this for progress, not the logical offset. */
    readonly compressedPosition: number;

    /** Logical bytes produced so far. */
    readonly uncompressedPosition: number;

    /** True once the whole compressed file has been fed to the inflater. */
    readonly done: boolean;

    /**
     * This archive is ONE gzip member — `gzip whole.warc` rather than
     * record-at-a-time compression — so it has no seek points at all.
     *
     * Only meaningful once `done`; false before that, because a large first member
     * is indistinguishable from a single one until the stream ends.
     *
     * Worth surfacing rather than ignoring. Such a file still PARSES correctly and
     * at normal speed, so nothing looks wrong — but every record's member is the
     * entire file, which means every payload read re-inflates the whole archive to
     * extract a few kilobytes. Measured: 31 ms to pull 6,260 bytes out of an 8 MB
     * file, and it scales linearly, so a 5 GB archive costs ~20 seconds per page.
     */
    readonly singleMember: boolean;
}

export class GzipReadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GzipReadError";
    }
}

/**
 * Does this file start with the gzip magic?
 *
 * Sniffed rather than taken from the filename, in both directions: a `.warc` that
 * is actually gzipped otherwise fails with a header-parse error pointing at the
 * wrong thing, and a `.warc.gz` that is not gzipped fails somewhere inside fflate.
 * One 2-byte read per file, against files measured in gigabytes.
 */
export const looksGzipped = async (file: BlobLike): Promise<boolean> => {
    if (file.size < 2) return false;

    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());

    return head[0] === GZIP_MAGIC_0 && head[1] === GZIP_MAGIC_1;
};

/** Index of the last member whose start is <= offset, or -1. */
const memberIndexAt = (
    starts: readonly { uncompressedOffset: number }[],
    offset: number,
): number => {
    let low = 0;
    let high = starts.length - 1;
    let found = -1;

    while (low <= high) {
        const mid = (low + high) >> 1;

        if (starts[mid]!.uncompressedOffset <= offset) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return found;
};

export const createGzipWarcReader = (
    file: BlobLike,
    options?: { historyBytes?: number; pushBytes?: number },
): GzipWarcReader => {
    const history = options?.historyBytes ?? HISTORY_BYTES;
    const pushSize = options?.pushBytes ?? PUSH_BYTES;

    /** Member starts, in order. A member's length is derived from the next one. */
    const opens: { compressedOffset: number; uncompressedOffset: number }[] = [
        { compressedOffset: 0, uncompressedOffset: 0 },
    ];

    /*
     * Retained decoded history, as a buffer with a live span [head, tail).
     *
     * This was a plain `Uint8Array` reallocated and copied on every output chunk,
     * which is O(n) per chunk and therefore O(n^2) over a file. It measured 459 ms
     * of pure copying on a 48 MB archive — more than half the cost of the parse —
     * because `locate()` legitimately runs production ahead of the consumer, and a
     * window that has grown to a megabyte was being copied whole thousands of
     * times. Exactly the quadratic trap this file's own indexWarcGz comment warns
     * about, one level down.
     *
     * Now: append into spare capacity, compact only when the tail runs out of room,
     * grow only when the LIVE span genuinely does not fit. Amortised O(1) per byte.
     *
     * Invariants, both load-bearing and both tested:
     *   I1  windowStart + (tail - head) === produced
     *   I2  windowStart <= the current read's start
     */
    let buffer = new Uint8Array(Math.max(history * 2, 1 << 16));
    let head = 0;
    let tail = 0;
    /** Logical offset of buffer[head]. */
    let windowStart = 0;
    let produced = 0;

    /** Compressed bytes handed to the inflater. */
    let fed = 0;
    let finished = false;

    const inflater = new Gunzip((chunk) => {
        // Trimming happens outside push(), because the in-flight read may still
        // need these bytes — see trimTo.
        if (buffer.length - tail < chunk.length) {
            const live = tail - head;

            if (buffer.length - live < chunk.length) {
                // The live span itself plus this chunk does not fit. Double until
                // it does, so growth is amortised rather than per-chunk.
                let capacity = buffer.length;
                while (capacity - live < chunk.length) capacity *= 2;

                const grown = new Uint8Array(capacity);
                grown.set(buffer.subarray(head, tail));
                buffer = grown;
            } else {
                // Room exists, just not at the tail. Slide the live span down.
                buffer.copyWithin(0, head, tail);
            }

            head = 0;
            tail = live;
        }

        buffer.set(chunk, tail);
        tail += chunk.length;
        produced += chunk.length;
    });

    inflater.onmember = (offset) => {
        opens.push({ compressedOffset: offset, uncompressedOffset: produced });
    };

    /**
     * Drop history the consumer can no longer ask for.
     *
     * Anchored to the CONSUMER, not to the production frontier, and that
     * distinction is the whole of this function. One 64 KB push can inflate to
     * megabytes, so production runs far ahead of the reader; trimming to "the last
     * `history` bytes produced" would throw away bytes mwarc has not reached yet.
     *
     * The Math.min against window.length is equally load-bearing. Without it,
     * windowStart can advance PAST produced on a long forward seek — the window
     * then claims to begin where no data exists, every later chunk is filed at the
     * wrong logical offset, and reads return plausible bytes from the wrong part of
     * the archive. That failure is silent at the read layer and surfaces much later
     * as a bogus header-parse error.
     */
    const trimTo = (consumerAt: number): void => {
        const drop = Math.min(tail - head, Math.max(0, consumerAt - history - windowStart));

        if (drop > 0) {
            // Just moves the head. No copy, and no reallocation — the space is
            // reclaimed by the next compaction in the output callback.
            head += drop;
            windowStart += drop;
        }
    };

    /** Feed one compressed block. Returns false at EOF. */
    const pump = async (): Promise<boolean> => {
        if (finished) return false;

        const end = Math.min(fed + pushSize, file.size);
        const block = new Uint8Array(await file.slice(fed, end).arrayBuffer());

        fed = end;
        finished = end >= file.size;

        // `final` tells fflate this is the last block, which is what makes it
        // flush the tail of the last member rather than waiting for more.
        inflater.push(block, finished);

        return true;
    };

    const read = async (start: number, size: number): Promise<ArrayBuffer | null> => {
        if (size <= 0) return new ArrayBuffer(0);

        if (start < windowStart) {
            // Deliberately fatal rather than restarting the stream from the last
            // member boundary. A restart would turn a bounded bug into an
            // unbounded O(n^2) that only shows up on large files; this says so at
            // the moment it happens. If it ever fires in practice the fix is a
            // larger historyBytes, and the message carries the number needed.
            throw new GzipReadError(
                `read at ${start} is ${windowStart - start} bytes behind the retained ` +
                `window (starts at ${windowStart}, history ${history}). ` +
                `Raise historyBytes past ${windowStart - start}.`,
            );
        }

        trimTo(start);

        const out = new Uint8Array(size);
        let filled = 0;

        while (filled < size) {
            const live = tail - head;
            const at = start + filled - windowStart;

            if (at >= 0 && at < live) {
                const take = Math.min(size - filled, live - at);
                const from = head + at;

                out.set(buffer.subarray(from, from + take), filled);
                filled += take;
                continue;
            }

            if (!(await pump())) break;

            // Bound memory across a long forward seek: without this, skipping a
            // large payload retains every byte skipped.
            trimTo(start);
        }

        // Null and short reads are both already part of the contract mwarc relies
        // on — mWarcConsumeNextChunk treats either as end-of-file.
        //
        // `out.buffer` directly on a full read: `slice` would copy the whole thing
        // a second time, and a full read is the overwhelmingly common case.
        if (filled === 0) return null;

        return filled === size ? out.buffer : out.buffer.slice(0, filled);
    };

    const materialize = (index: number): GzipMember => {
        const open = opens[index]!;
        const next = opens[index + 1];

        return {
            compressedOffset: open.compressedOffset,
            compressedLength: (next ? next.compressedOffset : file.size) - open.compressedOffset,
            uncompressedOffset: open.uncompressedOffset,
            uncompressedLength: (next ? next.uncompressedOffset : produced) - open.uncompressedOffset,
        };
    };

    const memberAt = async (offset: number): Promise<GzipMember | undefined> => {
        for (;;) {
            const index = memberIndexAt(opens, offset);

            // Either we have not inflated far enough to see this member yet, or we
            // have seen it but not the one after — and without that one we cannot
            // know where this one ends. Both are fixed by reading further.
            const known = index >= 0 && (index + 1 < opens.length || finished);

            if (known) return materialize(index);
            if (finished) return index >= 0 ? materialize(index) : undefined;

            if (!(await pump())) return index >= 0 ? materialize(index) : undefined;
        }
    };

    const locate = async (payloadOffset: number): Promise<GzipLocation | undefined> => {
        const member = await memberAt(payloadOffset);

        if (!member) return undefined;

        return {
            compressedOffset: member.compressedOffset,
            compressedLength: member.compressedLength,
            payloadOffsetInMember: payloadOffset - member.uncompressedOffset,
        };
    };

    return {
        read,
        memberAt,
        locate,
        get members() {
            return opens.map((_, index) => materialize(index));
        },
        get compressedPosition() {
            return fed;
        },
        get uncompressedPosition() {
            return produced;
        },
        get done() {
            return finished;
        },
        get singleMember() {
            // Free: `opens` is built by the pass that was happening anyway, and the
            // first locate() already forces `finished` for a single-member file
            // because closing member 0 needs the stream to end. So this is known
            // before any payload is ever read, which is the only place it hurts.
            return finished && opens.length === 1;
        },
    };
};

/**
 * Every member boundary in a .warc.gz, in one linear pass.
 *
 * Not used by the read path — createGzipWarcReader discovers members as it goes,
 * so the viewer's existing sequential pass produces the index as a by-product and
 * a second pass would be wasted. This exists for tooling and for the
 * single-member check below.
 */
export const indexWarcGz = async (
    file: BlobLike,
    options?: { pushBytes?: number },
): Promise<GzipMember[]> => {
    const pushSize = options?.pushBytes ?? PUSH_BYTES;

    const opens: { compressedOffset: number; uncompressedOffset: number }[] = [
        { compressedOffset: 0, uncompressedOffset: 0 },
    ];

    let produced = 0;

    const inflater = new Gunzip((chunk) => {
        produced += chunk.length;
    });

    inflater.onmember = (offset) => {
        opens.push({ compressedOffset: offset, uncompressedOffset: produced });
    };

    // Bounded blocks, not a growing tail slice. Re-slicing the remainder per member
    // is quadratic and measured 15.43 s against 0.37 s for the same file.
    for (let at = 0; at < file.size; at += pushSize) {
        const end = Math.min(at + pushSize, file.size);

        inflater.push(new Uint8Array(await file.slice(at, end).arrayBuffer()), end >= file.size);
    }

    return opens.map((open, index) => {
        const next = opens[index + 1];

        return {
            compressedOffset: open.compressedOffset,
            compressedLength: (next ? next.compressedOffset : file.size) - open.compressedOffset,
            uncompressedOffset: open.uncompressedOffset,
            uncompressedLength: (next ? next.uncompressedOffset : produced) - open.uncompressedOffset,
        };
    });
};

/**
 * Is this a single-member .gz — one continuous DEFLATE stream?
 *
 * If so there is no random access to be had at any price. deflate keeps a 32 KB
 * sliding window of back-references, so byte N is defined by every byte before it
 * and reading the middle means inflating from the start. Someone ran
 * `gzip whole.warc` instead of compressing per record.
 *
 * **Prefer `GzipWarcReader.singleMember` to this.** Standalone, this costs a full
 * inflate of the whole file just to answer a yes/no, which doubles the work for
 * every legitimate archive — whereas the reader learns the same thing for free from
 * the pass it was already making. This is here for tooling that has no reader.
 *
 * Early-exits on the first member, so the cost is only paid by the pathological
 * case it is looking for.
 */
export const isSingleMember = async (file: BlobLike): Promise<boolean> => {
    let members = 0;

    const inflater = new Gunzip(() => { });

    inflater.onmember = () => { members++; };

    for (let at = 0; at < file.size; at += PUSH_BYTES) {
        const end = Math.min(at + PUSH_BYTES, file.size);

        inflater.push(new Uint8Array(await file.slice(at, end).arrayBuffer()), end >= file.size);

        // One member is enough to answer the question; no need to read on.
        if (members > 0) return false;
    }

    return members === 0;
};

/**
 * Bytes [sliceStart, sliceEnd) of a payload, read cold from its member.
 *
 * Stateless, and it needs no index — the member start is a valid place to begin
 * inflating from nothing. Measured on real Browsertrix output: 40 random
 * out-of-order payloads, all correct, 0.97 ms each.
 *
 * A member decodes to 1.9 KB at the median and 4.8 MB at the worst, so a 24-byte
 * read typically costs inflating 1.9 KB. Not the whole file.
 */
/**
 * Is the platform's own gzip decoder available?
 *
 * `DecompressionStream` is 3.6x faster than fflate on this workload — 197 ms
 * against 711 ms inflating 1,624 members — because it is native code rather than
 * JS. Chrome 80+, Firefox 113+, Safari 16.4+, Bun and Node all have it.
 *
 * It can only be used HERE, on the retrieval path, and the reason is worth
 * knowing: the spec allows exactly ONE gzip member per stream, and it never
 * reports how many input bytes it consumed. That makes it useless for the index
 * pass, which has to walk member after member and learn where each one ended.
 * A single member is a complete gzip stream, so once a location is known the
 * limitation does not bite.
 */
const hasNativeGunzip = typeof DecompressionStream !== "undefined";

/** One complete gzip member, inflated by the platform. */
const nativeGunzip = async (frame: Uint8Array): Promise<Uint8Array> => {
    const stream = new DecompressionStream("gzip");

    const writer = stream.writable.getWriter();

    /*
     * Not awaited: the write only settles once the reader below drains it, so
     * awaiting here deadlocks. The caller learns about failures from the read.
     *
     * Caught all the same, because a corrupt member rejects BOTH sides, and the
     * writer's rejection with no handler is an unhandled rejection — a console
     * error next to the one the caller is already reporting properly, and two
     * "unhandled error between tests" entries in the suite output, which is
     * exactly the sort of standing noise that hides a real one later.
     */
    const ignore = () => { };
    writer.write(frame).catch(ignore);
    writer.close().catch(ignore);

    const reader = stream.readable.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        parts.push(value);
        total += value.length;
    }

    // Single chunk is the common case for a median 1.9 KB member; skip the copy.
    if (parts.length === 1) return parts[0]!;

    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }

    return out;
};

export const readGzipPayloadSlice = async (
    file: BlobLike,
    location: GzipLocation,
    sliceStart: number,
    sliceEnd: number,
): Promise<Uint8Array> => {
    const wanted = sliceEnd - sliceStart;

    if (wanted <= 0) return new Uint8Array(0);

    const from = location.payloadOffsetInMember + sliceStart;
    const to = location.payloadOffsetInMember + sliceEnd;

    const frame = new Uint8Array(
        await file
            .slice(location.compressedOffset, location.compressedOffset + location.compressedLength)
            .arrayBuffer(),
    );

    // fflate is kept as the fallback rather than the primary: it is the only
    // option in the index pass anyway, so it cannot be dropped, and it means a
    // platform without DecompressionStream degrades in speed rather than failing.
    const decoded = hasNativeGunzip ? await nativeGunzip(frame) : gunzipSync(frame);

    // "One record = one member" is what record-at-a-time compression means, and it
    // held exactly on 1,624 real members. But nothing in the gzip format forces it:
    // a writer may split a record across members, and silently returning a short
    // payload is the worst way to find that out.
    if (to > decoded.length) {
        throw new GzipReadError(
            `payload runs past its member: wanted bytes ${from}..${to} but the member ` +
            `at ${location.compressedOffset} decodes to ${decoded.length}. ` +
            `This archive splits records across gzip members.`,
        );
    }

    return decoded.subarray(from, to);
};
