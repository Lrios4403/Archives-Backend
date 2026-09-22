// bun test parser/payload.test.ts
//
// The wire chain, end to end: parse -> toWire -> structuredClone -> readPayload.
//
// gzip.test.ts proves the reader returns the right bytes. This proves the LOCATION
// survives the trip to the frontend and back, which is a separate failure mode and
// a silent one — a dropped `payload.gzip` does not throw, it renders compressed
// bytes as a document. §6 of fflate.warc.gz.md is what this covers.

import { describe, expect, test } from "bun:test";
import { gunzipSync, gzipSync } from "fflate";
import { mWarcDecode, type WarcRecord } from "../mwarc";
import { createGzipWarcReader, indexWarcGz, looksGzipped, type GzipLocation } from "./gzip";
import { absoluteLocation, waczArchives } from "./wacz";
import { readPayload, type ViewRecord } from "./view";
// From wire.ts, NOT worker.entry.ts. The entry must export no runtime value —
// a top-level `export` in the bundle is a SyntaxError in the classic worker it is
// loaded as, and importing these from there is what caused that. See wire.ts.
import { resolveSources, toWire } from "./wire";

const GZ = new URL(
    "../../warc.null/rec-7c53beba8825-oacu-oir-nih-20260622221651890-0.warc.gz",
    import.meta.url,
).pathname;
const PLAIN = new URL("../../warc.null/nekoweb.warc", import.meta.url).pathname;
const WACZ = new URL("../../warc.null/oacu-oir-nih.wacz.zip", import.meta.url).pathname;

const MWARC_OPTIONS = {
    content: false,
    returnChunkSizes: true,
    returnFullSize: true,
    chunkSize: 8 * 1024,
} as const;

const SLOW_MS = 60_000;

const haveGz = await Bun.file(GZ).exists();
const havePlain = await Bun.file(PLAIN).exists();
const haveWacz = await Bun.file(WACZ).exists();

/** A ViewRecord carrying only what readPayload reads. */
const viewRecord = (
    file: ViewRecord["file"],
    payload: NonNullable<ViewRecord["payload"]>,
): ViewRecord => ({ url: "http://example.invalid/", file, payload } as ViewRecord);

// ---------------------------------------------------------------------------
// resolveSources — what a selected file turns out to contain
// ---------------------------------------------------------------------------

describe("resolveSources", () => {
    test.if(havePlain)("a plain .warc is one ungzipped source", async () => {
        const sources = await resolveSources(Bun.file(PLAIN), "nekoweb.warc");

        expect(sources.length).toBe(1);
        expect(sources[0]!.gzipped).toBe(false);
        expect(sources[0]!.dataOffset).toBe(0);
    });

    test.if(haveGz)("a .warc.gz is one gzipped source", async () => {
        const sources = await resolveSources(Bun.file(GZ), "x.warc.gz");

        expect(sources.length).toBe(1);
        expect(sources[0]!.gzipped).toBe(true);
        expect(sources[0]!.dataOffset).toBe(0);
    });

    test.if(haveWacz)("a .wacz is several gzipped sources at ascending offsets", async () => {
        const sources = await resolveSources(Bun.file(WACZ), "x.wacz");

        expect(sources.length).toBeGreaterThan(1);
        expect(sources.every(s => s.gzipped)).toBe(true);
        expect(sources.every(s => s.dataOffset > 0)).toBe(true);

        // Ascending, which is what makes `dataOffset + compressedPosition` a
        // monotonic progress figure across the whole container.
        const offsets = sources.map(s => s.dataOffset);
        expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);

        // Each source is a real slice, not the whole zip.
        expect(sources.every(s => s.file.size < Bun.file(WACZ).size)).toBe(true);
    }, SLOW_MS);
});

// ---------------------------------------------------------------------------
// toWire — the descriptor going out
// ---------------------------------------------------------------------------

describe("toWire", () => {
    const record: WarcRecord = {
        "header-warc": { "WARC-Type": "response", "WARC-Target-URI": "<http://a/b>", offset: 100 },
        "header-meta": { statusCode: "200", "Content-Type": "text/html" },
        "header-content": { content: null, offset: 400, size: 900, chunks: [10, 20] },
    };

    const location: GzipLocation = {
        compressedOffset: 1234,
        compressedLength: 567,
        payloadOffsetInMember: 89,
    };

    test("omits gzip when there is none", () => {
        const wire = toWire(record);

        expect(wire.payload).toBeDefined();
        expect(wire.payload!.gzip).toBeUndefined();
        expect(wire.payload!.offset).toBe(400);
    });

    test("passes gzip through unchanged", () => {
        const wire = toWire(record, location);

        expect(wire.payload!.gzip).toEqual(location);
    });

    test("survives structuredClone with the location intact", () => {
        const wire = structuredClone(toWire(record, location));

        expect(wire.payload!.gzip).toEqual(location);
    });

    // The rule the wire shape exists to enforce: headers cross, bytes never do.
    test("never carries payload bytes", () => {
        const withBytes: WarcRecord = {
            ...record,
            "header-content": { ...record["header-content"], content: new ArrayBuffer(64) },
        };

        const wire = toWire(withBytes, location);

        expect(JSON.stringify(wire)).not.toContain("content");
        expect((wire.payload as Record<string, unknown>)["content"]).toBeUndefined();
    });

    test("unwraps an angle-bracketed target uri", () => {
        expect(toWire(record).url).toBe("http://a/b");
    });
});

// ---------------------------------------------------------------------------
// readPayload — the descriptor coming back
// ---------------------------------------------------------------------------

describe("readPayload", () => {
    test.if(havePlain)("plain path is identical to a direct slice", async () => {
        const file = Bun.file(PLAIN);
        const read = (start: number, length: number) =>
            file.slice(start, start + length).arrayBuffer();

        let checked = 0;

        for await (const record of mWarcDecode(read, MWARC_OPTIONS)) {
            const content = record["header-content"];
            if (!content) continue;

            const offset = Number(content["offset"] ?? 0);
            const size = Number(content["size"] ?? 0);
            if (size <= 0) continue;

            const chunks = Array.isArray(content["chunks"]) ? content["chunks"] as number[] : undefined;
            const bytes = await readPayload(viewRecord(file, { offset, size, chunks, digest: null }));

            // Compared against the raw slice, de-chunked the same way — so this
            // asserts the gzip branch was not taken, not just that it read.
            const raw = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
            const want = chunks && chunks.length > 0
                ? (await import("./view")).dechunkBody(raw, chunks)
                : raw;

            expect(Buffer.compare(bytes, want)).toBe(0);

            if (++checked >= 200) break;
        }

        expect(checked).toBeGreaterThan(0);
    }, SLOW_MS);

    test.if(haveGz)("gzip path matches the decompressed archive", async () => {
        const file = Bun.file(GZ);

        // Reference: every member inflated on its own. A different code path from
        // the streaming reader used to parse.
        const members = await indexWarcGz(file);
        const raw = new Uint8Array(await file.arrayBuffer());
        const reference = new Uint8Array(members.reduce((n, m) => n + m.uncompressedLength, 0));

        for (const member of members) {
            reference.set(
                gunzipSync(raw.subarray(member.compressedOffset, member.compressedOffset + member.compressedLength)),
                member.uncompressedOffset,
            );
        }

        const reader = createGzipWarcReader(file);
        let checked = 0;

        for await (const record of mWarcDecode(reader.read, MWARC_OPTIONS)) {
            const content = record["header-content"];
            if (!content) continue;

            const offset = Number(content["offset"] ?? 0);
            const size = Number(content["size"] ?? 0);
            if (size <= 0) continue;

            const gzip = await reader.locate(offset);
            expect(gzip).toBeDefined();

            // Through the full wire hop, clone included, exactly as the frontend
            // would hand it back.
            const wire = structuredClone(toWire(record, gzip!));
            const chunks = wire.payload!.chunks;

            const bytes = await readPayload(viewRecord(file, {
                offset: wire.payload!.offset,
                size: wire.payload!.size,
                chunks,
                digest: null,
                gzip: wire.payload!.gzip,
            }));

            const slice = reference.subarray(offset, offset + size);
            const want = chunks && chunks.length > 0
                ? (await import("./view")).dechunkBody(slice, chunks)
                : slice;

            expect(Buffer.compare(bytes, want)).toBe(0);

            if (++checked >= 120) break;
        }

        expect(checked).toBeGreaterThan(0);
    }, SLOW_MS);

    // The silent failure this whole chain is built to avoid. Dropping the location
    // must not quietly produce a document made of compressed bytes.
    test.if(haveGz)("dropping payload.gzip yields compressed bytes, not the body", async () => {
        const file = Bun.file(GZ);
        const reader = createGzipWarcReader(file);

        for await (const record of mWarcDecode(reader.read, MWARC_OPTIONS)) {
            const content = record["header-content"];
            if (!content) continue;

            const offset = Number(content["offset"] ?? 0);
            const size = Number(content["size"] ?? 0);
            if (size <= 64) continue;

            const gzip = (await reader.locate(offset))!;

            const correct = await readPayload(viewRecord(file, { offset, size, digest: null, gzip }));
            const dropped = await readPayload(viewRecord(file, { offset, size, digest: null }));

            // Not equal — which is the point. Slicing a compressed file at a
            // logical offset returns something, and that something is wrong.
            expect(Buffer.compare(correct, dropped)).not.toBe(0);
            break;
        }
    }, SLOW_MS);

    test("a record with no payload reads as empty", async () => {
        const record = { url: "x", file: Bun.file(PLAIN), payload: null } as unknown as ViewRecord;

        expect((await readPayload(record)).length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Content-Encoding — the response's own compression, a separate axis from the
// archive's. Crawlers store what the server sent, so a gzip-encoded body is
// gzipped on disk, and a blob url carries no header to tell the browser that.
// ---------------------------------------------------------------------------

describe("readPayload content-encoding", () => {
    const body = new TextEncoder().encode("<html><body>hello hello hello</body></html>");

    /** A one-payload file holding exactly `bytes`. */
    const fileOf = (bytes: Uint8Array) => new Blob([bytes]) as unknown as ViewRecord["file"];

    const record = (bytes: Uint8Array, contentEncoding?: string | null): ViewRecord => ({
        url: "http://example.invalid/",
        file: fileOf(bytes),
        payload: { offset: 0, size: bytes.length, digest: null },
        contentEncoding,
    } as ViewRecord);

    test("gzip is inflated", async () => {
        const encoded = gzipSync(body);

        expect(Buffer.compare(await readPayload(record(encoded, "gzip")), body)).toBe(0);
    });

    test("x-gzip is inflated", async () => {
        expect(Buffer.compare(await readPayload(record(gzipSync(body), "x-gzip")), body)).toBe(0);
    });

    test("deflate is inflated", async () => {
        const { zlibSync } = await import("fflate");

        expect(Buffer.compare(await readPayload(record(zlibSync(body), "deflate")), body)).toBe(0);
    });

    test("case and whitespace do not matter", async () => {
        expect(Buffer.compare(await readPayload(record(gzipSync(body), "  GZip ")), body)).toBe(0);
    });

    test("identity and absent pass through untouched", async () => {
        expect(Buffer.compare(await readPayload(record(body, "identity")), body)).toBe(0);
        expect(Buffer.compare(await readPayload(record(body, null)), body)).toBe(0);
        expect(Buffer.compare(await readPayload(record(body)), body)).toBe(0);
    });

    // Serving the raw bytes is the old behaviour, so an encoding we cannot handle
    // is no worse than before — and one undecodable asset must not fail the page.
    test("an unsupported encoding serves raw rather than throwing", async () => {
        expect(Buffer.compare(await readPayload(record(body, "br")), body)).toBe(0);
    });

    test("a body that claims gzip but is not serves raw rather than throwing", async () => {
        expect(Buffer.compare(await readPayload(record(body, "gzip")), body)).toBe(0);
    });

    // The composition order the two axes require: member, then chunk framing, then
    // Content-Encoding, because that is the order they were applied in.
    test("chunked framing is stripped before the content-encoding decode", async () => {
        const encoded = gzipSync(body);
        const half = Math.floor(encoded.length / 2);

        // Two chunks of the ENCODED body, framed as Transfer-Encoding: chunked.
        const frame = (part: Uint8Array) => [
            new TextEncoder().encode(`${part.length.toString(16)}\r\n`),
            part,
            new TextEncoder().encode("\r\n"),
        ];

        const parts = [
            ...frame(encoded.subarray(0, half)),
            ...frame(encoded.subarray(half)),
            new TextEncoder().encode("0\r\n\r\n"),
        ];

        const total = parts.reduce((n, p) => n + p.length, 0);
        const raw = new Uint8Array(total);
        let at = 0;
        for (const part of parts) { raw.set(part, at); at += part.length; }

        const chunked: ViewRecord = {
            url: "http://example.invalid/",
            file: fileOf(raw),
            payload: { offset: 0, size: raw.length, chunks: [half, encoded.length - half], digest: null },
            contentEncoding: "gzip",
        } as ViewRecord;

        expect(Buffer.compare(await readPayload(chunked), body)).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// The .wacz hop, where two coordinate systems meet
// ---------------------------------------------------------------------------

describe.if(haveWacz)("payload location inside a .wacz", () => {
    test("only the biased location reads correctly against the whole container", async () => {
        const wacz = Bun.file(WACZ);
        const archives = await waczArchives(wacz);
        const target = archives.find(a => a.name.endsWith("-0.warc.gz"))!;

        expect(await looksGzipped(target.file)).toBe(true);

        const reader = createGzipWarcReader(target.file);

        for await (const record of mWarcDecode(reader.read, MWARC_OPTIONS)) {
            const content = record["header-content"];
            if (!content) continue;

            const offset = Number(content["offset"] ?? 0);
            const size = Number(content["size"] ?? 0);
            if (size <= 0) continue;

            const entryRelative = (await reader.locate(offset))!;
            const absolute = absoluteLocation(entryRelative, target);

            // Entry-relative against the entry, absolute against the container.
            const viaEntry = await readPayload(viewRecord(target.file, {
                offset, size, digest: null, gzip: entryRelative,
            }));
            const viaContainer = await readPayload(viewRecord(wacz, {
                offset, size, digest: null, gzip: absolute,
            }));

            expect(Buffer.compare(viaEntry, viaContainer)).toBe(0);
            expect(viaContainer.length).toBe(size);
            break;
        }
    }, SLOW_MS);
});
