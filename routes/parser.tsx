/**
 * Serves the browser build of the mwarc parse worker.
 *
 *   GET /api/warcs/parser/index.js  -> the worker bundle (JavaScript)
 *
 * Built once, at import, and cached in memory for the life of the process — or
 * rebuilt when a source file changes on disk, which is what makes it usable in
 * development. Bun.build returns its artifacts as Blobs, so nothing is written to
 * disk: there is no build output to gitignore, stale, or serve by accident.
 *
 * Served gzipped to clients that accept it — 190 KB of minified JavaScript for
 * 82 KB on the wire, on the one request every reader of the offline viewer makes
 * before they can open a single page.
 *
 * The frontend consumes it the way cactions.tsx already does:
 *
 *   fetch('/api/warcs/parser/index.js')
 *     .then(r => r.blob())
 *     .then(b => new Worker(URL.createObjectURL(b)))
 */

const ENTRYPOINT = new URL("../parser/worker.entry.ts", import.meta.url).pathname;

/**
 * Every source file the bundle is built FROM, for staleness detection.
 *
 * Listed explicitly because Bun.build does not hand back its input set, and
 * worker.entry.ts has exactly one import. If it ever gains another, add it here —
 * the cost of forgetting is a bundle that keeps serving old code, which is not a
 * loud failure. It presents as the frontend silently ignoring messages it does
 * not recognise, because the browser is running a parser from before the protocol
 * changed. That has already happened once: a progress bar that jumped straight
 * from 0% to 100% because the cached bundle was still sending one message per
 * record under the old action name.
 */
const SOURCES = [
    ENTRYPOINT,

    /*
     * THIS FILE, because the build OPTIONS are part of what the output depends on
     * and nothing else here covers them.
     *
     * Learned the hard way: `format` was changed from "esm" to "iife" to fix a
     * bundle that would not load, the running server kept serving the cached ESM
     * build because no *source* mtime had moved, and the fix appeared to do
     * nothing at all. Same failure the note above describes, one level up — the
     * cache was correct about its inputs and wrong about what its inputs were.
     */
    new URL(import.meta.url).pathname,

    new URL("../mwarc.ts", import.meta.url).pathname,
    // Added when the viewer landed — and forgotten for one round of debugging
    // first, which is exactly the failure the note above describes. Editing
    // view.ts alone left the mtime unchanged as far as this route was concerned,
    // so the browser kept running the previous build and every fix looked like it
    // had done nothing.
    new URL("../parser/view.ts", import.meta.url).pathname,
    new URL("../parser/download.ts", import.meta.url).pathname,

    /*
     * The zip writer, which is now three files and no library.
     *
     * zipsink.ts is deliberately NOT here any more: nothing imports it, so it is
     * not in the bundle, and listing it would mean an edit to a file the browser
     * never receives triggering a rebuild. It is kept on disk as the version that
     * can deflate — see the header of storedsink.ts. If it is ever wired back up,
     * it has to come back to this list at the same time.
     */
    new URL("../parser/storedsink.ts", import.meta.url).pathname,
    new URL("../parser/storedzip.ts", import.meta.url).pathname,
    new URL("../parser/crc32.ts", import.meta.url).pathname,
    // .warc.gz support. Imported by both worker.entry.ts (for the reader) and
    // view.ts (for payload retrieval), so a change here can alter how every
    // compressed archive is read while leaving the two files above untouched.
    new URL("../parser/gzip.ts", import.meta.url).pathname,
    // .wacz support: reads the zip central directory so an archive inside a
    // container can be read in place. Added in the same change as gzip.ts and
    // forgotten here at first, which is the third time this list has been the
    // thing that was out of date.
    new URL("../parser/wacz.ts", import.meta.url).pathname,
    // The outbound wire protocol and source resolution. Lives outside the entry
    // specifically so the entry exports no runtime value — see wire.ts.
    new URL("../parser/wire.ts", import.meta.url).pathname,
];

/**
 * Newest mtime across the sources, or null if any of them cannot be stat'd.
 *
 * Null means "do not invalidate": a stat failure should not trigger a rebuild
 * loop, and if a source really has gone missing the build itself will say so.
 */
const sourceStamp = (): number | null => {
    try {
        return SOURCES.reduce((newest, path) => {
            const modified = Bun.file(path).lastModified;
            return modified > newest ? modified : newest;
        }, 0);
    } catch {
        return null;
    }
};

/*
 * CORS, which this route is the first to actually need.
 *
 * Every other endpoint is called from Next Server Components — server-to-server,
 * where CORS does not apply. This one is fetched by the BROWSER (cactions.tsx,
 * 'use client') from the Next dev server's origin, so without these headers the
 * request is blocked before the response body is ever read.
 *
 * "*" is appropriate here specifically: the bundle is public, static JavaScript
 * with no credentials and nothing user-specific. Endpoints that return archive
 * data should get a real origin allowlist rather than copying this.
 */
const ALLOWED_ORIGIN = Bun.env.CORS_ALLOW_ORIGIN ?? "*";

/*
 * Production, by either name.
 *
 * docker-compose.yml sets BUN_ENV=production and nothing in this project ever
 * sets NODE_ENV - yet webserver.ts reads `Bun.env.NODE_ENV !== "production"`
 * for Bun.serve's `development` flag, which therefore evaluates TRUE in
 * production. Both are honoured here rather than picking a side, so this cannot
 * silently no-op the way keying on NODE_ENV alone would have.
 */
const IS_PRODUCTION =
    Bun.env.NODE_ENV === "production" || Bun.env.BUN_ENV === "production";

const corsHeaders = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    // ETag isn't CORS-safelisted, so the browser hides it from JS unless it is
    // exposed. Harmless today (nothing reads it), but revalidation reads it.
    "Access-Control-Expose-Headers": "ETag, X-Parser-Built-At",
};

interface ParserBundle {
    code: string;
    /**
     * The same bytes, gzipped once at build time.
     *
     * 190 KB of minified JavaScript compresses to 82 KB, and this is a file every
     * reader of the offline viewer downloads before they can open a single page.
     * Compressing per request would be the same work over and over for a body
     * that only changes when a source file does.
     */
    gzip: Uint8Array;
    etag: string;
    builtAt: string;
}

/**
 * The cached build, shared by every request.
 *
 * Held as a promise rather than a value so concurrent first requests await the
 * same build instead of each starting their own. Cleared on failure so a broken
 * build can be fixed and retried without restarting the server.
 */
let bundlePromise: Promise<ParserBundle> | null = null;

/** Source mtime the cached bundle was built from. See getBundle. */
let bundleStamp: number | null = null;

const buildBundle = async (): Promise<ParserBundle> => {
    const result = await Bun.build({
        entrypoints: [ENTRYPOINT],
        target: "browser",

        /*
         * IIFE, not ESM, because this is spawned as a CLASSIC worker.
         *
         * It was "esm", which worked only by accident: worker.entry.ts exported
         * nothing but TYPES, and types are erased, so the bundle happened to have
         * no top-level `export` for ESM to emit. The moment a runtime export was
         * added — two functions, exported so tests could reach them — Bun emitted
         * `export { … }` at the end of the bundle and every parse died with
         * "Uncaught SyntaxError: Unexpected token 'export'" before reading a byte.
         * Same failure shape as the import.meta note below, same 0% "The parser
         * stopped unexpectedly", and just as far from its cause.
         *
         * IIFE cannot express a top-level export at all, so this closes the trap
         * rather than relying on nobody ever exporting a value from the entry.
         * parser.bundle.test.ts asserts the output still parses as a classic
         * script.
         */
        format: "iife",
        minify: true,

        /*
         * zip.js reads `import.meta.url` to work out where to load its own
         * workers from. This bundle is spawned as a CLASSIC worker — `new
         * Worker(blobUrl)`, no { type: "module" } — and `import.meta` is a
         * SyntaxError in a classic script. Not a runtime error in a corner: the
         * whole bundle fails to parse, so PARSING broke too, and every archive
         * reported "The parser stopped unexpectedly" at 0% without reading a byte.
         *
         * Defined away rather than fixed by switching to a module worker. That
         * would work, but it would raise the browser floor for parsing — module
         * workers are Firefox 114+ and Safari 15+ — to pay for a download feature
         * that only Chromium can do anyway. Parsing has to keep working
         * everywhere.
         *
         * The library's own answer to this is an entry point that skips the
         * worker bootstrap. In older layouts that was
         * `@zip.js/zip.js/lib/zip-no-worker-bootstrap.js`. It does not exist in
         * 2.8.51: every entry — the default, `zip-core.js`, `zip-core-native.js`,
         * `zip-core-external.js` — routes through `lib/zip-core-base.js`, which
         * runs `setDefaultConfiguration({ baseURI: import.meta.url })` at module
         * load. Checked each of them; none bundles clean.
         *
         * Safe because that one read is the ONLY one in the bundle. The two
         * others in the library, in `lib/core/external-assets.js`, resolve a
         * worker and a wasm url against the baseURI and would throw on an empty
         * string — but they sit on the "external engine" path, which this does
         * not import. Verified by bundling with the define and writing and
         * re-reading a real zip with `new Function(bundle)`, i.e. exactly the
         * classic-script scope a worker gives it.
         */
        define: { "import.meta.url": '""' },
    });

    if (!result.success || result.outputs.length === 0) {
        // Bun.build reports diagnostics rather than throwing, so surface them or
        // the failure is silent and the route just 500s with nothing to go on.
        const detail = result.logs.map(log => String(log)).join("\n");
        throw new Error(`parser bundle failed to build:\n${detail}`);
    }

    const code = await result.outputs[0]!.text();

    // Content hash, so the browser can revalidate cheaply and a changed parser
    // invalidates immediately instead of being served from cache.
    const etag = `"${Bun.hash(code).toString(16)}"`;

    return {
        code,
        // The string overload, which encodes as UTF-8 — matching the charset the
        // response declares. TextEncoder would too, but its Uint8Array is typed
        // over ArrayBufferLike and Bun's signature wants ArrayBuffer.
        gzip: Bun.gzipSync(code),
        etag,
        builtAt: new Date().toISOString(),
    };
};

/**
 * The cached bundle, rebuilt when its sources have changed on disk.
 *
 * It used to be built once for the life of the process, full stop. That is fine
 * in production and quietly wrong in development: edit the worker, reload the
 * page, and the browser is handed the build from before the edit — with no error
 * anywhere, because a correctly-served stale bundle looks exactly like a correct
 * one. A `no-cache` ETag on the response does not help, since the ETag is
 * computed from the code the process is still holding.
 *
 * One stat per request (two files) is nothing next to a Bun.build, and it makes
 * the cache correct rather than merely fast.
 */
const getBundle = (): Promise<ParserBundle> => {
    const stamp = sourceStamp();

    if (bundlePromise && stamp !== null && bundleStamp !== null && stamp !== bundleStamp) {
        console.log("parserRoute: worker source changed, rebuilding the parser bundle");
        bundlePromise = null;
    }

    if (!bundlePromise) {
        bundleStamp = stamp;
        bundlePromise = buildBundle().catch(error => {
            // Let the next request retry rather than caching the failure.
            bundlePromise = null;
            bundleStamp = null;
            throw error;
        });
    }

    return bundlePromise;
};

/*
 * Build it now, at import, rather than on the first request.
 *
 * Measured cold: 1.7 s for the first Bun.build in a process, 230-650 ms warm. That
 * second and a half used to be paid by whoever opened the offline viewer first —
 * a browser sitting on a pending request for index.js while the server compiled
 * the parser, on the page where the parser is the point.
 *
 * NOT awaited: the server starts listening immediately and the build finishes in
 * the background, so a request that does arrive first simply awaits the same
 * promise it would have created. Failures are swallowed here for the same reason
 * the frontend prewarm swallows its own — this is speculative, and getBundle
 * clears the cached rejection so the request that actually needs it rebuilds and
 * reports properly.
 */
void getBundle().catch(() => {});

/**
 * Test seam: is a build already in flight or finished, with no request made?
 *
 * The warm-up above is a module side effect, so there is no other way to assert
 * from outside that the first browser to ask does not wait for a Bun.build.
 */
export const __bundleWarmed = (): boolean => bundlePromise !== null;

export const parserRoute = (req: Request): Promise<Response> =>
    getBundle()
        .then(bundle => {
            // Revalidation: unchanged bundle, no body.
            if (req.headers.get("if-none-match") === bundle.etag) {
                return new Response(null, {
                    status: 304,
                    headers: { ...corsHeaders, ETag: bundle.etag, Vary: "Accept-Encoding" },
                });
            }

            const wantsGzip = (req.headers.get("accept-encoding") ?? "").includes("gzip");

            return new Response(wantsGzip ? bundle.gzip : bundle.code, {
                headers: {
                    ...corsHeaders,
                    "Content-Type": "text/javascript; charset=utf-8",
                    ETag: bundle.etag,
                    /*
                     * Revalidate in development, cache briefly in production.
                     *
                     * `no-cache` unconditionally was costing ~750 ms per page
                     * load, and for a reason that is invisible from here: the
                     * offline viewer spawns EIGHT workers with
                     * `new Worker(PARSER_SCRIPT_URL)`, and that design is built
                     * on the prewarm having put this body in the HTTP cache so
                     * the eight constructions are cache hits. `no-cache` means
                     * nothing is stored to hit, so all eight went to the network,
                     * queued behind one URL, and blocked. Measured in a HAR:
                     * `wait=0, recv=0, blocked=748` on eight identical requests
                     * for a 24 KB body.
                     *
                     * The stable URL is why this cannot simply be `immutable` —
                     * a rebuild does not change the path, so a long-lived copy
                     * could outlive a source change. That was the original
                     * concern and it is a real one, but it is a DEVELOPMENT
                     * concern: getBundle() stats its sources per request, so the
                     * server is never stale, only a browser's copy can be.
                     *
                     * 60 seconds bounds that to something shorter than the
                     * reload it would take to notice, while collapsing eight
                     * network round trips into one fetch and seven cache hits.
                     * Development keeps revalidating, so an edit is visible on
                     * the next reload exactly as before.
                     *
                     * Checks BOTH env vars on purpose. docker-compose sets
                     * BUN_ENV=production and nothing sets NODE_ENV, so keying
                     * this on NODE_ENV alone — the obvious choice — would have
                     * left production on `no-cache` and the whole fix inert.
                     */
                    "Cache-Control": IS_PRODUCTION ? "public, max-age=60" : "no-cache",
                    "X-Parser-Built-At": bundle.builtAt,

                    /*
                     * One ETag for both encodings, so `Vary` is not optional — a
                     * shared cache would otherwise be free to hand a gzip body to
                     * a client that never asked for one.
                     */
                    Vary: "Accept-Encoding",
                    ...(wantsGzip ? { "Content-Encoding": "gzip" } : {}),
                },
            });
        })
        .catch(error => {
            console.error("parserRoute error:", error);
            // CORS on the error too, or the browser reports an opaque network
            // failure and hides the actual build diagnostics.
            return new Response(
                `/* mwarc parser bundle failed to build */\n${String(error?.message ?? error)}`,
                {
                    status: 500,
                    headers: { ...corsHeaders, "Content-Type": "text/javascript; charset=utf-8" },
                },
            );
        });
