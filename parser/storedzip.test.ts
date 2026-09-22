// bun test parser/storedzip.test.ts
//
// A hand-rolled zip writer is only worth having if it is provably correct, and
// "it opened on my machine" is not that: a zip with a wrong crc, a wrong offset,
// or a missing zip64 extra still opens in most readers, and fails in one.
//
// So every archive built here is validated by Python's `zipfile` — a different
// implementation, no shared code, no shared assumptions — including `testzip()`,
// which verifies each entry's crc against its actual bytes. Several are also read
// back by this repo's OWN zip reader (parser/wacz.ts), because that is the code
// that will be asked to read these files if a .wacz is ever built this way.

import { describe, expect, test } from "bun:test";
import { crc32, crc32Simple } from "./crc32";
import { storedZipSize, writeStoredZip, type StoredZipEntry, type ZipSource } from "./storedzip";
import { readZipEntries } from "./wacz";

/**
 * A Blob as a ZipSource.
 *
 * The cast is the price of `lib: ["ESNext"]` in the backend tsconfig: Bun's
 * ambient Blob does not declare `slice`, so it does not structurally satisfy the
 * interface even though it has the method at runtime. gzip.test.ts casts at the
 * same boundary for the same reason.
 */
const source = (parts: (Uint8Array | string)[]): ZipSource & { arrayBuffer(): Promise<ArrayBuffer> } =>
    new Blob(parts) as unknown as ZipSource & { arrayBuffer(): Promise<ArrayBuffer> };

/** Collect a written zip into one buffer. */
const build = async (
    entries: StoredZipEntry[],
    options: Parameters<typeof writeStoredZip>[2] = {},
): Promise<Uint8Array> => {
    const parts: Uint8Array[] = [];

    const writable = new WritableStream<Uint8Array>({
        write: (chunk) => { parts.push(chunk); },
    });

    const total = await writeStoredZip(writable, entries, options);
    const out = new Uint8Array(total);

    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }

    return out;
};

const bytes = (length: number, seed = 1): Uint8Array => {
    const out = new Uint8Array(length);

    // A deterministic LCG rather than Math.random: a failure has to be
    // reproducible, and a crc bug that only shows on certain byte patterns is
    // exactly the kind that hides behind a fresh random buffer each run.
    let state = seed;
    for (let at = 0; at < length; at++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        out[at] = state & 0xff;
    }

    return out;
};

const entry = (name: string, data: Uint8Array | string, crc?: number): StoredZipEntry => ({
    name,
    data: source([data]),
    lastModDate: new Date("2026-08-21T12:34:56Z"),
    ...(crc === undefined ? {} : { crc32: crc }),
});

/**
 * Hand the archive to Python and ask what it thinks.
 *
 * `testzip()` returns the name of the first entry whose crc does not match its
 * data, or None. That is the assertion that matters: it is checking the thing
 * this file is most likely to get wrong, with arithmetic written by someone else.
 */
const inspect = async (zip: Uint8Array): Promise<{
    ok: boolean;
    bad: string | null;
    names: string[];
    sizes: number[];
    contents: string[];
    zip64: boolean;
    error?: string;
}> => {
    const path = `/tmp/storedzip-${Math.random().toString(36).slice(2)}.zip`;
    await Bun.write(path, zip);

    const script = `
import json, sys, zipfile
try:
    with zipfile.ZipFile(${JSON.stringify(path)}) as archive:
        infos = archive.infolist()
        print(json.dumps({
            "ok": True,
            "bad": archive.testzip(),
            "names": [i.filename for i in infos],
            "sizes": [i.file_size for i in infos],
            "contents": [archive.read(i.filename).decode("latin-1") for i in infos],
            # 45 means "zip64 required to extract".
            "zip64": any(i.extract_version >= 45 for i in infos),
        }))
except Exception as problem:
    print(json.dumps({"ok": False, "error": str(problem), "bad": None,
                      "names": [], "sizes": [], "contents": [], "zip64": False}))
`;

    const result = Bun.spawnSync(["python3", "-c", script]);
    const out = result.stdout.toString().trim();

    if (!out) throw new Error(`python said nothing: ${String(result.stderr ?? "(no stderr)")}`);

    return JSON.parse(out);
};

describe("crc32", () => {
    // The wide version folds eight bytes an iteration through eight tables. It is
    // worth ~3x and it is worth exactly nothing if it disagrees with the simple
    // one, so they are compared across every length that could straddle a group
    // boundary, plus sizes big enough to exercise the main loop.
    test("slicing by eight agrees with a byte at a time", () => {
        for (const length of [0, 1, 7, 8, 9, 15, 16, 17, 63, 64, 255, 4096, 100_003]) {
            const data = bytes(length, length + 1);

            expect(crc32(data)).toBe(crc32Simple(data));
        }
    });

    // Streaming is the point: a 4 GB entry is never one buffer.
    test("chunked folding equals the whole", () => {
        const data = bytes(50_000, 7);
        const whole = crc32(data);

        for (const chunk of [1, 3, 8, 1000, 49_999]) {
            let running = 0;
            for (let at = 0; at < data.length; at += chunk) {
                running = crc32(data.subarray(at, Math.min(at + chunk, data.length)), running);
            }

            expect(running).toBe(whole);
        }
    });

    // The known answer, so a table built wrong cannot pass by self-consistency.
    test("matches the published value for 'The quick brown fox jumps over the lazy dog'", () => {
        const text = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");

        expect(crc32(text)).toBe(0x414fa339);
    });
});

describe("stored zip", () => {
    test("Python reads it, and every crc checks out", async () => {
        const zip = await build([
            entry("manifest.txt", "one\ntwo\nthree\n"),
            entry("pages/index.html", "<!doctype html><title>hi</title>"),
            entry("assets/blob.bin", bytes(300_000)),
        ]);

        const seen = await inspect(zip);

        expect(seen.error).toBeUndefined();
        expect(seen.ok).toBe(true);
        expect(seen.bad).toBeNull();
        expect(seen.names).toEqual(["manifest.txt", "pages/index.html", "assets/blob.bin"]);
        expect(seen.sizes).toEqual([14, 32, 300_000]);
        expect(seen.contents[0]).toBe("one\ntwo\nthree\n");
    });

    test("this repo's own zip reader can read it", async () => {
        const zip = await build([
            entry("archive/one.warc.gz", bytes(5000)),
            entry("indexes/index.cdx", "a b c\n"),
        ]);

        const found = await readZipEntries(
            new Blob([zip]) as unknown as Parameters<typeof readZipEntries>[0]);
        const named = found.map(one => one.name).sort();

        expect(named).toEqual(["archive/one.warc.gz", "indexes/index.cdx"]);

        // Method 0, which is what makes a .wacz's members readable in place —
        // the property parser/wacz.ts depends on.
        for (const one of found) expect(one.method).toBe(0);

        // And the sizes the reader derives from the central directory match what
        // went in. A .wacz built this way would be readable by the same path a
        // Browsertrix one is.
        const sizes = Object.fromEntries(found.map(one => [one.name, one.uncompressedSize]));

        expect(sizes["archive/one.warc.gz"]).toBe(5000);
        expect(sizes["indexes/index.cdx"]).toBe(6);
    });

    // The size has to be knowable up front or the response cannot carry a
    // Content-Length, and without one the browser shows a download with no end.
    test("storedZipSize predicts the byte count exactly", async () => {
        const cases: StoredZipEntry[][] = [
            [entry("a", "x")],
            [entry("a", ""), entry("b", "")],
            [entry("one.bin", bytes(1000)), entry("two.bin", bytes(70_000))],
            [entry("crc-known.bin", bytes(4096), crc32(bytes(4096)))],
            [entry("ünïcodé/名前.txt", "hello")],
        ];

        for (const entries of cases) {
            const zip = await build(entries);

            expect(storedZipSize(entries)).toBe(zip.length);
        }
    });

    test("a supplied crc skips the data descriptor and still validates", async () => {
        const payload = bytes(9000, 11);
        const withCrc = await build([entry("known.bin", payload, crc32(payload))]);
        const withDescriptor = await build([entry("known.bin", payload)]);

        // Same bytes either way, and 16 bytes cheaper: no descriptor.
        expect(withCrc.length).toBe(withDescriptor.length - 16);

        const seen = await inspect(withCrc);

        expect(seen.bad).toBeNull();
        expect(seen.sizes).toEqual([9000]);
    });

    test("an empty entry is legal and reads back empty", async () => {
        const seen = await inspect(await build([entry("empty", ""), entry("after", "x")]));

        expect(seen.bad).toBeNull();
        expect(seen.sizes).toEqual([0, 1]);
        expect(seen.contents).toEqual(["", "x"]);
    });

    test("non-ASCII names survive, because archived urls contain them", async () => {
        const seen = await inspect(await build([
            entry("naïve/日本語/ünïcodé.html", "<p>ok</p>"),
            entry("with space & symbols (1).txt", "ok"),
        ]));

        expect(seen.bad).toBeNull();
        expect(seen.names).toEqual(["naïve/日本語/ünïcodé.html", "with space & symbols (1).txt"]);
    });

    /*
     * The zip64 path, on a hundred bytes.
     *
     * Reaching it honestly needs a four-gigabyte entry, which is not a test. The
     * thresholds are injectable precisely so the same branches — the local extra
     * field, the 8-byte descriptor, the central extra, the zip64 end record and
     * its locator, and the sentinels in the classic end record — run on data
     * small enough to check by hand and for Python to verify.
     */
    test("zip64 branches produce an archive Python calls zip64", async () => {
        const limits = { maxSize: 64, maxEntries: 0xffff };

        const zip = await build([
            entry("big.bin", bytes(200, 3)),
            entry("small.bin", "tiny"),
        ], { limits });

        const seen = await inspect(zip);

        expect(seen.error).toBeUndefined();
        expect(seen.bad).toBeNull();
        expect(seen.zip64).toBe(true);
        expect(seen.sizes).toEqual([200, 4]);
        expect(seen.contents[1]).toBe("tiny");
    });

    test("zip64 sizes are exact too, so Content-Length still holds", async () => {
        const limits = { maxSize: 64, maxEntries: 0xffff };
        const entries = [entry("big.bin", bytes(200, 5)), entry("also.bin", bytes(100, 6))];

        expect(storedZipSize(entries, limits)).toBe((await build(entries, { limits })).length);
    });

    test("a zip64 entry with a known crc needs no descriptor and still validates", async () => {
        const limits = { maxSize: 64, maxEntries: 0xffff };
        const payload = bytes(500, 9);

        const seen = await inspect(await build(
            [entry("known.bin", payload, crc32(payload))], { limits }));

        expect(seen.bad).toBeNull();
        expect(seen.zip64).toBe(true);
        expect(seen.sizes).toEqual([500]);
    });

    // Many entries, because the central directory is the part that scales and an
    // offset written wrong at entry 300 is invisible at entry 3.
    test("400 entries all land at the offsets the directory claims", async () => {
        const entries = Array.from({ length: 400 }, (_, index) =>
            entry(`records/${index.toString().padStart(4, "0")}.bin`, bytes(64 + index, index + 1)));

        const seen = await inspect(await build(entries));

        expect(seen.bad).toBeNull();
        expect(seen.names).toHaveLength(400);
        expect(seen.sizes[399]).toBe(64 + 399);
    });

    test("chunk size and lookahead do not change the output", async () => {
        const entries = [entry("a.bin", bytes(250_000, 21)), entry("b.txt", "trailing")];
        const reference = await build(entries);

        for (const chunkSize of [1, 1000, 65_536, 1 << 20]) {
            for (const lookahead of [0, 1, 4]) {
                expect(await build(entries, { chunkSize, lookahead })).toEqual(reference);
            }
        }
    });

    /*
     * A source that lies about its own length.
     *
     * The headers are already on the wire by the time the shortfall is noticed,
     * so there is nothing to do but fail loudly — an archive whose directory
     * disagrees with its data is corruption that opens.
     */
    test("a blob that produces fewer bytes than it declared is an error", async () => {
        const lying: ZipSource = {
            size: 500,
            slice: () => source([bytes(10)]),
            stream: () => source([bytes(10)]).stream(),
        };

        await expect(build([{ name: "short.bin", data: lying }])).rejects.toThrow(/declared 500/);
    });

    test("entries stream in the order they were given", async () => {
        const order = ["z-last.txt", "a-first.txt", "m-middle.txt"];
        const seen = await inspect(await build(order.map(name => entry(name, name))));

        expect(seen.names).toEqual(order);
    });
});
