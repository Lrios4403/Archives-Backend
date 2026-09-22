/**
 * Saving an archived page and its resources as a .zip.
 *
 * The same walk the viewer uses — see walkArchive in view.ts — with a different
 * destination. Where a view mints a blob url per record, a download writes a zip
 * entry per record and rewrites every reference to a RELATIVE path between them,
 * so the extracted folder opens in a browser with no server and no archive.
 *
 * The design and the measurements behind it are in download.plan.md, next to this
 * file. Three things in here look odd without it:
 *
 *   1. references are resolved to a TOKEN during the walk, not to a path. A zip
 *      path is relative to whoever points at it, so `static/bg.png` from one page
 *      is `../../static/bg.png` from another — one cached string cannot serve
 *      both. Tokens are swapped for paths once the whole set is known.
 *
 *   2. binary payloads are not read during the walk at all. The walk needs the
 *      reference graph, which only HTML and CSS carry; images are streamed
 *      straight out of the WARC afterwards, so nothing is read twice.
 *
 *   3. a url's file name gets the extension its CONTENT TYPE implies, which is
 *      also what stops a page colliding with a directory of the same name.
 *
 * Like view.ts, this touches no global and names no Bun or Node API: it is
 * bundled for the browser and runs inside a worker.
 */

import {
    blobType,
    isCss,
    isHtml,
    readPayload,
    walkArchive,
    type MissingRef,
    type ResolvedRef,
    type ViewDeps,
    type ViewRecord,
    type WalkResult,
} from "./view";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Content type to the extension a file of that type should carry on disk.
 *
 * Only the types worth being right about. Anything not here keeps whatever
 * extension the url already had, which is the safe answer — inventing `.bin` for
 * an unknown type would rename files that were perfectly well named.
 * `application/octet-stream` is deliberately absent for exactly that reason: it
 * means "I do not know", and the url's own extension is a better guess than none.
 *
 * ---------------------------------------------------------------------------
 * Why this exists when the url usually says it already
 *
 * Measured over 2,337 responses across 5am, crystal.cafe, lolcow and nekoweb:
 *
 *   48.4%  url extension already correct — this table is a no-op
 *   34.0%  url has NO extension, and this is the only thing that supplies one
 *    9.8%  directory url, so the name is `index` + whatever this says
 *    4.5%  type not in this table — no-op
 *    2.3%  url extension disagrees with the type
 *    0.9%  alias hit, i.e. a `.jpeg` that must not become `.jpeg.jpg`
 *
 * So it is doing nothing at all for half of everything, and is the only source of
 * a usable file name for a third. The third is not exotic — it is neocities' whole
 * url style (`/navi/rose/garden` is text/html) and every asset served under a
 * bare uuid. Without it those extract as extensionless files that Windows will
 * not open on a double-click and that a browser will not render from the folder.
 *
 * The 2.3% that disagree are why this APPENDS rather than replaces. Nearly all of
 * them are 404 pages served as html at an asset url — `style.css` returning
 * text/html — where the bytes on disk really are an error page and `style.css`
 * would be a lie, while `style.css.html` is true. And two of them were
 * `example.org` and a segment ending `.lesbian_couples`, where the "extension" is
 * just a dot in the name: replacing would have eaten part of it.
 */
const TYPE_EXTENSIONS: Record<string, string> = {
    "text/html": ".html",
    "application/xhtml+xml": ".html",
    "text/css": ".css",
    "text/javascript": ".js",
    "application/javascript": ".js",
    "application/x-javascript": ".js",
    "application/json": ".json",
    "application/manifest+json": ".json",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/svg+xml": ".svg",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
    "font/woff2": ".woff2",
    "font/woff": ".woff",
    "font/ttf": ".ttf",
    "application/font-woff": ".woff",
    // 46 responses in the four measured archives, every one of them previously
    // falling through. IE's font format, which is why it is still all over sites
    // of the era this archives.
    "application/vnd.ms-fontobject": ".eot",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "text/plain": ".txt",
    "application/pdf": ".pdf",
    "application/xml": ".xml",
    "text/xml": ".xml",
    "application/rss+xml": ".xml",
};

/**
 * Extensions that already mean a given type, so nothing is appended twice.
 *
 * Only `.jpeg` actually fires on the measured corpus — 21 times, each one a file
 * that would otherwise have landed as `.jpeg.jpg`. `.htm` and `.mjs` never
 * appeared in four archives; they stay because the corpus is four archives and
 * not the web.
 *
 * `.rss` and `.webmanifest` are here as the PAIRS to `application/rss+xml` and
 * `application/manifest+json` above. Adding those mappings without these entries
 * invents double extensions that did not exist before — `feed.rss` becoming
 * `feed.rss.xml`, `site.webmanifest` becoming `site.webmanifest.json` — which is
 * the exact thing this table is for. A mapping and its aliases go in together;
 * both of these were caught by re-measuring the corpus after adding the mapping,
 * not by reading the diff.
 */
const EXTENSION_ALIASES: Record<string, readonly string[]> = {
    ".html": [".html", ".htm", ".xhtml"],
    ".jpg": [".jpg", ".jpeg"],
    ".js": [".js", ".mjs"],
    ".xml": [".xml", ".rss"],
    ".json": [".json", ".webmanifest"],
};

/**
 * Names Windows refuses, whatever the extension.
 *
 * `CON.html` is as unopenable as `CON`. These are per-segment, and the check is
 * on the part before the first dot.
 */
const RESERVED = new Set([
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * Illegal on Windows, plus the control range and the separator itself.
 *
 * Every character spelled as an ESCAPE, never as a literal. This line previously
 * held real 0x00 and 0x1f bytes inside the class — invisible in an editor,
 * unreadable in a diff, and one careless save away from being stripped into a
 * regex that silently stops rejecting control characters in file names.
 *
 * A space is deliberately NOT in here: spaces are legal on every filesystem this
 * could be extracted onto, and `%20` decoding to a space is what a reader expects.
 * Nor is `-`, which appears in a large fraction of every url in the archive.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"|?*\\\/\u0000-\u001f\u007f]/g;

/**
 * Ceilings on a name and on a whole path.
 *
 * Windows' limit is 260 characters for the EXTRACTED path, which includes
 * wherever the reader unzipped it — a folder this code cannot see. So the budget
 * here is deliberately well under: about a hundred characters of extraction root
 * still leaves room. Measured on onionfarms.warc the median path is 49 characters
 * and the 95th percentile is 122, so this trims almost nothing in practice.
 */
const MAX_SEGMENT = 96;
const MAX_PATH = 180;

/** A short stable hash, for when a name has to be shortened but stay distinct. */
const shortHash = (text: string): string => {
    // FNV-1a. Not cryptographic and does not need to be: this only has to
    // separate two names that were about to become one, and it must be identical
    // across runs so a re-download does not rename files.
    let hash = 0x811c9dc5;

    for (let at = 0; at < text.length; at++) {
        hash ^= text.charCodeAt(at);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash.toString(16).padStart(8, "0");
};

/** Split a name into its stem and its extension, treating a leading dot as stem. */
const splitExtension = (name: string): [string, string] => {
    const at = name.lastIndexOf(".");

    return at <= 0 ? [name, ""] : [name.slice(0, at), name.slice(at)];
};

/** Make one path segment safe on every filesystem this could be extracted onto. */
export const safeSegment = (raw: string): string => {
    let out = raw.replace(ILLEGAL, "_");

    // Trailing dots and spaces are accepted by the zip and then silently dropped
    // by Windows, which turns "a. " and "a" into the same file at extract time.
    out = out.replace(/[. ]+$/g, "");

    if (out === "" || out === "." || out === "..") out = "_";

    const [stem] = splitExtension(out);
    if (RESERVED.has(stem.toLowerCase())) out = `_${out}`;

    if (out.length > MAX_SEGMENT) {
        const [longStem, keptExtension] = splitExtension(out);
        const room = Math.max(8, MAX_SEGMENT - keptExtension.length - 9);
        out = `${longStem.slice(0, room)}~${shortHash(raw)}${keptExtension}`;
    }

    return out;
};

/** The extension a record's bytes want, or "" when nothing is known about them. */
export const extensionFor = (record: ViewRecord): string =>
    TYPE_EXTENSIONS[(blobType(record).split(";")[0] ?? "").trim().toLowerCase()] ?? "";

/**
 * Where one record's bytes go inside the zip.
 *
 * `<host>/<path>`, with the content type's extension appended unless the last
 * segment already carries it. That rule does two jobs at once: it makes an
 * extensionless capture openable — `…/navi/rose/garden` is `text/html` and would
 * otherwise save as a file no OS knows what to do with — and it keeps a page from
 * colliding with a directory of the same name, because `x.12662.html` is not
 * `x.12662/`. Measured across five archives, 1020 urls are also directories and
 * the rule resolves every one of them.
 *
 * Deliberately NOT unique on its own: two records can land here. Resolving that
 * needs the whole set, and is `assignPaths` below.
 */
export const urlToZipPath = (url: string, record: ViewRecord): string => {
    let host = "";
    let path = "";
    let query = "";

    try {
        const parsed = new URL(url);
        // Port and credentials dropped: `:` is illegal on Windows, and neither
        // usually distinguishes anything a reader cares about.
        host = parsed.hostname.toLowerCase();
        path = decodeURIComponent(parsed.pathname);
        query = parsed.search.slice(1);
    } catch {
        // Not a url this runtime can parse. Everything still has to land
        // SOMEWHERE inside the zip rather than throwing away the bytes.
        return `_unparsed/${safeSegment(url)}`;
    }

    const segments: string[] = [];

    // Resolved here rather than trusted: a `..` that walked past the root would
    // otherwise write outside the zip when extracted, which is the classic zip
    // traversal bug.
    for (const segment of path.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") { segments.pop(); continue; }
        segments.push(safeSegment(segment));
    }

    const extension = extensionFor(record);

    // A trailing slash, or nothing at all, means there is no last segment to
    // extend — so the directory gets an index file instead.
    if (segments.length === 0 || path.endsWith("/")) {
        segments.push(`index${extension || ".html"}`);
    } else {
        const last = segments[segments.length - 1] ?? "";
        const aliases = EXTENSION_ALIASES[extension] ?? (extension ? [extension] : []);
        const already = aliases.some(alias => last.toLowerCase().endsWith(alias));

        if (extension && !already) segments[segments.length - 1] = `${last}${extension}`;
    }

    // Folded, not dropped: `?page=2` and `?page=3` are different pages, and
    // dropping the query would silently keep only one of them.
    if (query) {
        const [stem, keptExtension] = splitExtension(segments[segments.length - 1] ?? "index");
        segments[segments.length - 1] = `${stem}__q${shortHash(query)}${keptExtension}`;
    }

    const full = `${safeSegment(host) || "_nohost"}/${segments.join("/")}`;

    if (full.length <= MAX_PATH) return full;

    // Too long as a whole even with every segment inside its own limit. The tail
    // is what identifies the file, so the middle goes.
    const tail = segments[segments.length - 1] ?? "index";
    const head = safeSegment(host) || "_nohost";

    return `${head}/_deep/${shortHash(full)}/${tail}`;
};

/**
 * The path from one document to another, inside the zip.
 *
 * Both arguments are zip paths — `a/b/c.html` — never urls and never leading
 * slashes. A leading `./` is kept off the front because some very old parsers
 * mishandle it and nothing needs it.
 */
export const relativize = (fromPath: string, toPath: string): string => {
    const from = fromPath.split("/").slice(0, -1);
    const to = toPath.split("/");
    const target: string = to.pop() ?? "";

    let shared = 0;
    while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;

    const up = from.length - shared;
    const down = to.slice(shared);

    const parts = [...Array<string>(up).fill(".."), ...down, target];

    // Same directory, same name: a document referencing itself. "" is not a url,
    // so it becomes the bare file name.
    return parts.length === 1 ? target : parts.join("/");
};

// ---------------------------------------------------------------------------
// What goes in the zip
// ---------------------------------------------------------------------------

/** One record, on its way to becoming one zip entry. */
export interface DownloadEntry {
    /** The url the walk asked for. */
    url: string;
    /** The record that answered — differs when a redirect or a fallback was followed. */
    record: ViewRecord;

    /** Every other url that resolves to this same entry. */
    aliases: string[];
    mergedBy?: "redirect" | "digest";

    /** Rewritten text, held until the path map is final. Null for binaries. */
    text: string | null;

    /** Set on a 3xx that was kept as its own entry. */
    redirectTo?: string;

    /** Filled by assignPaths. */
    path?: string;
}

export type DownloadNoticeKind =
    | "missing"
    | "entry-failed"
    | "path-collision"
    | "merged"
    | "redirect-stub"
    | "path-truncated"
    | "limit-reached";

export interface DownloadNotice {
    kind: DownloadNoticeKind;
    url: string;
    detail?: string;
    reason?: MissingRef["reason"];
}

/** Where the record id goes into a name, and when. */
export type IdPolicy = "on-collision" | "always";

/** The archive a record came out of, for the disambiguating name. */
export type ArchiveNamer = (record: ViewRecord) => { file: string; uuid: string };

/**
 * A record's archive and id, folded into a file name.
 *
 * `<name>.<warc stem>.<WARC-Record-ID>.<ext>` — what it is, which archive it came
 * out of, which record inside that archive. The archive matters because a
 * download can pull records from more than one WARC: the viewer holds every file
 * the reader selected, and the nearest capture of a subresource may live in a
 * different one from the page.
 *
 * The stem of the archive name, not the file name, so an `.html` does not end up
 * with a `.warc` in the middle of it.
 *
 * THE WHOLE UUID. An earlier version stripped the hyphens and kept eight hex
 * characters, on the grounds that eight is plenty to separate a colliding group
 * of two or three and it costs less path length. That was the wrong trade: a
 * truncated uuid is not the WARC-Record-ID any more, so it cannot be pasted into
 * a search, matched against a manifest, or recognised by any other WARC tool —
 * it is just an opaque tag that happens to be unique. The point of putting the
 * id in the name is that it IS the record's identity, and the identity is the
 * whole of it.
 *
 * Length is handled where length is handled: the caps in safeSegment and the
 * whole-path guard below, applied AFTER the suffix rather than before it.
 */
export const withRecordId = (path: string, file: string, uuid: string): string => {
    const at = path.lastIndexOf("/");
    const dir = at < 0 ? "" : path.slice(0, at + 1);
    const [stem, extension] = splitExtension(at < 0 ? path : path.slice(at + 1));

    const archive = safeSegment(file.replace(/\.w?arc(\.gz)?$/i, ""));

    // Sanitised, not truncated. A WARC-Record-ID is hex and hyphens once
    // unwrapped from `<urn:uuid:…>`, so in practice nothing changes here — but a
    // crawler is free to write anything in that header, and a name is a name.
    const id = safeSegment(uuid.replace(/^<?urn:uuid:/i, "").replace(/>$/, "")) || "unknown";

    const named = `${dir}${stem}.${archive}.${id}${extension}`;

    // The caps have to run again: `urlToZipPath` measured a path that did not yet
    // carry an archive name and a full uuid, which together add around fifty
    // characters. Without this a long url plus a full id could exceed the budget
    // the earlier check had just brought it under.
    if (named.length <= MAX_PATH) return named;

    // Trim the file's own name first — the cheapest thing to lose.
    const room = Math.max(8, MAX_SEGMENT - archive.length - id.length - extension.length - 3);
    const trimmed = `${dir}${stem.slice(0, room)}.${archive}.${id}${extension}`;

    if (trimmed.length <= MAX_PATH) return trimmed;

    // Still over, which means the DIRECTORY is what is long — trimming the name
    // cannot fix that. Same `_deep` shape urlToZipPath uses for the same reason:
    // the tail is what identifies the file, so the middle is what goes. Keyed on
    // the original path, so it stays put across runs.
    const host = dir.split("/")[0] || "_nohost";

    return `${host}/_deep/${shortHash(path)}/${stem.slice(0, room)}.${archive}.${id}${extension}`;
};

/**
 * Give every entry a final, unique path.
 *
 * Runs once, with the whole set in hand, because none of this can be decided one
 * record at a time. Three things happen here:
 *
 *   - a natural path is computed for each entry
 *   - a group that wants the same path is disambiguated
 *   - a 3xx colliding with a 2xx yields to it, since they are not two peers but a
 *     page and a signpost to it
 *
 * The tiebreak inside a group of peers is the record id, never arrival order.
 * That is what makes a second download of the same page produce the same names —
 * which the future "add more pages to this zip" pass depends on, since it must
 * not rename what is already there.
 */
export const assignPaths = (
    entries: DownloadEntry[],
    namer: ArchiveNamer,
    policy: IdPolicy = "on-collision",
    note?: (notice: DownloadNotice) => void,
): void => {
    const groups = new Map<string, DownloadEntry[]>();

    for (const entry of entries) {
        const natural = urlToZipPath(entry.url, entry.record);
        const key = natural.toLowerCase();
        const group = groups.get(key);

        if (group) group.push(entry);
        else groups.set(key, [entry]);

        entry.path = natural;
    }

    const taken = new Set<string>();

    for (const group of groups.values()) {
        // The ordinary case: one record, one path. Suffixed anyway under
        // "always", which is what a multi-capture scope wants.
        const first = group[0];

        if (group.length === 1 && first && policy === "on-collision") {
            taken.add((first.path ?? "").toLowerCase());
            continue;
        }

        // A 2xx and a 3xx are not peers. The content keeps the plain name and the
        // redirect takes the suffix — decided by status code, so it does not
        // depend on which the walk reached first.
        const content = group.filter(entry => entry.redirectTo === undefined);
        const stubs = group.filter(entry => entry.redirectTo !== undefined);

        const only = content[0];

        if (content.length === 1 && only && stubs.length > 0 && policy === "on-collision") {
            taken.add((only.path ?? "").toLowerCase());

            for (const stub of stubs) {
                const { file, uuid } = namer(stub.record);
                stub.path = withRecordId(stub.path ?? "", file, uuid);
                taken.add(stub.path.toLowerCase());
            }

            continue;
        }

        // Peers. EVERY member is renamed, not just the ones after the first: a
        // bare name beside a suffixed one reads as one real file and one oddity,
        // and it would put arrival order back into the result.
        for (const entry of group) {
            const { file, uuid } = namer(entry.record);
            let next = withRecordId(entry.path ?? "", file, uuid);

            // Vanishingly unlikely, and cheap to rule out: two records from one
            // archive whose short ids happen to agree.
            for (let attempt = 2; taken.has(next.toLowerCase()); attempt++) {
                const [stem, extension] = splitExtension(next);
                next = `${stem}~${attempt}${extension}`;
            }

            if (group.length > 1) {
                note?.({
                    kind: "path-collision",
                    url: entry.url,
                    detail: `saved as ${next}`,
                });
            }

            entry.path = next;
            taken.add(next.toLowerCase());
        }
    }
};

// ---------------------------------------------------------------------------
// Redirect stubs
// ---------------------------------------------------------------------------

/**
 * The body for a 3xx kept as its own entry.
 *
 * Measured, this matters: of 96 redirects in 5am.warc only 8 have a body that
 * links anywhere, and 3874 of onionfarms' 3880 have no body at all. The redirect
 * lives in the `Location:` header, and a zip has no headers — so written out
 * as-captured, a stub is a page saying "301 Moved Permanently" with no way
 * forward.
 *
 * So the original bytes are kept when there are any, and a working forward link
 * is injected either way. This is the exact inverse of what the viewer does,
 * where a `<meta refresh>` is defused into `data-warc-refresh` — and deliberately
 * so. In the viewer the store owns navigation and a refresh would bypass it; on
 * disk the refresh is the only mechanism left to express a header that no longer
 * exists.
 */
export const redirectStub = (
    from: string,
    toUrl: string,
    toPath: string,
    captured: string | null,
): string => {
    const escaped = toPath.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const shown = toUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const head =
        `<meta http-equiv="refresh" content="0; url=${escaped}">` +
        `<link rel="canonical" href="${escaped}">`;

    const banner =
        `<p data-warc-redirect="${escaped}">Redirected to ` +
        `<a href="${escaped}">${shown}</a></p>`;

    if (captured && /<head[\s>]/i.test(captured)) {
        return captured.replace(/<head([^>]*)>/i, (whole, attrs) => `<head${attrs}>${head}`)
            .replace(/<\/body>/i, `${banner}</body>`);
    }

    if (captured && captured.trim()) {
        return `<!doctype html><html><head>${head}</head><body>${captured}${banner}</body></html>`;
    }

    // No body was captured at all — the common case by a wide margin.
    return `<!doctype html><html><head>${head}<title>Redirect</title></head>` +
        `<body>${banner}<p><small>${from.replace(/</g, "&lt;")}</small></p></body></html>`;
};

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Placeholder written into documents during the walk, swapped for a path after.
 *
 * Has to survive being put in an HTML attribute and a CSS `url()` without
 * escaping, and must not occur in real content. The prefix is checked against
 * every document and changed if an archive somehow contains it.
 */
const TOKEN_PREFIX = "__warc_zip_";
const tokenFor = (index: number) => `${TOKEN_PREFIX}${index}__`;

/**
 * A separate space for LINKS, because they resolve differently.
 *
 * A subresource token always becomes a path — the walk fetched it, so it has an
 * entry. A link token may have no entry at all, and then the whole anchor has to
 * be rewritten rather than just its href. Two prefixes keep that distinction
 * visible instead of encoding it in an index range.
 */
const LINK_PREFIX = "__warc_link_";
const linkTokenFor = (index: number) => `${LINK_PREFIX}${index}__`;

export interface DownloadPlan {
    ok: true;
    entries: DownloadEntry[];
    /**
     * Every url an anchor pointed at, indexed by its link token.
     *
     * Carried out of the walk because the decision it feeds — link, or neutralise
     * — cannot be made until every entry exists. See resolveTokens.
     */
    linkUrls: string[];
    /** The entry the reader asked for, so a manifest can name the front door. */
    root: DownloadEntry;
    missing: MissingRef[];
    resolved: ResolvedRef[];
    notices: DownloadNotice[];
}

export type DownloadPlanResult = DownloadPlan | Extract<WalkResult, { ok: false }>;

export interface DownloadOptions {
    /** Keep 3xx captures as their own entries. Default true. */
    includeRedirects?: boolean;
    idPolicy?: IdPolicy;
    maxEntries?: number;
    maxBytes?: number;
    /** Which archive a record came from, for the disambiguating name. */
    namer: ArchiveNamer;
    onNotice?: (notice: DownloadNotice) => void;
}

/**
 * Phase one: walk the graph, collect what has to be written, and decide where.
 *
 * Reads and rewrites HTML and CSS — the only types that reference anything — and
 * touches no binary payload at all. Their bytes are streamed straight out of the
 * WARC in phase two, so nothing is read twice and memory stays proportional to
 * the text rather than to the images.
 */
export const planDownload = async (
    record: ViewRecord,
    deps: ViewDeps,
    options: DownloadOptions,
): Promise<DownloadPlanResult> => {
    const entries: DownloadEntry[] = [];
    const notices: DownloadNotice[] = [];

    /** token -> the entry it stands for. */
    const byToken = new Map<string, DownloadEntry>();
    /** payload digest -> the entry that already holds those bytes. */
    const byDigest = new Map<string, DownloadEntry>();
    /** Every url an `<a href>` pointed at, indexed by its link token. */
    const linkUrls: string[] = [];

    const note = (notice: DownloadNotice) => {
        notices.push(notice);
        options.onNotice?.(notice);
    };

    let bytes = 0;
    let limited = false;

    const overLimit = () =>
        (options.maxEntries !== undefined && entries.length >= options.maxEntries) ||
        (options.maxBytes !== undefined && bytes >= options.maxBytes);

    const outcome = await walkArchive(record, deps, {
        // Text is read and rewritten because it carries the graph. Everything
        // else is recorded and left on disk until phase two.
        wants: (type) => (isHtml(type) || isCss(type) ? "text" : "record-only"),

        // A reference the archive cannot answer keeps the viewer's empty-data
        // placeholder: it is inert, needs no file, and renders as nothing rather
        // than as a broken-image icon.
        missingRef: undefined,

        navigation: "offline",

        /**
         * Where a LINK points, decided later.
         *
         * Always a token, never an answer. Asking "is this url in the download?"
         * at rewrite time gets the wrong answer whenever the target has not been
         * reached yet: a page that both links to B and embeds B in an iframe
         * would have its link neutralised if the anchor happened to be rewritten
         * before the iframe resolved, even though B ends up in the zip. The
         * question is only answerable once the walk is finished, so it is
         * deferred to the same substitution pass that resolves everything else.
         *
         * Deliberately NOT `resolve`: that reads, rewrites and DESCENDS, which is
         * right for an image and catastrophic for a link — chasing every `<a
         * href>` would drag the whole site into a download of one page.
         */
        resolveLink: (url) => {
            let index = linkUrls.indexOf(url);
            if (index < 0) index = linkUrls.push(url) - 1;

            return linkTokenFor(index);
        },

        emit: (target, content) => {
            if (overLimit() && !limited) {
                limited = true;
                note({ kind: "limit-reached", url: target.url,
                    detail: `stopped at ${entries.length} entries` });
            }

            // Byte-identical captures share one entry. `http://` and `https://`
            // of the same page are two records with the same digest, and writing
            // both would put two copies of one stylesheet in the zip with half
            // the references pointing at each.
            const digest = target.payload?.digest;

            if (digest) {
                const already = byDigest.get(`${digest}::${blobType(target)}`);

                if (already) {
                    already.aliases.push(target.url);
                    already.mergedBy = "digest";
                    note({ kind: "merged", url: target.url, detail: already.url });

                    return [...byToken.entries()]
                        .find(([, entry]) => entry === already)?.[0] ?? "";
                }
            }

            const entry: DownloadEntry = {
                url: target.url,
                record: target,
                aliases: [],
                text: content.kind === "text" ? content.text : null,
            };

            entries.push(entry);
            bytes += target.payload?.size ?? 0;

            if (digest) byDigest.set(`${digest}::${blobType(target)}`, entry);

            const token = tokenFor(entries.length - 1);
            byToken.set(token, entry);

            return token;
        },
    });

    if (!outcome.ok) return outcome;

    const root = byToken.get(outcome.ref);

    if (!root) {
        return {
            ok: false,
            reason: "unreadable",
            url: record.url,
            errorName: "NoRoot",
            message: "The page walked but produced no entry to save.",
        };
    }

    // Redirect hops kept as their own entries, if asked for. Done after the walk
    // rather than during it because a hop is only interesting once its
    // destination has an entry to point at.
    if (options.includeRedirects !== false) {
        for (const reference of outcome.resolved) {
            for (const hop of reference.redirects ?? []) {
                if (hop === reference.servedUrl) continue;
                if (entries.some(entry => entry.url === hop)) continue;

                entries.push({
                    url: hop,
                    // The destination's record stands in for the hop's own: the
                    // hop is a signpost and its bytes, where there are any, are a
                    // server error page. What matters is where it points.
                    // The ROOT's record stands in for the hop's own, only so the
                    // entry has a shape to carry — the path comes from the hop's
                    // url and the content is generated. A hop's real bytes are a
                    // server error page and are not worth a second lookup.
                    record: { ...root.record, url: hop, status: 301 },
                    aliases: [],
                    text: null,
                    redirectTo: reference.servedUrl,
                });

                note({ kind: "redirect-stub", url: hop, detail: reference.servedUrl });
            }
        }
    }

    assignPaths(entries, options.namer, options.idPolicy, note);

    for (const missed of outcome.missing) {
        note({ kind: "missing", url: missed.url, reason: missed.reason, detail: missed.referrer });
    }

    return { ok: true, entries, linkUrls, root, missing: outcome.missing,
        resolved: outcome.resolved, notices };
};

/**
 * Phase two, part one: swap every token in a document for a relative path.
 *
 * A plain string replace over text that has already been parsed once. The tokens
 * were chosen to need no escaping in either an attribute or a `url()`, so nothing
 * here has to understand HTML.
 */
export const resolveTokens = (
    text: string,
    fromPath: string,
    entries: readonly DownloadEntry[],
    linkUrls: readonly string[] = [],
): string => {
    /** Where a url ended up, by any of the names it answers to. */
    const paths = new Map<string, string>();

    for (const entry of entries) {
        if (!entry.path) continue;

        paths.set(entry.url, entry.path);
        for (const alias of entry.aliases) paths.set(alias, entry.path);
    }

    // Links FIRST, and over the whole attribute rather than just its value: a
    // link with no entry needs the href taken off the element entirely, which
    // means rewriting more than the token. Doing this before subresources also
    // means the two patterns cannot overlap on a malformed tag.
    let out = text.replace(
        new RegExp(`\\shref\\s*=\\s*["']${LINK_PREFIX}(\\d+)__["']`, "gi"),
        (whole, index: string) => {
            const url = linkUrls[Number(index)];
            if (url === undefined) return whole;

            const path = paths.get(url);

            // In the download: an ordinary working link, relative to here.
            if (path) return ` href="${escapeForAttribute(relativize(fromPath, path))}"`;

            // Not in the download. The href comes OFF, and the url moves to
            // data-warc-href — both because an href left in place is one
            // middle-click from the live site, and because that attribute is the
            // queue a later "download these too" pass reads.
            // Inert attributes only. An earlier version added a title and a
            // stylesheet that struck the link through; a downloaded page should
            // look like the page that was captured, so the archive normalises
            // where the link points and says nothing else about it.
            return ` data-warc-href="${escapeForAttribute(url)}" data-warc-missing=""`;
        },
    );

    // A <meta refresh> whose target is a link token.
    //
    // Handled explicitly, and BEFORE the generic fallback below, because the
    // fallback would put the original url back — turning a refresh that the
    // viewer defuses into one that fires and reaches the live web the moment the
    // file is opened. That is strictly worse than not downloading the page.
    //
    // In the download: rewritten to the local path, which is the only way a
    // redirect can be expressed on disk at all. Not in it: defused exactly as the
    // viewer defuses one, so the fact that the page redirected is preserved
    // without the redirect being able to happen.
    out = out.replace(/<meta\b[^>]*>/gi, tag => {
        const found = new RegExp(`${LINK_PREFIX}(\\d+)__`).exec(tag);
        if (!found) return tag;

        const url = linkUrls[Number(found[1])];
        if (url === undefined) return tag;

        const path = paths.get(url);

        if (path) {
            return tag.replace(found[0], escapeForAttribute(relativize(fromPath, path)));
        }

        return tag
            .replace(/(\scontent\s*=\s*)(["'])[^"']*\2/i, "$1\"0\"")
            .replace(/<meta\b/i, `<meta data-warc-refresh="${escapeForAttribute(url)}"`)
            .replace(/http-equiv\s*=\s*(["']?)refresh\1/i, 'data-warc-http-equiv="refresh"');
    });

    // Any link token that did NOT sit in an href or a meta — one built into an
    // attribute this rewriter does not model, or left in text. Rendered as the
    // plain url rather than as a token, which would be visible nonsense.
    out = out.replace(new RegExp(`${LINK_PREFIX}(\\d+)__`, "g"), (whole, index: string) =>
        linkUrls[Number(index)] ?? whole);

    return out.replace(new RegExp(`${TOKEN_PREFIX}(\\d+)__`, "g"), (whole, index: string) => {
        const entry = entries[Number(index)];

        return entry?.path ? relativize(fromPath, entry.path) : whole;
    });
};

/** Safe inside a double-quoted attribute. `&` first, or entities double-escape. */
const escapeForAttribute = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The zip, seen from here.
 *
 * An interface rather than zip.js directly, for two reasons. It keeps this module
 * free of the library — everything above is pure and testable without it — and it
 * is the seam a suite needs to make `add` throw on the fortieth entry, or `close`
 * throw after every entry succeeded, which is the failure that matters most and
 * the hardest to arrange for real.
 */
export interface ZipSink {
    /**
     * Resolves when the entry is in the archive.
     *
     * Safe to have several outstanding at once — the sink stages overlapping
     * entries on disk rather than in memory, so concurrency no longer costs the
     * streaming property. See zipsink.ts. Callers still have to await them all
     * before `close`.
     */
    add(path: string, content: ZipContent, options?: ZipEntryOptions): Promise<unknown>;
    close(): Promise<unknown>;
    /** Discard rather than finalise. A truncated-but-valid zip looks complete. */
    abort(reason?: unknown): Promise<unknown>;
}

export type ZipContent =
    | { kind: "text"; text: string }
    | { kind: "slice"; record: ViewRecord };

export interface ZipEntryOptions {
    lastModDate?: Date;
    /** 0 stores, 1-9 deflate. See ENTRY_LEVEL. */
    level?: number;
}

/**
 * Stored. Every entry, always. The zip is a container, not a compressor.
 *
 * This download exists to hand back the archived bytes, and the zip is only how
 * several of them travel together with their paths intact. Re-encoding them on
 * the way out buys size and costs the one property the feature is for: what comes
 * out of the archive is what went into it.
 *
 * It is not free, and the number should be on the record rather than discovered
 * later. Deflating where it helps and storing where it does not, measured over
 * 2,337 responses in four archives:
 *
 *   level 0 everywhere      345.8 MB
 *   level 6 where it helps  222.1 MB      -> 1.56x larger, +123.6 MB
 *   text/html alone          94.3 -> 17.6 MB      -> 5.35x larger
 *
 * So a text-heavy page is the case that suffers, and it suffers by a lot. The
 * trade is deliberate: a direct copy, written at disk speed with no CPU, in
 * exchange for a bigger file.
 *
 * This replaced an INCOMPRESSIBLE set of twelve already-compressed types that
 * chose 0 or 6 per entry. The measured ratios that set was based on are in
 * fflate.plan.md if compression is ever wanted back.
 */
const ENTRY_LEVEL = 0;

export interface WriteProgress {
    stage: "writing" | "finishing";
    path: string;
    entries: number;
    total: number;
    bytes: number;
}

export interface WriteOptions {
    onProgress?: (progress: WriteProgress) => void;
    /** Polled between entries. Returning true aborts the sink and stops. */
    cancelled?: () => boolean;
    onNotice?: (notice: DownloadNotice) => void;
    /**
     * How many entries may be in flight at once.
     *
     * **One, because nothing is compressed.** Parallelism was worth having when
     * entries were deflated: a CompressionStream does its work in native code off
     * the JS thread, so several at once could use several cores. With
     * ENTRY_LEVEL at 0 there is no CPU work to overlap — an entry is a read from
     * the WARC and a write to the output, and both are the same disk.
     *
     * Worse than useless, in fact: more than one entry in flight forces zip.js to
     * stage each one until the entry ahead of it lands, so a stored entry would be
     * written twice — once to staging, once to the archive — to parallelise work
     * that does not exist.
     *
     * The machinery stays because it is tested and it is one number. Raise it and
     * buffering and disk staging come back automatically; see zipsink.ts.
     */
    concurrency?: number;
}

/** See WriteOptions.concurrency. */
const DEFAULT_CONCURRENCY = 1;

export interface WriteResult {
    entries: number;
    bytes: number;
    cancelled: boolean;
}

/**
 * Phase two: stream the plan into a zip.
 *
 * Up to `concurrency` entries are in flight at once. This used to be strictly
 * sequential because overlapping entries force zip.js to stage them, and staging
 * meant memory — but the sink now stages to disk, so the streaming property
 * survives. See zipsink.ts.
 *
 * The DRIVING loop stays sequential and synchronous: choosing the content,
 * resolving tokens and picking a compression level all happen in plan order, on
 * this thread, before anything is handed to the sink. Only the compress-and-write
 * overlaps. That keeps `resolveTokens` deterministic and keeps the interesting
 * decisions in one readable sequence.
 *
 * Text was rewritten during the walk and only needs its tokens resolved. Binaries
 * have not been read at all yet; they are handed over as a record so the sink can
 * slice them straight out of the WARC.
 */
export const writeDownload = async (
    plan: DownloadPlan,
    sink: ZipSink,
    options: WriteOptions = {},
): Promise<WriteResult> => {
    let written = 0;
    let bytes = 0;

    // The manifest is an entry too. Counted here rather than left out, or the
    // final report says "5 of 4" and a bar drawn from it reaches 125%.
    const total = plan.entries.length + 1;

    const limit = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));

    /**
     * What is compressing right now.
     *
     * Each tracked promise removes ITSELF before settling, so by the time a
     * `Promise.race` on this set resolves the set has already shrunk. Deleting in
     * a separate `.then` is the usual way to get this wrong: race would wake on a
     * promise still in the set and the pool would run one short forever.
     */
    const inFlight = new Set<Promise<void>>();

    const track = (work: Promise<void>): void => {
        const tracked = work.finally(() => { inFlight.delete(tracked); });
        inFlight.add(tracked);
    };

    /**
     * Set before the sink is aborted, read by the entry tasks.
     *
     * Aborting rejects every add still in flight. Those are not failures — we
     * pulled the rug out — and reporting them would bury the one fact that
     * matters under a burst of "entry failed" notices.
     *
     * Note what this does NOT suppress: an entry that failed on its own merits
     * before the cancel arrived still reports. Simulated at concurrency 4 with
     * every entry failing and a cancel after 8 starts, the split was 5 real
     * notices and 3 suppressed, with every started entry accounted for exactly
     * once. That is the intended line — the flag hides consequences of the
     * abort, not failures that happened to be nearby.
     */
    let cancelling = false;

    const runEntry = async (
        entry: DownloadEntry,
        path: string,
        content: ZipContent,
        entryOptions: ZipEntryOptions,
    ): Promise<void> => {
        try {
            await sink.add(path, content, entryOptions);
        } catch (error) {
            if (cancelling) return;

            // ONE entry failing is not the download failing. A page missing one
            // image is worth having; throwing the whole zip away for it is not.
            options.onNotice?.({
                kind: "entry-failed",
                url: entry.url,
                detail: error instanceof Error ? error.message : String(error),
            });

            return;
        }

        written++;
        bytes += entry.record.payload?.size ?? 0;

        options.onProgress?.({ stage: "writing", path, entries: written, total, bytes });
    };

    /** Abort, then drain. Both, and in that order — see the note on `cancelling`. */
    const stop = async (): Promise<WriteResult> => {
        cancelling = true;

        // Aborted, not closed. Closing would write a central directory and leave
        // a VALID zip holding half the page — which is worse than no file,
        // because nothing about it looks wrong.
        await sink.abort("cancelled");
        await Promise.all([...inFlight]);

        return { entries: written, bytes, cancelled: true };
    };

    for (const entry of plan.entries) {
        if (options.cancelled?.()) return stop();

        const path = entry.path;
        if (!path) continue;

        const content: ZipContent = entry.redirectTo !== undefined
            ? {
                kind: "text",
                text: redirectStub(
                    entry.url,
                    entry.redirectTo,
                    relativize(path, pathOf(plan.entries, entry.redirectTo) ?? path),
                    entry.text,
                ),
            }
            : entry.text !== null
                ? { kind: "text", text: resolveTokens(entry.text, path, plan.entries, plan.linkUrls) }
                : { kind: "slice", record: entry.record };

        track(runEntry(entry, path, content, {
            // The capture's own date, not today's: an extracted file should
            // carry when it was archived.
            lastModDate: parseArchivedDate(entry.record.dateArchived),
            level: ENTRY_LEVEL,
        }));

        // One out before one more in. `race` and not `all`, or the pool would
        // drain to empty between batches and spend the tail of every batch idle.
        if (inFlight.size >= limit) await Promise.race(inFlight);
    }

    await Promise.all([...inFlight]);

    // Checked again: cancellation can land while the last entries were draining,
    // and finalising here would produce the valid-looking half archive that stop()
    // exists to prevent.
    if (options.cancelled?.()) return stop();

    // The manifest last, so it is written knowing the entry count is final.
    try {
        await sink.add("_warc-manifest.json", { kind: "text", text: buildManifest(plan) });
        written++;
    } catch {
        // A zip without its manifest is still a readable copy of the page.
        options.onNotice?.({ kind: "entry-failed", url: "_warc-manifest.json" });
    }

    options.onProgress?.({ stage: "finishing", path: "", entries: written, total, bytes });

    // This is the one that catches most people: the central directory is written
    // HERE, so every entry succeeding does not mean the file is good. Only a
    // close that returns means that.
    await sink.close();

    return { entries: written, bytes, cancelled: false };
};

/** Where a url ended up, by entry url or by any alias. */
const pathOf = (entries: readonly DownloadEntry[], url: string): string | undefined => {
    for (const entry of entries) {
        if (entry.url === url || entry.aliases.includes(url)) return entry.path;
    }

    return undefined;
};

/**
 * A WARC date to a Date, or undefined.
 *
 * Undefined rather than `new Date()`: an entry stamped with today would claim the
 * capture happened now, and a wrong date is worse than a missing one.
 */
const parseArchivedDate = (raw: string): Date | undefined => {
    const at = new Date(raw);

    return Number.isNaN(at.getTime()) ? undefined : at;
};

/**
 * The provenance of the copy, and the honest record of what is NOT in it.
 *
 * Without this a zip missing 45% of its stylesheet references looks like a
 * complete page that renders badly — see the measurements in download.plan.md.
 */
export const buildManifest = (plan: DownloadPlan): string => JSON.stringify({
    generated: new Date().toISOString(),
    page: {
        url: plan.root.url,
        path: plan.root.path,
        capturedAt: plan.root.record.dateArchived,
        contentType: blobType(plan.root.record),
    },
    entries: plan.entries.map(entry => ({
        path: entry.path,
        url: entry.url,
        capturedAt: entry.record.dateArchived,
        contentType: blobType(entry.record),
        bytes: entry.record.payload?.size ?? 0,
        ...(entry.aliases.length > 0 ? { aliases: entry.aliases } : {}),
        ...(entry.mergedBy ? { mergedBy: entry.mergedBy } : {}),
        ...(entry.redirectTo !== undefined
            ? { status: entry.record.status ?? 301, redirectsTo: entry.redirectTo }
            : {}),
    })),
    missing: plan.missing,
    notices: plan.notices.filter(notice => notice.kind !== "missing"),
}, null, 2);

/** Whether an archive's own text contains something that would be mistaken for a token. */
export const collidesWithToken = (text: string): boolean => text.includes(TOKEN_PREFIX);

/** Re-exported so the zip writer can read a payload without importing view.ts. */
export { readPayload, blobType };
