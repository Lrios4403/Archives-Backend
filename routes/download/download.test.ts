// bun test routes/download/download.test.ts
//
// The download route, driven end to end with fake lookups over a real file.
//
// Fakes for the database, a real WARC on disk for the bytes: the failures worth
// testing here are the ones that are hard to arrange in Postgres and trivial to
// arrange in a fixture — a row pointing past the end of a file, an archive that
// is not there, a length that does not match the header it was promised in.
//
// Every archive is validated by Python's `zipfile`, which shares no code and no
// assumptions with the writer. A zip can be exactly the promised length and still
// be unreadable, so the length assertions and the validity assertions are both
// necessary and neither is sufficient.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, appendFileSync } from "node:fs";
import { batchWithFallback, createDownloadRoute, type DownloadDeps } from "./index";
import { dedupe, fixedRange, pathForEntry, toEntry, type PayloadRow } from "./entries";

const DIR = "/tmp/download-route-test";
const WARC = `${DIR}/fixture.warc`;

/**
 * A WARC-ish file with known payloads at known offsets.
 *
 * Built once. The offsets are computed rather than written down, because a
 * hand-counted offset that is wrong makes every test in the file fail in the same
 * confusing way.
 */
const payloads: Record<string, { offset: number; length: number; body: string }> = {};

beforeAll(async () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });

    const bodies = {
        page: "<!doctype html><title>a page</title><p>hello</p>",
        style: "body { color: rebeccapurple }",
        image: "\x89PNG\r\n\x1a\n" + "binary-ish".repeat(40),
        empty: "",
    };

    let file = "";

    for (const [name, body] of Object.entries(bodies)) {
        const header = `WARC/1.1\r\nWARC-Type: response\r\nContent-Length: ${body.length}\r\n\r\n`;
        file += header;
        payloads[name] = { offset: file.length, length: body.length, body };
        file += body + "\r\n\r\n";
    }

    await Bun.write(WARC, file);
});

afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
});

const row = (
    id: string,
    uri: string,
    which: keyof typeof payloads | "missing-file" | "past-eof" | "chunked",
): PayloadRow => {
    const base = { warc_custom_id: id, uri, chunks: null, archived_date: "2026-06-22T22:16:51.890Z" };

    if (which === "missing-file") {
        return { ...base, file_path: `${DIR}/never-written.warc`, byte_offset: 0, byte_length: 100 };
    }

    if (which === "past-eof") {
        return { ...base, file_path: WARC, byte_offset: 10, byte_length: 10_000_000 };
    }

    if (which === "chunked") {
        const at = payloads.page!;
        return { ...base, file_path: WARC, byte_offset: at.offset, byte_length: at.length, chunks: [4, 5] };
    }

    const at = payloads[which]!;

    return { ...base, file_path: WARC, byte_offset: at.offset, byte_length: at.length };
};

/** Lookups that answer from a fixed table, and count how often they were asked. */
const fakeDeps = (
    byId: Record<string, PayloadRow>,
    byUrl: Record<string, PayloadRow> = {},
): DownloadDeps & { calls: { ids: number; urls: number } } => {
    const calls = { ids: 0, urls: 0 };

    return {
        calls,
        byIds: (ids) => {
            calls.ids++;
            // Deliberately reversed: the route must match rows by id, not by the
            // order the database happened to return them in.
            return Promise.resolve(ids.map(id => byId[id]).filter(Boolean).reverse() as PayloadRow[]);
        },
        byUrl: (url) => {
            calls.urls++;
            const found = byUrl[url];
            return Promise.resolve(found ? [found] : []);
        },
    };
};

const request = (query: string) =>
    new Request(`http://localhost:3000/api/warcs/download${query}`);

/** Hand the archive to Python and ask what it thinks of it. */
const inspect = async (bytes: ArrayBuffer) => {
    const path = `${DIR}/out-${Math.random().toString(36).slice(2)}.zip`;
    await Bun.write(path, bytes);

    const result = Bun.spawnSync(["python3", "-c", `
import json, zipfile
try:
    with zipfile.ZipFile(${JSON.stringify(path)}) as a:
        print(json.dumps({
            "ok": True, "bad": a.testzip(), "names": a.namelist(),
            "contents": {n: a.read(n).decode("latin-1") for n in a.namelist()},
        }))
except Exception as problem:
    print(json.dumps({"ok": False, "error": str(problem)}))
`]);

    return JSON.parse(result.stdout.toString().trim());
};

/** The response, its promised length, and its actual body. */
const download = async (query: string, deps: DownloadDeps) => {
    const response = await createDownloadRoute(deps)(request(query));
    const promised = Number(response.headers.get("x-warc-content-length"));
    const bytes = await response.arrayBuffer();

    return { response, promised, bytes, body: bytes.byteLength };
};

describe("pathForEntry", () => {
    test("host, path, id and extension", () => {
        expect(pathForEntry("https://example.test/a/b/page.html", "abc123"))
            .toBe("example.test/a/b/page.abc123.html");
    });

    test("a bare host gets an index", () => {
        expect(pathForEntry("https://example.test/", "id1")).toBe("example.test/index.id1.html");
    });

    /*
     * The security-relevant one: this decides where a file lands on a stranger's
     * disk when they extract the archive.
     *
     * The invariant is per-SEGMENT, not "the string contains no dots". A filename
     * like `a..b` is ordinary and harmless; traversal needs a segment that IS `..`,
     * an absolute path, or a separator smuggled through. Asserting no `..`
     * anywhere fails on `..%2f..%2f` — which cleans to `-2f..-2f…`, a perfectly
     * inert filename — and would have sent someone hardening code that is already
     * correct.
     */
    test("cannot escape the archive", () => {
        for (const hostile of [
            "https://example.test/../../../etc/passwd",
            "https://example.test/..%2f..%2fetc%2fpasswd",
            "https://example.test/a/../../b",
            "https://example.test/%2e%2e/%2e%2e/x",
            "https://example.test/a/./../b",
            "https://example.test/C:\\Windows\\system32",
            "https://example.test/a\u0000b",
            "https://example.test//////",
        ]) {
            const path = pathForEntry(hostile, "id");
            const segments = path.split("/");

            expect(path.startsWith("/")).toBe(false);
            expect(path).not.toContain("\\");
            expect(path).not.toContain(":");
            expect(path).not.toContain("\u0000");

            for (const segment of segments) {
                expect(segment).not.toBe("");
                expect(segment).not.toBe(".");
                expect(segment).not.toBe("..");
            }
        }
    });

    test("a query string disambiguates rather than being dropped", () => {
        const a = pathForEntry("https://example.test/p?page=1", "id");
        const b = pathForEntry("https://example.test/p?page=2", "id");

        expect(a).not.toBe(b);
    });

    test("something that is not a url still lands somewhere", () => {
        expect(pathForEntry("not a url at all", "id")).toContain("unknown-host");
    });

    test("a wild segment is truncated rather than passed through", () => {
        const path = pathForEntry(`https://example.test/${"x".repeat(500)}.html`, "id");

        expect(path.length).toBeLessThan(200);
    });
});

describe("fixedRange", () => {
    // The measurement this exists for: a held BunFile slice re-stats, so its size
    // can move between being summed into Content-Length and being written.
    test("the size does not move when the file grows", () => {
        const growing = `${DIR}/grows.warc`;

        Bun.spawnSync(["bash", "-c", `printf '0123456789' > ${growing}`]);

        const { source, available } = fixedRange(growing, 0, 10);

        expect(available).toBe(10);

        appendFileSync(growing, "ABCDEFGHIJKLMNOP");

        // A raw BunFile slice would report the new length here. This one cannot.
        expect(source.size).toBe(10);
    });

    test("reads are clamped to the frozen size", async () => {
        const growing = `${DIR}/clamped.warc`;

        Bun.spawnSync(["bash", "-c", `printf '0123456789' > ${growing}`]);

        const { source } = fixedRange(growing, 0, 10);

        appendFileSync(growing, "PADDINGPADDING");

        const whole = await source.slice().arrayBuffer();
        const over = await source.slice(0, 1000).arrayBuffer();

        expect(whole.byteLength).toBe(10);
        expect(over.byteLength).toBe(10);
    });

    test("a missing file offers nothing", () => {
        expect(fixedRange(`${DIR}/nope.warc`, 0, 100).available).toBe(0);
    });
});

describe("toEntry", () => {
    test("a good row becomes a lazy entry", () => {
        const made = toEntry(row("id1", "https://example.test/p.html", "page"), "id1", "id");

        expect(made.status.status).toBe("stored");
        expect(made.entry?.data.size).toBe(payloads.page!.length);
    });

    // Both of these are silent without the check: a missing archive stats as 0 and
    // a row past the end clamps, so the zip would hold a plausible file with the
    // wrong bytes and Content-Length would agree with the mistake.
    test("a missing archive is a short-read, not an empty file", () => {
        const made = toEntry(row("id1", "https://example.test/p", "missing-file"), "id1", "id");

        expect(made.entry).toBeNull();
        expect(made.status.status).toBe("short-read");
        expect(made.status.detail).toContain("currently offers 0");
    });

    test("a row past the end of the file is a short-read", () => {
        const made = toEntry(row("id1", "https://example.test/p", "past-eof"), "id1", "id");

        expect(made.entry).toBeNull();
        expect(made.status.status).toBe("short-read");
    });

    // Chunked payloads used to be skipped with a `chunked-skipped` row. They are
    // de-framed as they stream now — see chunked.test.ts for the state machine.
    test("a chunked payload is stored, de-framed", () => {
        const made = toEntry(row("id1", "https://example.test/p", "chunked"), "id1", "id");

        expect(made.status.status).toBe("stored");
        expect(made.entry).toBeTruthy();
        expect(made.status.detail).toContain("de-chunked");
        // The DECODED size, which is what the reader gets out of the zip.
        expect(made.entry!.data.size).toBe(9);
    });

    test("a row with no payload columns is no-payload", () => {
        const made = toEntry(
            { warc_custom_id: "x", uri: "https://e.test/", file_path: null, byte_offset: null, byte_length: null, chunks: null },
            "x", "id");

        expect(made.status.status).toBe("no-payload");
    });

    test("a zero-length payload is legal and stored", () => {
        const made = toEntry(row("id1", "https://example.test/e", "empty"), "id1", "id");

        expect(made.status.status).toBe("stored");
        expect(made.entry?.data.size).toBe(0);
    });
});

describe("dedupe", () => {
    test("collapses entries sharing a path but keeps both ledger rows", () => {
        const one = toEntry(row("id1", "https://example.test/p.html", "page"), "id1", "id");
        const two = toEntry(row("id1", "https://example.test/p.html", "page"), "id1", "id");

        const ledger = dedupe({
            entries: [one.entry!, two.entry!],
            status: [one.status, two.status],
        });

        expect(ledger.entries).toHaveLength(1);
        expect(ledger.status).toHaveLength(2);
    });
});

/*
 * The batch lookup is an optimisation, and this is what stops it being a single
 * point of failure.
 *
 * It was one. The first batch query used `= ANY(${ids})`, which Postgres rejects
 * with "malformed array literal" because that syntax wants a Postgres ARRAY and a
 * JS array in Bun's template does not produce one. Every download came back as an
 * archive holding nothing but a manifest that said `error` — the route was working
 * exactly as designed, faithfully reporting a lookup that could never succeed.
 */
describe("batchWithFallback", () => {
    const rowFor = (id: string): PayloadRow => ({
        ...row(id, `https://example.test/${id}`, "page"),
        warc_custom_id: id,
    });

    test("uses the batch when it works, and asks nothing twice", async () => {
        let singles = 0;

        const byIds = batchWithFallback(
            (ids) => Promise.resolve(ids.map(rowFor)),
            (id) => { singles++; return Promise.resolve([rowFor(id)]); },
            () => {},
        );

        expect(await byIds(["a", "b", "c"])).toHaveLength(3);
        expect(singles).toBe(0);
    });

    test("falls back to one query per id when the batch rejects", async () => {
        const asked: string[] = [];

        const byIds = batchWithFallback(
            () => Promise.reject(new Error('malformed array literal: "warcs/…"')),
            (id) => { asked.push(id); return Promise.resolve([rowFor(id)]); },
            () => {},
        );

        const rows = await byIds(["a", "b", "c"]);

        expect(asked).toEqual(["a", "b", "c"]);
        expect(rows.map(one => one.warc_custom_id)).toEqual(["a", "b", "c"]);
    });

    test("reports why it fell back, once, rather than silently going slow", async () => {
        const reasons: unknown[] = [];

        const byIds = batchWithFallback(
            () => Promise.reject(new Error("boom")),
            (id) => Promise.resolve([rowFor(id)]),
            (error) => { reasons.push(error); },
        );

        await byIds(["a", "b"]);

        expect(reasons).toHaveLength(1);
        expect(String(reasons[0])).toContain("boom");
    });

    test("a genuinely missing id is still missing after the fallback", async () => {
        const byIds = batchWithFallback(
            () => Promise.reject(new Error("boom")),
            (id) => Promise.resolve(id === "here" ? [rowFor(id)] : []),
            () => {},
        );

        expect((await byIds(["here", "gone"])).map(one => one.warc_custom_id)).toEqual(["here"]);
    });

    test("one failing id in the fallback does not lose the others", async () => {
        const byIds = batchWithFallback(
            () => Promise.reject(new Error("boom")),
            (id) => id === "bad" ? Promise.reject(new Error("nope")) : Promise.resolve([rowFor(id)]),
            () => {},
        );

        expect((await byIds(["a", "bad", "b"])).map(one => one.warc_custom_id)).toEqual(["a", "b"]);
    });

    // The end-to-end consequence: a broken batch query is a slow download, not a
    // download of nothing.
    test("the route still produces a real archive when the batch is broken", async () => {
        const good = fakeDeps({ image: row("image", "https://example.test/img/logo.png", "image") });

        const broken: DownloadDeps = {
            byIds: batchWithFallback(
                () => Promise.reject(new Error("malformed array literal")),
                (id) => good.byIds([id]),
                () => {},
            ),
            byUrl: good.byUrl,
        };

        const { response, promised, body, bytes } = await download("?ids=image&resources=0", broken);

        expect(response.status).toBe(200);
        expect(body).toBe(promised);

        const seen = await inspect(bytes);
        const manifest = JSON.parse(seen.contents["_warc-manifest.json"]);

        expect(seen.bad).toBeNull();
        expect(manifest.stored).toBe(1);
        expect(manifest.entries[0].status).toBe("stored");
    });
});

describe("the route", () => {
    const deps = () => fakeDeps({
        page: row("page", "https://example.test/index.html", "page"),
        style: row("style", "https://example.test/a/style.css", "style"),
        image: row("image", "https://example.test/img/logo.png", "image"),
        gone: row("gone", "https://example.test/gone", "missing-file"),
    }, {
        "https://example.test/index.html": row("page", "https://example.test/index.html", "page"),
    });

    test("refuses a request that asks for nothing", async () => {
        const response = await createDownloadRoute(deps())(request(""));

        expect(response.status).toBe(400);
    });

    /*
     * The cap refuses rather than truncating.
     *
     * It used to `slice(0, 500)`, so a request for six hundred captures produced
     * an archive of five hundred that said nothing about the other hundred. Every
     * other shortfall in this route reaches the manifest; this one could not,
     * because the entries were dropped before anything knew they existed.
     */
    test("refuses a request over the cap instead of quietly shortening it", async () => {
        const many = Array.from({ length: 501 }, (_, i) => `ids=id-${i}`).join("&");
        const response = await createDownloadRoute(deps())(request(`?${many}`));

        expect(response.status).toBe(400);
        expect(await response.text()).toContain("501");
    });

    test("the cap counts ids and urls together, since the work is the same", async () => {
        const half = Array.from({ length: 251 }, (_, i) => `ids=id-${i}`).join("&");
        const rest = Array.from({ length: 251 }, (_, i) => `urls=https://e.test/${i}`).join("&");

        const response = await createDownloadRoute(deps())(request(`?${half}&${rest}`));

        expect(response.status).toBe(400);
        expect(await response.text()).toContain("502");
    });

    test("exactly at the cap is allowed", async () => {
        const many = Array.from({ length: 500 }, (_, i) => `ids=id-${i}`).join("&");
        const response = await createDownloadRoute(deps())(request(`?${many}`));

        expect(response.status).toBe(200);
    });

    /*
     * The probe exists because of a catch-22: when a download comes out wrong the
     * explanation is in the manifest, and the manifest is inside the zip — so a
     * zip that will not open takes its own diagnosis with it.
     */
    describe("probe=1", () => {
        test("answers with the ledger and no archive", async () => {
            const response = await createDownloadRoute(deps())(
                request("?ids=page&ids=nope&probe=1"));

            expect(response.headers.get("content-type")).toContain("application/json");

            const probe = await response.json() as {
                probe: boolean; requested: number; stored: number; files: number;
                contentLength: number; payloadBytes: number;
                entries: { request: string; status: string }[];
                files_detail: { path: string; size: number }[];
            };

            expect(probe.probe).toBe(true);
            expect(probe.requested).toBe(2);
            expect(probe.stored).toBe(1);
            expect(probe.entries.map(one => one.status)).toEqual(["stored", "not-found"]);

            // The paths and sizes, which is what "why is this 128 KB" is asking.
            expect(probe.files_detail).toHaveLength(1);
            expect(probe.files_detail[0]!.size).toBe(payloads.page!.length);
        });

        // The number it reports has to be the number a real download promises, or
        // the probe is a second implementation that can disagree with the first.
        test("its contentLength equals the real response's header", async () => {
            const probe = await (await createDownloadRoute(deps())(
                request("?ids=page&ids=style&resources=0&probe=1"))).json() as { contentLength: number };

            const real = await createDownloadRoute(deps())(
                request("?ids=page&ids=style&resources=0"));

            expect(probe.contentLength).toBe(Number(real.headers.get("x-warc-content-length")));
            expect((await real.arrayBuffer()).byteLength).toBe(probe.contentLength);
        });

        test("reads nothing: it is the plan, not the payload", async () => {
            const response = await createDownloadRoute(deps())(request("?ids=image&probe=1"));

            // A JSON body that never touched the WARC. `payloadBytes` is summed
            // from declared sizes, which is a stat rather than a read.
            const probe = await response.json() as { payloadBytes: number };

            expect(probe.payloadBytes).toBe(payloads.image!.length);
        });
    });

    test("refuses a dateNear that is not a date", async () => {
        const response = await createDownloadRoute(deps())(request("?urls=x&dateNear=yesterday"));

        expect(response.status).toBe(400);
        expect(await response.text()).toContain("yesterday");
    });

    test("the promised Content-Length is the body, exactly", async () => {
        const { promised, body } = await download("?ids=page&ids=style&ids=image", deps());

        expect(promised).toBeGreaterThan(0);
        expect(body).toBe(promised);
    });

    test("and the archive is valid, with the payloads intact", async () => {
        const { bytes } = await download("?ids=page&ids=style&ids=image", deps());
        const seen = await inspect(bytes);

        expect(seen.error).toBeUndefined();
        expect(seen.bad).toBeNull();
        expect(seen.names).toContain("_warc-manifest.json");

        // The bytes out of the WARC, not the record header around them.
        expect(seen.contents["example.test/index.page.html"]).toBe(payloads.page!.body);
        expect(seen.contents["example.test/a/style.style.css"]).toBe(payloads.style!.body);
    });

    test("a missing id is a manifest row, not a failed request", async () => {
        const { response, promised, body, bytes } = await download(
            "?ids=page&ids=not-a-real-id&ids=gone", deps());

        expect(response.status).toBe(200);
        expect(body).toBe(promised);
        expect(response.headers.get("x-warc-missing")).toBe("2");

        const seen = await inspect(bytes);
        const manifest = JSON.parse(seen.contents["_warc-manifest.json"]);

        expect(manifest.requested).toBe(3);
        expect(manifest.stored).toBe(1);

        const byRequest = Object.fromEntries(
            manifest.entries.map((one: { request: string; status: string }) => [one.request, one.status]));

        expect(byRequest["not-a-real-id"]).toBe("not-found");
        expect(byRequest["gone"]).toBe("short-read");
    });

    test("ids are matched by id, not by the order the database returned them", async () => {
        // The fake reverses its rows on purpose.
        const { bytes } = await download("?ids=page&ids=style", deps());
        const manifest = JSON.parse((await inspect(bytes)).contents["_warc-manifest.json"]);

        expect(manifest.entries.map((one: { request: string }) => one.request)).toEqual(["page", "style"]);

        for (const one of manifest.entries) {
            // page -> .html, style -> .css. A positional match would cross them.
            if (one.request === "page") expect(one.resolvedPath).toContain(".html");
            if (one.request === "style") expect(one.resolvedPath).toContain(".css");
        }
    });

    test("every id costs one round trip, not one each", async () => {
        const injected = deps();

        await download("?ids=page&ids=style&ids=image", injected);

        expect(injected.calls.ids).toBe(1);
    });

    test("urls resolve through the nearest-capture lookup", async () => {
        const injected = deps();
        const { bytes } = await download("?urls=https://example.test/index.html", injected);

        expect(injected.calls.urls).toBe(1);

        const seen = await inspect(bytes);

        expect(seen.bad).toBeNull();
        expect(seen.contents["example.test/index.page.html"]).toBe(payloads.page!.body);
    });

    test("ids and urls in one request", async () => {
        const { promised, body, bytes } = await download(
            "?ids=style&urls=https://example.test/index.html", deps());

        expect(body).toBe(promised);

        const manifest = JSON.parse((await inspect(bytes)).contents["_warc-manifest.json"]);

        expect(manifest.entries.map((one: { kind: string }) => one.kind)).toEqual(["id", "url"]);
    });

    test("a lookup that throws fails only its own entries", async () => {
        const broken: DownloadDeps = {
            byIds: () => Promise.reject(new Error("connection reset")),
            byUrl: (url) => Promise.resolve([row("page", url, "page")]),
        };

        const { response, promised, body, bytes } = await download(
            "?ids=a&ids=b&urls=https://example.test/ok", broken);

        expect(response.status).toBe(200);
        expect(body).toBe(promised);

        const manifest = JSON.parse((await inspect(bytes)).contents["_warc-manifest.json"]);
        const byRequest = Object.fromEntries(
            manifest.entries.map((one: { request: string; status: string; detail?: string }) =>
                [one.request, one.status]));

        expect(byRequest["a"]).toBe("error");
        expect(byRequest["b"]).toBe("error");
        expect(manifest.stored).toBe(1);
    });

    test("a duplicate id is stored once and reported twice", async () => {
        const { bytes } = await download("?ids=page&ids=page", deps());
        const seen = await inspect(bytes);
        const manifest = JSON.parse(seen.contents["_warc-manifest.json"]);

        expect(seen.names.filter((n: string) => n.endsWith(".page.html"))).toHaveLength(1);
        expect(manifest.entries).toHaveLength(2);
    });

    test("an archive of only misses is still a valid zip", async () => {
        const { promised, body, bytes } = await download("?ids=nope1&ids=nope2", deps());
        const seen = await inspect(bytes);

        expect(body).toBe(promised);
        expect(seen.bad).toBeNull();
        expect(seen.names).toEqual(["_warc-manifest.json"]);
    });

    test("the response carries a filename and the counts", async () => {
        const { response } = await download("?ids=page", deps());

        expect(response.headers.get("content-type")).toBe("application/zip");
        expect(response.headers.get("content-disposition")).toMatch(/attachment; filename="archives\..+\.zip"/);
        expect(response.headers.get("x-warc-entries")).toBe("2");   // the page plus the manifest
        expect(response.headers.get("x-warc-missing")).toBe("0");
    });

    /*
     * The streaming invariant that matters most: the headers must be out before
     * any payload is read. If constructing the response drains the archive, then
     * every guarantee in the plan's §3.1 is void regardless of what the writer
     * does internally.
     */
    test("the response is returned with its body untouched", async () => {
        const response = await createDownloadRoute(deps())(request("?ids=page&ids=image"));

        /*
         * `bodyUsed` is the assertion, and it is the only one available from here.
         *
         * An earlier version of this test counted reads through a variable nothing
         * ever incremented, so it asserted `0 === 0` and would have passed against
         * a route that read the whole archive before replying. Counting reads for
         * real needs a source the route does not own, which is what
         * streaming.test.ts does at the writer level; from out here the honest
         * question is whether the response arrives with the body unconsumed and a
         * length already committed to.
         */
        expect(response.bodyUsed).toBe(false);
        expect(response.headers.get("x-warc-content-length")).toBeTruthy();

        const promised = Number(response.headers.get("x-warc-content-length"));
        const drained = await response.arrayBuffer();

        expect(drained.byteLength).toBe(promised);
        expect(response.bodyUsed).toBe(true);
    });
});
