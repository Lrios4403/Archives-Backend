/**
 * Rebuilding an archived page in the browser, from local files only.
 *
 * The backend serves an archived page by rewriting every asset url to point back
 * through /api/warcs/view, so the browser fetches each one from the server. The
 * offline viewer has no server: the WARCs are Files the user picked, so every
 * asset has to become a blob url before the document ever reaches an iframe.
 *
 * The shape that makes this workable is that this module does NOT hold the record
 * index. It asks, one url at a time. Shipping recordsUrlMap costs ~408ms of
 * blocking structured clone at 33k records, and 51% of that weight is
 * http.headers, which resolving a subresource never reads. A round trip is
 * microseconds and cannot go stale while a parse is still running.
 *
 * NOTHING HERE TOUCHES A GLOBAL. `resolve` and `createObjectURL` are both
 * injected, so this runs unchanged in a worker or on the main thread — which is
 * deliberate, because whether a parent document can load a blob url minted inside
 * a worker is a question best answered by trying it, and this way the answer does
 * not change any code in this file.
 *
 * Must stay free of Bun and Node APIs: bundled for the browser by
 * routes/parser.tsx, and run somewhere with no DOM. That rules out DOMParser and
 * HTMLRewriter, which is why the HTML rewriting below is textual.
 */

import { gunzipSync, unzlibSync } from "fflate";
import { readGzipPayloadSlice, type GzipLocation } from "./gzip";

/** The bit of Blob/File this module touches; the backend tsconfig has no DOM lib. */
export interface BlobLike {
    readonly size: number;
    slice(start?: number, end?: number): BlobLike;
    arrayBuffer(): Promise<ArrayBuffer>;
}

/** What is needed to turn a record into bytes. Cloneable — no functions. */
export interface ViewRecord {
    url: string;
    contentType: string;
    dateArchived: string;
    /** The archive the bytes live in. */
    file: BlobLike;
    payload: {
        /**
         * Offset of the first body byte.
         *
         * Real for a plain .warc. LOGICAL ONLY when `gzip` is present — slicing
         * `file` at it would return compressed bytes with no error, which renders
         * as a corrupt page rather than throwing. readPayload handles this; new
         * callers should go through readPayload rather than slicing themselves.
         */
        offset: number;
        /** Encoded length; includes chunk framing when chunked. */
        size: number;
        /** Per-chunk DECODED sizes, when the body was chunked. */
        chunks?: number[];
        /**
         * Where the bytes physically are, when the archive is a .warc.gz.
         *
         * Self-contained, so this works in a worker that never parsed the file.
         * Absent for a plain .warc.
         */
        gzip?: GzipLocation;
        /**
         * WARC-Payload-Digest, when the archive recorded one.
         *
         * Optional because the viewer never needed it. A download does: two
         * captures with the same digest are the same bytes, which is how
         * `http://` and `https://` of one page become a single zip entry
         * instead of two identical copies.
         */
        digest?: string | null;
    } | null;
    /**
     * WARC-Record-ID and the archive it came from.
     *
     * Carried on the record because a download names files after them, and any
     * lookup keyed by url would be wrong the moment two captures share one — which
     * is the normal case, and precisely the case the id exists to disambiguate.
     * Optional: the viewer has never needed either.
     */
    uuid?: string;
    warcFile?: string;

    /** Full Content-Type header, charset included, when there was one. */
    httpContentType?: string | null;
    /**
     * `Content-Encoding` of the captured response — "gzip", "br", or null.
     *
     * A DIFFERENT axis from `payload.gzip`, and both can apply at once: a
     * gzip-encoded body stored inside an already-gzipped archive member. They
     * decode in order — member, then chunked framing, then this — because that is
     * the order they were applied in.
     */
    contentEncoding?: string | null;
    /**
     * HTTP status of the capture. Null when the record carried no HTTP message.
     *
     * Needed because archives routinely store the SERVER'S 404 PAGE under an
     * asset's url — the crawler asked for /button/x.gif, got 404 and a page of
     * HTML, and stored exactly that. Without the status this is indistinguishable
     * from a real HTML resource, so the rewriter descended into the 404 page and
     * pulled in its stylesheet, its images and its nav, none of which the real
     * page wants. On one archive that was the difference between 1.7k and 12.8k
     * blobs across twelve pages.
     */
    status?: number | null;
}

/** Why the document itself cannot be shown at all. */
export type ViewFatalReason =
    /** No record for this url anywhere in the loaded archives. */
    | "not-archived"
    /** A record exists but stores no body: a revisit, a 304, a bodiless redirect. */
    | "no-payload"
    /** The File could not be read — moved on disk, permission revoked mid-session. */
    | "unreadable"
    /** Reserved for redirect-chain following. */
    | "redirect"
    /** Bytes exist but will not become a document. */
    | "decode";

/**
 * Why a REFERENCE could not be resolved. Never fatal: the page still renders.
 *
 * The distinction is the whole error model — fatal is about the document,
 * non-fatal is about everything it reaches through.
 */
export type MissingReason =
    | "not-archived"
    | "no-payload"
    | "unreadable"
    /** Stopped descending: see MAX_DEPTH. */
    | "depth-limit"
    /** A stylesheet that imports itself, directly or through a chain. */
    | "cycle"
    /** Reserved: asked for at runtime by script, once a fetch shim can report it. */
    | "dynamic"
    /** A 3xx chain that loops, or runs past the resolver's hop limit. */
    | "redirect"
    /**
     * The capture exists and records an HTTP error — usually a 404 page stored
     * under an asset's url. The resource was already gone when the crawl ran,
     * which is a different fact from the archive not holding it.
     */
    | "error-status";

export interface MissingRef {
    url: string;
    reason: MissingReason;
    /**
     * The document that wanted it. "bg.png is missing" versus "bg.png is missing,
     * wanted by style.css" is the difference between a shrug and a fix.
     */
    referrer: string;
}

/** What the resolver hands back. A null record carries the reason why. */
export interface ResolveOutcome {
    record: ViewRecord | null;
    reason?: MissingReason;
    /**
     * 3xx hops the resolver walked, in order, excluding the url asked for.
     *
     * The resolver follows redirects itself — it holds the record index, so it
     * can do in one pass what would otherwise be a round trip per hop. This is
     * the receipt: without it, a redirected reference is indistinguishable from
     * a lookup that quietly answered with the wrong record.
     */
    redirects?: string[];
}

export type ResolveRecord = (
    url: string,
    nearArchived: string,
    referrer: string,
) => Promise<ResolveOutcome>;

/** Re-exported so the worker can name the type it echoes back. */
export type { ResolveOutcome as ViewResolveOutcome };

/**
 * A reference that DID resolve, and to what.
 *
 * Reported for the same reason `missing` is: a url that resolves to the wrong
 * record is invisible from the outside — it looks like a complete success, and
 * the only symptom is the browser choking on the bytes much later, somewhere with
 * no url in the message. A `<script src>` that quietly came back as text/css is
 * exactly that failure, and without this list there is nothing to look at.
 */
export interface ResolvedRef {
    /** The url the document asked for. */
    url: string;
    /** The url of the record that answered — differs when a lookup fell back. */
    servedUrl: string;
    type: string;
    bytes: number;
    /** The document that wanted it. */
    referrer: string;
    /**
     * 3xx hops walked to reach it. Empty for the ordinary case.
     *
     * This is what separates the two ways `servedUrl` can differ from `url`: a
     * followed redirect (correct) and a fallback lookup (a bug). Without it the
     * diagnostic above cannot tell them apart and warns about both.
     */
    redirects?: string[];
}

export type ViewResult =
    | {
        ok: true;
        /** Blob url of the rebuilt document. */
        url: string;
        /**
         * The ARCHIVED url of the document that was built.
         *
         * Not derivable from `url`, which is a blob uuid, and not necessarily the
         * url that was asked for either — a redirect means the record that
         * rendered is the destination. Anything reporting on this view needs a
         * real address to name, so it travels with the result rather than being
         * remembered separately by each caller.
         */
        documentUrl: string;
        type: string;
        blobUrls: string[];
        missing: MissingRef[];
        resolved: ResolvedRef[];
    }
    | { ok: false; reason: ViewFatalReason; url: string; errorName: string; message: string };

/**
 * What the builder is doing right now.
 *
 * Rebuilding a page is not one step: the document's bytes come out of the
 * archive, get parsed, and then every reference in them is chased — which is
 * itself another read, another parse, another chase, several levels down. On a
 * page with two hundred subresources that is seconds of nothing, and a reader
 * looking at a blank frame cannot tell working from hung.
 */
export type ViewStage =
    /** Slicing a record's bytes out of the archive file. */
    | "reading"
    /** Chasing what a document references. The long one. */
    | "resolving"
    /** Substituting blob urls back into the document text. */
    | "rewriting"
    /** The blob url exists; nothing left to do. */
    | "done";

export interface ViewProgress {
    stage: ViewStage;
    /** The url being worked on at this moment — not the page, the resource. */
    url: string;
    /**
     * Subresources finished, and subresources KNOWN ABOUT so far.
     *
     * `total` grows as the walk descends: a stylesheet's own images are not
     * discovered until the stylesheet itself has been read. So this is honest
     * rather than smooth — it is what is known, not an estimate — and a bar
     * driven by it can move backwards in proportion. The counts are the useful
     * part; the ratio is a hint.
     */
    resolved: number;
    total: number;
}

export interface ViewDeps {
    resolve: ResolveRecord;
    /** Injected so this module never names a global. See the file note. */
    createObjectURL: (bytes: Uint8Array | string, type: string) => string;
    /**
     * Called as the build moves. Optional: every existing caller predates it and
     * a build that reports to nobody is a normal build.
     */
    onProgress?: (progress: ViewProgress) => void;
}

/**
 * Where a reference points when the archive does not contain it.
 *
 * about:blank rather than the original url, deliberately. A viewer that lets an
 * archived page fetch from the live web is a privacy leak — opening a 2019
 * capture would contact its original host today — and a lie about what was
 * captured, since present-day content would render as though it had been archived.
 */
export const MISSING_URL = "about:blank";

/**
 * What a missing SUBRESOURCE points at.
 *
 * An empty data: url rather than about:blank. Both render as nothing, but a
 * browser asked to load about:blank as an <img src> or a stylesheet logs
 * "ERR_UNKNOWN_URL_SCHEME" for every one — twenty missing assets meant twenty
 * console errors that looked like a failure in this code rather than a gap in the
 * archive. A data: url is a valid, empty, same-document resource: silent.
 *
 * about:blank stays right for NAVIGATIONS, where it is a real destination.
 */
const MISSING_SUBRESOURCE = "data:text/plain;base64,";

/**
 * How many levels of stylesheet to follow.
 *
 * HTML -> stylesheet -> @import -> @import is already unusual; past that it is
 * either a mistake or a loop the visited set did not catch, and the page renders
 * fine without the fifth level.
 */
const MAX_DEPTH = 5;

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

/**
 * Reconstruct a body from its raw "Transfer-Encoding: chunked" bytes.
 *
 * Ported from routes/view/chunks.tsx so both sides de-chunk identically. Framing
 * is "<hex-size>[;ext]\r\n<data>\r\n ... 0\r\n\r\n"; each stored size is a chunk's
 * DATA length, so skip the size line, copy `size` bytes, skip the trailing CRLF.
 */
export const dechunkBody = (raw: Uint8Array, chunkSizes: number[]): Uint8Array => {
    const out = new Uint8Array(chunkSizes.reduce((sum, n) => sum + n, 0));
    let src = 0;
    let dst = 0;

    for (const size of chunkSizes) {
        while (src + 1 < raw.length && !(raw[src] === 0x0d && raw[src + 1] === 0x0a)) src++;
        src += 2;

        const available = Math.max(0, Math.min(size, raw.length - src));
        out.set(raw.subarray(src, src + available), dst);
        dst += available;
        src += size + 2;

        // Truncated payload: stop cleanly rather than reading past the end.
        if (available < size) break;
    }

    return dst === out.length ? out : out.subarray(0, dst);
};

/**
 * A record's payload bytes, de-chunked when they need to be.
 *
 * The one place that knows how to turn a payload location into bytes, for both
 * plain and gzipped archives. Order matters and is fixed by two existing
 * invariants: `size` is the ENCODED length including chunk framing, and `chunks`
 * holds DECODED sizes — so any gzip member has to be inflated first and the
 * de-chunk composes after it.
 */
export const readPayload = async (record: ViewRecord): Promise<Uint8Array> => {
    if (!record.payload) return new Uint8Array(0);

    const { offset, size, chunks, gzip } = record.payload;

    const raw = gzip
        ? await readGzipPayloadSlice(record.file, gzip, 0, size)
        : new Uint8Array(await record.file.slice(offset, offset + size).arrayBuffer());

    const framed = chunks && chunks.length > 0 ? dechunkBody(raw, chunks) : raw;

    return decodeContentEncoding(framed, record.contentEncoding, offset);
};

/**
 * Undo the response's own `Content-Encoding`.
 *
 * Crawlers store what the server sent, headers included, so a body served
 * `Content-Encoding: gzip` is gzipped ON DISK. Handing those bytes to an iframe
 * with a `text/html` type renders a page of binary: the blob url carries no
 * Content-Encoding, so nothing tells the browser to inflate first. Rare but real —
 * 4 records in a 2,500-record sample.
 *
 * Deliberately NOT done by stripping the header and letting the browser handle it:
 * a blob url has no headers to strip, and the same bytes go into downloads, where
 * a `.html` file full of gzip is worse.
 *
 * Unknown or absent encodings pass through untouched. `br` is not handled — there
 * is no Brotli decoder in the bundle and fflate does not provide one — so it warns
 * rather than pretending.
 */
const decodeContentEncoding = (
    bytes: Uint8Array,
    encoding: string | null | undefined,
    offset: number,
): Uint8Array => {
    // A single token is the case worth handling. Stacked encodings ("gzip, br")
    // are legal and vanishingly rare, and guessing at them is worse than saying so.
    const coding = (encoding ?? "").trim().toLowerCase();

    if (coding === "" || coding === "identity") {
        // Nothing claims to be encoded, so a gzip magic here means the location
        // was dropped between the parse worker and this call — the failure mode
        // PostedViewRecord.payload.gzip warns about. Compressed bytes are about to
        // be rendered as a document either way; saying so beats mojibake.
        if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
            console.warn(
                `[view] payload at logical offset ${offset} starts with the gzip magic but ` +
                `declares no Content-Encoding and carries no gzip location — ` +
                `compressed bytes are about to be served raw`,
            );
        }

        return bytes;
    }

    try {
        if (coding === "gzip" || coding === "x-gzip") return gunzipSync(bytes);
        if (coding === "deflate") return unzlibSync(bytes);
    } catch (error) {
        // A body that does not decode is still a body. Returning it raw keeps the
        // record viewable — as binary, which is what it was before this existed —
        // rather than failing the whole page for one bad asset.
        console.warn(
            `[view] payload at logical offset ${offset} declares ` +
            `Content-Encoding: ${coding} but did not decode: ${String(error)}`,
        );

        return bytes;
    }

    console.warn(
        `[view] payload at logical offset ${offset} has unsupported ` +
        `Content-Encoding: ${coding} — serving it raw`,
    );

    return bytes;
};

/**
 * The MIME type to give the Blob.
 *
 * Prefers the full HTTP header so `charset` survives — an iframe handed
 * "text/html" with no charset guesses the encoding, and a page archived as
 * windows-1252 renders as mojibake.
 */
export const blobType = (record: ViewRecord): string =>
    record.httpContentType || record.contentType || "application/octet-stream";

const essence = (type: string) => (type.split(";")[0] ?? "").trim().toLowerCase();

export const isHtml = (type: string) => {
    const e = essence(type);
    return e === "text/html" || e === "application/xhtml+xml";
};

export const isCss = (type: string) => essence(type) === "text/css";

export const isJs = (type: string) => {
    const e = essence(type);
    return e === "text/javascript" || e === "application/javascript" ||
        e === "application/x-javascript" || e === "text/ecmascript" ||
        e === "application/ecmascript" || e === "module";
};

/**
 * Redirect the ways script navigates the page to __warcLocation.
 *
 * `window.location` cannot be intercepted. It is [Unforgeable] in the DOM spec:
 * not writable, not configurable, and defineProperty on it throws — so there is
 * no Proxy, no getter/setter, no shim that a page would go through. The only
 * lever left is the archived SOURCE, which we hold, so these rewrite the few
 * idioms that actually navigate into calls on the stand-in the guard installs.
 *
 * Deliberately narrow. `location.hash = x` is same-document and must keep
 * working, so it is not listed; neither is reading `location.pathname`, which is
 * harmless. What is listed is the set that leaves the page: href, assign,
 * replace, and assigning to `location` itself.
 *
 * This is textual and therefore fallible — a string containing "location.href="
 * gets rewritten too. That mis-rewrite is inert (it changes a string literal
 * nobody navigates with), which is why the trade is worth taking, but it is a
 * real limit and not a parser.
 */
const JS_NAVIGATION_REWRITES: Array<[RegExp, string]> = [
    // window.location.href = / .assign( / .replace(  — and top/parent/self/document
    [/\b(?:window|top|parent|self|document|globalThis)\s*\.\s*location\s*\.\s*(href|assign|replace|reload)\b/g,
        "__warcLocation.$1"],
    // bare location.href = / .assign( / .replace(
    // Case-sensitive on purpose: this must not match the "__warcLocation." the
    // line above just produced, and the capital L is what keeps them apart.
    [/\blocation\s*\.\s*(href|assign|replace|reload)\b/g, "__warcLocation.$1"],
    // window.location = "..."  — assignment to the object itself, not a member.
    // (?![=>]) so == and => are left alone.
    [/\b(?:window|top|parent|self|document|globalThis)\s*\.\s*location\s*=(?![=>])/g,
        "__warcLocation.href ="],
];

/** Rewrite a script so its navigations go through the guard. */
export const rewriteJs = (source: string): string =>
    JS_NAVIGATION_REWRITES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), source);

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

// The same two patterns the backend rewriter uses, so CSS is treated identically
// on both sides.
const CSS_URL = /url\(\s*["']?(.*?)["']?\s*\)/g;
const CSS_IMPORT = /@import\s+["']([^"']+)["']/g;

/**
 * An attribute value in any of the three spellings HTML allows.
 *
 * Double-quoted, single-quoted, or BARE. The bare form is the one that matters:
 * minifiers drop quotes wherever the value has no space in it, so a whole page
 * can read `<link href=/style.css rel=stylesheet><script src=/layoutget.js>`.
 * Matching only `"..."` meant every reference on such a page was left untouched
 * and the document went on pointing at paths that cannot resolve inside a blob.
 *
 * The bare character class is the spec's: an unquoted value stops at whitespace
 * or at any of " ' = < > `, which is also why `[^>]*` elsewhere stays safe.
 *
 * Three capture groups, exactly one of which is set — see attrValue.
 */
const ATTR_VALUE = `(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`;

/** The one of ATTR_VALUE's three groups that matched, starting at `first`. */
const attrValue = (groups: unknown[], first: number): string =>
    String(groups[first] ?? groups[first + 1] ?? groups[first + 2] ?? "");

/**
 * Safe inside a double-quoted attribute.
 *
 * `&` first, or the ampersand of an entity written by a later replacement would
 * itself be escaped and `&quot;` would come out as `&amp;quot;`.
 */
const escapeAttr = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Attributes naming a SUBRESOURCE — something the page loads on its own. */
const SUBRESOURCE_ATTRS = ["src", "poster", "data-src", "data-lazy-src"];

/**
 * Attributes naming a NAVIGATION — somewhere the reader might go next.
 *
 * Deliberately not resolved to blobs. A link is not part of rendering this page,
 * and following every one would pull the whole crawl into memory to show one
 * document.
 *
 * The url is left INTACT. Blanking it to about:blank was worse than useless: the
 * status bar showed nothing, "copy link address" gave nothing, and the page lost
 * the one piece of information a reader most wants from an archived link — where
 * it pointed. Clicks are stopped by NAVIGATION_GUARD below instead, which is a
 * better place for the rule anyway: one listener rather than an attribute rewrite
 * on every anchor in the document.
 */
const NAVIGATION_ATTRS = ["href", "action"];

/**
 * Stops archived links from reaching the live web, and reports them instead.
 *
 * Injected at the top of every rebuilt document. Capture phase, so it runs before
 * any handler the page installed for itself, and `closest` so a click on a span
 * inside an anchor still counts.
 *
 * This is what makes leaving the real href safe. Without it, restoring the url
 * would mean a click on a 2019 capture quietly fetches that site as it is today —
 * the privacy leak and the "is this archived or live?" confusion in one action.
 *
 * The message is the seam for navigation: a parent that listens for
 * `warc-navigate` can look the url up and show that capture instead.
 */
const navigationGuard = (documentUrl: string) => `<script data-warc-guard>(function(){
  var HERE = ${JSON.stringify(documentUrl)};

  // Marks this window as an archived document, so a NESTED archived document can
  // tell the difference between an ancestor that is more archive and the ancestor
  // that is the viewer.
  window.__warcGuarded = true;

  /**
   * The window that owns the records — the one to ask.
   *
   * NOT \`parent\`. An archived page can contain its own iframes (a sidebar, a
   * shoutbox, an updates log), and each of those is rebuilt and guarded exactly
   * like its container, so from inside one \`parent\` is more archived document,
   * not the viewer. postMessage does not bubble, and the guard in that middle
   * document only listens for fetch results — so a click in a nested frame posted
   * a navigate message into a window with no handler for it, and nothing
   * happened. Anything the nested frame requested at runtime, through the fetch
   * or XHR shim, hung on a promise nobody would ever settle.
   *
   * So the chain is walked instead, past every window that flagged itself above,
   * and the first one that did not is the viewer. Depth does not matter, and it
   * does not assume the viewer is the topmost frame — the viewer page could
   * itself be embedded, and \`top\` would then be a stranger.
   *
   * Same-origin throughout: these documents are blob: urls minted by the viewer,
   * so they inherit its origin and the walk is a legal read. Wrapped anyway, and
   * every fallback is one step more conservative than the last.
   */
  function host(){
    try {
      var at = window;
      // Bounded: a malformed chain cannot spin here.
      for (var hops = 0; hops < 32; hops++) {
        if (at.parent === at) break;
        at = at.parent;
        if (!at.__warcGuarded) return at;
      }
    } catch (e) {}
    try { return window.top || window.parent; } catch (e) {}
    return window.parent;
  }

  // Resolved per call rather than cached: the guard runs at parse time, before
  // this document is necessarily in its final place in the frame tree.
  function post(message){
    try { host().postMessage(message, "*"); return true; }
    catch (e) { return false; }
  }

  function nav(url, kind){
    post({ type: "warc-navigate", url: String(url), via: kind, from: HERE });
    // false, so an inline onclick="return __warcNav(...)" cancels the default.
    return false;
  }

  window.__warcNav = nav;

  /**
   * Stand-in for window.location, for code the rewriter redirected here.
   *
   * window.location is [Unforgeable] in the DOM spec: it cannot be replaced,
   * proxied, or redefined, and Object.defineProperty on it throws. So this is
   * not an interception — the rewriter edits the archived SOURCE to name this
   * object instead, and this is what it then talks to.
   *
   * Reads answer with the ORIGINAL archived url rather than the blob: url the
   * page is really loaded from. Page code that branches on its own address —
   * checking a path, a hostname, a query parameter — then behaves as it did when
   * captured, instead of seeing a uuid.
   */
  window.__warcLocation = {
    get href(){ return HERE; },
    set href(v){ nav(v, "location.href"); },
    assign: function(v){ return nav(v, "location.assign"); },
    replace: function(v){ return nav(v, "location.replace"); },
    reload: function(){ return nav(HERE, "location.reload"); },
    toString: function(){ return HERE; }
  };

  // Catch-all for links the rewriter never saw: ones built by script after load.
  // Capture phase, and installed before any page code runs, so it goes first.
  addEventListener("click", function(e){
    var a = e.target && e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    var href = a.getAttribute("href") || "";
    // Same-document anchors still work: they scroll, they do not navigate.
    if (href.charAt(0) === "#") return;
    e.preventDefault();
    e.stopPropagation();
    nav(a.href, "link");
  }, true);

  addEventListener("submit", function(e){
    e.preventDefault();
    e.stopPropagation();
    nav((e.target && e.target.action) || "", "form");
  }, true);

  /*
   * fetch and XMLHttpRequest, answered from the archive.
   *
   * The static rewriter only ever sees references written into the markup. A
   * page that builds a url in script and requests it at runtime — a comment
   * widget, a lazy image, a JSON feed — bypasses all of that, and left alone
   * would reach the LIVE web: a 2019 capture quietly contacting that host today,
   * which is the same privacy leak the click guard exists to prevent, arriving
   * through a different door.
   *
   * So both are replaced. Requests go to the viewer, which owns the records, and
   * come back as bytes. Nothing here can read the archive itself: this code runs
   * inside a blob: document with no handle on the File.
   *
   * Replies need no routing of their own. The viewer answers e.source — the window
   * that asked — so a nested frame's answer arrives at that frame directly, and
   * ids only ever have to be unique within one document.
   */
  var pending = {}, nextId = 1;

  addEventListener("message", function(e){
    var d = e.data;
    if (!d || d.type !== "warc-fetch-result") return;
    var settle = pending[d.id];
    if (!settle) return;
    delete pending[d.id];
    settle(d);
  });

  function ask(url){
    return new Promise(function(resolve){
      var id = nextId++;
      pending[id] = resolve;
      if (!post({ type: "warc-fetch", id: id, url: String(url), from: HERE })) {
        // Settled as a miss rather than left hanging. A promise that never
        // resolves is the one failure the page cannot handle: no catch runs, no
        // XHR event fires, and the widget waiting on it just stays empty.
        delete pending[id];
        resolve({ ok: false, url: String(url) });
      }
    });
  }

  // Absolute, and against the ARCHIVED address rather than the blob: url the
  // document is really loaded from — otherwise "/api/x" resolves against a uuid.
  function absolute(input){
    try { return new URL(String(input), HERE).href; } catch (err) { return String(input); }
  }

  // Left to the real implementation: data: and blob: are self-contained, and a
  // blob: url is one this viewer minted a moment ago.
  function passThrough(url){ return /^(data|blob):/i.test(url); }

  var realFetch = window.fetch && window.fetch.bind(window);

  window.fetch = function(input, init){
    var url = (input && typeof input === "object" && input.url) ? input.url : input;
    var target = absolute(url);

    if (passThrough(String(url))) return realFetch ? realFetch(input, init) : Promise.reject(new TypeError("fetch unavailable"));

    return ask(target).then(function(r){
      if (!r.ok) {
        // A Response with status 0 is not constructible, so an archive miss is
        // reported the way a blocked request is: a rejected promise. Page code
        // that handles offline already handles this.
        return Promise.reject(new TypeError("Not in this archive: " + target));
      }
      return new Response(r.bytes, {
        status: r.status && r.status >= 200 ? r.status : 200,
        headers: r.contentType ? { "Content-Type": r.contentType } : {}
      });
    });
  };

  var RealXHR = window.XMLHttpRequest;

  function WarcXHR(){
    this.readyState = 0;
    this.status = 0;
    this.statusText = "";
    this.response = null;
    this.responseText = "";
    this.responseType = "";
    this.responseURL = "";
    this.timeout = 0;
    this.withCredentials = false;
    this._headers = "";
    this._listeners = {};
  }

  WarcXHR.UNSENT = 0; WarcXHR.OPENED = 1; WarcXHR.HEADERS_RECEIVED = 2;
  WarcXHR.LOADING = 3; WarcXHR.DONE = 4;

  WarcXHR.prototype.open = function(method, url, async){
    this._url = absolute(url);
    // Synchronous XHR cannot be served: the answer is a postMessage round trip
    // and there is no way to block on one. Deliberately not faked — a silent
    // empty response would look like a resource that exists and is empty.
    this._sync = async === false;
    this.readyState = 1;
    this._fire("readystatechange");
  };

  WarcXHR.prototype.setRequestHeader = function(){};
  WarcXHR.prototype.overrideMimeType = function(){};
  WarcXHR.prototype.abort = function(){ this._aborted = true; };
  WarcXHR.prototype.getAllResponseHeaders = function(){ return this._headers; };
  WarcXHR.prototype.getResponseHeader = function(name){
    var m = new RegExp("^" + String(name) + ": (.*)$", "im").exec(this._headers);
    return m ? m[1] : null;
  };

  WarcXHR.prototype.addEventListener = function(type, fn){
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  WarcXHR.prototype.removeEventListener = function(type, fn){
    var l = this._listeners[type]; if (!l) return;
    var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  };

  WarcXHR.prototype._fire = function(type){
    var e = { type: type, target: this, currentTarget: this };
    var direct = this["on" + type];
    if (typeof direct === "function") { try { direct.call(this, e); } catch (err) {} }
    var l = this._listeners[type] || [];
    for (var i = 0; i < l.length; i++) { try { l[i].call(this, e); } catch (err) {} }
  };

  WarcXHR.prototype.send = function(){
    var self = this;

    if (this._sync) {
      this.readyState = 4;
      this.status = 0;
      this._fire("readystatechange");
      this._fire("error");
      this._fire("loadend");
      return;
    }

    ask(this._url).then(function(r){
      if (self._aborted) return;

      self.readyState = 4;
      self.responseURL = r.url || self._url;

      if (!r.ok) {
        self.status = 0;
        self._fire("readystatechange");
        self._fire("error");
        self._fire("loadend");
        return;
      }

      self.status = r.status && r.status >= 100 ? r.status : 200;
      self.statusText = "OK";
      self._headers = r.contentType ? "content-type: " + r.contentType + "\\r\\n" : "";

      var bytes = new Uint8Array(r.bytes);

      if (self.responseType === "arraybuffer") self.response = r.bytes;
      else if (self.responseType === "blob") self.response = new Blob([bytes], { type: r.contentType || "" });
      else {
        var text = "";
        try { text = new TextDecoder().decode(bytes); } catch (err) {}
        self.responseText = text;
        if (self.responseType === "json") { try { self.response = JSON.parse(text); } catch (err) { self.response = null; } }
        else self.response = text;
      }

      self._fire("readystatechange");
      self._fire("load");
      self._fire("loadend");
    });
  };

  // Kept reachable: something may legitimately want the real one, and dropping
  // a global entirely breaks feature detection that tests for its existence.
  WarcXHR.__real = RealXHR;
  window.XMLHttpRequest = WarcXHR;
})();</script>`;

/**
 * Undo the escaping HTML applies to attribute values.
 *
 * `&` is written `&amp;` inside an attribute, so a query string reaches this
 * rewriter as `?a=1&amp;b=2`. Handing that to `new URL()` keeps the `&amp;`
 * verbatim, and the resulting url matches nothing in the archive — which is
 * exactly how a page full of query-bearing asset urls resolves to nothing at all
 * while its records sit right there.
 *
 * Only the five predefined entities plus numeric escapes: an attribute value can
 * legally carry any named entity, but these are what actually appear in urls, and
 * a full table would be a lot of weight for references nobody writes.
 */
const decodeEntities = (raw: string): string =>
    raw
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        // Last, or "&amp;lt;" would decode twice and produce "<" for a literal "&lt;".
        .replace(/&amp;/gi, "&");

const absolute = (raw: string, base: string): string | null => {
    try {
        return new URL(decodeEntities(raw), base).href;
    } catch {
        return null;
    }
};

/**
 * A reference that is not a fetch and must be left exactly as it is.
 *
 * `#anchor` resolves against the document and is how SVG and CSS reference
 * elements in this same page — url(#gradient), <use href="#icon">. Rewriting
 * those breaks them silently. data:/blob: are already self-contained;
 * javascript:/mailto:/tel: are not fetches at all.
 */
const isNonFetchable = (raw: string) =>
    raw.startsWith("#") || /^(data|blob|javascript|mailto|tel|about):/i.test(raw);

/**
 * Put NAVIGATION_GUARD as early in the document as it can go.
 *
 * Right after <head> when there is one, otherwise after <html>, otherwise at the
 * very front. Position matters: the guard listens in the capture phase, so it
 * beats any handler the page adds — but only for events fired after it runs, and
 * a page that navigates on load would otherwise get away before it exists.
 *
 * Prepending blindly would break a document that opens with a doctype, which must
 * be the first thing in the file.
 */
const injectGuard = (html: string, documentUrl: string): string => {
    const guard = navigationGuard(documentUrl);

    const head = /<head\b[^>]*>/i.exec(html);
    if (head) {
        const at = head.index + head[0].length;
        return html.slice(0, at) + guard + html.slice(at);
    }

    const htmlTag = /<html\b[^>]*>/i.exec(html);
    if (htmlTag) {
        const at = htmlTag.index + htmlTag[0].length;
        return html.slice(0, at) + guard + html.slice(at);
    }

    return guard + html;
};

/**
 * What to do with a link the reader could click.
 *
 * `"guard"` is the viewer: the href is made absolute, an onclick is added, and the
 * guard script is injected — so a click is cancelled and reported to the store,
 * which looks the url up in the archive instead of letting the page reach the live
 * web.
 *
 * `"offline"` is a downloaded copy on disk. There is no store and no parent window
 * to report to, so the guard would make every link silently do nothing — the exact
 * failure that nested iframes hit. Instead: links into the download become relative
 * paths and work, and everything else is neutralised. See download.plan.md.
 */
export type NavigationPolicy = "guard" | "offline";

export interface RewriteContext {
    /** The document these references are relative to. */
    base: string;
    /** Resolve one absolute url to a reference string, or the missing placeholder. */
    resolve: (absoluteUrl: string, depth: number, referrer: string) => Promise<string>;
    depth: number;

    /** Defaults to MISSING_SUBRESOURCE. */
    missingRef?: string;

    /** Defaults to "guard". */
    navigation?: NavigationPolicy;

    /**
     * Resolve a NAVIGATION target, for the offline policy only.
     *
     * Separate from `resolve` because the two answer different questions and must
     * not be confused: `resolve` fetches and descends, which is right for an image
     * and wrong for a link — chasing every `<a href>` would pull the whole site
     * into a download of one page. This one only asks "is this already here?", and
     * returns null when it is not.
     */
    resolveLink?: (absoluteUrl: string) => string | null;
}

/** Replace every url() and @import in a stylesheet with a blob url. */
export const rewriteCss = async (text: string, ctx: RewriteContext): Promise<string> => {
    // Collected first, resolved concurrently, then substituted: a regex replace
    // cannot await, and resolving one at a time would serialise every font and
    // background image in the sheet behind the one before it.
    const wanted = new Set<string>();

    for (const pattern of [CSS_URL, CSS_IMPORT]) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            const raw = (match[1] ?? "").trim();
            if (!raw || isNonFetchable(raw)) continue;
            const abs = absolute(raw, ctx.base);
            if (abs) wanted.add(abs);
        }
    }

    const resolved = new Map<string, string>();
    await Promise.all([...wanted].map(async url => {
        resolved.set(url, await ctx.resolve(url, ctx.depth + 1, ctx.base));
    }));

    const swap = (raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed || isNonFetchable(trimmed)) return trimmed;
        const abs = absolute(trimmed, ctx.base);
        return (abs && resolved.get(abs)) || ctx.missingRef || MISSING_SUBRESOURCE;
    };

    return text
        .replace(CSS_URL, (_, raw) => `url("${swap(String(raw))}")`)
        .replace(CSS_IMPORT, (_, raw) => `@import "${swap(String(raw))}"`);
};

/**
 * Rewrite a document so every subresource points at a blob url.
 *
 * Textual, not DOM-based: there is no DOMParser where this runs, and the HTML has
 * to be FINAL before it reaches an iframe — anything that let the browser parse it
 * first would let it start fetching the original urls.
 *
 * Scripts and on* handlers are preserved by choice. Archived JS therefore runs
 * with the embedding origin, and anything it fetches at runtime bypasses this
 * rewriter entirely and will not come from the archive.
 */
export const rewriteHtml = async (html: string, ctx: RewriteContext): Promise<string> => {
    // A <base href> changes what every relative reference in the document means,
    // so it has to be honoured before anything is resolved.
    const baseMatch = new RegExp(`<base\\s[^>]*href\\s*=\\s*${ATTR_VALUE}`, "i").exec(html);
    const base = (baseMatch && absolute(attrValue(baseMatch, 1), ctx.base)) || ctx.base;
    const inner: RewriteContext = { ...ctx, base };

    /**
     * Whether this document is destined for a file on disk rather than the viewer.
     *
     * The difference is that there is no store and no parent window out there. The
     * guard's whole design is to cancel a click and report it upward; shipped in a
     * zip it would make every link silently do nothing, which is precisely the
     * failure nested iframes hit before their guard learned to find the viewer.
     */
    const offline = ctx.navigation === "offline";

    const linkPattern = /<link\s[^>]*>/gi;

    /**
     * Whether a <link> names something the page LOADS.
     *
     * Most do not. `canonical` and `alternate` are metadata pointing at the
     * page's own address, and resolving one fetched the document a second time
     * and minted it a second blob url — visible in the output as a canonical href
     * with a different uuid from the document containing it. `preconnect` and
     * `dns-prefetch` are hints about hosts, not requests for bytes.
     *
     * A <link> with no rel at all is left alone: it is not a subresource by any
     * reading, and guessing costs a wasted fetch.
     */
    const isSubresourceLink = (tag: string): boolean => {
        const match = new RegExp(`\\srel\\s*=\\s*${ATTR_VALUE}`, "i").exec(tag);
        const rel = match && attrValue(match, 1);
        if (!rel) return false;

        return rel
            .toLowerCase()
            .split(/\s+/)
            .some(token =>
                token === "stylesheet" ||
                token === "icon" ||
                token === "apple-touch-icon" ||
                token === "apple-touch-icon-precomposed" ||
                token === "mask-icon" ||
                token === "shortcut" ||
                token === "preload" ||
                token === "manifest");
    };

    // Every distinct subresource, resolved once and concurrently.
    const wanted = new Set<string>();

    const want = (raw: string | undefined) => {
        if (!raw || isNonFetchable(raw.trim())) return;
        const abs = absolute(raw.trim(), base);
        if (abs) wanted.add(abs);
    };

    for (const attr of SUBRESOURCE_ATTRS) {
        const pattern = new RegExp(`\\s${attr}\\s*=\\s*${ATTR_VALUE}`, "gi");
        for (const match of html.matchAll(pattern)) want(attrValue(match, 1));
    }

    for (const match of html.matchAll(new RegExp(`\\s(?:srcset|data-srcset)\\s*=\\s*${ATTR_VALUE}`, "gi"))) {
        for (const part of attrValue(match, 1).split(",")) want(part.trim().split(/\s+/)[0]);
    }

    // <link href> is a navigation attribute by name but a subresource in fact
    // when its rel says so — and only then.
    for (const tag of html.match(linkPattern) ?? []) {
        if (!isSubresourceLink(tag)) continue;
        const match = new RegExp(`\\shref\\s*=\\s*${ATTR_VALUE}`, "i").exec(tag);
        if (match) want(attrValue(match, 1));
    }

    const resolved = new Map<string, string>();
    await Promise.all([...wanted].map(async url => {
        resolved.set(url, await inner.resolve(url, ctx.depth + 1, base));
    }));

    /** null means "leave this attribute exactly as it was". */
    const blobFor = (raw: string): string | null => {
        const trimmed = raw.trim();
        if (!trimmed || isNonFetchable(trimmed)) return null;
        const abs = absolute(trimmed, base);
        return (abs && resolved.get(abs)) || ctx.missingRef || MISSING_SUBRESOURCE;
    };

    let out = html;

    // Every replacement below emits a DOUBLE-QUOTED value regardless of how the
    // source spelled it. A blob url contains no quote or space so it is always
    // safe to quote, and normalising here means the output is uniform even when
    // the input was minified.
    for (const attr of SUBRESOURCE_ATTRS) {
        out = out.replace(new RegExp(`(\\s${attr})\\s*=\\s*${ATTR_VALUE}`, "gi"), (whole, lead, ...groups) => {
            const replacement = blobFor(attrValue(groups, 0));
            return replacement === null ? whole : `${lead}="${replacement}"`;
        });
    }

    // Only inside a <link> tag, so ordinary anchors are not swept up by an href
    // rule meant for stylesheets — and only when the rel says it is a load.
    out = out.replace(linkPattern, tag =>
        isSubresourceLink(tag)
            ? tag.replace(new RegExp(`(\\shref)\\s*=\\s*${ATTR_VALUE}`, "i"), (whole, lead, ...groups) => {
                const replacement = blobFor(attrValue(groups, 0));
                return replacement === null ? whole : `${lead}="${replacement}"`;
            })
            : tag);

    // srcset: a comma-separated list of "<url> <descriptor>".
    out = out.replace(new RegExp(`(\\s(?:srcset|data-srcset))\\s*=\\s*${ATTR_VALUE}`, "gi"), (_whole, lead, ...groups) => {
        const rewritten = attrValue(groups, 0)
            .split(",")
            .map(part => {
                const trimmed = part.trim();
                if (!trimmed) return null;
                const [url, ...descriptor] = trimmed.split(/\s+/);
                const replacement = blobFor(url ?? "");
                return replacement === null ? trimmed : [replacement, ...descriptor].join(" ");
            })
            .filter((part): part is string => part !== null)
            .join(", ");

        return `${lead}="${rewritten}"`;
    });

    // Navigations: the url is made ABSOLUTE and left in place. A relative href
    // cannot resolve inside a blob document, so `/about` would be meaningless
    // even as a label; the absolute form is both correct and readable, and it is
    // what a reader sees in the status bar or copies out.
    //
    // NAVIGATION_GUARD is what stops the click, not this rewrite.
    for (const attr of NAVIGATION_ATTRS) {
        // `\b` after the tag name, not `\s`. With `\s` the tag's own separator is
        // consumed by the prefix, so `\shref` then needs a SECOND space that is
        // not there and `<a href="...">` never matches — every anchor silently
        // kept pointing at the live web. `\b` is zero-width, leaving the space
        // for the attribute, and still refuses to match `<area>` because there is
        // no boundary between the `a` and the `r`.
        const pattern = new RegExp(`(<(?:a|form)\\b[^>]*?)(\\s${attr})\\s*=\\s*${ATTR_VALUE}`, "gi");
        out = out.replace(pattern, (whole, tagStart, lead, ...groups) => {
            const value = attrValue(groups, 0).trim();
            // A same-document anchor still works and must not be touched.
            if (!value || value.startsWith("#")) return whole;

            const abs = absolute(value, base);
            // Unresolvable against the document — a mailto:, a javascript:, or
            // something malformed. Left exactly as found rather than guessed at.
            if (!abs) return whole;

            const quoted = abs.replace(/"/g, "&quot;");

            if (offline) {
                // Inside the download: point at the local copy, and the link
                // works from the filesystem exactly as it did on the web.
                const local = ctx.resolveLink?.(abs);

                if (local) return `${tagStart}${lead}="${escapeAttr(local)}"`;

                // Not in the download. The href comes OFF the element rather than
                // being disabled with a handler: an href still on the tag is one
                // middle-click or "copy link address" away from the live site,
                // and a 2019 capture opened from disk in 2026 should not be able
                // to reach out at all.
                //
                // It moves to data-warc-href rather than being discarded, because
                // that attribute is the queue: a later pass that downloads more
                // pages reads exactly this to know what was wanted and not taken.
                // Two inert attributes and nothing else. No title, no class, no
                // style: the link keeps whatever the page gave it and simply
                // stops pointing at the live web.
                return `${tagStart} data-warc-href="${quoted}" data-warc-missing=""`;
            }

            return `${tagStart}${lead}="${quoted}"`;
        });
    }

    // An explicit onclick as well as the document listener. The listener catches
    // links built by script after load; this is the one you can SEE in the
    // markup, and it survives a page that stops propagation in its own capture
    // handler.
    //
    // A SEPARATE pass over whole tags, not folded into the href rewrite above.
    // That rewrite only ever sees the text BEFORE the href, so a tag whose
    // onclick came after it looked like it had none — and got a second one,
    // leaving `onclick="..." onclick="..."` where the browser keeps the first and
    // silently drops the page's own.
    //
    // Tags that already have an onclick are left alone: chaining two handlers
    // through an attribute string means quoting the original inside the new one,
    // and getting that wrong breaks behaviour the page depends on. The document
    // listener still covers them.
    //
    // Skipped entirely offline: __warcNav does not exist in a file on disk, so
    // this would add an inline handler that throws on every click — and an
    // exception in an onclick does NOT cancel the default, so the link would
    // then go to the live web. Worse than doing nothing.
    if (!offline) {
        out = out.replace(/<a\b[^>]*>/gi, tag => {
            if (/\sonclick\s*=/i.test(tag)) return tag;
            if (!/\shref\s*=/i.test(tag)) return tag;

            // Same-document anchors scroll rather than navigate; nothing to cancel.
            const href = new RegExp(`\\shref\\s*=\\s*${ATTR_VALUE}`, "i").exec(tag);
            if (!href || attrValue(href, 1).trim().startsWith("#")) return tag;

            return tag.replace(/\s*>$/, ` onclick="return __warcNav(this.href,'link')">`);
        });
    }

    // Inline style="..." and <style> blocks both carry url() references.
    //
    // Collected, resolved, then substituted through a FUNCTION replacement. Two
    // traps avoided: a string pattern passed to String.replace only ever replaces
    // the first match, and a string replacement treats `$&` and `$1` as
    // references — a stylesheet containing a literal `$&` would come out mangled.
    const rewriteEmbeddedCss = async (pattern: RegExp, extract: (whole: string) => string | null) => {
        const texts = new Set<string>();

        for (const match of out.matchAll(pattern)) {
            const css = extract(match[0]);
            if (css && css.includes("url(")) texts.add(css);
        }

        if (texts.size === 0) return;

        const done = new Map<string, string>();
        await Promise.all([...texts].map(async css => { done.set(css, await rewriteCss(css, inner)); }));

        out = out.replace(pattern, whole => {
            const css = extract(whole);
            const rewritten = css === null ? undefined : done.get(css);
            return rewritten === undefined ? whole : whole.split(css as string).join(rewritten);
        });
    };

    // Inline style is quoted in practice — a bare one cannot contain a space, and
    // CSS almost always does — but matched through ATTR_VALUE anyway so the rule
    // is the same everywhere rather than one attribute having its own.
    await rewriteEmbeddedCss(
        new RegExp(`\\sstyle\\s*=\\s*${ATTR_VALUE}`, "gi"),
        whole => {
            const match = new RegExp(`\\sstyle\\s*=\\s*${ATTR_VALUE}`, "i").exec(whole);
            return match ? attrValue(match, 1) : null;
        },
    );

    await rewriteEmbeddedCss(
        /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
        whole => /<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(whole)?.[1] ?? null,
    );

    // Inline scripts get the same navigation rewrite as external ones — a
    // `location.href = "..."` is no less a redirect for being in the document.
    // The guard itself is skipped: it is already correct, and rewriting it would
    // point __warcLocation at itself.
    out = out.replace(/(<script\b(?![^>]*\bdata-warc-guard\b)[^>]*>)([\s\S]*?)(<\/script>)/gi,
        (whole, open, body, close) => `${open}${rewriteJs(String(body))}${close}`);

    // <meta http-equiv="refresh" content="0;url=..."> navigates with no script
    // and no click, so neither the guard nor the rewrite above would see it. The
    // delay is kept and the url moved onto a data attribute: the fact that the
    // page redirected is worth preserving even though the redirect is not.
    out = out.replace(/<meta\b[^>]*>/gi, tag => {
        if (!/http-equiv\s*=\s*["']?refresh/i.test(tag)) return tag;

        const content = new RegExp(`\\scontent\\s*=\\s*${ATTR_VALUE}`, "i").exec(tag);
        const value = content ? attrValue(content, 1) : "";
        const target = /url\s*=\s*(.+)$/i.exec(value)?.[1]?.trim().replace(/^["']|["']$/g, "");
        if (!target) return tag;

        const abs = absolute(target, base) ?? target;

        if (offline) {
            // On disk a refresh is not something to defuse — it is the only way
            // left to express a redirect, since headers do not survive into a
            // zip. Pointed at the local copy when there is one, and only defused
            // when there is not, which is the case where following it would
            // reach the live web.
            const local = ctx.resolveLink?.(abs);

            if (local) {
                return tag.replace(
                    new RegExp(`(\\scontent\\s*=\\s*)${ATTR_VALUE}`, "i"),
                    `$1"${value.replace(/url\s*=.*$/i, `url=${escapeAttr(local)}`)}"`,
                );
            }
        }

        return tag
            .replace(new RegExp(`(\\scontent\\s*=\\s*)${ATTR_VALUE}`, "i"), "$1\"0\"")
            .replace(/<meta\b/i, `<meta data-warc-refresh="${escapeAttr(abs)}"`)
            .replace(/http-equiv\s*=\s*["']?refresh["']?/i, 'data-warc-http-equiv="refresh"');
    });

    // The guard is the viewer's, and only the viewer's. Offline it would be a
    // script posting to a window that does not exist — see the note on `offline`.
    //
    // NOTHING goes in to replace it. An earlier version injected a stylesheet
    // that struck through and faded every neutralised link, and that is the wrong
    // trade: a downloaded page should look like the page that was captured. The
    // archive's job here is to normalise where the link POINTS, not to editorialise
    // about it in the middle of someone's design.
    //
    // The `data-warc-missing` attribute is still set, so anything that wants to
    // style or find these — a reader with their own stylesheet, or the later pass
    // that reads `data-warc-href` as a download queue — still can.
    if (offline) return out;

    return injectGuard(out, ctx.base);
};

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** Decoding bytes to text without naming a global. */
const decodeText = (bytes: Uint8Array): string => {
    // TextDecoder exists in every environment this runs in; referenced through
    // globalThis so the module declares no ambient global of its own.
    const Ctor = (globalThis as { TextDecoder?: new () => { decode(input: Uint8Array): string } }).TextDecoder;
    if (!Ctor) throw new Error("TextDecoder is unavailable in this environment");
    return new Ctor().decode(bytes);
};

/**
 * Turn one archived record into a blob url that renders, pulling in whatever it
 * references.
 *
 * Failures split by what they affect. A problem with THIS record is fatal and
 * returns ok:false — there is nothing to show. A problem with anything it
 * references is collected into `missing` and the page renders without it.
 */
export const buildView = async (record: ViewRecord, deps: ViewDeps): Promise<ViewResult> => {
    // Every url this build minted, so the caller can revoke them together. Filled
    // by the strategy below; the walk itself knows nothing about blobs.
    const blobUrls: string[] = [];

    const outcome = await walkArchive(record, deps, {
        // The viewer reads everything — `wants` is left at its default. "none"
        // is unreachable here for that reason, and is an empty blob rather than a
        // throw so that a future caller narrowing `wants` cannot break the viewer
        // by surprise.
        emit: (_target, content) => {
            const url = content.kind === "bytes"
                ? deps.createObjectURL(content.bytes, content.type)
                : deps.createObjectURL(content.kind === "text" ? content.text : "", content.type);

            blobUrls.push(url);

            return url;
        },
    });

    if (!outcome.ok) return outcome;

    return {
        ok: true,
        url: outcome.ref,
        documentUrl: outcome.documentUrl,
        type: outcome.type,
        blobUrls,
        missing: outcome.missing,
        resolved: outcome.resolved,
    };
};

/**
 * What a walk does with one record's content.
 *
 * `emit` returns the STRING that references this record from anywhere else, and
 * the walk substitutes it into every document that points here. For the viewer
 * that is a blob url. For a download it is a placeholder token, swapped for a
 * relative path once the whole set is known — see download.ts, and the note on
 * tokens in download.plan.md.
 */
export interface EmittedContent {
    /** Rewritten text, for the types that reference other things. */
    kind: "text";
    text: string;
    type: string;
}

export interface EmittedBytes {
    kind: "bytes";
    bytes: Uint8Array;
    type: string;
}

/** No content at all: the caller asked not to read this one. */
export interface EmittedNothing {
    kind: "none";
    type: string;
}

export type Emitted = EmittedContent | EmittedBytes | EmittedNothing;

export interface WalkStrategy {
    /**
     * Whether this record's bytes are wanted, and as what.
     *
     * `"record-only"` is the one that earns this hook: a download's first pass
     * needs the whole reference graph, which means reading and rewriting every
     * HTML and CSS file — but it does not need a single image, because those are
     * streamed straight from the WARC in the second pass. Without this every
     * payload would be read twice.
     *
     * Defaults to reading everything, which is what the viewer wants.
     */
    wants?: (type: string, record: ViewRecord) => "text" | "bytes" | "record-only";

    /** Turn one record's content into the reference string for it. */
    emit: (record: ViewRecord, content: Emitted, depth: number) => Promise<string> | string;

    /** What a reference the archive cannot answer becomes. Defaults to about:blank. */
    missingRef?: string;

    /** Handed to rewriteHtml. Defaults to the viewer's guard. */
    navigation?: NavigationPolicy;

    /** Handed to rewriteHtml under the offline policy. See RewriteContext. */
    resolveLink?: (absoluteUrl: string) => string | null;
}

export interface WalkOk {
    ok: true;
    /** Whatever `emit` returned for the top-level record. */
    ref: string;
    documentUrl: string;
    type: string;
    missing: MissingRef[];
    resolved: ResolvedRef[];
}

export type WalkResult = WalkOk | Extract<ViewResult, { ok: false }>;

/**
 * Walk the reference graph from one record, handing each one to a strategy.
 *
 * This is the whole of what used to be buildView, minus the blob urls. It is
 * shared rather than copied because everything difficult about the viewer lives
 * here — redirect chains, ancestor-path cycle detection, the error-status guard
 * that stopped 404 pages recursing into twelve thousand blobs, the missing-reason
 * bookkeeping. A second copy in download.ts would start out correct and drift,
 * and the suites that guard this behaviour would only be watching one of them.
 *
 * Failures split by what they affect. A problem with THIS record is fatal and
 * returns ok:false — there is nothing to show. A problem with anything it
 * references is collected into `missing` and the page is built without it.
 */
export const walkArchive = async (
    record: ViewRecord,
    deps: ViewDeps,
    strategy: WalkStrategy,
): Promise<WalkResult> => {
    const missing: MissingRef[] = [];
    const missingSeen = new Set<string>();

    /** url -> blob url, for references that have FINISHED building. */
    const built = new Map<string, string>();

    /**
     * url -> the url that asked for it, so an ancestor walk is possible.
     *
     * This replaced a flat in-flight Set, which could not tell the two apart:
     *
     *   - an ancestor of mine is building this  -> a real cycle
     *   - something ELSE is building this now   -> perfectly fine
     *
     * and reported both as cycles. On one real page that dropped 5 resources
     * that were sitting in the archive — a stylesheet and a script wanted by
     * both the document and a nested page, resolved at the same moment, so
     * whichever asked second was told it was a loop and got nothing. A cycle is
     * a property of the path from the document to here, not of what happens to
     * be in flight elsewhere.
     */
    const askedBy = new Map<string, string>();

    /**
     * Whether `url` is already on the path from the document down to `from`.
     *
     * Bounded by MAX_DEPTH rather than trusting the map to be acyclic — the map
     * describes a graph that may well have a loop in it, which is the entire
     * thing being detected.
     */
    const onPathTo = (url: string, from: string): boolean => {
        let at: string | undefined = from;

        for (let step = 0; at !== undefined && step <= MAX_DEPTH + 1; step++) {
            if (at === url) return true;
            at = askedBy.get(at);
        }

        return false;
    };

    const nearArchived = record.dateArchived;

    const missingRef = strategy.missingRef ?? MISSING_SUBRESOURCE;
    const wants = strategy.wants ?? (() => "bytes" as const);

    const resolved: ResolvedRef[] = [];

    // Subresources known about, and subresources finished. Both only ever grow;
    // see the note on ViewProgress for why `total` is not known up front.
    let discovered = 0;
    let finished = 0;

    /**
     * Report where the build is, cheaply enough to call on every step.
     *
     * Deduped on the whole tuple: the recursion reports the same state from
     * several places, and a listener that has to diff messages itself is a
     * listener that will forget to.
     */
    let lastReport = "";

    const report = (stage: ViewStage, url: string) => {
        if (!deps.onProgress) return;

        const key = `${stage}::${url}::${finished}/${discovered}`;
        if (key === lastReport) return;
        lastReport = key;

        deps.onProgress({ stage, url, resolved: finished, total: discovered });
    };

    const noteMissing = (url: string, reason: MissingReason, referrer: string) => {
        const key = `${url}::${reason}`;
        if (missingSeen.has(key)) return;
        missingSeen.add(key);
        missing.push({ url, reason, referrer });
    };

    /**
     * Counting wrapper around resolveOne.
     *
     * Separate so the counters cannot drift: resolveOne has half a dozen exits —
     * missing, no-payload, error-status, cycle, depth-limit, success — and one
     * of them forgetting to tick `finished` is a progress bar that never
     * arrives. try/finally covers all of them including a throw, which is the
     * one nobody remembers.
     */
    const resolveToBlobUrl = async (url: string, depth: number, referrer: string): Promise<string> => {
        // Already built: a second reference to one asset is not more work, and
        // counting it would inflate both halves of the ratio for nothing.
        const cached = built.get(url);
        if (cached) return cached;

        discovered++;
        report("resolving", url);

        try {
            return await resolveOne(url, depth, referrer);
        } finally {
            finished++;
            report("resolving", url);
        }
    };

    const resolveOne = async (url: string, depth: number, referrer: string): Promise<string> => {
        const cached = built.get(url);
        if (cached) return cached;

        if (depth > MAX_DEPTH) {
            noteMissing(url, "depth-limit", referrer);
            return missingRef;
        }

        // Already open further up THIS path: a genuine cycle. Neither end is
        // finished, so there is no blob url to hand back. One edge gets broken;
        // which one depends on traversal order, and either is fine.
        if (onPathTo(url, referrer)) {
            noteMissing(url, "cycle", referrer);
            return missingRef;
        }

        // First asker wins. Two parents wanting the same url concurrently would
        // otherwise let the later one repoint a path that is still being walked;
        // the first is the one whose build is actually in progress, so it is the
        // one that matters. A wrong pointer here can only ever cost a spurious
        // cycle or a missed one, and MAX_DEPTH is the hard backstop under both.
        //
        // Never unwound. askedBy is a record of the path taken, not a lock: a
        // finished url is answered from `built` above, before the cycle check is
        // reached, so a pointer left behind cannot cause a false cycle later.
        if (!askedBy.has(url)) askedBy.set(url, referrer);

        const outcome = await deps.resolve(url, nearArchived, referrer);

        if (!outcome.record) {
            noteMissing(url, outcome.reason ?? "not-archived", referrer);
            return missingRef;
        }

        if (!outcome.record.payload) {
            noteMissing(url, "no-payload", referrer);
            return missingRef;
        }

        // An error capture is not the resource. Serving a 404 page as an <img>
        // renders nothing either way, so the only thing descending into it
        // achieves is dragging that page's own stylesheet, images and layout
        // into a document that never asked for them.
        //
        // Subresources only. The top-level document goes through buildOne
        // directly and never reaches here, so a reader who deliberately opens an
        // archived 404 page still sees it — which is right, that is what was
        // captured at that url.
        const status = outcome.record.status;

        if (typeof status === "number" && status >= 400) {
            noteMissing(url, "error-status", referrer);
            return missingRef;
        }

        // The record that answered may already have been built under its own
        // url — two references reaching one destination through redirects, or
        // a fallback lookup. Reusing it means one Blob rather than two copies
        // of identical bytes.
        //
        // A plain cache READ, never an await on work in progress: `built`
        // holds finished urls only, so this can never wait on a build that is
        // itself waiting on this one. Two references resolving at the same
        // instant still build twice; the cost is memory, not correctness.
        const servedUrl = outcome.record.url;
        const alreadyBuilt = servedUrl === url ? undefined : built.get(servedUrl);

        // The served url joins the path too, under the url that reached it.
        // Without this a redirect breaks the ancestor walk: a.html serving
        // b.html's record, where b.html links back to a.html, would have no
        // way to see a.html above it and would recurse until MAX_DEPTH.
        if (servedUrl !== url && !askedBy.has(servedUrl)) askedBy.set(servedUrl, url);

        let blobUrl: string;

        try {
            blobUrl = alreadyBuilt ?? await buildOne(outcome.record, depth);
        } catch {
            // A subresource that will not read is the archive's problem, not
            // this page's — the page still renders without it.
            noteMissing(url, "unreadable", referrer);
            return missingRef;
        }

        // Recorded even though it worked. `servedUrl` is what makes a wrong
        // answer visible: when it differs from `url`, a lookup fell back to
        // something else, and that is how a <script src> ends up holding CSS.
        resolved.push({
            url,
            servedUrl,
            type: blobType(outcome.record),
            bytes: outcome.record.payload.size,
            referrer,
            redirects: outcome.redirects,
        });

        built.set(url, blobUrl);

        // Also under the url that ANSWERED, so the next reference reaching
        // this destination — by any spelling — finds it above.
        if (servedUrl !== url) built.set(servedUrl, blobUrl);

        return blobUrl;
    };

    const buildOne = async (target: ViewRecord, depth: number): Promise<string> => {
        const type = blobType(target);

        // Asked BEFORE the payload is read, which is the point of the hook: a
        // download's first pass wants the reference graph, not fifty megabytes of
        // images it is going to stream straight out of the WARC later anyway.
        const wanted = wants(type, target);

        if (wanted === "record-only") {
            return strategy.emit(target, { kind: "none", type }, depth);
        }

        report("reading", target.url);

        const bytes = await readPayload(target);
        const ctx: RewriteContext = {
            base: target.url,
            resolve: resolveToBlobUrl,
            depth,
            missingRef,
            navigation: strategy.navigation,
            resolveLink: strategy.resolveLink,
        };

        // "rewriting" is reported AFTER the rewrite, not before it. A rewrite is
        // where the descent happens — rewriteHtml resolves everything the page
        // references — so announcing it up front would label the whole slow part
        // as rewriting when it is really resolving.
        if (isHtml(type)) {
            const out = await rewriteHtml(decodeText(bytes), ctx);
            report("rewriting", target.url);
            return strategy.emit(target, { kind: "text", text: out, type }, depth);
        }

        if (isCss(type)) {
            const out = await rewriteCss(decodeText(bytes), ctx);
            report("rewriting", target.url);
            return strategy.emit(target, { kind: "text", text: out, type }, depth);
        }

        if (isJs(type)) {
            return strategy.emit(
                target, { kind: "text", text: rewriteJs(decodeText(bytes)), type }, depth);
        }

        // Everything else is served exactly as captured.
        return strategy.emit(target, { kind: "bytes", bytes, type }, depth);
    };

    // ---- the document itself: every failure here is fatal --------------------

    if (!record.payload) {
        return {
            ok: false,
            reason: "no-payload",
            url: record.url,
            errorName: "NoPayload",
            message: "This record was captured without a body — a revisit, a redirect, or a 304.",
        };
    }

    try {
        const ref = await buildOne(record, 0);

        // Forced past the dedupe: "done" with the same counts as the last
        // "resolving" would otherwise be swallowed, and done is the one message
        // a listener cannot afford to miss — it is what takes the overlay down.
        lastReport = "";
        report("done", record.url);

        return { ok: true, ref, documentUrl: record.url, type: blobType(record), missing, resolved };
    } catch (error) {
        return {
            ok: false,
            reason: error instanceof Error && /decode/i.test(error.message) ? "decode" : "unreadable",
            url: record.url,
            errorName: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
        };
    }
};
