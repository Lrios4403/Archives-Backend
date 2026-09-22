// bun test routes/view/rewrite.test.ts
//
// The entity-decoding step in front of every rewritten url.
//
// This exists because of a bug that was invisible from the inside: HTMLRewriter
// returns an attribute's TEXT, not its value, so a url with two query
// parameters arrived carrying the literal `&amp;` and was looked up as a url
// that has never existed. Whole XenForo and phpBB forums rendered unstyled
// while single-parameter urls worked, so most of the corpus looked fine.
//
// The offline viewer never had it — it reads attributes through the DOM, which
// decodes for it. Tested here rather than there for exactly that reason: this is
// the side that does its own string work.

import { describe, expect, test } from "bun:test";
import { decodeHtmlEntities, makeArchivedApiHref } from "./rewrite";

const CTX = {
    meta: { uri: "https://onionfarms.com/" },
    apiUri: "https://archives.m4cgyver.net/api/warcs/view",
    requestUrl: new URL("https://archives.m4cgyver.net/api/warcs/view?id=x"),
};

/** The url the archive is actually asked for, pulled back out of a rewrite. */
const lookedUpUri = (href: string | null): string | null => {
    if (!href) return null;
    return new URL(href).searchParams.get("uri");
};

describe("decodeHtmlEntities", () => {
    test("&amp; becomes & — the case that broke every forum stylesheet", () => {
        expect(decodeHtmlEntities("a.css?x=1&amp;y=2")).toBe("a.css?x=1&y=2");
    });

    test("the real XenForo css.php href, end to end", () => {
        const raw = "https://onionfarms.com/css.php?css=public%3Aapp.less&amp;s=99&amp;l=1&amp;d=1785648741";

        expect(decodeHtmlEntities(raw)).toBe(
            "https://onionfarms.com/css.php?css=public%3Aapp.less&s=99&l=1&d=1785648741",
        );
    });

    test("the other attribute-legal entities", () => {
        expect(decodeHtmlEntities("&lt;&gt;&quot;&apos;")).toBe("<>\"'");
    });

    test("numeric, decimal and hex, upper and lower x", () => {
        expect(decodeHtmlEntities("&#38;")).toBe("&");
        expect(decodeHtmlEntities("&#x26;")).toBe("&");
        expect(decodeHtmlEntities("&#X26;")).toBe("&");
    });

    /*
     * The reason this is a single regex pass and not repeated replacement.
     * Decoding twice — or handling &amp; after the others — turns the literal
     * text "&amp;lt;" into "<", inventing a character the document never held.
     */
    test("decodes ONCE: &amp;lt; is the text &lt;, not a less-than sign", () => {
        expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
    });

    test("leaves unknown and malformed entities exactly as written", () => {
        expect(decodeHtmlEntities("&bogus;")).toBe("&bogus;");
        expect(decodeHtmlEntities("&amp")).toBe("&amp");        // no semicolon
        expect(decodeHtmlEntities("100% & rising")).toBe("100% & rising");
    });

    test("an out-of-range code point is left alone rather than throwing", () => {
        expect(() => decodeHtmlEntities("&#1114112;")).not.toThrow();
        expect(decodeHtmlEntities("&#1114112;")).toBe("&#1114112;");
        // Lone surrogates are not characters; String.fromCodePoint accepts them
        // but they would corrupt the url.
        expect(decodeHtmlEntities("&#xD800;")).toBe("&#xD800;");
    });

    test("a url with no entities is untouched", () => {
        const plain = "https://onionfarms.com/styles/app.css";

        expect(decodeHtmlEntities(plain)).toBe(plain);
    });
});

describe("makeArchivedApiHref", () => {
    test("asks the archive for the DECODED url", () => {
        const href = makeArchivedApiHref(
            "https://onionfarms.com/css.php?css=public%3Aapp.less&amp;s=99&amp;l=1",
            CTX,
        );

        expect(lookedUpUri(href)).toBe(
            "https://onionfarms.com/css.php?css=public%3Aapp.less&s=99&l=1",
        );
    });

    test("no `&amp;` survives into the lookup", () => {
        const href = makeArchivedApiHref("/js.php?a=1&amp;b=2&amp;c=3", CTX);

        expect(lookedUpUri(href)).not.toContain("&amp;");
        expect(lookedUpUri(href)).toBe("https://onionfarms.com/js.php?a=1&b=2&c=3");
    });

    /*
     * The single-parameter case is why this went unnoticed for so long: no `&`
     * means no entity, so plain asset urls were always correct and only forums
     * broke.
     */
    test("a single-parameter url was never affected, and still is not", () => {
        const href = makeArchivedApiHref("https://fonts.googleapis.com/css?family=Poppins", CTX);

        expect(lookedUpUri(href)).toBe("https://fonts.googleapis.com/css?family=Poppins");
    });

    test("relative urls still resolve against the record's own uri", () => {
        expect(lookedUpUri(makeArchivedApiHref("/styles/app.css", CTX)))
            .toBe("https://onionfarms.com/styles/app.css");
    });

    /*
     * Non-http schemes come back byte-for-byte. A data: URI can contain the
     * characters "&amp;" as payload, and decoding those would corrupt it — which
     * is why only the value used for the lookup is decoded, not the value
     * returned.
     */
    test("a data: URI is returned untouched, entities and all", () => {
        const data = "data:text/plain;base64,Zm9vJmFtcDti";

        expect(makeArchivedApiHref(data, CTX)).toBe(data);
        expect(makeArchivedApiHref("data:text/html,a&amp;b", CTX)).toBe("data:text/html,a&amp;b");
    });

    test("mailto/javascript/tel are left for the browser", () => {
        expect(makeArchivedApiHref("mailto:a@b.test", CTX)).toBe("mailto:a@b.test");
        expect(makeArchivedApiHref("javascript:void(0)", CTX)).toBe("javascript:void(0)");
    });

    test("an already-rewritten url is not rewritten twice", () => {
        const once = makeArchivedApiHref("/css.php?a=1&amp;b=2", CTX)!;

        expect(makeArchivedApiHref(once, CTX)).toBe(once);
    });

    test("empty and nullish inputs yield null", () => {
        expect(makeArchivedApiHref(null, CTX)).toBeNull();
        expect(makeArchivedApiHref(undefined, CTX)).toBeNull();
        expect(makeArchivedApiHref("", CTX)).toBeNull();
    });
});
