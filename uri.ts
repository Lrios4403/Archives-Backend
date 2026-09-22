/**
 * URI fragment handling, shared by the view route and the HTML/CSS rewriter.
 *
 * A fragment is never sent to a server — it exists only in the browser. So no
 * crawler stores "example.com/page#section" as a WARC-Target-URI, and any lookup
 * carrying one cannot match. But the rewriter was building archive URLs with
 * `new URL(raw, base).href`, which includes the fragment, so
 *
 *     <a href="#section">   on   example.com/page
 *
 * became  ?uri=example.com%2Fpage%23section  — a key that matches nothing.
 *
 * The rule these helpers enforce: the fragment is never part of a lookup key, and
 * never thrown away either. It belongs on the OUTER URL, where the browser can
 * apply it to whatever document comes back.
 */

/**
 * The URI without its fragment.
 *
 * Splits on the first unescaped "#", which is exactly where a fragment starts per
 * RFC 3986. A percent-encoded %23 is not a delimiter and is left alone. String
 * work rather than `new URL()` so this never throws on a relative or malformed
 * input.
 */
export function stripFragment(uri: string): string {
  const i = uri.indexOf("#");
  return i === -1 ? uri : uri.slice(0, i);
}

/**
 * The fragment INCLUDING its leading "#", or "" when there isn't one.
 *
 * A bare trailing "#" counts as no fragment. That is not pedantry — it is what
 * makes the canonicalising redirect loop-safe. Gating the redirect on "the raw
 * string contains #" would, for "page#", strip nothing, rebuild an identical URL
 * and redirect forever.
 */
export function fragmentOf(uri: string): string {
  const i = uri.indexOf("#");
  if (i === -1) return "";
  const fragment = uri.slice(i + 1);
  return fragment ? "#" + fragment : "";
}

/** Whether `uri` carries a fragment worth preserving. */
export function hasFragment(uri: string): boolean {
  return fragmentOf(uri) !== "";
}

/**
 * Whether two absolute URLs address the same document, i.e. differ only by
 * fragment.
 *
 * Used to spot same-document references, which must NOT be rewritten:
 *
 *   <a href="#section">          rewriting turns a scroll into a full page fetch
 *   fill="url(#gradient)"        SVG paint servers
 *   filter: url(#blur)           CSS filters
 *   <use href="#icon">           SVG sprites
 *
 * Those resolve against the document base, so rewriting them to an absolute
 * archive URL silently breaks gradients, masks, filters and sprites, and makes
 * every in-page anchor reload the whole document through the API.
 *
 * Compares the fragment-free forms, so a differing query string correctly counts
 * as a different document ("?q=2#x" against a base of "?q=1" is not same-document).
 */
export function isSameDocument(a: string, b: string): boolean {
  return stripFragment(a) === stripFragment(b);
}
