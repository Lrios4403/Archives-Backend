// bun test parser/storedsink.test.ts
//
// The download path's zip, now that zip.js is out of it.
//
// storedzip.test.ts proves the FORMAT is right. This file proves the ADAPTER is:
// that a ZipSink backed by the stored writer behaves the way download.ts expects
// one to — text entries, lazy record slices, chunked payloads, one failed entry
// not taking the archive down, and an abort leaving nothing finalised.
//
// The last one is the reason this file exists at all. A truncated zip that has
// been closed is a VALID zip holding half a page, and nothing about it looks
// wrong; the only way to know we do not produce one is to cancel and check.

import { describe, expect, test } from "bun:test";
import { writeDownload, type DownloadEntry, type DownloadPlan } from "./download";
import { createStoredZipSink } from "./storedsink";
import type { ViewRecord } from "./view";

/** Collects everything written, and remembers whether it was closed or aborted. */
const collector = () => {
    const parts: Uint8Array[] = [];
    let closed = false;
    let aborted = false;

    return {
        get closed() { return closed; },
        get aborted() { return aborted; },
        get bytes() {
            const total = parts.reduce((sum, part) => sum + part.length, 0);
            const out = new Uint8Array(total);
            let at = 0;
            for (const part of parts) { out.set(part, at); at += part.length; }
            return out;
        },
        writable: new WritableStream<Uint8Array>({
            write: (chunk) => { parts.push(chunk); },
            close: () => { closed = true; },
            abort: () => { aborted = true; },
        }),
    };
};

const sinkOver = (writable: WritableStream<Uint8Array>, signal?: AbortSignal) =>
    createStoredZipSink({
        writable,
        // The cast is the price of `lib: ["ESNext"]`: no DOM lib means no
        // BlobPart, and Bun's ambient Blob does not declare `slice` either.
        blob: (parts, options) => new Blob(parts as (Uint8Array | string)[], options),
        ...(signal ? { signal } : {}),
    });

/** A WARC-ish blob, and a record pointing into it. */
const archiveWith = (body: string) => {
    const prefix = "WARC/1.1\r\nContent-Length: 0\r\n\r\n";
    const file = new Blob([prefix + body]);

    const record = (over?: Partial<ViewRecord>): ViewRecord => ({
        url: "https://example.test/page.html",
        contentType: "text/html",
        dateArchived: "2026-08-21T12:00:00.000Z",
        file: file as unknown as ViewRecord["file"],
        payload: { offset: prefix.length, size: body.length },
        ...over,
    } as ViewRecord);

    return { file, record };
};

const inspect = async (zip: Uint8Array) => {
    const path = `/tmp/storedsink-${Math.random().toString(36).slice(2)}.zip`;
    await Bun.write(path, zip);

    const result = Bun.spawnSync(["python3", "-c", `
import json, zipfile
try:
    with zipfile.ZipFile(${JSON.stringify(path)}) as archive:
        print(json.dumps({
            "ok": True, "bad": archive.testzip(),
            "names": archive.namelist(),
            "contents": {i: archive.read(i).decode("utf-8", "replace") for i in archive.namelist()},
        }))
except Exception as problem:
    print(json.dumps({"ok": False, "error": str(problem)}))
`]);

    return JSON.parse(result.stdout.toString().trim());
};

describe("stored zip sink", () => {
    test("text and record entries land in one readable archive", async () => {
        const out = collector();
        const sink = sinkOver(out.writable);
        const { record } = archiveWith("<h1>the archived body</h1>");

        await sink.add("index.html", { kind: "slice", record: record() }, { level: 0 });
        await sink.add("_warc-manifest.json", { kind: "text", text: '{"ok":true}' });
        await sink.close();

        expect(out.closed).toBe(true);

        const seen = await inspect(out.bytes);

        expect(seen.error).toBeUndefined();
        expect(seen.bad).toBeNull();
        expect(seen.names).toEqual(["index.html", "_warc-manifest.json"]);

        // The record entry is the WARC's bytes, sliced — not the headers around them.
        expect(seen.contents["index.html"]).toBe("<h1>the archived body</h1>");
        expect(seen.contents["_warc-manifest.json"]).toBe('{"ok":true}');
    });

    test("a record with no payload becomes an empty entry, not a failure", async () => {
        const out = collector();
        const sink = sinkOver(out.writable);
        const { record } = archiveWith("body");

        await sink.add("empty.bin", { kind: "slice", record: record({ payload: undefined }) });
        await sink.close();

        const seen = await inspect(out.bytes);

        expect(seen.bad).toBeNull();
        expect(seen.contents["empty.bin"]).toBe("");
    });

    /*
     * A chunked body is the one case that HAS to be buffered: the bytes in the
     * WARC are interleaved with chunk-length lines, so there is no byte range that
     * is the payload. Worth a test because it is the only path where the sink
     * reads rather than slices, and the two produce different code.
     */
    test("a chunked payload is de-chunked before it goes in", async () => {
        const body = "4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        const prefix = "WARC/1.1\r\n\r\n";
        const file = new Blob([prefix + body]);

        const record = {
            url: "https://example.test/chunked",
            contentType: "text/plain",
            dateArchived: "2026-08-21T12:00:00.000Z",
            file: file as unknown as ViewRecord["file"],
            payload: {
                offset: prefix.length,
                // The ENCODED length, framing included — and `chunks` holds the
                // DECODED sizes, not offsets. See the invariants on readPayload.
                size: body.length,
                chunks: [4, 5],
            },
        } as unknown as ViewRecord;

        const out = collector();
        const sink = sinkOver(out.writable);

        await sink.add("chunked.txt", { kind: "slice", record });
        await sink.close();

        const seen = await inspect(out.bytes);

        expect(seen.bad).toBeNull();
        expect(seen.contents["chunked.txt"]).toBe("Wikipedia");
    });

    // The trade this sink makes, stated as a test: it cannot deflate, and it must
    // say so rather than storing quietly. A silent fallback is a 1.56x size
    // regression that nothing reports.
    test("a request to compress is refused, not ignored", async () => {
        const out = collector();
        const sink = sinkOver(out.writable);

        await expect(sink.add("a.txt", { kind: "text", text: "x" }, { level: 6 }))
            .rejects.toThrow(/only stores/);

        await sink.abort("done");
    });

    test("abort discards rather than finalising", async () => {
        const out = collector();
        const sink = sinkOver(out.writable);

        await sink.add("half.txt", { kind: "text", text: "the first half" });
        await sink.abort("cancelled");

        expect(out.aborted).toBe(true);
        expect(out.closed).toBe(false);

        // No central directory was written, so this is not a zip at all — which is
        // the point. A closed one would have been a valid archive holding half a
        // page, and nothing about it would have looked wrong.
        const seen = await inspect(out.bytes);

        expect(seen.ok).toBe(false);
    });

    test("an aborted signal stops the next entry", async () => {
        const controller = new AbortController();
        const out = collector();
        const sink = sinkOver(out.writable, controller.signal);

        await sink.add("first.txt", { kind: "text", text: "in" });
        controller.abort();

        await expect(sink.add("second.txt", { kind: "text", text: "out" }))
            .rejects.toThrow(/cancelled/);
    });

    test("closing twice is an error rather than a second directory", async () => {
        const out = collector();
        const sink = sinkOver(out.writable);

        await sink.add("a.txt", { kind: "text", text: "a" });
        await sink.close();

        await expect(sink.close()).rejects.toThrow(/finished/);
    });

    /*
     * The serialisation, which is the one behaviour zipsink handled differently.
     *
     * zip.js staged overlapping entries to disk so several could be in flight;
     * this writer queues them instead. Either way the archive has to be correct,
     * and correctness here means no interleaving — a zip has one write position.
     */
    test("overlapping adds are serialised, not interleaved", async () => {
        const out = collector();
        const sink = sinkOver(out.writable);

        await Promise.all([
            sink.add("one.txt", { kind: "text", text: "1".repeat(1000) }),
            sink.add("two.txt", { kind: "text", text: "2".repeat(1000) }),
            sink.add("three.txt", { kind: "text", text: "3".repeat(1000) }),
        ]);

        await sink.close();

        const seen = await inspect(out.bytes);

        expect(seen.bad).toBeNull();
        expect(seen.names).toEqual(["one.txt", "two.txt", "three.txt"]);
        expect(seen.contents["two.txt"]).toBe("2".repeat(1000));
    });

    // A rejected add must not poison the ones after it: the queue is shared, and a
    // failure that propagated down the chain would report one bad entry as many.
    test("one failed entry does not fail the entries after it", async () => {
        const out = collector();
        const sink = sinkOver(out.writable);

        /*
         * A source that lies about its own length.
         *
         * The lie has to be in the SLICE, not the payload: the sink builds the
         * entry from `file.slice(...)`, so a real Blob would simply report the
         * shorter size and produce a correct, shorter entry. This one claims 500
         * bytes and yields 10, which is the case the writer's size check exists
         * for — caught after the header is already on the wire.
         */
        const short = new Blob(["0123456789"]) as unknown as {
            slice(from?: number, to?: number): unknown;
            stream(): ReadableStream<Uint8Array>;
        };

        const lying = {
            url: "https://example.test/short",
            contentType: "application/octet-stream",
            dateArchived: "2026-08-21T12:00:00.000Z",
            file: {
                size: 500,
                slice: () => ({
                    size: 500,
                    slice: (from?: number, to?: number) => short.slice(from, to),
                    stream: () => short.stream(),
                }),
            } as unknown as ViewRecord["file"],
            payload: { offset: 0, size: 500 },
        } as unknown as ViewRecord;

        await expect(sink.add("short.bin", { kind: "slice", record: lying })).rejects.toThrow();

        // The archive is unusable from here — the header for a 500-byte entry is on
        // the wire — so what matters is that the NEXT add reports its own outcome
        // rather than re-reporting this one.
        await expect(sink.add("after.txt", { kind: "text", text: "ok" }))
            .resolves.toBeUndefined();
    });
});

/* ---- end to end, through writeDownload -------------------------------- */

describe("writeDownload over the stored sink", () => {
    const entryFor = (url: string, path: string, text: string | null, body: string): DownloadEntry => {
        const { record } = archiveWith(body);

        return {
            url,
            record: record({ url }),
            aliases: [],
            text,
            path,
        };
    };

    test("a whole plan becomes an archive Python validates", async () => {
        const entries = [
            entryFor("https://example.test/", "index.html", "<h1>rewritten</h1>", "<h1>original</h1>"),
            entryFor("https://example.test/logo.png", "logo.png", null, "PNGDATAPNGDATA"),
            entryFor("https://example.test/app.js", "app.js", null, "console.log(1)"),
        ];

        const plan: DownloadPlan = {
            ok: true,
            entries,
            linkUrls: [],
            root: entries[0]!,
            missing: [],
            resolved: [],
            notices: [],
        };

        const out = collector();
        const sink = sinkOver(out.writable);

        // No close here: writeDownload closes the sink itself, and that is the
        // point of its own comment — the central directory is written there, so
        // every entry succeeding is not the same as the file being good.
        const result = await writeDownload(plan, sink, {});

        // Three entries plus the manifest.
        expect(result.entries).toBe(4);
        expect(result.cancelled).toBe(false);

        const seen = await inspect(out.bytes);

        expect(seen.error).toBeUndefined();
        expect(seen.bad).toBeNull();
        expect(seen.names.sort()).toEqual(
            ["_warc-manifest.json", "app.js", "index.html", "logo.png"]);

        // The rewritten text, not the archived original: a text entry is handed to
        // the sink as a string that the walk already rewrote.
        expect(seen.contents["index.html"]).toBe("<h1>rewritten</h1>");
        // And a binary is the WARC's own bytes.
        expect(seen.contents["logo.png"]).toBe("PNGDATAPNGDATA");

        expect(JSON.parse(seen.contents["_warc-manifest.json"])).toBeTruthy();
    });

    test("cancelling mid-plan leaves nothing finalised", async () => {
        const entries = Array.from({ length: 6 }, (_, index) =>
            entryFor(`https://example.test/${index}`, `file-${index}.bin`, null, `body ${index}`));

        const plan: DownloadPlan = {
            ok: true, entries, linkUrls: [], root: entries[0]!,
            missing: [], resolved: [], notices: [],
        };

        const out = collector();
        const sink = sinkOver(out.writable);

        let seenEntries = 0;

        const result = await writeDownload(plan, sink, {
            onProgress: () => { seenEntries++; },
            cancelled: () => seenEntries >= 2,
        });

        expect(result.cancelled).toBe(true);
        expect(out.aborted).toBe(true);
        expect(out.closed).toBe(false);
        expect((await inspect(out.bytes)).ok).toBe(false);
    });
});
