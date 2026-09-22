// bun run parser/storedzip.bench.ts
//
// zip.js in STORE mode against the hand-rolled writer, on the shapes a download
// actually takes.
//
// Not a test — it prints numbers and asserts nothing, because a timing assertion
// on shared hardware is a flaky test. storedzip.test.ts is where correctness
// lives, and NOTHING here is worth reading if that file is failing: a writer that
// skips work is always faster.
//
// zip.js is configured exactly as zipsink.ts configures it — no workers, native
// CompressionStream, 1 MB chunks, zip64, no buffered writes — so this compares
// the two libraries doing the same job, not one of them badly set up.

import { BlobReader, ZipWriter, configure } from "@zip.js/zip.js";
import { crc32, crc32Simple } from "./crc32";
import { writeStoredZip, type StoredZipEntry } from "./storedzip";

configure({ useWebWorkers: false, useCompressionStream: true, chunkSize: 1024 * 1024 });

/** STORE. Method 0. The whole point. */
const STORE = 0;

/** Counts bytes and drops them, so the measurement is the writer, not the disk. */
const nullSink = () => {
    let total = 0;

    return {
        get total() { return total; },
        writable: new WritableStream<Uint8Array>({
            write: (chunk) => { total += chunk.length; },
        }),
    };
};

const bytes = (length: number, seed: number): Uint8Array => {
    const out = new Uint8Array(length);
    let state = seed;

    for (let at = 0; at < length; at++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        out[at] = state & 0xff;
    }

    return out;
};

/**
 * One shape of download.
 *
 * `blobs` are built ONCE and reused by both writers, so blob construction is
 * outside the timed region for both and neither pays for the other's warm-up.
 */
interface Shape {
    name: string;
    note: string;
    blobs: Blob[];
}

const shape = (name: string, note: string, sizes: number[]): Shape => ({
    name,
    note,
    blobs: sizes.map((size, index) => new Blob([bytes(size, index + 1)])),
});

const MB = 1024 * 1024;
const KB = 1024;

/*
 * The corpus figures in zipsink.ts's own comments: 54% of responses under 16 KB,
 * one 28.8 MB entry, 450 chunks at 64 KB. So the shapes below are that spread —
 * a lot of small entries, a few big ones — plus the two extremes on either side
 * to show where each writer's cost actually is.
 */
const shapes: Shape[] = [
    shape("2000 tiny", "2,000 x 4 KB — per-entry overhead dominates",
        Array.from({ length: 2000 }, () => 4 * KB)),

    shape("500 small", "500 x 16 KB — the median response",
        Array.from({ length: 500 }, () => 16 * KB)),

    shape("realistic mix", "270 under 16 KB, 30 mid, 3 large — the measured spread",
        [
            ...Array.from({ length: 270 }, (_, i) => 1 * KB + (i % 15) * KB),
            ...Array.from({ length: 30 }, (_, i) => 200 * KB + i * 40 * KB),
            8 * MB, 12 * MB, 28 * MB,
        ]),

    shape("8 large", "8 x 16 MB — CRC and copying dominate",
        Array.from({ length: 8 }, () => 16 * MB)),

    shape("1 huge", "one 256 MB entry — pure streaming throughput",
        [256 * MB]),
];

// Cast at the boundary, like the tests: Bun's ambient Blob does not declare
// `slice` under `lib: ["ESNext"]`, so it fails the structural check it satisfies
// perfectly well at runtime.
const entriesFor = (blobs: Blob[], withCrc = false): StoredZipEntry[] =>
    blobs.map((data, index) => ({
        name: `records/${index.toString().padStart(5, "0")}.bin`,
        data: data as unknown as StoredZipEntry["data"],
        ...(withCrc ? { crc32: 0 } : {}),
    }));

/* ---- the two writers --------------------------------------------------- */

const runZipJs = async (blobs: Blob[]): Promise<number> => {
    const sink = nullSink();

    const writer = new ZipWriter(sink.writable, {
        bufferedWrite: false,
        keepOrder: true,
        zip64: true,
        level: STORE,
    });

    for (const [index, blob] of blobs.entries()) {
        await writer.add(
            `records/${index.toString().padStart(5, "0")}.bin`,
            new BlobReader(blob),
            { level: STORE });
    }

    await writer.close();

    return sink.total;
};

const runStored = async (blobs: Blob[], options = {}): Promise<number> => {
    const sink = nullSink();

    await writeStoredZip(sink.writable, entriesFor(blobs), options);

    return sink.total;
};

/** With the crc supplied, which is what an indexed corpus would allow. */
const runStoredPrecomputed = async (blobs: Blob[]): Promise<number> => {
    const sink = nullSink();

    // The crc is a lie here (0), on purpose: the point of this row is to price
    // the WRITE path with no crc work in it, and a real crc would mean reading
    // every blob first, inside the timed region. The archives it produces are
    // invalid and are never validated.
    await writeStoredZip(sink.writable, entriesFor(blobs, true), {});

    return sink.total;
};

/* ---- timing ------------------------------------------------------------ */

/**
 * Best of three, after a warm-up.
 *
 * The warm-up is for JIT and for the crc tables, which would otherwise be billed
 * to whichever writer ran first. Best-of rather than mean because this measures a
 * ceiling: every source of noise on a shared machine — scheduling, page cache
 * eviction, another process — can only make a run slower, never faster, so the
 * minimum is the closest thing to the cost of the code itself.
 *
 * It also mattered: a single timed pass had the crc-free writer coming out 40%
 * SLOWER than the one doing more work, which is not a result, it is variance.
 */
const time = async (run: () => Promise<number>): Promise<{ ms: number; bytes: number }> => {
    await run();

    let best = Infinity;
    let written = 0;

    for (let attempt = 0; attempt < 3; attempt++) {
        const started = performance.now();
        written = await run();
        best = Math.min(best, performance.now() - started);
    }

    return { ms: best, bytes: written };
};

const rate = (bytes: number, ms: number) => `${(bytes / MB / (ms / 1000)).toFixed(0)} MB/s`;
const millis = (ms: number) => `${ms < 10 ? ms.toFixed(1) : ms.toFixed(0)} ms`;
const pad = (text: string, width: number) => text.padEnd(width);
const num = (text: string, width: number) => text.padStart(width);

console.log("\n=== zip.js STORE vs hand-rolled stored writer ===");
console.log("    (sources in memory, so these price CPU and nothing else.");
console.log("     Read the 'from disk' section below before believing any of it.");
console.log("     The 'known crc' row is not a real speedup here: an in-memory");
console.log("     Blob slice is nearly free, so removing the crc leaves almost");
console.log("     no work at all. It is an upper bound, not a forecast.)\n");

for (const one of shapes) {
    const total = one.blobs.reduce((sum, blob) => sum + blob.size, 0);

    console.log(`${one.name}  —  ${one.note}`);
    console.log(`  ${one.blobs.length} entries, ${(total / MB).toFixed(1)} MB\n`);

    const zipjs = await time(() => runZipJs(one.blobs));
    const stored = await time(() => runStored(one.blobs));
    const known = await time(() => runStoredPrecomputed(one.blobs));

    const rows: [string, { ms: number; bytes: number }][] = [
        ["zip.js (STORE)", zipjs],
        ["storedzip", stored],
        ["storedzip + known crc", known],
    ];

    for (const [label, result] of rows) {
        const speedup = label === "zip.js (STORE)"
            ? ""
            : `  ${(zipjs.ms / result.ms).toFixed(2)}x`;

        console.log(
            `    ${pad(label, 24)} ${num(millis(result.ms), 9)}`
            + `  ${num(rate(result.bytes, result.ms), 10)}${speedup}`);
    }

    // Byte-for-byte size comparison, because a smaller archive that is missing a
    // descriptor is not a win.
    console.log(`    ${pad("archive size", 24)} zip.js ${(zipjs.bytes / MB).toFixed(2)} MB`
        + `   storedzip ${(stored.bytes / MB).toFixed(2)} MB`
        + `   delta ${stored.bytes - zipjs.bytes} bytes\n`);
}

/* ---- the same thing, but the source is a real file on disk ------------- */

/*
 * Everything above reads from Blobs that are already in memory, which prices the
 * CPU and nothing else. That is the right isolation for comparing two writers,
 * and it is NOT the shape of a download: the browser's source is a File the user
 * picked, and every slice of it is a read.
 *
 * So the same comparison against a real WARC, sliced the way a download slices
 * one. This is the number to quote.
 */
console.log("=== from disk: slices of a real .warc ===\n");

{
    const path = new URL("../../warc.null/nekoweb.warc", import.meta.url).pathname;
    const source = Bun.file(path);

    if (await source.exists()) {
        const size = source.size;

        /*
         * 300 slices at spread-out offsets, which is what a download of 300
         * records looks like: many ranges out of one big file, not one sequential
         * read. Sizes follow the corpus — mostly small, a few large.
         */
        const slices: Blob[] = [];
        let at = 0;

        for (let index = 0; index < 300 && at < size; index++) {
            const length = index % 50 === 0
                ? Math.min(4 * MB, size - at)
                : Math.min(2 * KB + (index % 17) * 6 * KB, size - at);

            slices.push(source.slice(at, at + length) as unknown as Blob);

            // Skipping between reads on purpose: adjacent slices would let the
            // filesystem read ahead and flatter both writers equally, but it is
            // not what a set of arbitrary record offsets does.
            at += length + 64 * KB;
        }

        const total = slices.reduce((sum, blob) => sum + blob.size, 0);

        console.log(`  ${slices.length} slices of nekoweb.warc, ${(total / MB).toFixed(1)} MB\n`);

        const zipjs = await time(() => runZipJs(slices));
        const stored = await time(() => runStored(slices));
        const streamed = await time(() => runStored(slices, { read: "stream" }));
        const known = await time(() => runStoredPrecomputed(slices));

        for (const [label, result] of [
            ["zip.js (STORE)", zipjs],
            ["storedzip (slice)", stored],
            ["storedzip (stream)", streamed],
            ["storedzip + known crc", known],
        ] as const) {
            const speedup = label === "zip.js (STORE)" ? "" : `  ${(zipjs.ms / result.ms).toFixed(2)}x`;

            console.log(`    ${pad(label, 24)} ${num(millis(result.ms), 9)}`
                + `  ${num(rate(result.bytes, result.ms), 10)}${speedup}`);
        }
    } else {
        console.log("    (skipped: warc.null/nekoweb.warc not present)");
    }

    console.log("");
}

/* ---- the crc, on its own ----------------------------------------------- */

console.log("=== crc32, which is now the only work over the bytes ===\n");

{
    const data = bytes(64 * MB, 99);

    for (const [label, fn] of [
        ["byte at a time", crc32Simple],
        ["slicing by eight", crc32],
    ] as const) {
        fn(data.subarray(0, 1 << 20));

        const started = performance.now();
        fn(data);
        const ms = performance.now() - started;

        console.log(`    ${pad(label, 24)} ${num(ms.toFixed(0) + " ms", 9)}  ${num(rate(data.length, ms), 10)}`);
    }

    // Bun's native crc32, for the ceiling. NOT available in the browser, which is
    // where the download worker runs — so this is the server-side number and the
    // reason the JS table above is the one that matters.
    const native = (Bun as unknown as { hash?: { crc32?: (input: Uint8Array) => number } }).hash?.crc32;

    if (native) {
        native(data.subarray(0, 1 << 20));

        const started = performance.now();
        native(data);
        const ms = performance.now() - started;

        console.log(`    ${pad("Bun.hash.crc32 (server)", 24)} ${num(ms.toFixed(0) + " ms", 9)}  ${num(rate(data.length, ms), 10)}`);
    }
}

/* ---- chunk size and lookahead ----------------------------------------- */

console.log("\n=== chunk size, on the 256 MB entry ===\n");

{
    const blobs = [new Blob([bytes(256 * MB, 5)])];

    for (const chunkSize of [64 * KB, 256 * KB, 1 * MB, 4 * MB]) {
        const result = await time(() => runStored(blobs, { chunkSize }));

        console.log(`    ${pad(`${chunkSize / KB} KB chunks`, 24)} ${num(result.ms.toFixed(0) + " ms", 9)}`
            + `  ${num(rate(result.bytes, result.ms), 10)}`);
    }

    console.log("");

    for (const lookahead of [0, 1, 2, 4]) {
        const result = await time(() => runStored(blobs, { lookahead }));

        console.log(`    ${pad(`lookahead ${lookahead}`, 24)} ${num(result.ms.toFixed(0) + " ms", 9)}`
            + `  ${num(rate(result.bytes, result.ms), 10)}`);
    }
}

/* ---- what dropping zip.js would do to the bundle ---------------------- */

console.log("\n=== bundle cost of the dependency ===\n");

{
    const probe = async (source: string, label: string) => {
        // Inside the project, not /tmp: `@zip.js/zip.js` resolves through
        // node_modules, and an entry point outside the tree cannot see it.
        const path = new URL(`./.bundle-probe-${label}.ts`, import.meta.url).pathname;
        await Bun.write(path, source);

        const result = await Bun.build({
            entrypoints: [path],
            target: "browser",
            format: "iife",
            minify: true,
            define: { "import.meta.url": '""' },
        });

        if (!result.success) throw new Error(result.logs.map(String).join("\n"));

        const code = await result.outputs[0]!.text();
        const gzip = Bun.gzipSync(code).length;

        console.log(`    ${pad(label, 24)} ${num((code.length / KB).toFixed(0) + " KB", 9)}`
            + `  ${num((gzip / KB).toFixed(0) + " KB gz", 12)}`);

        await Bun.file(path).unlink();
    };

    await probe(
        `import { ZipWriter, BlobReader, configure } from "@zip.js/zip.js";
         (globalThis as Record<string, unknown>).probe = [ZipWriter, BlobReader, configure];`,
        "zipjs");

    await probe(
        `import { writeStoredZip, storedZipSize } from "./storedzip";
         (globalThis as Record<string, unknown>).probe = [writeStoredZip, storedZipSize];`,
        "storedzip");
}

console.log("");
