// bun test routes/download/recursive.test.ts
//
// Recursive mode: a page, plus what it needs to work offline.
//
// The walk itself is parser/download.ts and is tested there. What is tested here
// is the ADAPTER — that a database row becomes a record the walk can use, that
// its output becomes zip entries, and that the four fields which exist only for
// this path are actually carried. Each of those four, left out, produces a
// plausible archive with one specific thing wrong:
//
//   digest           byte-identical captures stored twice
//   status           the crawler's stored 404 PAGE walked as if it were real html
//   contentEncoding  a gzip-encoded document parsed as binary, so no links found
//   uuid / warcFile  colliding filenames with nothing to disambiguate them
//
// The fixture is a hand-built WARC because the assertion is about the graph: one
// page, a stylesheet, an image, a link to a second page, and a duplicate of the
// stylesheet at a second url so the digest merge has something to merge.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { createDownloadRoute, type DownloadDeps } from "./index";
import { toViewRecord } from "./recursive";
import type { PayloadRow } from "./entries";

const DIR = "/tmp/download-recursive-test";
const WARC = `${DIR}/site.warc`;

interface Stored {
    url: string;
    type: string;
    body: string;
    offset: number;
    length: number;
    digest: string;
    id: string;
}

const stored: Record<string, Stored> = {};

const PAGE = `<!doctype html>
<html><head>
  <link rel="stylesheet" href="/style.css">
</head><body>
  <h1>Home</h1>
  <img src="/logo.png" alt="logo">
  <a href="/about.html">About</a>
</body></html>`;

const STYLE = "body { background: url(/bg.png); color: rebeccapurple }";

beforeAll(async () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });

    const parts: { key: string; url: string; type: string; body: string; digest: string }[] = [
        { key: "page", url: "https://site.test/", type: "text/html", body: PAGE, digest: "sha1:PAGE" },
        { key: "style", url: "https://site.test/style.css", type: "text/css", body: STYLE, digest: "sha1:STYLE" },
        // The same bytes at a second url, which is what http:// vs https:// looks
        // like to the walk — and the only way the digest merge can be observed.
        { key: "styleAlias", url: "http://site.test/style.css", type: "text/css", body: STYLE, digest: "sha1:STYLE" },
        { key: "logo", url: "https://site.test/logo.png", type: "image/png", body: "\x89PNG\r\n\x1a\nLOGOBYTES", digest: "sha1:LOGO" },
        { key: "bg", url: "https://site.test/bg.png", type: "image/png", body: "\x89PNG\r\n\x1a\nBGBYTES", digest: "sha1:BG" },
        { key: "about", url: "https://site.test/about.html", type: "text/html", body: "<!doctype html><h1>About</h1>", digest: "sha1:ABOUT" },
    ];

    let file = "";

    for (const part of parts) {
        file += `WARC/1.1\r\nWARC-Type: response\r\nWARC-Target-URI: ${part.url}\r\n\r\n`;

        stored[part.key] = {
            url: part.url,
            type: part.type,
            body: part.body,
            offset: file.length,
            length: part.body.length,
            digest: part.digest,
            id: `rec-${part.key}`,
        };

        file += part.body + "\r\n\r\n";
    }

    await Bun.write(WARC, file);
});

afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
});

const rowFor = (record: Stored, over: Partial<PayloadRow> = {}): PayloadRow & {
    status?: number;
    headers?: unknown;
    payload_digest?: string | null;
} => ({
    warc_custom_id: record.id,
    uri: record.url,
    file_path: WARC,
    byte_offset: record.offset,
    byte_length: record.length,
    chunks: null,
    content_type: record.type,
    archived_date: "2026-06-22T22:16:51.890Z",
    status: 200,
    headers: { "content-type": record.type },
    payload_digest: record.digest,
    ...over,
});

const depsFor = (records: Stored[] = Object.values(stored)): DownloadDeps => {
    const byUrl = new Map(records.map(record => [record.url, rowFor(record)]));
    const byId = new Map(records.map(record => [record.id, rowFor(record)]));

    return {
        byIds: (ids) => Promise.resolve(ids.map(id => byId.get(id)).filter(Boolean) as PayloadRow[]),
        byUrl: (url) => Promise.resolve(byUrl.has(url) ? [byUrl.get(url)!] : []),
    };
};

const get = (query: string, deps: DownloadDeps) =>
    createDownloadRoute(deps)(new Request(`http://localhost:3000/api/warcs/download${query}`));

const inspect = async (bytes: ArrayBuffer) => {
    const path = `${DIR}/out-${Math.random().toString(36).slice(2)}.zip`;
    await Bun.write(path, bytes);

    const result = Bun.spawnSync(["python3", "-c", `
import json, zipfile
with zipfile.ZipFile(${JSON.stringify(path)}) as a:
    print(json.dumps({
        "bad": a.testzip(), "names": a.namelist(),
        "contents": {n: a.read(n).decode("latin-1") for n in a.namelist()},
    }))
`]);

    return JSON.parse(result.stdout.toString().trim());
};

describe("toViewRecord", () => {
    test("carries the four fields that only the download path needs", () => {
        const record = toViewRecord(rowFor(stored.page!));

        expect(record.payload?.digest).toBe("sha1:PAGE");
        expect(record.status).toBe(200);
        expect(record.uuid).toBe("rec-page");
        expect(record.warcFile).toBe(WARC);
    });

    test("reads content-encoding out of the stored headers, whatever the case", () => {
        const record = toViewRecord(rowFor(stored.page!, {
            headers: { "Content-Encoding": "gzip", "Content-Type": "text/html" },
        } as Partial<PayloadRow>));

        expect(record.contentEncoding).toBe("gzip");
        expect(record.httpContentType).toBe("text/html");
    });

    test("survives headers arriving as a JSON string", () => {
        const record = toViewRecord(rowFor(stored.page!, {
            headers: JSON.stringify({ "content-encoding": "br" }),
        } as Partial<PayloadRow>));

        expect(record.contentEncoding).toBe("br");
    });

    test("a row with no payload columns has a null payload, not a bad one", () => {
        const record = toViewRecord(rowFor(stored.page!, {
            file_path: null, byte_offset: null, byte_length: null,
        }));

        expect(record.payload).toBeNull();
    });

    test("the file is lazy — constructing a record reads nothing", () => {
        const record = toViewRecord(rowFor(stored.logo!));

        // A BunFile, so `size` is a stat and the bytes are still on disk.
        expect(record.file.size).toBeGreaterThan(0);
        expect(typeof record.file.slice).toBe("function");
    });
});

describe("the recursive route", () => {
    /*
     * Several documents in one request, which the old `recursive=1` mode refused.
     *
     * It refused because it was a single-root walk. Expansion is per document now,
     * so this is just a request for two pages — and the shared stylesheet has to
     * arrive once, which is the thing that could go wrong when two walks are
     * merged into one archive.
     */
    test("two documents in one request share their resources", async () => {
        const response = await get("?urls=https://site.test/&urls=https://site.test/about.html", depsFor());

        expect(response.status).toBe(200);

        const bytes = await response.arrayBuffer();

        expect(bytes.byteLength).toBe(Number(response.headers.get("x-warc-content-length")));

        const seen = await inspect(bytes);

        expect(seen.bad).toBeNull();
        expect(seen.names.filter((name: string) => name.endsWith(".css"))).toHaveLength(1);

        const manifest = JSON.parse(seen.contents["_warc-manifest.json"]);

        expect(manifest.entries).toHaveLength(2);
        expect(manifest.entries.every((one: { status: string }) => one.status === "stored")).toBe(true);
    });

    /*
     * The bug a real download found, and the reason it was worth reporting.
     *
     * `entriesFromPlan` used to slice the record's file directly, reasoning that
     * the walk had already read the record so the file must exist and be long
     * enough. It does not follow: the length comes from the DATABASE and the bytes
     * come from DISK. A `file_path` that does not resolve — a relative path read
     * from a different working directory, a moved archive — stats as 0.
     *
     * The entry then declared N bytes and produced none, the writer's size check
     * threw MID-STREAM, and the response had already promised a Content-Length. The
     * client got a truncated body, which Windows reports as "The compressed
     * (zipped) Folder is invalid".
     *
     * So the assertion is not "the entry is missing" — it is "the archive OPENS".
     */
    test("a record whose file is not there yields a VALID archive, not a truncated one", async () => {
        /*
         * Its own digest, which matters. Built from stored.logo it inherited that
         * record's digest, the merge collapsed the two images into one entry, and
         * dropping the survivor took its alias with it — so the "good" image
         * vanished too. Correct behaviour for identical bytes, and not what this
         * test is about. See the note on merge-and-drop in the plan.
         */
        const missing: Stored = {
            ...stored.logo!,
            url: "https://site.test/gone.png",
            id: "rec-gone",
            digest: "sha1:GONE",
        };

        const withGone = `<!doctype html><html><body><img src="/gone.png"><img src="/logo.png"></body></html>`;
        const path = `${DIR}/gone.warc`;
        const header = `WARC/1.1\r\n\r\n`;
        await Bun.write(path, header + withGone);

        const rootRow = {
            ...rowFor(stored.page!),
            uri: "https://site.test/has-gone.html",
            warc_custom_id: "rec-has-gone",
            file_path: path,
            byte_offset: header.length,
            byte_length: withGone.length,
        };

        const deps: DownloadDeps = {
            byIds: () => Promise.resolve([rootRow]),
            byUrl: (url) => {
                if (url === missing.url) {
                    // The row exists and points at a file that does not.
                    return Promise.resolve([{
                        ...rowFor(missing),
                        file_path: `${DIR}/never-written.warc`,
                    }]);
                }

                const found = Object.values(stored).find(one => one.url === url);

                return Promise.resolve(found ? [rowFor(found)] : []);
            },
        };

        const response = await get("?ids=rec-has-gone", deps);

        expect(response.status).toBe(200);

        const bytes = await response.arrayBuffer();

        // The header and the body agree, which is what a mid-stream abort breaks.
        expect(bytes.byteLength).toBe(Number(response.headers.get("x-warc-content-length")));

        const seen = await inspect(bytes);

        // Python opens it and every crc checks out. This is the assertion that
        // would have caught the bug.
        expect(seen.bad).toBeNull();

        // The good image is there, the absent one is not, and the manifest says so
        // rather than leaving a hole.
        const names = seen.names.join(" ");

        expect(names).toContain("logo");
        expect(names).not.toContain("gone.png");

        const manifest = JSON.parse(seen.contents["_warc-manifest.json"]);
        const dropped = manifest.entries[0].expansion.dropped;

        expect(dropped).toHaveLength(1);
        expect(dropped[0].url).toBe(missing.url);
        expect(dropped[0].expected).toBeGreaterThan(0);
        expect(dropped[0].available).toBe(0);
    });

    /*
     * Two ways a document's own bytes can be unavailable, and they report
     * differently — which is right, because they are different failures.
     *
     *   absent file    the walk cannot read the document at all -> "error"
     *   short file     the walk reads what is there and succeeds, and the entry is
     *                  then dropped for a length mismatch -> "short-read"
     *
     * The second is the one that used to produce an invalid zip.
     */
    test("a document whose own file is absent is an error", async () => {
        const rootRow = {
            ...rowFor(stored.page!),
            uri: "https://site.test/vanished.html",
            warc_custom_id: "rec-vanished",
            file_path: `${DIR}/never-written.warc`,
        };

        const deps: DownloadDeps = {
            byIds: () => Promise.resolve([rootRow]),
            byUrl: () => Promise.resolve([]),
        };

        const response = await get("?ids=rec-vanished", deps);
        const bytes = await response.arrayBuffer();

        expect(bytes.byteLength).toBe(Number(response.headers.get("x-warc-content-length")));

        const seen = await inspect(bytes);
        const manifest = JSON.parse(seen.contents["_warc-manifest.json"]);

        expect(seen.bad).toBeNull();

        expect(manifest.entries[0].status).toBe("error");
    });

    /*
     * A short file cannot FAIL a document, and this pins what happens instead.
     *
     * A text entry's bytes are the rewritten string, not a range of the WARC, so
     * there is no declared length for the writer to disagree with — the walk reads
     * what is there, rewrites it, and stores a shorter page. That is the right call
     * (half a page beats no page) and it must not be silent, so it lands in
     * `truncated` rather than `dropped`.
     */
    test("a document whose file is SHORTER than its row is stored, and reported truncated", async () => {
        const short = `${DIR}/short.warc`;
        const header = `WARC/1.1\r\n\r\n`;
        await Bun.write(short, header + "<!doctype html><p>truncated");

        const rootRow = {
            ...rowFor(stored.page!),
            uri: "https://site.test/short.html",
            warc_custom_id: "rec-short",
            file_path: short,
            byte_offset: header.length,
            byte_length: 100_000,
        };

        const response = await get("?ids=rec-short", {
            byIds: () => Promise.resolve([rootRow]),
            byUrl: () => Promise.resolve([]),
        });

        const bytes = await response.arrayBuffer();

        expect(bytes.byteLength).toBe(Number(response.headers.get("x-warc-content-length")));

        const seen = await inspect(bytes);
        const manifest = JSON.parse(seen.contents["_warc-manifest.json"]);

        expect(seen.bad).toBeNull();

        const row = manifest.entries[0];

        // Stored, because a partial document is worth keeping.
        expect(row.status).toBe("stored");
        expect(row.expansion.dropped).toHaveLength(0);

        // And named, because a partial document that says nothing is a lie.
        expect(row.expansion.truncated).toHaveLength(1);
        expect(row.expansion.truncated[0].expected).toBe(100_000);
        expect(row.expansion.truncated[0].available).toBeLessThan(100_000);
    });

    test("a missing capture is still a manifest row, document or not", async () => {
        const response = await get("?ids=not-a-record", depsFor());

        // Same as any other miss: the request was answerable in part, and the
        // archive says which part.
        expect(response.status).toBe(200);

        const seen = await inspect(await response.arrayBuffer());
        const manifest = JSON.parse(seen.contents["_warc-manifest.json"]);

        expect(manifest.entries[0].status).toBe("not-found");
    });

    test("pulls in the page's own references, one level and beyond", async () => {
        const response = await get("?urls=https://site.test/", depsFor());

        expect(response.status).toBe(200);

        const bytes = await response.arrayBuffer();

        expect(bytes.byteLength).toBe(Number(response.headers.get("x-warc-content-length")));

        const seen = await inspect(bytes);

        expect(seen.bad).toBeNull();

        const names = seen.names.join(" ");

        // The document, its stylesheet, its image — and bg.png, which is only
        // reachable by descending INTO the css.
        expect(names).toContain("style");
        expect(names).toContain("logo");
        expect(names).toContain("bg");
    });

    test("the document is rewritten, not copied", async () => {
        const response = await get("?urls=https://site.test/", depsFor());
        const seen = await inspect(await response.arrayBuffer());

        const html = Object.entries(seen.contents)
            .find(([name]) => name.endsWith(".html") && !name.includes("about"))?.[1] as string;

        expect(html).toBeTruthy();

        /*
         * The point of planning before writing: the archived document's absolute
         * references have become paths inside the zip. If this still said
         * `href="/style.css"` the archive would be a folder of files that only
         * work when served from the site's own root.
         */
        expect(html).not.toContain('href="/style.css"');
        expect(html).not.toContain('src="/logo.png"');
        expect(html).toContain("style");
    });

    test("the manifest reports what the walk did, per document", async () => {
        const response = await get("?urls=https://site.test/", depsFor());
        const seen = await inspect(await response.arrayBuffer());
        const manifest = JSON.parse(seen.contents["_warc-manifest.json"]);

        // One requested item, so one row — and the walk's account hangs off it
        // rather than off the archive, because a request can hold several walks.
        expect(manifest.entries).toHaveLength(1);

        const row = manifest.entries[0];

        expect(row.request).toBe("https://site.test/");
        expect(row.status).toBe("stored");
        expect(row.resolvedPath).toBeTruthy();
        expect(row.expansion.dependencies).toBeGreaterThan(0);
        expect(Array.isArray(row.expansion.missing)).toBe(true);
        expect(Array.isArray(row.expansion.merged)).toBe(true);
        expect(Array.isArray(row.expansion.notices)).toBe(true);
    });

    test("a reference the archive does not hold is reported, not fatal", async () => {
        // Everything except bg.png, which the stylesheet asks for.
        const partial = Object.values(stored).filter(one => one.url !== "https://site.test/bg.png");

        const response = await get("?urls=https://site.test/", depsFor(partial));

        expect(response.status).toBe(200);

        const seen = await inspect(await response.arrayBuffer());
        const manifest = JSON.parse(seen.contents["_warc-manifest.json"]);

        expect(seen.bad).toBeNull();

        const row = manifest.entries[0];

        expect(row.expansion.missing.length).toBeGreaterThan(0);
        expect(JSON.stringify(row.expansion.missing)).toContain("bg.png");
    });

    /*
     * The digest merge, which is what §5.1 of the plan is about and what the
     * `payload_digest` column was added for.
     *
     * Two urls, identical bytes. Without the digest reaching the walk this stores
     * the stylesheet twice and half the references point at each copy — a size
     * regression that nothing reports.
     */
    test("identical bytes at two urls become one entry", async () => {
        const withAlias = `<!doctype html>
<html><head>
  <link rel="stylesheet" href="https://site.test/style.css">
  <link rel="stylesheet" href="http://site.test/style.css">
</head><body>ok</body></html>`;

        // A root whose html references both copies.
        const root: Stored = {
            ...stored.page!,
            url: "https://site.test/two-sheets.html",
            id: "rec-two-sheets",
            body: withAlias,
            digest: "sha1:TWOSHEETS",
        };

        // Written into its own file so the offsets stay honest.
        const path = `${DIR}/two.warc`;
        const header = `WARC/1.1\r\nWARC-Type: response\r\n\r\n`;
        await Bun.write(path, header + withAlias);

        const rootRow = {
            ...rowFor(root),
            file_path: path,
            byte_offset: header.length,
            byte_length: withAlias.length,
        };

        const deps: DownloadDeps = {
            byIds: () => Promise.resolve([rootRow]),
            byUrl: (url) => {
                if (url === root.url) return Promise.resolve([rootRow]);

                const found = Object.values(stored).find(one => one.url === url);

                return Promise.resolve(found ? [rowFor(found)] : []);
            },
        };

        const response = await get("?ids=rec-two-sheets", deps);
        const seen = await inspect(await response.arrayBuffer());
        const manifest = JSON.parse(seen.contents["_warc-manifest.json"]);

        expect(seen.bad).toBeNull();

        // One stylesheet in the archive, not two.
        const sheets = seen.names.filter((name: string) => name.endsWith(".css"));

        expect(sheets).toHaveLength(1);

        // And the merge is on the record, with the second url as an alias — the
        // absence of this is exactly how a missing digest presents.
        const merged = manifest.entries[0].expansion.merged;

        expect(merged).toHaveLength(1);
        expect(merged[0].by).toBe("digest");
        expect(merged[0].aliases.join(" ")).toContain("style.css");
    });

    test("without a digest the same bytes are stored twice", async () => {
        /*
         * The mutation, as a test rather than as a comment.
         *
         * This is what recursive mode did before `payload_digest` was added to the
         * view and the nearest-capture query: correct output, quietly larger, and
         * no merge to notice the absence of.
         */
        const noDigest = Object.values(stored).map(one => ({ ...one, digest: "" }));

        const withAlias = `<!doctype html><link rel="stylesheet" href="https://site.test/style.css">`
            + `<link rel="stylesheet" href="http://site.test/style.css">`;

        const path = `${DIR}/nodigest.warc`;
        const header = `WARC/1.1\r\n\r\n`;
        await Bun.write(path, header + withAlias);

        const rootRow = {
            ...rowFor(stored.page!),
            uri: "https://site.test/nodigest.html",
            warc_custom_id: "rec-nodigest",
            file_path: path,
            byte_offset: header.length,
            byte_length: withAlias.length,
            payload_digest: null,
        };

        const deps: DownloadDeps = {
            byIds: () => Promise.resolve([rootRow]),
            byUrl: (url) => {
                const found = noDigest.find(one => one.url === url);

                return Promise.resolve(found ? [{ ...rowFor(found), payload_digest: null }] : []);
            },
        };

        const response = await get("?ids=rec-nodigest", deps);
        const seen = await inspect(await response.arrayBuffer());
        const manifest = JSON.parse(seen.contents["_warc-manifest.json"]);

        expect(seen.bad).toBeNull();
        expect(seen.names.filter((name: string) => name.endsWith(".css"))).toHaveLength(2);
        expect(manifest.entries[0].expansion.merged).toHaveLength(0);
    });
});
