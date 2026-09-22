// bun test routes/download/streaming.test.ts
//
// The five streaming invariants from download.plan.md §3.1.
//
// These are the assumptions the whole route rests on, and they are assumptions
// about somebody else's code — the TransformStream's queue, and when Bun decides
// to pull. Every other test in this directory checks that the bytes are right;
// these check that there are never very many of them in memory at once, which is
// the difference between a route that streams and one that merely returns a
// ReadableStream.
//
// Sources here are SYNTHETIC. A real 256 MB fixture would make the suite slow and
// would measure this machine's disk rather than the writer's behaviour; a source
// that hands back zeroed buffers isolates exactly the thing under test.

import { describe, expect, test } from "bun:test";
import { createStoredZipStream, writeStoredZip, type StoredZipEntry, type ZipSource } from "./storedzip";

const MB = 1024 * 1024;

/** A byte range that costs nothing to read and counts every read. */
const countingSource = (size: number) => {
    let reads = 0;
    let bytesRead = 0;
    let peakOutstanding = 0;
    let outstanding = 0;

    const source: ZipSource = {
        size,
        slice: (from = 0, to = size) => {
            reads++;
            outstanding++;
            peakOutstanding = Math.max(peakOutstanding, outstanding);

            const length = Math.max(0, Math.min(to, size) - from);

            return {
                arrayBuffer: () => {
                    bytesRead += length;
                    outstanding--;

                    return Promise.resolve(new ArrayBuffer(length));
                },
            };
        },
        stream: () => {
            reads++;

            return new ReadableStream<Uint8Array>({
                pull(controller) {
                    bytesRead += size;
                    controller.enqueue(new Uint8Array(size));
                    controller.close();
                },
            });
        },
    };

    return {
        source,
        get reads() { return reads; },
        get bytesRead() { return bytesRead; },
        /** How many slices were in flight at the high-water mark. */
        get peakOutstanding() { return peakOutstanding; },
    };
};

const entriesOf = (
    count: number,
    size: number,
): { entries: StoredZipEntry[]; sources: ReturnType<typeof countingSource>[] } => {
    const sources = Array.from({ length: count }, () => countingSource(size));

    return {
        sources,
        entries: sources.map((one, index) => ({
            name: `records/${String(index).padStart(4, "0")}.bin`,
            data: one.source,
        })),
    };
};

const rss = () => process.memoryUsage.rss() / MB;

describe("§3.1 invariant 1: memory does not scale with the archive", () => {
    test("writing 4 x 64 MB never holds much more than a chunk", async () => {
        const { entries } = entriesOf(4, 64 * MB);

        const before = rss();
        let peak = before;
        let written = 0;

        // Sampled rather than measured at the end: the whole question is whether
        // there is a spike in the middle, and a reading taken afterwards would
        // miss one that the collector has already cleaned up.
        const watch = setInterval(() => { peak = Math.max(peak, rss()); }, 2);

        const total = await writeStoredZip(
            new WritableStream({ write: (chunk) => { written += chunk.length; } }),
            entries,
            { chunkSize: 1 * MB },
        );

        clearInterval(watch);

        expect(written).toBe(total);
        expect(total).toBeGreaterThan(256 * MB);

        /*
         * 256 MB of payload, and the ceiling is a small multiple of the chunk.
         *
         * Generous on purpose — this is a garbage-collected runtime and the number
         * that matters is the SHAPE, not the value. If retention were proportional
         * to the archive this would be 256 MB over the baseline rather than tens.
         */
        expect(peak - before).toBeLessThan(64);
    }, 60_000);
});

describe("§3.1 invariant 4: no payload is read more than once", () => {
    test("each entry is read exactly once through, in chunk-sized pieces", async () => {
        const { entries, sources } = entriesOf(3, 4 * MB);

        await writeStoredZip(
            new WritableStream({ write: () => {} }),
            entries,
            { chunkSize: 1 * MB },
        );

        for (const source of sources) {
            // 4 MB in 1 MB pieces: four reads, four megabytes. Not five, and not
            // eight — a second pass to compute the crc would double both.
            expect(source.reads).toBe(4);
            expect(source.bytesRead).toBe(4 * MB);
        }
    });

    test("the lookahead is the only concurrency, and it is bounded", async () => {
        const { entries, sources } = entriesOf(1, 16 * MB);

        await writeStoredZip(
            new WritableStream({ write: () => {} }),
            entries,
            { chunkSize: 1 * MB, lookahead: 1 },
        );

        // One being written plus one read ahead. Sixteen chunks, never more than
        // two of them in flight — this is the number that bounds memory per
        // response, so it is worth pinning rather than trusting.
        expect(sources[0]!.peakOutstanding).toBeLessThanOrEqual(2);
    });

    test("lookahead 0 means one read at a time", async () => {
        const { entries, sources } = entriesOf(1, 8 * MB);

        await writeStoredZip(
            new WritableStream({ write: () => {} }),
            entries,
            { chunkSize: 1 * MB, lookahead: 0 },
        );

        expect(sources[0]!.peakOutstanding).toBe(1);
    });
});

describe("§3.1 invariant 5: nothing is read until the consumer pulls", () => {
    test("createStoredZipStream reads nothing before the first read()", async () => {
        const { entries, sources } = entriesOf(4, 8 * MB);

        const stream = createStoredZipStream(entries, { chunkSize: 1 * MB });

        // A few turns of the event loop, so a writer that ran eagerly would have
        // got somewhere by now.
        await new Promise(resolve => setTimeout(resolve, 20));

        const readsBeforePulling = sources.reduce((sum, one) => sum + one.reads, 0);

        /*
         * At most the first chunk, which the TransformStream's queue accepts
         * before applying backpressure. What must NOT have happened is the whole
         * archive: 32 chunks across four entries.
         */
        expect(readsBeforePulling).toBeLessThanOrEqual(2);

        // And it does produce once asked.
        const reader = stream.getReader();
        const first = await reader.read();

        expect(first.done).toBe(false);

        await reader.cancel();
    });
});

describe("§3.1 invariant 3: a slow consumer does not make the producer run ahead", () => {
    /*
     * The one that matters most, and the one that was still an assumption.
     *
     * "Streaming" is not "returns a ReadableStream". A producer that reads as fast
     * as it can, into a consumer that is slower, buffers the difference — and for
     * a 2 GB archive over a slow connection the difference IS the archive. The
     * writer awaits `writer.ready` before every write, which is the queue's own
     * signal that it has room; this checks that the signal is actually honoured
     * end to end rather than merely present in the source.
     */
    test("reading 4 chunks slowly does not read the whole archive", async () => {
        const { entries, sources } = entriesOf(8, 8 * MB);
        const totalChunks = 8 * 8;   // 64, at 1 MB each

        const stream = createStoredZipStream(entries, { chunkSize: 1 * MB });
        const reader = stream.getReader();

        for (let taken = 0; taken < 4; taken++) {
            await reader.read();
            // A deliberate stall, standing in for a slow socket.
            await new Promise(resolve => setTimeout(resolve, 15));
        }

        const readSoFar = sources.reduce((sum, one) => sum + one.reads, 0);

        /*
         * Four chunks consumed. The producer is allowed to be a little ahead — the
         * queue holds one, the lookahead holds one, and headers are written
         * without waiting — but "a little" has to mean single digits rather than
         * all 64. If backpressure were not honoured this would be 64.
         */
        expect(readSoFar).toBeLessThan(12);
        expect(readSoFar).toBeLessThan(totalChunks);

        await reader.cancel();
    });

    test("a consumer that walks away does not leave the writer running", async () => {
        const { entries, sources } = entriesOf(6, 8 * MB);

        const stream = createStoredZipStream(entries, { chunkSize: 1 * MB });
        const reader = stream.getReader();

        await reader.read();
        await reader.cancel();

        const atCancel = sources.reduce((sum, one) => sum + one.reads, 0);

        // Long enough that an unstopped writer would have finished all 48 chunks.
        await new Promise(resolve => setTimeout(resolve, 60));

        const later = sources.reduce((sum, one) => sum + one.reads, 0);

        /*
         * A cancelled reader errors the writable, so the writer's next `write`
         * rejects and `writeStoredZip` aborts. Without that, a reader closing a
         * connection would leave a job reading a WARC to nobody — which at eight
         * concurrent downloads is how a server ends up doing more work after its
         * clients have gone than before.
         */
        expect(later - atCancel).toBeLessThan(6);
        expect(later).toBeLessThan(48);
    });
});
