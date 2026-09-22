import { serve, spawn } from "bun";
import { latestRoute } from "./routes/latest";
import { searchRoute } from "./routes/search";
import { viewRoute } from "./routes/view";
import { parseArgs } from "util";
import { nearRoute } from "./routes/near";
import { infoRoute } from "./routes/infomation";
import { pathRoute } from "./routes/path";
import { historyRoute } from "./routes/history";
import { detailRoute } from "./routes/detail";
import { contentTypesRoute } from "./routes/content-types";
import { statusRoute } from "./routes/status";
import { progressRoute } from "./routes/progress";
import { parserRoute } from "./routes/parser";
import { downloadRoute } from "./routes/download";
import { waitForDatabase } from "./db";
import { warmWarcFolderStats } from "./disk";

const args = parseArgs({
  args: Bun.argv,
  options: {
    threads: {
      type: 'string',
    },
  },
  strict: true,
  allowPositionals: true,
});

/*
if (args.values.threads) {
  const threads = Number(args.values.threads);
  const buns: any[] = [];

  await Bun.build({
    entrypoints: ['./webserver.ts'],
    outdir: './',
    target: "bun"
  })

  for (let i = 0; i < threads; i++) {
    buns.push(spawn({
      cmd: ["bun", "./webserver.js"],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    }))
  }
} else {

  console.log("Webserver is online")

  const routes = {
    "/api/warcs/latest": latestRoute,   // (req) => Response | Promise<Response>
    "/api/warcs/search": searchRoute,   // (req) => Response | Promise<Response>
    "/api/warcs/view": viewRoute,   // (req) => Response | Promise<Response>
    "/api/warcs/near": nearRoute,   // (req) => Response | Promise<Response>
    "/*": () => new Response("Not Found", { status: 404 })
  };

  serve({
    routes,
    port: 3000,
    development: false,
    reusePort: true,
  })
}
  */


console.log("Webserver is online")

/*
 * Start the warc-folder scan now, in the background.
 *
 * getWarcFolderStats caches, so the only slow call is the first one. Paying for
 * it here means no REQUEST ever pays for it: by the time /api/warcs/status or
 * /api/warcs/progress is asked, a reading already exists and every later refresh
 * serves the previous value while it runs.
 *
 * Deliberately not awaited. A network mount that is briefly unavailable must not
 * stop the server from starting — every other route works without it.
 */
warmWarcFolderStats("./warcs/");

// Static Response objects for fixed routes: Bun serves these without allocating a
// new Response per request.
const NOT_FOUND = new Response("Not Found", { status: 404 });
const HEALTH = new Response("OK");

const routes = {
  "/health": HEALTH,
  /*
   * Parse progress for every known file.
   *
   * Under /api/warcs with the rest of the API rather than bare like /health,
   * because only /api/* is proxied through from the Next frontend — a bare path
   * is reachable from this box and nowhere else.
   */
  "/api/warcs/progress": progressRoute,
  "/api/warcs/latest": latestRoute,   // (req) => Response | Promise<Response>
  "/api/warcs/search": searchRoute,
  "/api/warcs/view": viewRoute,
  "/api/warcs/near": nearRoute,
  "/api/warcs/info": infoRoute,
  "/api/warcs/path": pathRoute,
  "/api/warcs/detail": detailRoute,
  "/api/warcs/content-types": contentTypesRoute,
  "/api/warcs/status": statusRoute,
  // Browser build of the mwarc parse worker, bundled on first request.
  "/api/warcs/parser/index.js": parserRoute,
  /*
   * Captures bundled into a zip, streamed from the WARCs on disk.
   *
   * Takes an optional second argument for its database lookups, which Bun never
   * passes — the default is the live ones. That seam is why the route's failure
   * paths are testable at all: a row pointing past the end of a file is trivial
   * to fake and near-impossible to arrange in Postgres.
   */
  "/api/warcs/download": downloadRoute,
  "/api/history": historyRoute,
  "/*": NOT_FOUND,
} as const;

// Don't start serving until the database actually accepts connections, so early
// requests don't hit a not-ready DB right after `docker compose up`.
await waitForDatabase();

serve({
  routes,
  port: Number(Bun.env.PORT ?? 3000),
  /*
   * Reads BOTH variables, because this deployment sets the other one.
   *
   * docker-compose.yml sets `BUN_ENV=production` on webserver-archives and
   * webparser-archives. Nothing sets NODE_ENV. So this test was always true in
   * production and the server has been running in DEVELOPMENT MODE on the public
   * internet — which is not cosmetic: Bun's dev mode answers an unhandled error
   * with its error overlay instead of a plain 500.
   *
   * Measured on the live box before this change: `GET /api/warcs/path` with no
   * parameters returned 66,811 bytes of HTML containing the exception type, the
   * message, and the container's internal `/app` paths, to any unauthenticated
   * caller. That is an information leak with a one-word cause.
   *
   * Defaulting to development when NEITHER is set is deliberate — a bare
   * `bun webserver.ts` on a laptop should still show the overlay. Only an
   * explicit "production" in either variable turns it off, so the fix cannot be
   * undone by someone renaming the variable back.
   */
  development:
    Bun.env.NODE_ENV !== "production" && Bun.env.BUN_ENV !== "production",

  /*
   * No idle timeout, because one of these routes streams archives.
   *
   * It was 30 seconds, which is a sensible number for a request that answers from
   * the database and a hostile one for a download. `idleTimeout` is the longest a
   * connection may go without moving data, and a zip of a hundred payloads read
   * out of a WARC on a slow mount — a Docker bind mount over a Windows
   * filesystem, say — can easily be quiet for longer than that during a single
   * large read.
   *
   * When it fires, Bun closes the socket mid-body. The client keeps the partial
   * file, and because the response is chunked there is no length for it to notice
   * is missing: the browser reports success and the file is a truncated zip.
   * Windows says "The compressed (zipped) Folder is invalid" and the server says
   * nothing, because from its side nothing failed.
   *
   * That is exactly the failure this endpoint produced on its first real use: a
   * 19 MB archive arriving as 128 KB. The plan was correct, the writer was
   * correct, and the socket was closed underneath both.
   */
  idleTimeout: 0,
});

console.log(`Serving on port ${Number(Bun.env.PORT ?? 3000)}`);