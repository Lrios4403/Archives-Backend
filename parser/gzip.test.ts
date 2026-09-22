// bun test parser/gzip.test.ts
//
// Reads a real Browsertrix .warc.gz and checks the gzip reader against an
// independently-derived reference: every member inflated on its own with
// gunzipSync and concatenated. That is a different code path from the streaming
// Gunzip the reader uses, so agreement between them means something — unlike
// comparing the reader to itself.
//
// The shared fixture is built lazily and memoised rather than in beforeAll,
// because inflating and parsing 77 MB takes ~5 s and bun's beforeAll times out at
// 5 s with no way to raise it: its type signature takes the callback only, so
// passing a timeout runs but fails `tsc --noEmit`. A lazy fixture lets each test
// declare its own timeout, which is the thing bun does support.
//
// Skips cleanly when the archive is absent, so a checkout without warc.null still
// runs the suite.

import { describe, expect, test } from "bun:test";
import { gunzipSync } from "fflate";
import { mWarcDecode } from "../mwarc";
import {
    createGzipWarcReader,
    GzipReadError,
    indexWarcGz,
    isSingleMember,
    looksGzipped,
    readGzipPayloadSlice,
    type GzipLocation,
    type GzipMember,
} from "./gzip";

const ARCHIVE = new URL(
    "../../warc.null/rec-7c53beba8825-oacu-oir-nih-20260622221651890-0.warc.gz",
    import.meta.url,
).pathname;

/** A plain .warc, for the "not gzipped" half of the detection test. */
const PLAIN = new URL("../../warc.null/nekoweb.warc", import.meta.url).pathname;

const MWARC_OPTIONS = {
    content: false,
    returnChunkSizes: true,
    returnFullSize: true,
    chunkSize: 8 * 1024,
} as const;

/** Long enough to inflate and parse a 50 MB archive; bun's default is 5 s. */
const SLOW_MS = 60_000;

interface Located {
    payloadOffset: number;
    payloadSize: number;
    chunks?: number[];
    location: GzipLocation;
}

interface Fixture {
    gz: ReturnType<typeof Bun.file>;
    members: GzipMember[];
    /** The whole archive, inflated member by member. The reference. */
    reference: Uint8Array;
    /** Record starts, from parsing through the gzip reader. */
    recordStarts: number[];
    /** Every record with a payload, and where the reader says its bytes are. */
    located: Located[];
}

const build = async (): Promise<Fixture> => {
    const gz = Bun.file(ARCHIVE);
    const members = await indexWarcGz(gz);

    const raw = new Uint8Array(await gz.arrayBuffer());
    const total = members.reduce((sum, m) => sum + m.uncompressedLength, 0);
    const reference = new Uint8Array(total);

    for (const member of members) {
        const frame = raw.subarray(
            member.compressedOffset,
            member.compressedOffset + member.compressedLength,
        );

        reference.set(gunzipSync(frame), member.uncompressedOffset);
    }

    // One pass, collecting everything the tests need.
    const reader = createGzipWarcReader(gz);
    const recordStarts: number[] = [];
    const located: Located[] = [];

    for await (const record of mWarcDecode(reader.read, MWARC_OPTIONS)) {
        const warc = record["header-warc"];
        const content = record["header-content"];

        recordStarts.push(Number(warc["offset"] ?? 0));

        if (!content) continue;

        const payloadOffset = Number(content["offset"] ?? 0);
        const payloadSize = Number(content["size"] ?? 0);

        if (payloadSize <= 0) continue;

        const location = await reader.locate(payloadOffset);
        if (!location) throw new Error(`no location for payload at ${payloadOffset}`);

        located.push({
            payloadOffset,
            payloadSize,
            chunks: Array.isArray(content["chunks"]) ? content["chunks"] as number[] : undefined,
            location,
        });
    }

    return { gz, members, reference, recordStarts, located };
};

let fixture: Promise<Fixture> | null = null;

/** Built once, on whichever test needs it first. */
const setup = (): Promise<Fixture> => (fixture ??= build());

const present = await Bun.file(ARCHIVE).exists();

describe("gzip .warc.gz reader", () => {
    if (!present) {
        test.skip(`archive absent (${ARCHIVE})`, () => { });
        return;
    }

    test("detects gzip from the bytes, not the file name", async () => {
        expect(await looksGzipped(Bun.file(ARCHIVE))).toBe(true);
        expect(await looksGzipped(Bun.file(PLAIN))).toBe(false);
    });

    test("is not a single-member .gz", async () => {
        expect(await isSingleMember(Bun.file(ARCHIVE))).toBe(false);
    });

    test("a record-compressed archive is not flagged single-member", async () => {
        const { gz } = await setup();
        const reader = createGzipWarcReader(gz);

        // False before the stream ends, because a large first member and a single
        // member are indistinguishable until then.
        expect(reader.singleMember).toBe(false);

        for (;;) {
            const block = await reader.read(reader.uncompressedPosition, 1 << 20);
            if (!block || block.byteLength === 0) break;
        }

        expect(reader.done).toBe(true);
        expect(reader.singleMember).toBe(false);
    }, SLOW_MS);

    // `gzip whole.warc` rather than record-at-a-time. It parses correctly and then
    // makes every payload read re-inflate the entire archive, so it has to be
    // detectable — and it was written and left unwired until this test existed.
    test("a single-member .gz IS flagged", async () => {
        const { reference } = await setup();
        const { gzipSync } = await import("fflate");

        const single = gzipSync(reference.subarray(0, 2 << 20), { level: 1 });
        const file = new Blob([single]) as unknown as Parameters<typeof createGzipWarcReader>[0];

        const reader = createGzipWarcReader(file);

        for (;;) {
            const block = await reader.read(reader.uncompressedPosition, 1 << 20);
            if (!block || block.byteLength === 0) break;
        }

        expect(reader.done).toBe(true);
        expect(reader.members.length).toBe(1);
        expect(reader.singleMember).toBe(true);
        expect(await isSingleMember(file)).toBe(true);
    }, SLOW_MS);

    test("the index is contiguous and covers the whole file in both spaces", async () => {
        const { members, gz } = await setup();

        expect(members.length).toBeGreaterThan(1);
        expect(members.reduce((sum, m) => sum + m.compressedLength, 0)).toBe(gz.size);

        for (let i = 1; i < members.length; i++) {
            const previous = members[i - 1]!;
            const current = members[i]!;

            expect(previous.compressedOffset + previous.compressedLength)
                .toBe(current.compressedOffset);
            expect(previous.uncompressedOffset + previous.uncompressedLength)
                .toBe(current.uncompressedOffset);
        }
    }, SLOW_MS);

    // The 1:1 record<->member property the whole design rests on. Exact on real
    // Browsertrix output.
    test("every record starts exactly on a member boundary", async () => {
        const { members, recordStarts } = await setup();
        const starts = new Set(members.map(m => m.uncompressedOffset));

        expect(recordStarts.length).toBe(members.length);
        expect(recordStarts.every(offset => starts.has(offset))).toBe(true);
    }, SLOW_MS);

    test("no payload spills past its own member", async () => {
        const { members, located } = await setup();

        const spilling = located.filter(entry => {
            const member = members.findLast(m => m.uncompressedOffset <= entry.payloadOffset)!;

            return entry.payloadOffset - member.uncompressedOffset + entry.payloadSize
                > member.uncompressedLength;
        });

        expect(spilling).toEqual([]);
    }, SLOW_MS);

    // The differential test, and the one worth most: mWarcDecode over the gzip
    // reader must see byte for byte what it sees over the plain archive.
    test("every read matches the decompressed archive", async () => {
        const { gz, reference, recordStarts } = await setup();
        const reader = createGzipWarcReader(gz);

        let wrongReads = 0;
        let records = 0;

        const checked = async (start: number, size: number): Promise<ArrayBuffer | null> => {
            const buffer = await reader.read(start, size);

            if (buffer && buffer.byteLength > 0) {
                const got = new Uint8Array(buffer);

                if (Buffer.compare(got, reference.subarray(start, start + got.length)) !== 0) {
                    wrongReads++;
                }
            }

            return buffer;
        };

        for await (const _ of mWarcDecode(checked, MWARC_OPTIONS)) records++;

        expect(wrongReads).toBe(0);
        expect(records).toBe(recordStarts.length);
        expect(reader.compressedPosition).toBe(gz.size);
        expect(reader.uncompressedPosition).toBe(reference.length);
        expect(reader.done).toBe(true);
    }, SLOW_MS);

    test("locate() resolves a usable location for every record with a payload", async () => {
        const { members, located } = await setup();

        expect(located.length).toBeGreaterThan(0);
        expect(located.every(e => e.location.compressedLength > 0)).toBe(true);
        expect(located.every(e => e.location.payloadOffsetInMember >= 0)).toBe(true);

        // Every location must name a member that actually exists.
        const starts = new Set(members.map(m => m.compressedOffset));
        expect(located.every(e => starts.has(e.location.compressedOffset))).toBe(true);
    }, SLOW_MS);

    test("readGzipPayloadSlice returns the same bytes, cold and out of order", async () => {
        const { gz, reference, located } = await setup();

        // Shuffled, because retrieval never happens in parse order — a view reads
        // whichever subresource the page references next.
        const sample = located
            .map(entry => ({ entry, key: Math.random() }))
            .sort((a, b) => a.key - b.key)
            .slice(0, 60)
            .map(s => s.entry);

        for (const { location, payloadOffset: offset, payloadSize: size } of sample) {
            const whole = await readGzipPayloadSlice(gz, location, 0, size);
            expect(Buffer.compare(whole, reference.subarray(offset, offset + size))).toBe(0);

            // A mid-payload range, which is what a Range request becomes.
            if (size > 64) {
                const from = 17;
                const to = Math.min(size, 17 + 41);
                const part = await readGzipPayloadSlice(gz, location, from, to);

                expect(Buffer.compare(part, reference.subarray(offset + from, offset + to))).toBe(0);
            }
        }
    }, SLOW_MS);

    // The descriptor crosses postMessage twice (fflate.warc.gz.md §6). A class
    // instance, a getter or a method would be dropped silently.
    test("a GzipLocation survives structuredClone and still reads", async () => {
        const { gz, reference, located } = await setup();
        const entry = located[0]!;

        const cloned = structuredClone(entry.location);
        expect(cloned).toEqual(entry.location);

        const bytes = await readGzipPayloadSlice(gz, cloned, 0, entry.payloadSize);
        const want = reference.subarray(entry.payloadOffset, entry.payloadOffset + entry.payloadSize);

        expect(Buffer.compare(bytes, want)).toBe(0);
    }, SLOW_MS);

    test("a payload running past its member throws rather than truncating", async () => {
        const { gz, located } = await setup();
        const bogus: GzipLocation = { ...located[0]!.location, payloadOffsetInMember: 1 << 30 };

        expect(readGzipPayloadSlice(gz, bogus, 0, 16)).rejects.toThrow(GzipReadError);
    }, SLOW_MS);

    // Loud, not quietly quadratic: a too-far-back read must not silently restart
    // the stream from the last member boundary.
    test("reading behind the retained window throws", async () => {
        const reader = createGzipWarcReader(Bun.file(ARCHIVE), { historyBytes: 1024 });

        await reader.read(0, 64);
        await reader.read(900_000, 64);

        expect(reader.read(0, 64)).rejects.toThrow(GzipReadError);
    });
});
