// bun test routes/download/chunked.test.ts
//
// Chunked payloads, de-framed as they stream.
//
// This is the one entry shape that is not a byte range: the stored bytes are
// interleaved with chunk-length lines, so byte 5,000 of the body is at no
// computable offset in the archive. Until now these were a `chunked-skipped` row
// in the manifest.
//
// The state machine that walks the framing is the whole risk. It has to survive a
// read landing anywhere — mid-size-line, mid-data, between the two bytes of a
// CRLF — so most of this file is the same body read at window sizes chosen to
// split it in each of those places. A de-chunker that is wrong by one byte still
// produces a plausible file, which is why the assertions compare against the
// decoded bytes rather than against a length.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { chunkedRange, dechunkingStream, toEntry, type PayloadRow } from "./entries";
import { writeStoredZip } from "./storedzip";

const DIR = "/tmp/download-chunked-test";

beforeAll(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
});

afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
});

/** A chunked body on disk, and what it decodes to. */
const encode = async (
    name: string,
    pieces: string[],
    prefix = "WARC/1.1\r\nTransfer-Encoding: chunked\r\n\r\n",
): Promise<{ path: string; offset: number; encoded: number; sizes: number[]; decoded: string }> => {
    let body = "";

    for (const piece of pieces) {
        body += `${piece.length.toString(16)}\r\n${piece}\r\n`;
    }

    // The terminating chunk, which is framing and not body.
    body += "0\r\n\r\n";

    const path = `${DIR}/${name}.warc`;
    await Bun.write(path, prefix + body);

    return {
        path,
        offset: prefix.length,
        encoded: body.length,
        sizes: pieces.map(piece => piece.length),
        decoded: pieces.join(""),
    };
};

/** Read a source the way the writer does: through stream(), to the end. */
const drain = async (source: { stream(): ReadableStream<Uint8Array> }): Promise<string> => {
    const reader = source.stream().getReader();
    const parts: Uint8Array[] = [];

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Copied, because the de-chunker enqueues VIEWS onto the read window and
        // the window is reused. Real consumers write the bytes out immediately;
        // a test that keeps them has to take its own copy.
        parts.push(new Uint8Array(value));
    }

    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;

    for (const part of parts) { out.set(part, at); at += part.length; }

    return new TextDecoder().decode(out);
};

describe("chunkedRange", () => {
    test("declares the DECODED size, which is what the archive gets", async () => {
        const fixture = await encode("simple", ["Wiki", "pedia"]);
        const range = chunkedRange(fixture.path, fixture.offset, fixture.encoded, fixture.sizes);

        expect(range.source.size).toBe(9);
        expect(range.decoded).toBe(9);
        // The encoded length is longer, and is only used to bound the read.
        expect(fixture.encoded).toBeGreaterThan(9);
    });

    test("de-frames a body", async () => {
        const fixture = await encode("basic", ["Wiki", "pedia"]);
        const range = chunkedRange(fixture.path, fixture.offset, fixture.encoded, fixture.sizes);

        expect(await drain(range.source)).toBe("Wikipedia");
    });

    /*
     * Bodies big enough that the platform's own windows land in several places.
     *
     * Worth having, and NOT sufficient — see "adversarial windows" below. Bun
     * hands a small payload over in a single read, so on its own this exercises no
     * boundary at all: with only these tests, breaking the split-CRLF handling
     * changed nothing and all ten still passed.
     */
    test("survives the platform's own read windows", async () => {
        const cases: [string, string[]][] = [
            ["one-byte-chunks", Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26)))],
            ["long-single", ["x".repeat(300_000)]],
            ["mixed", ["a".repeat(7), "b".repeat(100_000), "c", "d".repeat(65_536)]],
            ["hex-sizes", ["y".repeat(255), "z".repeat(4096)]],
        ];

        for (const [name, pieces] of cases) {
            const fixture = await encode(name, pieces);
            const range = chunkedRange(fixture.path, fixture.offset, fixture.encoded, fixture.sizes);

            const got = await drain(range.source);

            expect(got.length).toBe(fixture.decoded.length);
            expect(got).toBe(fixture.decoded);
        }
    }, 60_000);

    test("a single empty chunk decodes to nothing", async () => {
        const fixture = await encode("empty", [""]);
        const range = chunkedRange(fixture.path, fixture.offset, fixture.encoded, fixture.sizes);

        expect(range.source.size).toBe(0);
        expect(await drain(range.source)).toBe("");
    });

    test("stops at the last known chunk and never emits the terminator", async () => {
        const fixture = await encode("terminated", ["abc"]);
        const range = chunkedRange(fixture.path, fixture.offset, fixture.encoded, fixture.sizes);

        // "0\r\n\r\n" follows the data in the file. It is framing, and a
        // de-chunker that walked past its own chunk list would include it.
        expect(await drain(range.source)).toBe("abc");
    });

    /*
     * The test that actually exercises the state machine.
     *
     * Reading from a file gives whatever windows Bun chooses, which for a small
     * payload is one — so nothing above splits a size line, a chunk, or the two
     * bytes of a CRLF. Verified by mutation: with only the tests above, dropping
     * the carried `\r` at a window boundary broke nothing and all ten passed.
     *
     * So the windows are chosen here instead. One byte at a time puts a boundary
     * at EVERY position, which is the only way to be sure the carry works; the
     * larger sizes are there because a bug can need two bytes to show up.
     */
    const windowed = (bytes: Uint8Array, window: number) => ({
        stream: () => {
            let at = 0;

            return new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (at >= bytes.length) {
                        controller.close();

                        return;
                    }

                    controller.enqueue(bytes.subarray(at, Math.min(at + window, bytes.length)));
                    at += window;
                },
            });
        },
    });

    test("adversarial windows: a boundary at every byte", async () => {
        const pieces = ["Wiki", "pedia", "!".repeat(300), "x"];
        const fixture = await encode("adversarial", pieces);

        const encoded = new Uint8Array(await Bun.file(fixture.path)
            .slice(fixture.offset, fixture.offset + fixture.encoded).arrayBuffer());

        for (const window of [1, 2, 3, 4, 5, 7, 13, 64, 1024]) {
            const stream = dechunkingStream(windowed(encoded, window), fixture.sizes);
            const got = await drain({ stream: () => stream });

            expect(got).toBe(fixture.decoded);
        }
    }, 60_000);

    test("a size line split across two reads", async () => {
        // Chunk lengths whose hex is two digits, so the size line itself is long
        // enough to be cut in half.
        const fixture = await encode("split-size", ["a".repeat(255), "b".repeat(4096)]);

        const encoded = new Uint8Array(await Bun.file(fixture.path)
            .slice(fixture.offset, fixture.offset + fixture.encoded).arrayBuffer());

        for (const window of [1, 2, 3]) {
            const got = await drain({
                stream: () => dechunkingStream(windowed(encoded, window), fixture.sizes),
            });

            expect(got).toBe(fixture.decoded);
        }
    });

    // `slice` cannot answer for a decoded view, and saying so is better than
    // returning framing bytes that still open as a file.
    test("slice refuses rather than answering wrongly", async () => {
        const fixture = await encode("noslice", ["abc"]);
        const range = chunkedRange(fixture.path, fixture.offset, fixture.encoded, fixture.sizes);

        expect(range.source.sequential).toBe(true);
        expect(() => range.source.slice(0, 3)).toThrow(/sequential/);
    });
});

describe("a chunked entry in a real archive", () => {
    const rowFor = (fixture: Awaited<ReturnType<typeof encode>>): PayloadRow => ({
        warc_custom_id: "rec-chunked",
        uri: "https://site.test/chunked.txt",
        file_path: fixture.path,
        byte_offset: fixture.offset,
        // The ENCODED length, which is what payloads.byte_length holds.
        byte_length: fixture.encoded,
        chunks: fixture.sizes,
        content_type: "text/plain",
        archived_date: "2026-06-22T22:16:51.890Z",
    });

    test("is stored, not skipped", async () => {
        const fixture = await encode("entry", ["Wiki", "pedia"]);
        const made = toEntry(rowFor(fixture), "rec-chunked", "id");

        expect(made.status.status).toBe("stored");
        expect(made.entry).toBeTruthy();
        // The manifest reports the decoded size, or it would disagree with the zip.
        expect(made.status.size).toBe(9);
        expect(made.status.detail).toContain("2 chunks");
    });

    /*
     * The invariant that makes this safe to ship: the writer verifies that a
     * source produced exactly the bytes it declared. A de-chunker off by one would
     * fail here rather than writing a zip whose central directory disagrees with
     * its data — which is corruption that opens.
     */
    test("the writer's own size check passes, which is the real proof", async () => {
        const fixture = await encode("verified", ["a".repeat(1000), "b".repeat(2000), "c"]);
        const made = toEntry(rowFor(fixture), "rec-chunked", "id");

        let written = 0;

        const total = await writeStoredZip(
            new WritableStream({ write: (chunk) => { written += chunk.length; } }),
            [made.entry!],
        );

        expect(written).toBe(total);
    });

    test("Python reads the entry back as the decoded body", async () => {
        const fixture = await encode("python", ["Hello, ", "chunked ", "world"]);
        const made = toEntry(rowFor(fixture), "rec-chunked", "id");

        const parts: Uint8Array[] = [];

        const total = await writeStoredZip(
            new WritableStream({ write: (chunk) => { parts.push(new Uint8Array(chunk)); } }),
            [made.entry!],
        );

        const zip = new Uint8Array(total);
        let at = 0;
        for (const part of parts) { zip.set(part, at); at += part.length; }

        const path = `${DIR}/chunked.zip`;
        await Bun.write(path, zip);

        const result = Bun.spawnSync(["python3", "-c", `
import json, zipfile
with zipfile.ZipFile(${JSON.stringify(path)}) as a:
    name = a.namelist()[0]
    print(json.dumps({"bad": a.testzip(), "body": a.read(name).decode()}))
`]);

        const seen = JSON.parse(result.stdout.toString().trim());

        // An independent implementation agrees the crc is right and the bytes are
        // the body — not the framing, and not the framing plus the body.
        expect(seen.bad).toBeNull();
        expect(seen.body).toBe("Hello, chunked world");
    });

    test("a chunked row pointing past the end of the file is a short-read", async () => {
        const fixture = await encode("short", ["abc"]);

        const made = toEntry({
            ...rowFor(fixture),
            byte_length: fixture.encoded + 10_000,
        }, "rec-chunked", "id");

        expect(made.entry).toBeNull();
        expect(made.status.status).toBe("short-read");
        expect(made.status.detail).toContain("encoded bytes");
    });
});
