// bun test routes/download/integration.test.ts
//
// Phase 3 of download.plan.md: a real download of real records out of a real
// WARC, with the byte ranges taken from the archive's own CDX index.
//
// Everything in download.test.ts is a fixture written by the test. This file uses
// nothing it made up: the urls are the ones the crawler saw, the offsets are the
// ones the indexer recorded, and the bytes are compared against the WARC itself
// rather than against a string this file also wrote. That is the difference
// between "the code does what I told it" and "the code does the job".
//
// Skipped when the corpus is not present, like the other archive-backed suites.
//
// Note the `resources=0` on the fidelity tests. They compare the bytes in the zip
// against the bytes in the WARC, and a requested html capture is REWRITTEN by
// default — its references made relative — so demanding byte-identity while
// expansion is on would be asserting the opposite of the feature. The last test in
// the file is the one that exercises expansion on real data.

import { describe, expect, test } from "bun:test";
import { open } from "node:fs/promises";
import { createDownloadRoute, type DownloadDeps } from "./index";
import type { PayloadRow } from "./entries";

const WARC = new URL("../../../warc.null/nekoweb.warc", import.meta.url).pathname;
const CDX = new URL("../../../warc.null/nekoweb.cdx", import.meta.url).pathname;

const HAVE = await Bun.file(WARC).exists() && await Bun.file(CDX).exists();

/** One record, as the index describes it. */
interface Indexed {
    url: string;
    mime: string;
    status: string;
    id: string;
    offset: number;
    length: number;
}

/**
 * The CDX, turned into byte ranges.
 *
 * The index records an offset per record and no length — the columns are
 * `a b a m s k r M V g u`, and V is the offset. A record's length is therefore
 * the distance to the next one, which is only meaningful once the rows are sorted
 * by offset rather than by url, which is how they are stored.
 *
 * The last record is dropped: there is nothing after it to measure against, and
 * guessing "to the end of the file" would include the WARC's trailing bytes.
 */
const readIndex = async (): Promise<Indexed[]> => {
    const lines = (await Bun.file(CDX).text()).split("\n").filter(Boolean);
    const rows: Omit<Indexed, "length">[] = [];

    for (const line of lines) {
        if (line.startsWith(" CDX")) continue;

        const [url, , , mime, status, , , , offset, , urn] = line.split(" ");
        const at = Number(offset);

        if (!url || !Number.isFinite(at)) continue;

        rows.push({
            url,
            mime: mime ?? "",
            status: status ?? "",
            // The urn is the record id, which is what warc_custom_id holds.
            id: (urn ?? "").replace(/^<urn:uuid:|>$/g, "") || url,
            offset: at,
        });
    }

    rows.sort((a, b) => a.offset - b.offset);

    return rows.slice(0, -1).map((row, index) => ({
        ...row,
        length: rows[index + 1]!.offset - row.offset,
    }));
};

const rowFor = (record: Indexed): PayloadRow => ({
    warc_custom_id: record.id,
    uri: record.url,
    file_path: WARC,
    byte_offset: record.offset,
    byte_length: record.length,
    chunks: null,
    content_type: record.mime,
    archived_date: "2025-09-05T01:13:42.000Z",
});

const depsFor = (records: Indexed[]): DownloadDeps => {
    const byId = new Map(records.map(record => [record.id, rowFor(record)]));

    return {
        byIds: (ids) => Promise.resolve(ids.map(id => byId.get(id)).filter(Boolean) as PayloadRow[]),
        byUrl: (url) => {
            const found = records.find(record => record.url === url);

            return Promise.resolve(found ? [rowFor(found)] : []);
        },
    };
};

/** Ask Python what it makes of the archive, and hand back its contents. */
const inspect = async (bytes: ArrayBuffer) => {
    const path = `/tmp/download-integration-${Math.random().toString(36).slice(2)}.zip`;
    await Bun.write(path, bytes);

    const result = Bun.spawnSync(["python3", "-c", `
import base64, json, zipfile
with zipfile.ZipFile(${JSON.stringify(path)}) as a:
    print(json.dumps({
        "bad": a.testzip(),
        "names": a.namelist(),
        "sizes": {i.filename: i.file_size for i in a.infolist()},
        "sha": {i.filename: __import__("hashlib").sha256(a.read(i.filename)).hexdigest() for i in a.infolist()},
        "manifest": (a.read("_warc-manifest.json").decode()
                     if "_warc-manifest.json" in a.namelist() else None),
    }))
`]);

    const out = result.stdout.toString().trim();

    if (!out) throw new Error(`python: ${String(result.stderr ?? "(silent)")}`);

    return JSON.parse(out);
};

const sha256 = async (bytes: ArrayBuffer | Uint8Array): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", bytes as ArrayBuffer);

    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
};

/**
 * The bytes a range of the archive really holds, by positional read.
 *
 * NOT `Bun.file(path).slice(a, b).arrayBuffer()`, which is the obvious way to
 * write this and is the one thing a reference read must not do here. That call
 * is unreliable over a Docker Desktop bind mount on Windows: a read wider than
 * 64 KiB comes back rounded up to the next multiple of 65,512, correct bytes
 * followed by bytes past the end of the range.
 *
 * Using it here made this test assert the archive against a corrupted reference.
 * It failed on the first payload over 64 KiB and blamed the DOWNLOAD, which was
 * byte-perfect — the size assertion right above passed, and only the digest
 * disagreed. A reference has to be read by a route the code under test does not
 * share, or it cannot referee anything.
 */
const rangeOf = async (path: string, offset: number, length: number): Promise<Uint8Array> => {
    const handle = await open(path, "r");

    try {
        const bytes = new Uint8Array(length);
        let got = 0;

        while (got < length) {
            const { bytesRead } = await handle.read(bytes, got, length - got, offset + got);
            if (bytesRead === 0) break;
            got += bytesRead;
        }

        return got === length ? bytes : bytes.subarray(0, got);
    } finally {
        await handle.close();
    }
};

describe.if(HAVE)("a real download, from a real archive", () => {
    test("40 records: valid zip, exact length, and byte-identical payloads", async () => {
        const index = await readIndex();

        expect(index.length).toBeGreaterThan(40);

        // A spread rather than the first forty: the first records of a crawl are
        // all one page's assets, and the interesting paths are further in.
        const chosen = Array.from({ length: 40 }, (_, i) => index[Math.floor(i * index.length / 40)]!);
        const query = chosen.map(record => `ids=${encodeURIComponent(record.id)}`).join("&");

        const response = await createDownloadRoute(depsFor(index))(
            new Request(`http://localhost:3000/api/warcs/download?${query}&resources=0`));

        expect(response.status).toBe(200);

        const promised = Number(response.headers.get("x-warc-content-length"));
        const bytes = await response.arrayBuffer();

        // §8.1 layer 4, on real data: the header and the body agree.
        expect(bytes.byteLength).toBe(promised);

        const seen = await inspect(bytes);

        expect(seen.bad).toBeNull();
        // Forty records, plus the manifest. No collisions, so no entry was lost to
        // a path clash — the thing pathForEntry is for, on real urls.
        expect(seen.names).toHaveLength(41);

        /*
         * The assertion that makes this an integration test rather than another
         * unit one: every entry's bytes are compared against the WARC on disk.
         *
         * Digests rather than the bytes themselves, so a failure prints two hashes
         * instead of a megabyte of binary.
         */
        for (const record of chosen) {
            const path = seen.names.find((name: string) => name.includes(record.id));

            expect(path).toBeTruthy();
            expect(seen.sizes[path!]).toBe(record.length);

            const expected = await sha256(
                await rangeOf(WARC, record.offset, record.length));

            expect(seen.sha[path!]).toBe(expected);
        }
    }, 120_000);

    test("by url rather than by id, resolved through the nearest-capture lookup", async () => {
        const index = await readIndex();
        const chosen = index.slice(0, 5);
        const query = chosen.map(record => `urls=${encodeURIComponent(record.url)}`).join("&");

        const response = await createDownloadRoute(depsFor(index))(
            new Request(`http://localhost:3000/api/warcs/download?${query}&dateNear=2025-09-05T00:00:00Z&resources=0`));

        const bytes = await response.arrayBuffer();

        expect(bytes.byteLength).toBe(Number(response.headers.get("x-warc-content-length")));

        const seen = await inspect(bytes);

        expect(seen.bad).toBeNull();
        expect(seen.names).toHaveLength(6);
    }, 120_000);

    /*
     * Real urls are where path assignment gets tested properly: query strings,
     * percent-encoding, non-ASCII, deep paths, and two captures of the same page.
     */
    test("every real url gets its own path inside the archive", async () => {
        const index = await readIndex();
        const chosen = index.slice(0, 200);
        const query = chosen.map(record => `ids=${encodeURIComponent(record.id)}`).join("&");

        const response = await createDownloadRoute(depsFor(index))(
            new Request(`http://localhost:3000/api/warcs/download?${query}&resources=0`));

        const bytes = await response.arrayBuffer();
        const seen = await inspect(bytes);

        expect(seen.bad).toBeNull();

        // Every entry distinct, and every one of them a relative path with no
        // traversal in it — on two hundred urls nobody chose.
        const names = seen.names.filter((name: string) => name !== "_warc-manifest.json");

        expect(new Set(names).size).toBe(names.length);

        for (const name of names) {
            expect(name.startsWith("/")).toBe(false);

            for (const segment of name.split("/")) {
                expect(segment).not.toBe("");
                expect(segment).not.toBe("..");
            }
        }

        // And every one of them is accounted for, so no url was quietly dropped
        // on the way to a path.
        expect(names).toHaveLength(chosen.length);
    }, 120_000);

    /*
     * Expansion on real data, which is the default path and therefore the one that
     * matters most.
     *
     * Asking for the crawl's front page should not produce one html file. The
     * fixture-based tests prove the mechanism; this proves it survives contact with
     * a document a person actually wrote — one whose references are absolute, whose
     * stylesheet has a query string on it, and some of which the crawl never
     * captured.
     */
    test("asking for a real page brings its real resources", async () => {
        const index = await readIndex();
        const home = index.find(record => record.mime.startsWith("text/html"));

        expect(home).toBeTruthy();

        const response = await createDownloadRoute(depsFor(index))(
            new Request("http://localhost:3000/api/warcs/download"
                + `?urls=${encodeURIComponent(home!.url)}&dateNear=2025-09-05T00:00:00Z`));

        expect(response.status).toBe(200);

        const bytes = await response.arrayBuffer();

        // The invariant that has to hold whatever the walk found.
        expect(bytes.byteLength).toBe(Number(response.headers.get("x-warc-content-length")));

        const seen = await inspect(bytes);

        expect(seen.bad).toBeNull();

        /*
         * More than the document alone, and the manifest says how many. Not a
         * fixed number: it is whatever this crawl captured, and asserting "17"
         * would break the day the corpus is re-crawled.
         */
        expect(seen.names.length).toBeGreaterThan(2);

        const manifest = JSON.parse(seen.manifest);
        const row = manifest.entries[0];

        expect(row.status).toBe("stored");
        expect(row.expansion.dependencies).toBeGreaterThan(0);

        // Every dependency is in the archive, so the count and the contents agree.
        // The +1 is the manifest itself.
        expect(seen.names.length).toBe(row.expansion.dependencies + 2);
    }, 120_000);
});
