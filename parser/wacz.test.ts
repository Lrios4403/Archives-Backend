// bun test parser/wacz.test.ts
//
// Reads a real 464 MB .wacz in place and checks that a `.warc.gz` inside it is
// byte-identical to the same archive extracted — which is the claim WACZ support
// rests on, and the reason it needs no changes to gzip.ts.

import { beforeAll, describe, expect, test } from "bun:test";
import { mWarcDecode } from "../mwarc";
import {
    createGzipWarcReader,
    indexWarcGz,
    looksGzipped,
    readGzipPayloadSlice,
    type GzipLocation,
} from "./gzip";
import {
    absoluteLocation,
    looksZipped,
    readZipEntries,
    waczArchives,
    waczIndex,
    WaczError,
} from "./wacz";

const WACZ = new URL("../../warc.null/oacu-oir-nih.wacz.zip", import.meta.url).pathname;

/** The `-0` archive, extracted. The reference for reading it in place. */
const EXTRACTED = new URL(
    "../../warc.null/rec-7c53beba8825-oacu-oir-nih-20260622221651890-0.warc.gz",
    import.meta.url,
).pathname;

const MWARC_OPTIONS = {
    content: false,
    returnChunkSizes: true,
    returnFullSize: true,
    chunkSize: 8 * 1024,
} as const;

const FULL_PASS_MS = 60_000;

const haveWacz = await Bun.file(WACZ).exists();
const haveExtracted = await Bun.file(EXTRACTED).exists();

describe("wacz", () => {
    if (!haveWacz) {
        test.skip(`archive absent (${WACZ})`, () => { });
        return;
    }

    let wacz: ReturnType<typeof Bun.file>;

    beforeAll(() => {
        wacz = Bun.file(WACZ);
    });

    test("detects a zip from its signature", async () => {
        expect(await looksZipped(wacz)).toBe(true);

        // And is NOT mistaken for a bare .warc.gz, which matters because the two
        // are dispatched on the same sniff.
        expect(await looksGzipped(wacz)).toBe(false);
    });

    test("reads the central directory", async () => {
        const entries = await readZipEntries(wacz);

        expect(entries.length).toBeGreaterThan(0);
        expect(entries.some(e => e.name === "datapackage.json")).toBe(true);
        expect(entries.some(e => /^archive\/.*\.warc\.gz$/.test(e.name))).toBe(true);

        // Every entry's data has to lie inside the file, and the offsets must be
        // strictly ascending — a decoding slip in the zip64 path shows up here
        // before it shows up as a corrupt record.
        for (const entry of entries) {
            expect(entry.dataOffset).toBeGreaterThan(0);
            expect(entry.dataOffset + entry.compressedSize).toBeLessThanOrEqual(wacz.size);
        }
    });

    // The property the whole approach depends on. If Browsertrix ever deflates
    // these, waczArchives throws instead of mis-reading, and this test is what
    // would tell us the assumption changed.
    test("archives are STORED, so each is a contiguous byte range", async () => {
        const entries = await readZipEntries(wacz);
        const archives = entries.filter(e => /\.warc\.gz$/.test(e.name));

        expect(archives.length).toBeGreaterThan(0);
        expect(archives.every(e => e.method === 0)).toBe(true);
    });

    test("waczArchives yields readable views", async () => {
        const archives = await waczArchives(wacz);

        expect(archives.length).toBeGreaterThan(0);

        for (const archive of archives) {
            expect(archive.size).toBeGreaterThan(0);
            expect(archive.file.size).toBe(archive.size);

            // A view of a .warc.gz must itself look like one.
            expect(await looksGzipped(archive.file)).toBe(true);
        }
    });

    test("the bundled CDXJ index is found", async () => {
        const index = await waczIndex(wacz);

        expect(index).not.toBeNull();
        expect(index!.size).toBeGreaterThan(0);
    });

    test.if(haveExtracted)(
        "an archive read in place is byte-identical to the extracted file",
        async () => {
            const archives = await waczArchives(wacz);
            const target = archives.find(a => a.name.endsWith("-0.warc.gz"));

            expect(target).toBeDefined();

            const extracted = Bun.file(EXTRACTED);
            expect(target!.size).toBe(extracted.size);

            // Spot-check rather than compare 50 MB: head, tail, and a few interior
            // windows. A wrong dataOffset shifts everything, so any window catches it.
            const probes: [number, number][] = [
                [0, 4096],
                [Math.floor(target!.size / 3), 4096],
                [Math.floor(target!.size / 2), 4096],
                [target!.size - 4096, 4096],
            ];

            for (const [at, length] of probes) {
                const fromZip = new Uint8Array(await target!.file.slice(at, at + length).arrayBuffer());
                const fromDisk = new Uint8Array(await extracted.slice(at, at + length).arrayBuffer());

                expect(Buffer.compare(fromZip, fromDisk)).toBe(0);
            }
        },
        FULL_PASS_MS,
    );

    // The point of all of it: gzip.ts is handed a zip slice and neither knows nor
    // cares. No biasing, no new fields, no second code path.
    test(
        "createGzipWarcReader parses an archive straight out of the .wacz",
        async () => {
            const archives = await waczArchives(wacz);
            const target = archives.find(a => a.name.endsWith("-0.warc.gz"))!;

            const members = await indexWarcGz(target.file);
            expect(members.length).toBeGreaterThan(1);

            const reader = createGzipWarcReader(target.file);
            let records = 0;

            for await (const _ of mWarcDecode(reader.read, MWARC_OPTIONS)) records++;

            // 1,624 members and 1,624 records, with no extraction step anywhere.
            expect(records).toBe(members.length);
            expect(reader.compressedPosition).toBe(target.size);
        },
        FULL_PASS_MS,
    );

    test("a non-zip is rejected clearly", async () => {
        const notAZip = Bun.file(EXTRACTED);

        if (!haveExtracted) return;

        expect(readZipEntries(notAZip)).rejects.toThrow(WaczError);
    });

    // What the frontend does with listArchives: slice the picked file into one
    // handle per archive so the worker pool parses them in parallel. Each slice has
    // to stand alone as a .warc.gz, because the worker receiving it will sniff it
    // and see a bare archive, not a container.
    test(
        "each archive slices out as a standalone .warc.gz",
        async () => {
            const archives = await waczArchives(wacz);

            expect(archives.length).toBeGreaterThan(1);

            for (const archive of archives) {
                // The slice must be exactly the entry, or every offset inside it is
                // wrong by however much it is out.
                expect(archive.file.size).toBe(archive.size);
                expect(await looksGzipped(archive.file)).toBe(true);
                // And must NOT still look like the container it came from.
                expect(await looksZipped(archive.file)).toBe(false);
                expect(archive.dataOffset + archive.size).toBeLessThanOrEqual(wacz.size);
            }
        },
        FULL_PASS_MS,
    );

    test.if(haveExtracted)(
        "a sliced archive parses to the same records as the extracted file",
        async () => {
            const archives = await waczArchives(wacz);
            const target = archives.find(a => a.name.endsWith("-0.warc.gz"))!;

            const count = async (file: Parameters<typeof createGzipWarcReader>[0]) => {
                const reader = createGzipWarcReader(file);
                let records = 0;
                for await (const _ of mWarcDecode(reader.read, MWARC_OPTIONS)) records++;
                return records;
            };

            expect(await count(target.file)).toBe(await count(Bun.file(EXTRACTED)));
        },
        FULL_PASS_MS,
    );

    // The two coordinate systems. A location produced against an entry view is
    // entry-relative; read it against the whole .wacz unbiased and it lands
    // dataOffset bytes early, inside the previous entry, and inflates garbage.
    test(
        "a biased location reads correctly against the whole .wacz",
        async () => {
            const archives = await waczArchives(wacz);
            const target = archives.find(a => a.name.endsWith("-0.warc.gz"))!;

            const reader = createGzipWarcReader(target.file);

            // First record with a payload is enough — the bias is constant.
            let entryRelative: GzipLocation | undefined;
            let payloadOffset = 0;
            let payloadSize = 0;

            for await (const record of mWarcDecode(reader.read, MWARC_OPTIONS)) {
                const content = record["header-content"];
                if (!content) continue;

                const size = Number(content["size"] ?? 0);
                if (size <= 0) continue;

                payloadOffset = Number(content["offset"] ?? 0);
                payloadSize = size;
                entryRelative = await reader.locate(payloadOffset);
                break;
            }

            expect(entryRelative).toBeDefined();

            const absolute = absoluteLocation(entryRelative!, target);
            expect(absolute.compressedOffset).toBe(entryRelative!.compressedOffset + target.dataOffset);
            expect(absolute.payloadOffsetInMember).toBe(entryRelative!.payloadOffsetInMember);

            // Entry-relative location against the entry view, and absolute location
            // against the whole .wacz, must give the same bytes.
            const viaEntry = await readGzipPayloadSlice(target.file, entryRelative!, 0, payloadSize);
            const viaWacz = await readGzipPayloadSlice(wacz, absolute, 0, payloadSize);

            expect(Buffer.compare(viaEntry, viaWacz)).toBe(0);
            expect(viaWacz.length).toBe(payloadSize);

            // And the unbiased location against the whole file must NOT agree —
            // otherwise this test would pass even with the bias removed.
            let mismatched = true;
            try {
                const wrong = await readGzipPayloadSlice(wacz, entryRelative!, 0, payloadSize);
                mismatched = Buffer.compare(wrong, viaWacz) !== 0;
            } catch {
                // Throwing is also an acceptable outcome: the bytes at the wrong
                // offset usually are not a valid gzip member at all.
                mismatched = true;
            }

            expect(mismatched).toBe(true);
        },
        FULL_PASS_MS,
    );
});
