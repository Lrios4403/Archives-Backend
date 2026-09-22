// bun test parser/progress.test.ts
//
// Drives the real worker entry and watches what it posts.
//
// This exists because of a bug nothing else could see: the worker reported
// `parsedOffset` as mwarc's LOGICAL offset while `size` was the file on disk. For a
// plain .warc those are the same number, so every test passed. For a .warc.gz at
// 50.8 MB compressed to 77.5 MB the ratio crosses 1.0 two thirds of the way in, so
// the bar hit 100% and then sat there, still parsing.
//
// The unit tests could not catch it: the reader was right, the locations were
// right, the records were right. Only the MESSAGES were wrong, and only for a
// compressed archive. So this drives worker.entry.ts the way the page does — post
// a handle, collect what comes back — and asserts the invariants the UI depends on:
//
//   parsedOffset is monotonic, and never exceeds size.
//
// `self` is globalThis under bun, so importing the entry registers its onmessage
// handler and postMessage can be stubbed. No worker is spawned.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const GZ = new URL(
    "../../warc.null/rec-7c53beba8825-oacu-oir-nih-20260622221651890-0.warc.gz",
    import.meta.url,
).pathname;
const PLAIN = new URL("../../warc.null/nekoweb.warc", import.meta.url).pathname;

const SLOW_MS = 120_000;

interface Posted {
    action?: string;
    name?: string;
    parsedOffset?: number;
    size?: number;
    percent?: number;
    status?: string;
    records?: number;
    responses?: number;
    stage?: string;
    message?: string;
    errorName?: string;
}

const globals = globalThis as unknown as {
    self: { onmessage?: ((event: { data: unknown }) => void) | null };
    postMessage: (message: unknown) => void;
};

let originalPostMessage: typeof globals.postMessage;

/** Post a handle to the worker and collect everything it posts back. */
const run = async (path: string): Promise<Posted[]> => {
    const posted: Posted[] = [];
    let done = false;

    globals.postMessage = (message: unknown) => {
        const data = message as Posted;
        posted.push(data);

        if (data.action === "parsed" || data.action === "error") done = true;
    };

    const file = Bun.file(path);

    globals.self.onmessage?.({
        data: {
            action: "parseStream",
            handle: {
                name: path.split("/").pop(),
                size: file.size,
                parsedOffset: 0,
                file,
            },
        },
    });

    // The handler kicks off an un-awaited promise, so wait for a terminal message.
    const deadline = Date.now() + SLOW_MS;
    while (!done && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }

    return posted;
};

/** Every message that carries a progress figure the main thread will apply. */
const progressMessages = (posted: Posted[]): Posted[] =>
    posted.filter(m => m.action === "progress" || m.action === "newRecords" || m.action === "parsed");

const haveGz = await Bun.file(GZ).exists();
const havePlain = await Bun.file(PLAIN).exists();

beforeAll(async () => {
    originalPostMessage = globals.postMessage;
    // Importing registers self.onmessage. Dynamic, so the stub above is in place
    // before any module-level code runs.
    await import("./worker.entry");
});

afterAll(() => {
    globals.postMessage = originalPostMessage;
});

describe("worker progress reporting", () => {
    test.if(haveGz)("a .warc.gz never reports past 100%", async () => {
        const posted = await run(GZ);
        const messages = progressMessages(posted);

        expect(posted.some(m => m.action === "parsed")).toBe(true);
        expect(messages.length).toBeGreaterThan(1);

        // THE assertion. Every figure the main thread divides by `size` has to be
        // in the same coordinate space as `size`.
        for (const message of messages) {
            expect(message.size).toBeGreaterThan(0);
            expect(message.parsedOffset).toBeGreaterThanOrEqual(0);
            expect(message.parsedOffset!).toBeLessThanOrEqual(message.size!);
        }
    }, SLOW_MS);

    test.if(haveGz)("progress is monotonic", async () => {
        const posted = await run(GZ);
        let previous = -1;

        // Walking backwards would make the bar visibly retreat, which is what two
        // coordinate spaces on alternate messages produced.
        for (const message of progressMessages(posted)) {
            const at = message.parsedOffset ?? 0;

            expect(at).toBeGreaterThanOrEqual(previous);
            previous = at;
        }
    }, SLOW_MS);

    test.if(haveGz)("it finishes at exactly 100% having found every record", async () => {
        const posted = await run(GZ);
        const parsed = posted.find(m => m.action === "parsed")!;

        expect(parsed.parsedOffset ?? 0).toBe(parsed.size ?? -1);
        expect(parsed.status).toBe("parsed");
        // 1,624 records in this archive; a short count would mean the parse stopped
        // early without reporting an error.
        expect(parsed.records).toBe(1624);
    }, SLOW_MS);

    test.if(haveGz)("the reported percent reaches 100 only at the end", async () => {
        const posted = await run(GZ);
        const during = posted.filter(m => m.action === "progress");

        expect(during.length).toBeGreaterThan(1);
        // Every mid-parse percent must be a real percentage.
        expect(during.every(m => m.percent! >= 0 && m.percent! <= 100)).toBe(true);
        // And the sequence must not saturate early: the last few can be 100, but
        // most of them being 100 is the bug this file exists for.
        const saturated = during.filter(m => m.percent === 100).length;
        expect(saturated).toBeLessThan(during.length / 2);
    }, SLOW_MS);

    // The plain path must be untouched — for a .warc the two coordinate spaces are
    // the same number, so this is the control.
    test.if(havePlain)("a plain .warc still reports bounded, monotonic progress", async () => {
        const posted = await run(PLAIN);
        const messages = progressMessages(posted);
        let previous = -1;

        expect(posted.some(m => m.action === "parsed")).toBe(true);

        for (const message of messages) {
            const at = message.parsedOffset ?? 0;

            expect(at).toBeLessThanOrEqual(message.size ?? 0);
            expect(at).toBeGreaterThanOrEqual(previous);
            previous = at;
        }
    }, SLOW_MS);
});
