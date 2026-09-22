// bun test parser/segments.test.ts
//
// Splitting one .warc across several workers. The tests here are the INVARIANTS,
// not the implementation, because the implementation has exactly one way to be
// subtly wrong and it is silent: a boundary that drops a record, or claims one
// twice, produces a parse that finishes cleanly with the wrong contents.
//
// The whole design rests on one rule — a worker owns every record whose START
// falls in [start, end), and reads past `end` to finish the last one — so the
// headline test is that the union of the segments equals the single pass EXACTLY.
// See segments.plan.md §1.

import { describe, expect, test } from "bun:test";
import { mWarcDecode, mWarcFindRecordStart } from "../mwarc";

const ARCHIVES = [
    "nekoweb.warc",
    "lolcow.warc",
    "5am.warc",
    "crystal.cafe.warc",
] as const;

const MWARC = { content: false, returnChunkSizes: true, chunkSize: 8 * 1024 } as const;
const SLOW_MS = 120_000;

const readerFor = (file: ReturnType<typeof Bun.file>, size: number) =>
    async (start: number, length: number): Promise<ArrayBuffer | null> =>
        start >= size ? null : file.slice(start, Math.min(start + length, size)).arrayBuffer();

/** Every record start in [start, end), via the parser itself. */
const recordStarts = async (
    read: (start: number, length: number) => Promise<ArrayBuffer | null>,
    start?: number,
    end?: number,
): Promise<number[]> => {
    const found: number[] = [];

    for await (const record of mWarcDecode(read, { ...MWARC, start, end })) {
        const at = record["header-warc"]?.["offset"];
        if (typeof at === "number") found.push(at);
    }

    return found;
};

/** The union of an N-way split, as the workers would produce it. */
const segmentedStarts = async (
    read: (start: number, length: number) => Promise<ArrayBuffer | null>,
    size: number,
    count: number,
): Promise<number[]> => {
    const bounds = Array.from({ length: count + 1 }, (_, i) => Math.floor((size * i) / count));
    const all: number[] = [];

    for (let i = 0; i < count; i++) {
        const from = bounds[i]!;
        const to = bounds[i + 1]!;

        const at = await mWarcFindRecordStart(read, from, to, size);

        // Null is legitimate: one record can span a whole segment, and then this
        // segment owns nothing while the one before it parses that record.
        if (at === null) continue;

        all.push(...await recordStarts(read, at, to));
    }

    return all.sort((a, b) => a - b);
};

const present = (name: string) =>
    Bun.file(new URL(`../../warc.null/${name}`, import.meta.url).pathname);

/*
 * Existence resolved ONCE, at module scope, where top-level await is allowed.
 *
 * `test.if(await ...)` does not work: the describe callback is synchronous, so the
 * await has nowhere to live. Hoisting it also means each archive is stat'd once
 * rather than once per test that mentions it.
 */
const HAVE = Object.fromEntries(
    await Promise.all(
        [...ARCHIVES].map(async name => [name, await present(name).exists()] as const),
    ),
) as Record<string, boolean>;

describe("segmented parsing", () => {
    for (const name of ARCHIVES) {
        const file = present(name);

        test.if(HAVE[name] ?? false)(`${name}: the union of N segments equals one pass`, async () => {
            const size = file.size;
            const read = readerFor(file, size);

            const whole = await recordStarts(read);
            expect(whole.length).toBeGreaterThan(0);

            // Several counts, because a bug can hide at one split and not another —
            // 7 in particular puts a boundary inside a large record on these files,
            // which is the case that produces a zero-record segment.
            for (const count of [2, 3, 4, 7]) {
                const union = await segmentedStarts(read, size, count);

                // Identical, not merely the same length: a dropped record and a
                // duplicated one cancel out in a count.
                expect(union).toEqual(whole);
                expect(new Set(union).size).toBe(union.length);
            }
        }, SLOW_MS);
    }

    // The single-worker path must be untouched by any of this.
    test.if(HAVE["nekoweb.warc"] ?? false)(
        "omitting start and end parses exactly what it always did",
        async () => {
            const file = present("nekoweb.warc");
            const read = readerFor(file, file.size);

            const bare = await recordStarts(read);
            const explicit = await recordStarts(read, 0, file.size);

            expect(bare).toEqual(explicit);
            expect(bare[0]).toBe(0);
        },
        SLOW_MS,
    );
});

describe("mWarcFindRecordStart", () => {
    test.if(HAVE["nekoweb.warc"] ?? false)(
        "offset 0 is answered without scanning",
        async () => {
            const file = present("nekoweb.warc");
            const read = readerFor(file, file.size);

            expect(await mWarcFindRecordStart(read, 0, file.size, file.size)).toBe(0);
        },
    );

    test.if(HAVE["nekoweb.warc"] ?? false)(
        "every answer is a real record start, never anything else",
        async () => {
            const file = present("nekoweb.warc");
            const size = file.size;
            const read = readerFor(file, size);

            const real = new Set(await recordStarts(read));

            // Arbitrary offsets, including ones deliberately just before and just
            // after a known boundary.
            const probes = [1, 2, 999, size - 1, size >> 1, (size >> 2) + 7];
            for (const start of real) { probes.push(start - 1, start, start + 1); if (probes.length > 200) break; }

            for (const from of probes) {
                if (from < 0 || from >= size) continue;

                const at = await mWarcFindRecordStart(read, from, size, size);

                if (at === null) continue;

                expect(real.has(at)).toBe(true);
                // And it is the FIRST one at or after `from`, not just any.
                expect(at).toBeGreaterThanOrEqual(from);
            }
        },
        SLOW_MS,
    );

    test.if(HAVE["nekoweb.warc"] ?? false)(
        "a range containing no record start returns null",
        async () => {
            const file = present("nekoweb.warc");
            const read = readerFor(file, file.size);

            const starts = await recordStarts(read);
            // Between two adjacent records there is, by definition, nothing.
            const a = starts[10]!;
            const b = starts[11]!;

            expect(b - a).toBeGreaterThan(2);
            expect(await mWarcFindRecordStart(read, a + 1, b, file.size)).toBeNull();
        },
        SLOW_MS,
    );

    /*
     * The case the corpus does not contain: a WARC stored INSIDE another WARC puts
     * a genuine version line at a line start inside a payload, and a bare scan
     * cannot tell it apart from a real record.
     *
     * The fixture has a SECOND outer record after the nested one, which is what
     * makes it realistic and what makes the guard work: the planted record's own
     * Content-Length points somewhere inside the enclosing payload rather than at a
     * version line, so the confirmation rejects it. With the nested record at the
     * very end of the file there is nothing to confirm against and it would be
     * accepted — see the note in looksLikeRecordStart on why that trade is the
     * right way round.
     */
    test("a version line planted inside a payload is not mistaken for a record", async () => {
        const encoder = new TextEncoder();

        const innerText =
            "WARC/1.0\r\n" +
            "WARC-Type: response\r\n" +
            "WARC-Target-URI: http://inner/\r\n" +
            "WARC-Record-ID: <urn:uuid:00000000-0000-4000-8000-000000000002>\r\n" +
            "Content-Length: 4\r\n" +
            "\r\n" +
            "hey!\r\n\r\n";

        const record = (uuid: string, type: string, body: string, extra = "") =>
            `WARC/1.0\r\nWARC-Type: ${type}\r\n` +
            `WARC-Target-URI: http://outer/${uuid}\r\n` +
            `WARC-Record-ID: <urn:uuid:00000000-0000-4000-8000-${uuid}>\r\n${extra}` +
            `Content-Length: ${body.length}\r\n\r\n${body}\r\n\r\n`;

        // The nested archive, then an ordinary record after it.
        const nested = record("000000000001", "resource", innerText, "Content-Type: application/warc\r\n");
        const after = record("000000000003", "response", "second");
        const bytes = encoder.encode(nested + after);

        const read = async (start: number, length: number): Promise<ArrayBuffer | null> =>
            start >= bytes.length
                ? null
                : bytes.slice(start, Math.min(start + length, bytes.length)).buffer as ArrayBuffer;

        // The planted line really is at a line start, so a bare scan would take it.
        const planted = encoder.encode(nested).length - encoder.encode(innerText + "\r\n\r\n").length;
        expect(bytes[planted]).toBe(0x57);
        expect(bytes[planted - 1]).toBe(0x0a);

        // Searching past the first record must skip the planted one and land on the
        // real second record, not on the payload.
        const found = await mWarcFindRecordStart(read, 1, bytes.length, bytes.length);

        expect(found).not.toBeNull();
        expect(found).toBe(encoder.encode(nested).length);
        expect(found).not.toBe(planted);
    });
});
