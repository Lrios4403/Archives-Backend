import type { BunRequest } from "bun";
import { get_warc_response_payload, get_warc_response_payload_near } from "../../db";
import { parseChunkSizes, dechunkBody, chunkDataRanges } from "./chunks";
import { registerHtmlHandlers, rewriteCssText, type RedirectAction } from "./rewrite";
import { fragmentOf, stripFragment } from "../../uri";

const textDecoder = new TextDecoder();

function parseDateNear(dateNearRaw: string | null): Date {
    // Use provided date if present, otherwise use now
    return dateNearRaw ? new Date(dateNearRaw) : new Date();
}

/**
 * Bun's SQL client usually returns JSONB columns already decoded into JS objects,
 * but can also hand back a JSON string. Accept either, so the redirect/location
 * rewrite never silently breaks on JSON.parse(object) throwing.
 */
function normalizeDbJson(value: unknown): Record<string, any> {
    if (!value) return {};
    if (typeof value === "string") {
        try { return JSON.parse(value); } catch { return { raw: value }; }
    }
    if (typeof value === "object") return value as Record<string, any>;
    return {};
}

/**
 * Parse a single HTTP Range header (RFC 7233) against a known total length.
 * Supports "bytes=start-end", "bytes=start-" (open-ended) and "bytes=-suffix"
 * (last N bytes). Returns an inclusive {start,end}, null (no/unsupported range ->
 * serve the whole body as 200), or "unsatisfiable" (-> 416). Multi-range requests
 * are treated as no-range (serve full), which is spec-compliant and enough for
 * media players, which always request a single range.
 */
function parseRange(
    header: string | null | undefined,
    totalLen: number,
): { start: number; end: number } | null | "unsatisfiable" {
    if (!header) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) return null; // malformed or multi-range -> just serve the full body
    const [, s, e] = m;
    if (s === "" && e === "") return null;

    let start: number;
    let end: number;
    if (s === "") {
        // suffix range: the last `suffix` bytes
        const suffix = Number(e);
        if (suffix <= 0) return "unsatisfiable";
        start = Math.max(0, totalLen - suffix);
        end = totalLen - 1;
    } else {
        start = Number(s);
        end = e === "" ? totalLen - 1 : Number(e);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalLen) {
        return "unsatisfiable";
    }
    if (end >= totalLen) end = totalLen - 1; // clamp to the resource
    return { start, end };
}

/*
 * The absolute base every rewritten url in the archived page is built on.
 *
 * This was hardcoded to http://localhost:3000/api/warcs/view, which is correct
 * exactly when the reader is sitting at the machine running the backend. Served
 * through anything else — the VPS at archives.m4cgyver.net over the WireGuard
 * tunnel — every rewritten href, src, srcset, CSS url() and @import in the
 * document pointed at a port on the READER'S OWN machine. The page renders, and
 * then every stylesheet, script and image fails to load.
 *
 * Derived from the request instead, so the document refers back to whatever
 * host actually served it, and no caller has to know or pass anything:
 *
 *   direct     Host: localhost:3000                    -> http://localhost:3000/...
 *   via nginx  Host: archives.m4cgyver.net             -> https://archives.m4cgyver.net/...
 *              X-Forwarded-Proto: https
 *
 * The proxy headers are the load-bearing part. Behind nginx the connection to
 * this server is plain http, so requestUrl.protocol says "http" and the archived
 * page would be full of http:// links inside an https:// document — mixed
 * content, which browsers block outright.
 *
 * An explicit ?apiUri= still wins, and is threaded onto every rewritten url in
 * rewrite.tsx, so it keeps propagating to nested resources exactly as before.
 */
const requestApiUri = (req: BunRequest, requestUrl: URL): string => {
    const first = (value: string | null) => value?.split(",")[0]?.trim() || undefined;

    const proto = first(req.headers.get("x-forwarded-proto"))
        ?? requestUrl.protocol.replace(":", "");
    const host = first(req.headers.get("x-forwarded-host"))
        ?? req.headers.get("host")
        ?? requestUrl.host;

    return `${proto}://${host}/api/warcs/view`;
};

/** Main handler (promise-chained style) */
export const viewRoute = (req: BunRequest): Promise<Response> => {
    const requestUrl = new URL(req.url);
    const id = requestUrl.searchParams.get("id");
    const rawUri = requestUrl.searchParams.get("uri");
    const dateNearRaw = requestUrl.searchParams.get("dateNear");
    const dateNear = parseDateNear(dateNearRaw);
    const apiUri = requestUrl.searchParams.get('apiUri') ?? requestApiUri(req, requestUrl);
    const preventDefaultFlag = requestUrl.searchParams.get("preventDefault") === "true";

    /*
     * What a click inside the frame should do. See RedirectAction in rewrite.tsx.
     *
     * `preventDefault=true` is kept as an alias for `redirectAction=postMessage`
     * rather than dropped: it is threaded through every rewritten url in this
     * file, so a page already open in a reader's tab has it on every link, and
     * retiring it outright would break navigation for exactly as long as that
     * tab stays open. The new parameter wins when both are present.
     *
     * Anything unrecognised is "none". A typo should leave the frame inert
     * rather than silently enabling a behaviour the caller did not ask for.
     */
    const redirectAction: RedirectAction =
        requestUrl.searchParams.get("redirectAction") === "postMessage"
            || (requestUrl.searchParams.get("redirectAction") === null && preventDefaultFlag)
            ? "postMessage"
            : "none";

    /*
     * Canonicalise a fragment out of ?uri= and redirect.
     *
     * A fragment is browser-only and never reaches a server, so no crawler stores
     * "page#section" as a WARC-Target-URI and a lookup carrying one matches
     * nothing. Stripping it silently would fix the lookup but lose the anchor —
     * the browser would never learn where to scroll. A redirect is the only way to
     * hand the fragment back to the client, so we move it onto the outer URL:
     *
     *   in   ?uri=http%3A%2F%2Fex.com%2Fpage%23section&dateNear=...
     *   out  ?uri=http%3A%2F%2Fex.com%2Fpage&dateNear=...#section
     *
     * The browser then applies #section to the archived document it receives.
     *
     * Loop safety comes from fragmentOf(), which reports "" for a bare trailing
     * "#". Gating on "the string contains #" would make "page#" strip nothing,
     * rebuild an identical URL, and redirect forever. After a real redirect the
     * uri param has no "#" at all, so this branch cannot re-fire.
     *
     * 302 rather than 301 on purpose: a permanent redirect gets cached by the
     * browser, which is painful while the viewer is still changing.
     */
    if (rawUri) {
        const fragment = fragmentOf(rawUri);
        if (fragment) {
            const to = new URL(requestUrl);           // keeps dateNear/apiUri/preventDefault
            to.searchParams.set("uri", stripFragment(rawUri));
            to.hash = fragment;

            // This should be silent in normal operation — the rewriter now keeps
            // fragments out of ?uri= entirely. Volume here means some path is
            // still building archive URLs the old way, or an old link/bookmark is
            // in play, and that's worth being able to see.
            console.warn(
                `[view] fragment in ?uri= — redirecting to canonical form: ${rawUri}` +
                ` (referer: ${req.headers.get("referer") ?? "none"})`,
            );
            return Promise.resolve(Response.redirect(to.href, 302));
        }
    }

    // Fragment-free from here on. stripFragment also cleans up a bare trailing "#",
    // which does not warrant a redirect but must not reach the lookup.
    const uri = rawUri === null ? null : stripFragment(rawUri);

    if (!id && (!uri || !dateNear)) {
        return Promise.resolve(Response.json({ error: "Missing search parameters!" }, { status: 500 }));
    }

    const metaPromise = id !== null
        ? get_warc_response_payload(id)
        : get_warc_response_payload_near(uri ?? "", dateNear);

    return metaPromise.then(res => {
        if (!res || res.length === 0) {
            return Response.json({ error: `No record found`, id, url: uri, dateNear }, { status: 404 });
        }

        const meta = res[0];
        const start = Number(meta.byte_offset);
        const end = start + Number(meta.byte_length);
        const fh = Bun.file(meta.file_path);

        // Chunk data sizes recorded by the parser (payloads.chunks). Present only
        // when the archived response used Transfer-Encoding: chunked.
        const chunkSizes = parseChunkSizes(meta.chunks);
        const isChunked = chunkSizes.length > 0;

        const headers = normalizeDbJson(meta.headers);

        let location = headers.location ?? headers.Location;

        // normalize Location header to archived API link
        if (location) {
            try {
                const fullUrl = new URL(location, meta.uri);
                const archivedApiUrl = new URL(apiUri);
                archivedApiUrl.searchParams.set("uri", fullUrl.href);
                archivedApiUrl.searchParams.set("dateNear", meta.archived_date?.toString?.() ?? String(meta.archived_date));
                archivedApiUrl.searchParams.set("apiUri", apiUri);
                archivedApiUrl.searchParams.set("preventDefault", requestUrl.searchParams.get("preventDefault") ?? "");
                // Carried forward too, so a document reached BY a click is
                // guarded exactly like the one that was clicked from.
                archivedApiUrl.searchParams.set("redirectAction", redirectAction);
                location = archivedApiUrl.href;
            } catch (e) {
                // leave location as-is if parsing failed
            }
        }

        const contentType = String(meta.content_type || "");
        const baseCtx = { meta, apiUri, preventDefaultFlag, requestUrl, redirectAction };
        const status = Number(meta.status) || 200;

        const headersOut: Record<string, string> = { "Content-Type": contentType };
        if (location) headersOut["Location"] = location;

        // HTML or CSS: materialize the body as a string to rewrite URLs (de-chunk
        // first when chunked). NOTE: we intentionally do NOT stream non-chunked HTML
        // via HTMLRewriter.transform(Response) — that leaves the pre-rewrite
        // Content-Length on the response while the rewritten body is a different
        // length, which stalls the client until the idle timeout (~30s). Buffering
        // and transforming the string yields a correct Content-Length.
        if (contentType.includes("text/html") || contentType.includes("text/css")) {
            return fh.slice(start, end).arrayBuffer().then(rawBuf => {
                const raw = new Uint8Array(rawBuf);
                const text = textDecoder.decode(isChunked ? dechunkBody(raw, chunkSizes) : raw);

                if (contentType.includes("text/html")) {
                    const htmlRewriter = new HTMLRewriter();
                    registerHtmlHandlers(htmlRewriter, baseCtx);
                    return new Response(htmlRewriter.transform(text), { status, headers: headersOut });
                }
                return new Response(rewriteCssText(text, { meta, apiUri, requestUrl }), { status, headers: headersOut });
            });
        }

        // Binary / passthrough. Advertise range support so media players can seek.
        headersOut["Accept-Ranges"] = "bytes";

        // Unchunked: serve straight from the file so Bun can stream it (and use
        // sendfile(2)); slice the file directly by absolute offset for range requests.
        if (!isChunked) {
            const totalLen = end - start;
            const range = parseRange(req.headers.get("Range"), totalLen);

            if (range === "unsatisfiable") {
                return new Response(null, {
                    status: 416,
                    headers: { ...headersOut, "Content-Range": `bytes */${totalLen}` },
                });
            }
            if (range) {
                headersOut["Content-Range"] = `bytes ${range.start}-${range.end}/${totalLen}`;
                headersOut["Content-Length"] = String(range.end - range.start + 1);
                return new Response(fh.slice(start + range.start, start + range.end + 1), { status: 206, headers: headersOut });
            }
            headersOut["Content-Length"] = String(totalLen);
            return new Response(fh.slice(start, end), { status, headers: headersOut });
        }

        // Chunked: the decoded body is the concatenation of each chunk's data range
        // (framing stripped), assembled as a lazy multi-part blob; slice it for ranges.
        const body = new Blob(chunkDataRanges(start, chunkSizes).map(([s, e]) => fh.slice(s, e)));
        const totalLen = body.size;
        const range = parseRange(req.headers.get("Range"), totalLen);

        if (range === "unsatisfiable") {
            return new Response(null, {
                status: 416,
                headers: { ...headersOut, "Content-Range": `bytes */${totalLen}` },
            });
        }
        if (range) {
            // Blob.slice end is exclusive; our range end is inclusive.
            headersOut["Content-Range"] = `bytes ${range.start}-${range.end}/${totalLen}`;
            headersOut["Content-Length"] = String(range.end - range.start + 1);
            return new Response(body.slice(range.start, range.end + 1), { status: 206, headers: headersOut });
        }
        headersOut["Content-Length"] = String(totalLen);
        return new Response(body, { status, headers: headersOut });
    });
};
