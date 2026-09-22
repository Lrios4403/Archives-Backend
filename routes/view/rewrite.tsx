/**
 * URL / HTML / CSS rewriting for the view route.
 *
 * Every asset URL in an archived page is rewritten to point back through the
 * archive API (makeArchivedApiHref), so nested resources resolve to archived
 * copies instead of the live web.
 */

import { isSameDocument } from "../../uri";

const regexCss = /url\(\s*["']?(.*?)["']?\s*\)/g;
const regexCssImport = /@import\s+["']([^"']+)["']/g;

/**
 * Build a single archived API href for a target URL, unwrapping nested api?uri=... chains.
 *
 * Fragments get two special treatments, because they are a browser-side concept
 * that never reaches a server:
 *
 *   1. A SAME-DOCUMENT reference is returned as a bare "#fragment" and not
 *      rewritten at all. Previously `<a href="#section">` became an absolute
 *      archive URL, so an in-page anchor cost a full document fetch instead of a
 *      scroll — and the same bug silently broke SVG/CSS references to elements in
 *      this document (url(#gradient), filter: url(#blur), <use href="#icon">),
 *      since those also resolve against the document base.
 *
 *   2. For a cross-document link the fragment is moved OFF the lookup key and
 *      onto the outer URL. `?uri=` must be fragment-free or it matches no stored
 *      URI; the trailing "#fragment" is invisible to the server and the browser
 *      applies it to the archived document it gets back, which still carries its
 *      original element ids.
 */
/** The entities that can legally appear inside an HTML attribute value. */
const NAMED_ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
};

/**
 * An attribute's TEXT is not its VALUE.
 *
 * HTMLRewriter (lol-html) hands back attribute values exactly as they appear in
 * the source, entities and all. Nothing here decoded them, so a url with more
 * than one query parameter — where `&` must be written `&amp;` in HTML — was
 * looked up with the entity still in it:
 *
 *   asked for  …/css.php?css=public:app.less&amp;s=99&amp;l=1&amp;d=1785648741
 *   archived   …/css.php?css=public:app.less&s=99&l=1&d=1785648741
 *
 * A url that has never existed anywhere, so the lookup missed and the page
 * rendered unstyled. Measured on onionfarms.com: 0 captures for the form asked
 * for, 19 for the real one.
 *
 * The offline viewer never had this bug, and the reason is instructive rather
 * than incidental: it rewrites through the DOM, so the browser's parser decodes
 * the attribute before it ever sees it. It was inheriting correctness from the
 * HTML parser. This side does its own string work and has to do the decoding
 * itself.
 *
 * Affects far more than stylesheets — js.php, attachment and avatar endpoints,
 * anything with two parameters. XenForo and phpBB serve nearly every asset that
 * way, which is why whole forums came out unstyled while simple sites were fine.
 *
 * ONE pass, deliberately. Decoding repeatedly (or handling `&amp;` last) would
 * turn the literal text `&amp;lt;` into `<`, inventing a character the document
 * never contained.
 */
export const decodeHtmlEntities = (value: string): string =>
    value.replace(
        /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
        (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
            if (dec !== undefined || hex !== undefined) {
                const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);

                // Out-of-range or surrogate code points would throw. An
                // undecodable entity is left as written rather than dropped:
                // mangling a url is worse than leaving it alone.
                if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
                if (code >= 0xd800 && code <= 0xdfff) return whole;

                return String.fromCodePoint(code);
            }

            return NAMED_ENTITIES[name!.toLowerCase()] ?? whole;
        },
    );

export function makeArchivedApiHref(rawurl: string | null | undefined, {
    meta,
    apiUri,
    requestUrl,
    redirectAction,
}: {
    meta: any,
    apiUri: string,
    requestUrl: URL,
    redirectAction?: RedirectAction,
}): string | null {
    if (!rawurl) return null;

    /*
     * Decoded for the LOOKUP, while every early return still hands back the
     * original text.
     *
     * That split matters: a `data:` URI can legitimately contain the characters
     * `&amp;` as data, and rewriting those bytes would corrupt the payload. Only
     * the value we parse as a url and send to the archive is decoded.
     */
    const decoded = decodeHtmlEntities(rawurl);

    if (decoded.startsWith(apiUri)) return rawurl;

    const input = new URL(decoded, meta.uri);

    /*
     * Only http(s) is a thing an archive can hold.
     *
     * `new URL()` is happy to parse `mailto:`, `javascript:`, `tel:` and `data:`,
     * so all four used to come out the other side as archive lookups: an email
     * link became a request for the uri "mailto:someone@example.test", which the
     * viewer answers with a "not archived" panel, and an inline
     * `src="data:image/png;base64,…"` became a fetch for a url no crawler has ever
     * stored. On a XenForo forum, where `javascript:void(0)` is on most in-page
     * controls, that turned every toggle into a failed navigation.
     *
     * Returned RAW rather than rewritten or dropped. These are not broken links,
     * they are links whose meaning is entirely client-side, and the browser
     * already knows what to do with each of them.
     */
    if (input.protocol !== "http:" && input.protocol !== "https:") {
        return rawurl;
    }

    // `new URL()` normalizes a bare trailing "#" to an empty hash, so a non-empty
    // input.hash is a real fragment.
    const fragment = input.hash;

    // Same document, differing only by fragment: leave it as a pure anchor. Note
    // this deliberately does NOT catch a same-document link with no fragment —
    // that still needs rewriting, or clicking it would navigate to the live web.
    if (fragment && isSameDocument(input.href, meta.uri)) {
        return fragment;
    }

    // The fragment is never part of the lookup key.
    input.hash = "";

    const archivedApiUrl = new URL(apiUri);
    archivedApiUrl.searchParams.set('uri', input.href);
    archivedApiUrl.searchParams.set('dateNear', meta.archived_date?.toString?.() ?? String(meta.archived_date));
    archivedApiUrl.searchParams.set('apiUri', apiUri);
    archivedApiUrl.searchParams.set('preventDefault', requestUrl.searchParams.get("preventDefault") ?? "");

    /*
     * The mode travels with the link.
     *
     * Without this the guard covers only the first document: click through to a
     * second page and it arrives with the default "none", unguarded, and the
     * next click leaves the frame for the live web. Every rewritten url goes
     * through this function, so this is the one place that has to remember.
     */
    if (redirectAction) archivedApiUrl.searchParams.set('redirectAction', redirectAction);

    // Reattached to the OUTER url, after the query string.
    return archivedApiUrl.href + fragment;
}

/** Rewrite srcset string using makeArchivedApiHref for each URL token */
function rewriteSrcset(srcset: string | null | undefined, ctx: { meta: any, apiUri: string, preventDefaultFlag: boolean, requestUrl: URL }) {
    if (!srcset) return srcset;
    return srcset
        .split(',')
        .map(part => {
            const trimmed = part.trim();
            if (!trimmed) return "";
            const [urlPart, ...descParts] = trimmed.split(/\s+/);
            const desc = descParts.join(' ');
            const replaced = makeArchivedApiHref(urlPart, ctx);
            return desc ? `${replaced} ${desc}` : `${replaced}`;
        })
        .filter(Boolean)
        .join(', ');
}

/** Rewrite CSS text by replacing url(...) and @import occurrences */
export function rewriteCssText(text: string, ctx: { meta: any, apiUri: string, requestUrl: URL }) {
    return text
        .replace(regexCss, (_, cssUrl) => {
            try {
                const full = new URL(cssUrl, ctx.meta.uri).href;
                const archived = makeArchivedApiHref(full, { meta: ctx.meta, apiUri: ctx.apiUri, requestUrl: ctx.requestUrl });
                return `url("${archived}")`;
            } catch (e) {
                return `url("${cssUrl}")`;
            }
        })
        .replace(regexCssImport, (_, importUrl) => {
            const archived = makeArchivedApiHref(importUrl, { meta: ctx.meta, apiUri: ctx.apiUri, requestUrl: ctx.requestUrl });
            return `@import "${archived}"`;
        });
}

/** Register a set of attribute handlers on an HTMLRewriter instance */
/**
 * What a click inside the frame should do.
 *
 *   "none"         nothing. The frame is a static exhibit; a link does whatever
 *                  the rewritten href does, which is to load the archived copy
 *                  INTO the frame with no involvement from the page around it.
 *   "postMessage"  tell the parent and let it decide. The frame navigates
 *                  nowhere itself; it posts `warc-navigate` and stops.
 *
 * Named rather than boolean because "should the frame prevent the default" is
 * not the question a caller is asking — it is one of the mechanics of the
 * answer, which is how the old `preventDefault=true` flag ended up describing
 * an implementation detail that nothing on the receiving end listened for.
 */
export type RedirectAction = "none" | "postMessage";

export interface RewriteContext {
    meta: any;
    apiUri: string;
    preventDefaultFlag: boolean;
    requestUrl: URL;
    redirectAction: RedirectAction;
}

/**
 * The navigation guard, injected once per document.
 *
 * A port of the offline viewer's guard (backend/parser/view.ts) with the
 * fetch/XHR shim left out, because that half cannot work here: offline answers
 * a request by reading the WARC the reader picked, and this frame's parent has
 * no File to read. Everything about NAVIGATION carries over unchanged, and
 * deliberately so — two viewers that disagree about what a click means is how
 * you get a bug that only reproduces in one of them.
 *
 * Why one injected listener instead of the per-anchor `onclick` this replaces:
 *
 *   - it sees links that did not exist when the rewriter ran. A forum that
 *     renders its thread list in script, an infinite scroll, anything built
 *     after load — the rewriter never saw those anchors, so they had no onclick
 *     and they left the frame.
 *   - it catches form submits, which had no handling at all.
 *   - capture phase, installed before any page script, so it runs first rather
 *     than after whatever the page bound to the same click.
 *
 * `host()` walks up past any window that flagged itself as archived, rather than
 * posting to `window.parent`. An archived page can contain its own frames, and
 * each is rewritten and guarded exactly like its container — so from inside one,
 * `parent` is more archived document, not the viewer. The old onclick posted to
 * `window.parent` and a click in a nested frame went to a window with no
 * listener.
 */
export function navigationGuardScript(ctx: RewriteContext): string {
    const here = ctx.meta?.uri ?? "";
    const dateNear = ctx.meta?.archived_date?.toString?.() ?? String(ctx.meta?.archived_date ?? "");

    return `<script data-warc-guard>(function(){
  var HERE = ${JSON.stringify(here)};
  var WHEN = ${JSON.stringify(dateNear)};

  window.__warcGuarded = true;

  function host(){
    try {
      var at = window;
      for (var hops = 0; hops < 32; hops++) {
        if (at.parent === at) break;
        at = at.parent;
        if (!at.__warcGuarded) return at;
      }
    } catch (e) {}
    try { return window.top || window.parent; } catch (e) {}
    return window.parent;
  }

  /*
   * The archived address a rewritten href points at.
   *
   * Every link in this document was rewritten to /api/warcs/view?uri=<original>,
   * so the thing the parent needs is that parameter and not the api url wrapping
   * it. A link the rewriter left alone — one it could not resolve — has no uri
   * param, and its own href is the best answer available.
   */
  function target(raw){
    try {
      var u = new URL(raw, HERE || location.href);
      return u.searchParams.get("uri") || u.href;
    } catch (e) { return raw; }
  }

  function nav(url, kind){
    try {
      host().postMessage({ type: "warc-navigate", url: String(url), via: kind, from: HERE, dateNear: WHEN }, "*");
    } catch (e) {}
    // false so an inline onclick="return __warcNav(...)" cancels the default.
    return false;
  }

  window.__warcNav = nav;

  /*
   * Stand-in for window.location, for code the rewriter redirected here.
   * window.location is [Unforgeable] — it cannot be replaced or proxied — so
   * this is not an interception; the rewriter names this object instead.
   * Reads answer with the ARCHIVED url, so page code that branches on its own
   * address behaves as it did when captured.
   */
  window.__warcLocation = {
    get href(){ return HERE; },
    set href(v){ nav(target(v), "location.href"); },
    assign: function(v){ return nav(target(v), "location.assign"); },
    replace: function(v){ return nav(target(v), "location.replace"); },
    reload: function(){ return nav(HERE, "location.reload"); },
    toString: function(){ return HERE; }
  };

  addEventListener("click", function(e){
    var a = e.target && e.target.closest && e.target.closest("a[href], area[href], [data-href]");
    if (!a) return;
    var href = a.getAttribute("href") || a.getAttribute("data-href") || "";
    // Same-document anchors still scroll. A fragment never reaches a server, so
    // no crawler captured one and no record can exist for it.
    if (!href || href.charAt(0) === "#") return;
    e.preventDefault();
    e.stopPropagation();
    nav(target(href), "link");
  }, true);

  addEventListener("submit", function(e){
    e.preventDefault();
    e.stopPropagation();
    nav(target((e.target && e.target.getAttribute && e.target.getAttribute("action")) || HERE), "form");
  }, true);
})();</script>`;
}

export function registerHtmlHandlers(htmlRewriter: any, ctx: RewriteContext) {
    /*
     * The guard goes in <head>, prepended, so it runs before anything the page
     * brought with it. `prepend` rather than `append` matters: a page whose own
     * script binds a click handler in head would otherwise get there first.
     *
     * Documents without a <head> exist, so <html> and <body> are covered too.
     * Only the first insertion does anything — the script sets window.__warcGuarded
     * and the re-entry check below reads it.
     */
    if (ctx.redirectAction === "postMessage") {
        const guard = navigationGuardScript(ctx);
        let injected = false;

        const inject = {
            element(e: any) {
                if (injected) return;
                injected = true;
                e.prepend(guard, { html: true });
            },
        };

        htmlRewriter.on("head", inject);
        // NOT `html`. HTMLRewriter is a stream, so <html> fires before <head>
        // does — registering it means it always wins the race and the script
        // lands before the head rather than inside it. Measured: byte 987 with
        // <head> at 3829. The parser hoists it back and it still runs, but the
        // served markup is then invalid and the placement is accidental.
        // <body> is the fallback for a document with no <head> at all.
        htmlRewriter.on("body", inject);
    }

    // Generic src handler
    htmlRewriter.on('*[src]', {
        element(e: any) {
            const val = e.getAttribute('src');
            if (!val) return;
            const replaced = makeArchivedApiHref(val, ctx);
            if (replaced) e.setAttribute('src', replaced);
        }
    });

    // Generic href handler
    htmlRewriter.on('*[href]', {
        element(e: any) {
            const val = e.getAttribute('href');
            if (!val) return;
            const replaced = makeArchivedApiHref(val, ctx);
            if (replaced) e.setAttribute('href', replaced);
        }
    });

    // img, source, picture: src + srcset + lazy attributes
    htmlRewriter.on('img, source, picture', {
        element(e: any) {
            const s = e.getAttribute('src');
            if (s) {
                const r = makeArchivedApiHref(s, ctx);
                if (r) e.setAttribute('src', r);
            }

            const ss = e.getAttribute('srcset');
            if (ss) {
                e.setAttribute('srcset', rewriteSrcset(ss, ctx));
            }

            // lazy-src / data-srcset patterns
            const dataSrcset = e.getAttribute('data-srcset');
            if (dataSrcset && dataSrcset.trim()) {
                e.setAttribute('data-srcset', rewriteSrcset(dataSrcset, ctx));
            } else {
                const lazy = e.getAttribute('data-src') ?? e.getAttribute('data-lazy-src');
                if (lazy) {
                    const r = makeArchivedApiHref(lazy, ctx);
                    if (r) e.setAttribute('data-src', r);
                }
            }
        }
    });

    // inline style attr
    htmlRewriter.on('*[style]', {
        element(e) {
            const style = e.getAttribute('style');
            if (!style) return;
            const replaced = style.replace(regexCss, (_, cssUrl) => {
                return `url("${makeArchivedApiHref(cssUrl, ctx)}")`;
            });
            e.setAttribute('style', replaced);
        }
    });

    // <style> block content - many HTMLRewriter implementations don't expose inner text setters.
    // We still call element handler to attempt setInnerContent if supported.
    htmlRewriter.on('style', {
        element(e: any) {
            try {
                // Some runtimes provide getInnerContent / setInnerContent
                const inner = (typeof e.getInnerContent === 'function') ? e.getInnerContent() : null;
                if (inner) {
                    const rewritten = rewriteCssText(inner, { meta: ctx.meta, apiUri: ctx.apiUri, requestUrl: ctx.requestUrl });
                    if (typeof e.setInnerContent === 'function') e.setInnerContent(rewritten);
                }
            } catch (err) { /* ignore if runtime doesn't support */ }
        }
    });

    // meta refresh
    htmlRewriter.on('meta[http-equiv]', {
        element(e: any) {
            const httpEquiv = (e.getAttribute('http-equiv') || '').toLowerCase();
            if (httpEquiv !== 'refresh') return;
            const content = e.getAttribute('content') ?? '';
            const replaced = content.replace(/url=(.+)$/i, (_, u) => {
                return `url=${makeArchivedApiHref(u.trim(), ctx)}`;
            });
            e.setAttribute('content', replaced);
        }
    });

    /*
     * The per-anchor `onclick` that used to live here is gone.
     *
     * It wrapped every <a> the rewriter saw in an inline handler that posted
     * `{type:"navigation", uri, dateNear}` to `window.parent`. Three things were
     * wrong with it, and the guard injected above fixes all three:
     *
     *   - nothing listened. Grep the frontend: the only message handler is the
     *     offline viewer's, and it listens for `warc-navigate`. Every one of
     *     these posts went into a window with no receiver, which is why clicking
     *     a link in /warcs/view did nothing at all.
     *   - it only ever covered anchors present in the markup at rewrite time.
     *   - it posted to `window.parent`, which is the wrong window as soon as the
     *     archived page has frames of its own.
     *
     * Nothing replaces it here because nothing needs to: the guard is one
     * capture-phase listener on the document, so it sees these anchors and the
     * ones built later, and it does not have to modify the page to do it.
     */
}
