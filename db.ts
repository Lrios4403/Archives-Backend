import { file, SQL } from "bun";
import type { WarcFile, WarcIp, WarcUri, WarcPayload, WarcRecordEntry, WarcRequestEntry, WarcResponseEntry, WarcContentType, WarcInsertResponseFull, WarcHistoryRow, WarcRecordDetailRow, WarcResponseBulkInput } from "./db.types";


/**
 * Connections are budgeted PER THREAD, because every parse worker imports this
 * module and therefore builds its own pool:
 *
 *   total = 1 main pool + PARSE_WORKERS x worker pool
 *
 * The worker number is deliberately small, and not just to stay under
 * max_connections. Concurrent writers are the real constraint: EXPLAIN BUFFERS on
 * searches taken during ingest showed `written=11326`, i.e. the SEARCH backend
 * was evicting and flushing dirty pages itself because shared_buffers was full of
 * ingest's. That is what turns a 289ms search into 2.8s. At 8 workers x 4 that is
 * 32 connections all streaming 1024-row bulk inserts; at 2 it is 16, and the
 * background writer has a chance to keep ahead of them.
 *
 * Parse threads can stay numerous — decoding is the CPU-bound part and doesn't
 * need a connection. Raise PG_POOL_MAX_WORKER only if inserts become the
 * measured bottleneck, and watch pg_stat_io's writes when you do.
 */
const POOL_MAX = Bun.isMainThread
  ? Number(Bun.env.PG_POOL_MAX ?? 20)
  : Number(Bun.env.PG_POOL_MAX_WORKER ?? 2);

/**
 * Seconds a pooled connection may sit idle before it is closed.
 *
 * This was 0, which Bun reads as "never reclaim". That is not a small default:
 * it makes every connection the pool has EVER opened permanent, so a momentary
 * spike becomes the steady state and the pool only ever ratchets upward.
 *
 * It took the database down. Measured on origimagic: `webparser-archives` had
 * finished its work ("Done parsing all files") yet still held 80 idle backends,
 * far above its own 20-connection budget for the main thread; the webserver held
 * its 20; 80 + 20 = 100 = max_connections exactly, and Postgres then refused
 * every new connection including the superuser reserve — `FATAL: sorry, too many
 * clients already`. Restarting the parser dropped it to 40 in use.
 *
 * Note what it does NOT do: `max` was already correct and the parse workers
 * already exit cleanly (parse.worker.ts handles `shutdown` with process.exit).
 * Nothing here caps a pool that a non-zero `max` did not already cap. What it
 * changes is that an over-budget pool now RECOVERS instead of staying that way
 * until someone restarts the container.
 *
 * 30s, verified against Bun 1.3.6 rather than assumed — bun-types documents
 * idleTimeout with connectionTimeout's description ("wait for connection to
 * become available"), which is a copy-paste error. Measured directly: a pool
 * opened to 10 and left alone shrank; the same pool at idleTimeout 0 did not.
 * Long enough that a busy parser or a steady stream of searches never churns
 * connections, short enough that a finished parse drains within half a minute.
 */
const POOL_IDLE_TIMEOUT_S = Number(Bun.env.PG_POOL_IDLE_TIMEOUT ?? 30);

/*
 * Required, with no fallback, and the absent fallback is the point.
 *
 * This used to default to a full connection string with a working username
 * and password in it. That is a credential in source, and source gets
 * published -- but the quieter problem is that a default here cannot be right
 * for anybody else: the hostname it named is a docker-compose service name
 * that resolves only inside one particular stack. Anywhere else it either
 * fails to resolve or, worse, quietly reaches some OTHER database that
 * happens to answer to that name.
 *
 * Throwing at import is deliberate. The alternative -- connect to a default
 * and find out later -- turns a missing variable into a wrong-database bug
 * that surfaces as puzzling query results rather than as an error. Failing
 * before the first query is the cheapest version of this mistake there is.
 *
 * See .env.example for the shape of the value.
 */
const DATABASE_URL = Bun.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. This backend has no default connection string -- " +
      "copy .env.example to .env and fill it in. Expected shape: " +
      "postgres://USER:PASSWORD@HOST:5432/warcs",
  );
}

// One source of truth: Bun auto-detects Postgres from the connection string.
export const sql = new SQL({
  url: DATABASE_URL,

  max: POOL_MAX,
  idleTimeout: POOL_IDLE_TIMEOUT_S,
  connectionTimeout: 0,
});

/**
 * Drop and recreate the entire schema from db/setup.sql.
 *
 * DESTRUCTIVE — setup.sql drops every table before creating it, progress
 * included. This was called on every parser boot, which is exactly why the
 * archive was re-read from zero on every restart; it is now something a caller
 * has to ask for. See parser.ts.
 *
 * ALSO DESTRUCTIVE TO SEARCH, which is less obvious and worth stating here
 * rather than only in the .sql. db/setup.sql has drifted from production: its
 * search_responses() is the ~19s MATERIALIZED shape, its search_responses_count()
 * has no 10k cap, and it does not define search_responses_broad() at all — which
 * get_warc_search_responses below calls. Running this would leave the search
 * routes slower than they have ever been and one of them throwing.
 *
 * The deployed bodies are in db/DEPLOYED.recovered.sql. Reconcile setup.sql from
 * that before ever calling this again.
 */
export const reset_database = () => sql.file("db/setup.sql");

/**
 * Block until the database accepts a real query, retrying with backoff.
 *
 * compose's `depends_on: service_healthy` waits for pg_isready, but that can
 * still flap during first-boot: the Postgres image runs a temporary socket-only
 * server while it initializes, so the TCP listener the app uses may not be up
 * yet when the container is marked healthy. Rather than crash on the first query
 * ("the database system is starting up" / ECONNREFUSED), wait it out.
 *
 * @throws if the DB is still unreachable after `retries` attempts.
 */
export const waitForDatabase = async ({
  retries = 30,
  delayMs = 1000,
}: { retries?: number; delayMs?: number } = {}): Promise<void> => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await sql`SELECT 1`;
      if (attempt > 1) console.log(`Database ready (after ${attempt} attempts).`);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === retries) {
        throw new Error(`Database not reachable after ${retries} attempts: ${msg}`);
      }
      console.warn(`Database not ready yet (attempt ${attempt}/${retries}): ${msg}. Retrying in ${delayMs}ms...`);
      await Bun.sleep(delayMs);
    }
  }
};

/**
 * Newest captures first. Both options are optional (`get_latest_archives()` is
 * valid); an omitted or blank contentType means "all types".
 *
 * Delegates to get_latest_responses() rather than filtering the latest_responses
 * view. Selecting from the view let the planner fold the filter into the join and
 * work backwards — scan all ~632k responses for text/html, probe records and uris
 * by PK ~291k times each, sort 291k rows — 4.1s and 2.3M buffer hits to return
 * 12 rows. The function walks records newest-first and stops at the limit.
 *
 * Matching is on content_types.base_type (plus a substring fallback), so
 * 'text/html' still matches 'text/html; charset=utf-8'.
 */
export const get_latest_archives = ({
  limit,
  contentType,
}: { limit?: number; contentType?: string } = {}) => {
  const ct = contentType?.trim() || null;
  return sql`
    SELECT * FROM get_latest_responses(${ct}::text, ${limit ?? 12}::int)
  `;
};

export const get_warc_file = (filepath: string) =>
  sql`SELECT * FROM warc_files WHERE file_path = ${filepath}`;

export const insert_warc_files = (files: WarcFile[]) =>
  sql`
    INSERT INTO warc_files
    ${sql(files)}
    ON CONFLICT (file_path) DO UPDATE
      SET file_path = EXCLUDED.file_path
    RETURNING *
  `.catch((e) => console.error("insert_warc_files", files, e));

// parameterized get (avoid sql.unsafe)
export const get_warc_ip = (ip: string) =>
  sql`
    SELECT *
    FROM ips
    WHERE ip = inet ${ip}
  `.catch((e) => console.error("get_warc_ip", ip, e));

export const insert_warc_ip = (ip: WarcIp) =>
  sql`
    INSERT INTO ips
    ${sql(ip)}
    ON CONFLICT (ip) DO UPDATE
      SET ip = EXCLUDED.ip
    RETURNING *
  `.catch((e) => console.error("insert_warc_ip", ip, e));

export const get_warc_uri = (uri: string) =>
  sql`
    SELECT *
    FROM uris
    WHERE uri = ${uri}
  `.catch((e) => console.error("get_warc_uri", uri, e));

export const insert_warc_uri = (uri: WarcUri) =>
  sql`
      INSERT INTO uris
      ${sql(uri)}
      ON CONFLICT (uri) DO UPDATE
        SET uri = EXCLUDED.uri
      RETURNING *
    `.catch((e) => {
    console.error("insert_warc_uri", uri, e);
    throw e;
  });

export const get_warc_payload = (
  file_id: number,
  byte_offset: number,
  bytes_length: number
) =>
  sql`
    SELECT *
    FROM payloads
    WHERE file_id = ${file_id}
      AND byte_offset = ${byte_offset}
      AND byte_length = ${bytes_length}
  `.catch((e) =>
    console.error("get_warc_payload", file_id, byte_offset, bytes_length, e)
  );

export const insert_warc_payload = (payload: WarcPayload) =>
  sql`
    INSERT INTO payloads
    ${sql(payload)}
    ON CONFLICT (file_id, byte_offset, byte_length) DO UPDATE
      SET file_id = EXCLUDED.file_id,
          byte_offset = EXCLUDED.byte_offset,
          byte_length = EXCLUDED.byte_length
    RETURNING *
  `.catch((e) => console.error("insert_warc_payload", payload, e));

export const get_warc_record = (
  file_id: number,
  warc_record_id: string,
  record_type: string,
  archived_date: Date,
  uri_id: number,
  ip_id: number,
  payload_id: number
) =>
  sql`
    SELECT * FROM records WHERE
      warc_file_id = ${file_id} AND
      warc_record_id = ${warc_record_id} AND
      record_type = ${record_type} AND
      archived_date = ${archived_date} AND
      uri_id = ${uri_id} AND
      ip_id = ${ip_id} AND
      payload_id = ${payload_id}
  `;

export const insert_warc_record = (record: WarcRecordEntry) =>
  sql`
    INSERT INTO records
    ${sql(record)}
    ON CONFLICT (warc_custom_id) DO UPDATE
      SET warc_custom_id = EXCLUDED.warc_custom_id
    RETURNING *
  `.catch((e) => console.error("insert_warc_record", record, e));

// Upsert request (requests.record_id is UNIQUE => conflict target is record_id)
export const insert_warc_request = (request: WarcRequestEntry) =>
  sql`
    INSERT INTO requests
    ${sql(request)}
    ON CONFLICT (record_id) DO UPDATE
      SET method       = EXCLUDED.method,
          http_version = EXCLUDED.http_version,
          headers      = EXCLUDED.headers
    RETURNING *
  `.catch((e) => console.error("insert_warc_request", request, e));

// Upsert response (responses.record_id is UNIQUE => conflict target is record_id)
export const insert_warc_response = (response: WarcResponseEntry) =>
  sql`
    INSERT INTO responses
    ${sql(response)}
    ON CONFLICT (record_id) DO UPDATE
      SET http_version   = EXCLUDED.record_id
    RETURNING *
  `.catch((e) => console.error("insert_warc_response", response, e));


export const insert_warc_content_type = (contentType: WarcContentType) =>
  sql`
      INSERT INTO content_types
      ${sql(contentType)}
      ON CONFLICT (type) DO UPDATE
        SET type = EXCLUDED.type
      RETURNING *
    `.catch((e) => console.error("insert_content_type", contentType, e));

// Recursion level of a URL = number of path segments after the host (0 = homepage).
// The regex approach we settled on: detect a scheme, else assume https://, then
// count non-empty pathname segments. Guarded so a malformed URI can never throw
// and break ingestion (falls back to 0 = treated as top level).
export function recursionLevel(value: string): number {
  try {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
      ? new URL(value)
      : new URL(`https://${value}`);
    return (url.pathname.match(/[^/]+/g) ?? []).length;
  } catch {
    return 0;
  }
}

export const insert_warc_response_full = (response: WarcInsertResponseFull) => 
  sql`
    SELECT insert_warc_response_full(
      ${response.warc_custom_id},
      ${response.warc_record_id ?? null},
      ${response.warc_archived_date},
      ${response.file_path},
      ${response.ip}::INET,
      ${response.uri},
      ${response.http_content_type ?? null},
      ${response.http_headers ? JSON.stringify(response.http_headers) : '{}'}::jsonb,
      ${response.http_status ?? null},
      ${response.http_last_modified ?? null},
      ${response.payload_byte_offset ?? null},
      ${response.payload_byte_length ?? null},
      ${response.payload_chunks?.length ? `{${response.payload_chunks.join(',')}}` : null}::bigint[],
      ${response.payload_digest ?? null},
      ${recursionLevel(response.uri)}
    ) AS id;
  `;

export function formatWarcComposite(item: WarcResponseBulkInput): string {
  // Safe helper to handle text fields, escaping for PG composite-literal parsing.
  //
  // ORDER MATTERS: backslashes must be doubled BEFORE quotes are escaped.
  // Inside a composite literal, `\` escapes the next character, so a value
  // containing `\"` (which every JSON.stringify'd header with an embedded quote
  // contains) would otherwise emit `\\"` -> parsed as a literal backslash
  // followed by an END-OF-FIELD quote. The field is truncated mid-JSON and
  // Postgres rejects it with `invalid input syntax for type json`.
  //
  // Escaping quotes first and backslashes second would be equally wrong: it
  // would double the backslashes this step just introduced.
  //
  // An unquoted empty string is how a composite literal spells NULL, which is
  // what we want for null/undefined. Note Array#join() also renders null as
  // "", so the unquoted numeric/timestamp fields below become NULL too.
  const escapeText = (val: string | null | undefined) => {
    if (val === null || val === undefined) return '';
    return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  };

  // Convert number arrays into PG array text syntax: {1,2,3}
  const chunksStr = item.payload_chunks && item.payload_chunks.length > 0
    ? `"{${item.payload_chunks.join(',')}}"`
    : `"{}"`;

  // Safely stringify JSON and escape it for the text tuple boundary
  const headersStr = escapeText(JSON.stringify(item.http_headers));

  // Order must perfectly match your CREATE TYPE declaration order
  const fields = [
    escapeText(item.warc_custom_id),
    item.warc_record_id,
    item.warc_archived_date,
    escapeText(item.file_path),
    item.ip,
    escapeText(item.uri),
    escapeText(item.http_content_type),
    headersStr,
    item.http_status,
    item.http_last_modified ? item.http_last_modified : '',
    item.payload_byte_offset,
    item.payload_byte_length,
    chunksStr,
    escapeText(item.payload_digest),
    item.recursion_level
  ];

  return `(${fields.join(',')})`;
}

export const insert_warc_response_bulk = (responses: WarcResponseBulkInput[]|string[]) => {
  const tuples = (typeof responses[0] === 'string')
    ? (responses as string[])
    : (responses as WarcResponseBulkInput[]).map(formatWarcComposite);

    return  sql`SELECT insert_warc_responses_full(
      ${sql.array(tuples, 'text')}::warc_response_bulk_input[]
    )`;
}

/**
 * When the second strategy joins in, if the first has not finished.
 *
 * NOT a cutoff. The first strategy keeps running; this only decides when it
 * stops being the only one running. See the note above get_warc_search_responses
 * for why that distinction is the whole fix.
 */
const SEARCH_HEDGE_AFTER_MS = 250;

/**
 * Hard ceiling on EITHER strategy, enforced by Postgres.
 *
 * The number that matters is the frontend's, not this one: lib/db.tsx aborts at
 * BACKEND_TIMEOUT_MS and stops reading. Anything still running past that point is
 * work for a reader who is already looking at an error panel — and on this box it
 * also evicts the shared_buffers their retry needs. So the ceiling is derived from
 * the client's patience, and the assertion below makes the two impossible to drift
 * apart silently. That drift is exactly what produced the outage this replaces.
 */
const SEARCH_CEILING_MS = 7_000;

/** Must match BACKEND_TIMEOUT_MS in frontend/lib/db.tsx. */
const FRONTEND_ABORT_MS = 10_000;

/**
 * Measured, not guessed: page 1 of "kiwifarms.net" is 112 ms of SQL but 260-520 ms
 * end-to-end over WireGuard + Bun + JSON + nginx. 1 s is that with headroom.
 */
const NON_SQL_OVERHEAD_MS = 1_000;

if (SEARCH_CEILING_MS + NON_SQL_OVERHEAD_MS >= FRONTEND_ABORT_MS) {
  throw new Error(
    `search budget is impossible: a query may run ${SEARCH_CEILING_MS}ms plus ~${NON_SQL_OVERHEAD_MS}ms `
    + `of transport, but the frontend gives up at ${FRONTEND_ABORT_MS}ms. Lower SEARCH_CEILING_MS or `
    + `raise BACKEND_TIMEOUT_MS in frontend/lib/db.tsx — they are one budget in two files.`,
  );
}

type SearchStrategy = "ordered" | "broad";

const OTHER: Record<SearchStrategy, SearchStrategy> = { ordered: "broad", broad: "ordered" };

/**
 * Which strategy won last time, per query.
 *
 * The race below costs one extra database query the first time a search is slow.
 * This is what stops it costing that on every later repeat: once a query has a
 * winner, it runs that one alone. The TTL is what stops the answer being frozen —
 * the previous design's whole failure was a decision made once, in 2026-08, that
 * was still being applied after the corpus grew 58%.
 */
const strategyMemo = new Map<string, { winner: SearchStrategy; at: number }>();

/** How long a remembered winner is trusted before the race is re-run. */
const STRATEGY_MEMO_TTL_MS = 10 * 60_000;

/** Bounded so a flood of distinct queries cannot grow this without limit. */
const STRATEGY_MEMO_MAX = 500;

/**
 * A search term as TEXT rather than as a LIKE pattern.
 *
 * Every search function builds `uri ILIKE ('%' || p_query || '%')`, with no
 * ESCAPE clause, so `%` and `_` in the term were pattern metacharacters and not
 * characters. Two ways that was visibly wrong on this corpus:
 *
 *   kiwifarms_st   110 matches, because `_` matches any single character
 *   kiwifarms.st   101 matches, which is the answer the reader wanted
 *   100%           296,048 matches — the entire uris table — because the
 *                  pattern became `%100%%` and the trailing `%` matched anything
 *   100\%            3,037 matches, the urls that really do contain "100%"
 *
 * Backslash is Postgres' default LIKE escape character, so escaping here needs
 * no change to any function: the escapes travel inside a bind parameter and
 * `\%` in the assembled pattern already means a literal percent sign. Requires
 * standard_conforming_strings, which is on (checked on the running server) and
 * has been the default since 9.1 — and does not apply to bind parameters at all.
 *
 * Measured on the live database: the trigram index is still chosen
 * (`Bitmap Index Scan on idx_uris_trgm` with `Index Cond: uri ~~* '%kiwifarms\_st%'`)
 * and the escaped query is FASTER, because it stops matching most of the table
 * — 880 ms against 4,015 ms for the unescaped form.
 *
 * All three metacharacters in one pass, so there is no order-of-replacement
 * hazard: escaping `%` first and then `\` would double-escape its own output.
 *
 * NOT applied to p_content_type. That parameter is compared two ways —
 * `ct.base_type = content_type_base(p_content_type)` as well as an ILIKE — and
 * escaping it would break the equality. Real content types contain none of
 * these characters, and the frontend validates the value against the list of
 * types the corpus actually holds before sending it.
 */
const likeLiteral = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/*
 * Two strategies, because neither wins everywhere.
 *
 * search_responses() walks idx_uris_recursion_level_uri in the order the query
 * already wants and stops at the limit. search_responses_broad() materialises
 * every match first, then sorts. Measured on this corpus:
 *
 *   query        ordered      broad       matching uris
 *   kiwifarms      33 ms   10,637 ms      1,690,388
 *   neocities      11 ms      120 ms        105,462
 *   tumblr         21 ms      193 ms         66,593
 *   onionfarms  1,415 ms      180 ms        122,263
 *
 * The tempting fix is to pick by match count — and it does not work. neocities
 * (105k) is 11 ms ordered while onionfarms (122k) is 1,415 ms, near-identical
 * counts either side of a 100x difference. What actually decides it is how far
 * into the (recursion_level, uri) ordering the first N matches sit, which is a
 * property of the data that no cheap estimate exposes and the planner itself
 * gets wrong (it assumes matches are spread evenly; they are not).
 *
 * So: don't predict, measure.
 *
 * ## How that went wrong, and what replaced it
 *
 * The first version of "measure" was: run ordered under a 300 ms
 * statement_timeout, and on cancellation run broad. That is not a measurement,
 * it is a PREDICTION dressed as one — it bets that anything slower than 300 ms
 * is a query broad will win. The bet was true in 2026-08 and false by 2026-09,
 * and nothing announced the change. Re-measured on the same box, corpus grown
 * 10.6M -> 16.7M uris (median of 3, ms):
 *
 *   query           offset    ordered      broad    winner
 *   onionfarms           0      2,188        228    broad, by 9.6x
 *   onionfarms         320      2,491        235    broad
 *   neocities            0          8        123    ordered
 *   tumblr               0         10        329    ordered
 *   kiwifarms          320        688     17,883    ordered, by 26x
 *   kiwifarms.net      320      1,333     18,496    ordered, by 14x
 *
 * Both halves moved. onionfarms still wants broad — so deleting broad, which is
 * the obvious reading of "the fallback is inverted", would make it 10x slower.
 * But kiwifarms.net now costs 1,333 ms on the ordered path at depth, which trips
 * a 300 ms tripwire, so the fallback fired and substituted an 18-second query for
 * a 1.3-second one. The frontend gave up at 10 s and the reader was told their
 * search "was not run". It had run, twice.
 *
 * There is no single threshold that serves both. onionfarms wants to abandon the
 * ordered path EARLY (300 ms is right for it); kiwifarms.net wants to never
 * abandon it at all. A constant cannot be both, which is why this no longer uses
 * one.
 *
 * ## What it does instead: hedge, then remember
 *
 * Start ordered. If it has not finished in SEARCH_HEDGE_AFTER_MS, start broad
 * ALONGSIDE it rather than instead of it, and take whichever finishes first.
 * Neither is cancelled on suspicion; the loser is bounded by SEARCH_CEILING_MS.
 *
 *   onionfarms    -> ordered still running at 250 ms, broad joins, broad returns
 *                    at ~480 ms total. Same as the old fallback, by luck.
 *   kiwifarms.net -> ordered still running at 250 ms, broad joins, ORDERED
 *                    returns at 1,333 ms and wins. Previously: 18 s and a panel.
 *
 * The winner is remembered per query for STRATEGY_MEMO_TTL_MS, so the extra query
 * is paid once per query per ten minutes, not on every request. And because the
 * memo expires, the answer is re-derived as the corpus changes instead of being
 * frozen into a constant that some later reader has to discover is stale.
 *
 * Verified before shipping: both functions return byte-identical rows for the
 * same (query, offset, limit, content_type) — checked across kiwifarms.net,
 * onionfarms, neocities and tumblr at offsets 0/64/160/320. Racing two strategies
 * that disagreed would make results flicker between page loads.
 */
/**
 * One strategy, under the ceiling.
 *
 * SET LOCAL, so it must be in a transaction — it reverts on commit and cannot
 * leak the timeout onto a pooled connection's next user. A plain SET here would
 * eventually apply the ceiling to the parser's bulk inserts.
 *
 * .unsafe() for the SET, and it has to be: SET takes a LITERAL, not a bind
 * parameter — a tagged template sends `SET LOCAL statement_timeout = $1` and
 * Postgres answers `syntax error at or near "$1"`. The value is a module
 * constant, never user input, so interpolating it is not an injection surface.
 */
/**
 * Stop a query that nobody is waiting for any more.
 *
 * Bun's own `Query.cancel()` looks like the answer and is not: measured against
 * this database, it flips `.cancelled` to true, sends Postgres nothing, lets the
 * backend run the full 20 seconds, and then RESOLVES the promise. The only thing
 * that actually cancels is pg_cancel_backend from a DIFFERENT connection, which
 * rejected the target 5 ms after being issued.
 *
 * Best-effort by construction. The pid may already be gone, the pool may be
 * busy, the query may have finished a microsecond ago — none of which is worth
 * surfacing, because the caller already has its answer and this is pure cleanup.
 *
 * Note what this raises in the cancelled query: SQLSTATE 57014, exactly the same
 * code as statement_timeout, differing only in message text ("canceling
 * statement due to user request" vs "...due to statement timeout"). The old
 * fallback dispatched on 57014, so wiring this in then would have made every
 * cancellation trigger the 19-second broad query. That dispatch is gone; if
 * anything ever reintroduces one, it has to compare the MESSAGE, not the code.
 */
const cancelBackend = (pid: number): void => {
  sql`SELECT pg_cancel_backend(${pid})`.catch(() => {});
};

/**
 * The backend pid out of a folded `SET ...; SELECT pg_backend_pid()` result.
 *
 * A multi-statement `.unsafe()` goes over the simple query protocol and comes
 * back as one array per statement — `[[], [{ pid }]]` — so the pid is not at a
 * fixed index if the statement list ever changes. Searched for instead.
 */
const pidFrom = (result: unknown): number | null => {
  for (const set of Array.isArray(result) ? result : []) {
    for (const row of Array.isArray(set) ? set : []) {
      const pid = Number((row as any)?.pid);

      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  }

  return null;
};

const runSearchStrategy = (
  strategy: SearchStrategy,
  p_pattern: string,
  p_offset: number,
  p_limit_count: number,
  p_content_type: string | null,
  onPid?: (pid: number) => void,
): Promise<any> =>
  sql.begin((tx: typeof sql) =>
    /*
     * The pid rides along with the timeout rather than costing its own round
     * trip. Measured against this database: SET alone 13.58 ms/op, SET plus a
     * separate `SELECT pg_backend_pid()` 18.62 ms/op, both folded into one
     * statement 14.05 ms/op. So knowing which backend to cancel costs 0.47 ms,
     * not 5 ms — and it has to be learned on THIS connection, because that is
     * the one running the query.
     */
    tx
      .unsafe(
        `SET LOCAL statement_timeout = ${Number(SEARCH_CEILING_MS)}; SELECT pg_backend_pid() AS pid`,
      )
      .then((head: unknown) => {
        const pid = pidFrom(head);

        if (pid !== null) onPid?.(pid);
      })
      .then(() =>
        strategy === "ordered"
          ? tx`SELECT * FROM search_responses(${p_pattern}, ${p_offset}, ${p_limit_count}, ${p_content_type})`
          : tx`SELECT * FROM search_responses_broad(${p_pattern}, ${p_offset}, ${p_limit_count}, ${p_content_type})`,
      ),
  );

const rememberWinner = (key: string, winner: SearchStrategy): void => {
  // Cheapest possible bound: when full, start over. The memo is an optimisation,
  // so losing it costs one hedged query per key, never a wrong answer.
  if (strategyMemo.size >= STRATEGY_MEMO_MAX) strategyMemo.clear();

  strategyMemo.set(key, { winner, at: Date.now() });
};

export const get_warc_search_responses = (
  p_query: string,
  p_offset: number = 0,
  p_limit_count: number = 100,
  p_content_type: string | null = null,
  /*
   * The request's own signal, so a reader who navigates away or hits stop takes
   * their query with them.
   *
   * Bun's serve() gives every handler `req.signal` and it fires within a
   * millisecond of the client disconnecting — but it does NOT cancel the
   * handler, and nothing downstream of it notices. Measured before this: the
   * handler ran its full duration and only observed `aborted === true` at the
   * end, having held a connection and evicted shared_buffers for a page nobody
   * was going to read.
   *
   * Optional, so every existing caller is unaffected.
   */
  signal?: AbortSignal,
): Promise<any> => {
  // Escaped ONCE, up here, so both strategies and the count below all ask exactly
  // the same question. Escaping at each call site is how the rows and the total
  // silently come to disagree.
  const p_pattern = likeLiteral(p_query);

  /*
   * Every backend pid this call has put to work, so any of them can be stopped.
   *
   * Two things stop a query here: the hedge finishing (the loser is now doing
   * work for an answer we already have) and the reader leaving. Both need the
   * pid, and the pid is only knowable from inside the connection running the
   * query — hence the callback rather than a return value.
   */
  const pids = new Map<SearchStrategy, number>();
  let winner: SearchStrategy | null = null;
  let abandoned = false;

  const stop = (strategy: SearchStrategy) => {
    const pid = pids.get(strategy);

    if (pid !== undefined) cancelBackend(pid);
  };

  const run = (strategy: SearchStrategy) =>
    runSearchStrategy(strategy, p_pattern, p_offset, p_limit_count, p_content_type, (pid) => {
      pids.set(strategy, pid);

      /*
       * The pid can arrive AFTER the outcome is already decided — the loser's
       * first round trip races the winner's whole query. Checked on arrival as
       * well as on decision, so a late pid is not a query left running to the
       * ceiling unattended.
       */
      if (abandoned || (winner !== null && strategy !== winner)) cancelBackend(pid);
    });

  if (signal) {
    if (signal.aborted) abandoned = true;
    else
      signal.addEventListener(
        "abort",
        () => {
          abandoned = true;
          for (const pid of pids.values()) cancelBackend(pid);
        },
        { once: true },
      );
  }

  /*
   * Keyed on the pattern and the filter, NOT on the offset.
   *
   * Measured: the winner is stable across depth — onionfarms prefers broad at
   * offsets 0, 64 and 320 alike, and kiwifarms.net prefers ordered at all three.
   * Which strategy suits a query is a property of where its matches sit in the
   * (recursion_level, uri) ordering, and that does not change with the page.
   */
  const memoKey = `${p_pattern}\u0000${p_content_type ?? ""}`;
  const remembered = strategyMemo.get(memoKey);

  if (remembered && Date.now() - remembered.at < STRATEGY_MEMO_TTL_MS) {
    return run(remembered.winner).catch((error: any) => {
      /*
       * The remembered winner failed — most likely it hit the ceiling because the
       * data moved under it. Forget it and try the other one rather than handing
       * the reader an error on the strength of a stale note.
       */
      strategyMemo.delete(memoKey);
      console.warn(
        `search: remembered "${remembered.winner}" strategy failed for ${JSON.stringify(p_query)} `
        + `(${error?.message ?? error}); trying "${OTHER[remembered.winner]}"`,
      );

      return run(OTHER[remembered.winner]);
    });
  }

  let decided = false;

  const win = (won: SearchStrategy) => {
    if (decided) return;
    decided = true;
    winner = won;
    rememberWinner(memoKey, won);

    // The other strategy is now computing an answer we already have.
    stop(OTHER[won]);
  };

  const ordered = run("ordered").then((rows) => {
    win("ordered");
    return rows;
  });

  /*
   * The hedge. It exists only while the ordered path is still running: if that
   * has already settled when the timer fires, this never starts a second query
   * and never settles, and Promise.any takes the ordered result.
   */
  const hedged = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (decided) return;

      console.info(
        `search: hedging ${JSON.stringify(p_query)} at offset ${p_offset} — `
        + `ordered still running after ${SEARCH_HEDGE_AFTER_MS}ms, starting broad alongside it`,
      );

      run("broad").then((rows) => {
        win("broad");
        resolve(rows);
      }, reject);
    }, SEARCH_HEDGE_AFTER_MS);

    // Never hold the process open for a hedge nobody is waiting on.
    (timer as any).unref?.();
    // Settled either way, the hedge is moot.
    ordered.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  });

  /*
   * Promise.any, so the first SUCCESS wins and a single failure does not sink the
   * request. If both fail it throws an AggregateError, whose message is useless in
   * a log — so it is unwrapped to the ordered path's error, which is the one that
   * describes what the reader actually asked for.
   */
  return Promise.any([ordered, hedged]).catch((error: any) => {
    const first = error?.errors?.[0] ?? error;

    console.error(
      `search: both strategies failed for ${JSON.stringify(p_query)} at offset ${p_offset}:`,
      first?.message ?? first,
    );

    throw first;
  });
};

/**
 * A page identified by where the previous one ENDED, rather than by how many
 * rows to skip.
 *
 * This is the same result set as get_warc_search_responses, reached the cheap
 * way. OFFSET makes Postgres walk the whole ordered prefix and throw it away —
 * to produce 336 matches for "kiwifarms.net" it applies the ILIKE to 1,078,036
 * index entries and discards them, every page, from the beginning. A seek starts
 * the index scan at the cursor instead. Measured, rows verified identical:
 *
 *   query           page     OFFSET      SEEK   speedup
 *   kiwifarms.net     21    1,361 ms     28 ms      49x
 *   kiwifarms.net    101    1,444 ms      8 ms     183x
 *   onionfarms        21    2,517 ms     11 ms     227x
 *   neocities          3       11 ms     12 ms       1x   (already fast)
 *
 * onionfarms is the interesting row: the seek path beats it by 227x, which is
 * more than the broad strategy ever won by. Where a cursor is available there is
 * nothing left for the hedge above to decide, so this path does not use it.
 *
 * A NULL cursor means "from the beginning" and is exactly page 1 — verified
 * identical to offset 0, so callers need no special case.
 *
 * Returns recursion_level alongside the row, because that plus `uri` IS the
 * cursor for the next page and the caller cannot construct it otherwise.
 *
 * NOT used when a content-type filter is set: that path plans as a BitmapAnd
 * over idx_uris_trgm and idx_uris_content_type_ids rather than walking
 * idx_uris_recursion_level_uri, so the seek predicate does not apply to it. See
 * db/migrate_search_seek.sql.
 */
export const get_warc_search_responses_after = (
  p_query: string,
  p_after_level: number | null,
  p_after_uri: string | null,
  p_limit_count: number = 16,
): Promise<any> =>
  sql.begin((tx: typeof sql) =>
    tx
      .unsafe(`SET LOCAL statement_timeout = ${Number(SEARCH_CEILING_MS)}`)
      .then(
        () => tx`
          SELECT *
          FROM search_responses_after(
            ${likeLiteral(p_query)}, ${p_after_level}, ${p_after_uri}, ${p_limit_count}
          )
        `,
      ),
  );

/**
 * The sort position of one uri, for building a cursor.
 *
 * The seek function returns recursion_level with each row; the OFFSET function
 * does not, and changing its return type would mean dropping and recreating a
 * function the site depends on. Since a page's cursor is just its LAST uri's
 * position, one lookup on uris_uri_key (a unique btree) is enough and costs well
 * under a millisecond — cheaper than the migration it avoids.
 */
export const get_uri_sort_position = (uri: string): Promise<any> =>
  sql`SELECT recursion_level FROM uris WHERE uri = ${uri} LIMIT 1`;

/**
 * The point at which the count stops counting.
 *
 * `search_responses_count` used to run an exact `COUNT(*)` over every matching
 * URI. For a term as common as "kiwifarms" — 1,690,388 of the corpus's 10.6M
 * URIs, 16% of everything held — that is a 10.5 second full scan, and it was
 * the ENTIRE remaining cost of the query once the ordered-scan work landed:
 * the rows themselves came back in 63ms and then the page sat waiting on a
 * number.
 *
 * Counting to 10,001 instead answers the only question the number is actually
 * asked: "more than a screenful, and roughly how many?" 10.5s -> 75ms, a 140x
 * cut, and the value is still exact for every query under the cap (which is
 * nearly all of them — "myspace" reports its true 2,409).
 *
 * MUST stay in sync with the LIMIT inside the deployed `search_responses_count`
 * function, and it is the reason `count_capped` is on the wire: a client that
 * gets 10001 needs to know it means "10,000+" and not "exactly 10,001".
 */
export const SEARCH_COUNT_CAP = 10_000;

export const get_warc_search_responses_count = (
  p_query: string,
  p_content_type: string | null = null
) =>
  sql`
    SELECT *
    FROM search_responses_count(${likeLiteral(p_query)}, ${p_content_type})
  `

// Distinct base content types currently stored ("text/html", "image/png", ...),
// A->Z. Derives the base from `type` on the fly (split before the first ';'), so
// it works whether or not content_types.base_type has been backfilled.
export const get_content_types = () =>
  sql`
    SELECT DISTINCT lower(btrim(split_part(type, ';', 1))) AS content_type
    FROM content_types
    WHERE type IS NOT NULL AND btrim(type) <> ''
    ORDER BY content_type
  ` as Promise<{ content_type: string }[]>

export const get_warc_record_payload = (warc_custom_id:string) => 
  sql`
  SELECT * FROM record_payloads WHERE warc_custom_id = ${warc_custom_id}
`

// Nearest record (payload) to `dateNear` for an exact URI. Same before/after
// probe as get_warc_response_payload_near; queries base tables so it can use
// idx_records_uri_archived_date_cover. Columns mirror the record_payloads view.
// (Currently unused by any route, but kept correct — the old version ordered by
// archived_date, which the record_payloads view doesn't even expose.)
export const get_warc_record_payload_near = (uri: string, dateNear: Date) =>
  sql`
    WITH u AS (
      SELECT id FROM uris WHERE uri = ${uri}
    ),
    candidates AS (
      (
        SELECT rec.id AS record_id
        FROM records rec
        JOIN u ON rec.uri_id = u.id
        WHERE rec.archived_date <= ${dateNear}
        ORDER BY rec.archived_date DESC
        LIMIT 1
      )
      UNION ALL
      (
        SELECT rec.id AS record_id
        FROM records rec
        JOIN u ON rec.uri_id = u.id
        WHERE rec.archived_date >= ${dateNear}
        ORDER BY rec.archived_date ASC
        LIMIT 1
      )
    )
    SELECT
      rec.id,
      rec.warc_custom_id,
      wf.file_path,
      pl.byte_offset,
      pl.byte_length,
      u2.uri
    FROM candidates c
    JOIN records rec        ON rec.id = c.record_id
    LEFT JOIN warc_files wf ON rec.warc_file_id = wf.id
    LEFT JOIN payloads pl   ON rec.payload_id = pl.id
    JOIN uris u2            ON rec.uri_id = u2.id
    ORDER BY abs(extract(epoch from rec.archived_date - ${dateNear}))
    LIMIT 1;
  `;

  export const get_warc_response_payload = (warc_custom_id:string) =>
    sql`
    SELECT * FROM response_payloads WHERE warc_custom_id = ${warc_custom_id}
  `

  /**
   * The same view, for many ids at once.
   *
   * One round trip rather than one per id, which matters for the download route
   * specifically: nothing can be written into a zip until every entry's length is
   * known, so N sequential lookups are N latencies sitting in front of the first
   * byte of the response.
   *
   * Rows come back in whatever order the planner produced. The caller matches
   * them by `warc_custom_id` rather than by position — there is no ORDER BY here
   * and adding one would sort by the wrong thing anyway, since the interesting
   * order is the one the request asked for.
   *
   * ## `IN ${sql([…])}`, not `= ANY(${array})`
   *
   * The first version used `= ANY(${warc_custom_ids})` and failed on every
   * request with:
   *
   *     malformed array literal: "warcs/5am.warc::https://…::88165991-…"
   *
   * `= ANY` wants a Postgres ARRAY, and handing Bun's tagged template a JS array
   * in that position does not produce one — the driver sends the element and the
   * server tries to parse an archived url as an array literal. `sql([…])` is the
   * documented helper for a value list: it expands to `IN ($1, $2, …)`, one bound
   * parameter per id, which is both correct and safe for ids containing `::`,
   * `?`, `&` and a full url.
   */
  export const get_warc_response_payloads = (warc_custom_ids: string[]) =>
    sql`
    SELECT * FROM response_payloads WHERE warc_custom_id IN ${sql(
      /*
       * A sentinel for the empty case, because `IN ()` is a syntax error.
       *
       * No warc_custom_id is the empty string — they are always
       * `<file>::<uri>::<uuid>` — so this matches nothing, which is the right
       * answer for "none requested". Guarding here rather than trusting callers:
       * the alternative is a query that works for every input except one and
       * fails as a syntax error rather than an empty result.
       */
      warc_custom_ids.length > 0 ? warc_custom_ids : [""],
    )}
  `
  
  // Nearest capture to `dateNear` for an exact URI. Instead of scanning every
  // capture and sorting by abs(distance), probe the closest capture at/before the
  // date and the closest at/after it (each an indexed LIMIT 1 on
  // idx_records_uri_archived_date_cover), then compare only those 1-2 candidates.
  // Runs against base tables so the planner gets a clean index path; the selected
  // columns mirror the response_payloads view the caller expects.
  export const get_warc_response_payload_near = (uri: string, dateNear: Date) =>
    sql`
      WITH u AS (
        SELECT id FROM uris WHERE uri = ${uri}
      ),
      candidates AS (
        (
          SELECT rec.id AS record_id
          FROM records rec
          JOIN u ON rec.uri_id = u.id
          WHERE rec.archived_date <= ${dateNear}
          ORDER BY rec.archived_date DESC
          LIMIT 1
        )
        UNION ALL
        (
          SELECT rec.id AS record_id
          FROM records rec
          JOIN u ON rec.uri_id = u.id
          WHERE rec.archived_date >= ${dateNear}
          ORDER BY rec.archived_date ASC
          LIMIT 1
        )
      )
      SELECT
        resp.id,
        resp.record_id,
        rec.warc_custom_id,
        wf.file_path,
        pl.byte_offset,
        pl.byte_length,
        pl.chunks,
        -- Needed by the download route's recursive mode: two captures with the
        -- same digest are the same bytes, which is how http:// and https:// of one
        -- page become a single zip entry instead of two identical copies. Absent
        -- from this list, the merge silently never fires.
        pl.payload_digest,
        resp.status,
        resp.http_version,
        resp.headers,
        ct.type       AS content_type,
        u2.uri,
        rec.archived_date
      FROM candidates c
      JOIN records rec        ON rec.id = c.record_id
      JOIN responses resp     ON resp.record_id = rec.id
      LEFT JOIN warc_files wf ON rec.warc_file_id = wf.id
      LEFT JOIN payloads pl   ON rec.payload_id = pl.id
      LEFT JOIN content_types ct ON resp.content_type_id = ct.id
      JOIN uris u2            ON rec.uri_id = u2.id
      ORDER BY abs(extract(epoch from rec.archived_date - ${dateNear}))
      LIMIT 1;
    `;
  


  
  // Nearest response to `dateNear` for an exact URI (used by near.tsx). Rewritten
  // from ORDER BY abs(...) over all captures to before/after indexed probes.
  // Output columns are unchanged: responses.* plus record/uri fields.
  export const get_response_by_uri = (uri: string, dateNear: Date) =>
    sql`
      WITH u AS (
        SELECT id FROM uris WHERE uri = ${uri}
      ),
      candidates AS (
        (
          SELECT rec.id AS record_id
          FROM records rec
          JOIN u ON rec.uri_id = u.id
          WHERE rec.archived_date <= ${dateNear}
          ORDER BY rec.archived_date DESC
          LIMIT 1
        )
        UNION ALL
        (
          SELECT rec.id AS record_id
          FROM records rec
          JOIN u ON rec.uri_id = u.id
          WHERE rec.archived_date >= ${dateNear}
          ORDER BY rec.archived_date ASC
          LIMIT 1
        )
      )
      SELECT
        r.*,                  -- all columns from responses
        rec.warc_custom_id,   -- warc_custom_id from records
        rec.archived_date,    -- record date
        rec.record_type,
        rec.ip_id,
        rec.payload_id,
        u2.uri AS full_uri    -- full URI from uris table
      FROM candidates c
      JOIN records rec ON rec.id = c.record_id
      JOIN responses r ON r.record_id = rec.id
      JOIN uris u2 ON u2.id = rec.uri_id
      ORDER BY abs(extract(epoch from rec.archived_date - ${dateNear}))  -- nearest of the 1-2 candidates
      LIMIT 1;
    `;
  
    

/** 
 * Call the Postgres get_site_responses(p_uri, p_warc_custom_id) function.
 * Both args are optional; pass null/undefined to ignore a filter.
 */
export const get_site_responses = (
  p_uri?: string | null,
  p_warc_custom_id?: string | null
) =>
  sql`
    SELECT *
    FROM get_site_responses(${p_uri ?? null}, ${p_warc_custom_id ?? null})
  `

/**
 * Full capture history for an exact URL, newest first. Reads the response_history
 * view. Returns an empty array when the URL has no captures.
 */
export const get_url_history = (uri: string) =>
  sql`
    SELECT *
    FROM response_history
    WHERE uri = ${uri}
    ORDER BY archived_date DESC
  ` as Promise<WarcHistoryRow[]>

/**
 * Full detail for a single capture by warc_custom_id: the record's response
 * fields plus its associated request fields. The request is linked either via
 * WARC-Concurrent-To (responses.concurrent_to -> requests.id) or by sharing the
 * record (requests.record_id), whichever is present. Returns [] if the id is
 * unknown. Redirect chain (when the response is a 3xx) is fetched separately by
 * the route via get_redirect_path.
 */
export const get_record_detail = (warc_custom_id: string) =>
  sql`
    SELECT
      rec.warc_custom_id,
      rec.record_type,
      rec.archived_date,
      u.uri,
      i.ip                                                AS ip,
      resp.id                                             AS response_id,
      resp.status                                         AS response_status,
      resp.http_version                                   AS response_http_version,
      resp.headers                                        AS response_headers,
      resp.last_modified                                  AS response_last_modified,
      ct.type                                             AS content_type,
      COALESCE(req_c.id, req_r.id)                        AS request_id,
      COALESCE(req_c.method, req_r.method)                AS request_method,
      COALESCE(req_c.http_version, req_r.http_version)    AS request_http_version,
      COALESCE(req_c.headers, req_r.headers)              AS request_headers
    FROM records rec
    LEFT JOIN responses resp     ON resp.record_id = rec.id
    LEFT JOIN requests req_c     ON req_c.id = resp.concurrent_to
    LEFT JOIN requests req_r     ON req_r.record_id = rec.id
    LEFT JOIN uris u             ON rec.uri_id = u.id
    LEFT JOIN ips i              ON rec.ip_id = i.id
    LEFT JOIN content_types ct   ON resp.content_type_id = ct.id
    WHERE rec.warc_custom_id = ${warc_custom_id}
    LIMIT 1
  ` as Promise<WarcRecordDetailRow[]>



export type RedirectHopRow = {
  id: number;
  record_id: number;
  warc_custom_id: string | null;
  file_path: string | null;
  byte_offset: number | null;
  byte_length: number | null;
  chunks: number[] | null;
  status: number | null;
  http_version: string | null;
  headers: Record<string, any> | null;
  content_type: string | null;
  uri: string | null;
  archived_date: string | null; // will be returned as text from bun client; parse to Date if needed
  hop: number;
  location_header: string | null;
  resolved_location: string | null;
};

/**
 * Follow redirect hops for a start uri or warc_custom_id.
 *
 * @param p_uri - exact URI to start from (optional if p_warc_custom_id provided)
 * @param p_date_archived - optional Date to pick the response closest to this date when starting by URI
 * @param p_warc_custom_id - optional warc_custom_id to start from (preferred if provided)
 * @param p_max_hops - optional max hops (default 20)
 * @returns Promise with array of rows returned by get_redirect_path
 */
export const get_redirect_path = (
  p_uri?: string | null,
  p_date_archived?: Date | string | null,
  p_warc_custom_id?: string | null,
  p_max_hops: number = 20
) =>
  sql`
    SELECT *
    FROM get_redirect_path(
      ${p_uri ?? null},
      ${p_date_archived ? (p_date_archived instanceof Date ? p_date_archived : new Date(p_date_archived)) : null},
      ${p_warc_custom_id ?? null},
      ${p_max_hops}
    )
  `.catch((e) =>
    console.error("get_redirect_path", { p_uri, p_date_archived, p_warc_custom_id, p_max_hops }, e)
  ) as Promise<RedirectHopRow[]>;
/* ---------------------------------------------------------------------------
 * Parse progress
 *
 * See the "Parse progress" section at the end of db/setup.sql for what a row
 * means and why the resume point is allowed to lag. The short version: every
 * insert on the write path is ON CONFLICT DO NOTHING, so resuming EARLY costs a
 * few re-parsed records and resuming LATE loses them silently. Everything here
 * biases early.
 * ------------------------------------------------------------------------ */

/**
 * Is the progress schema present?
 *
 * Asked on boot instead of creating it, because the only thing that CAN create
 * it is setup.sql and setup.sql is a wipe. A parser that quietly ran the init
 * script to fix a missing table would delete the archive to add a column, so it
 * reports the problem and names the command instead.
 */
export const progress_schema_ready = () =>
  sql`SELECT to_regclass('public.file_progress') IS NOT NULL AS ready`
    .then((rows: any) => rows?.[0]?.ready === true)
    .catch(() => false);

export type ParseStatus = "pending" | "parsing" | "parsed" | "error";

export interface ParsePlanRow {
  file_id: number | string;
  file_path: string;
  status: ParseStatus;
  byte_offset: number | string;
  file_size: number | string | null;
  records: number | string;
  error: string | null;
}

/** One row per known warc file, with wherever the last run got to. */
export const get_parse_plan = () =>
  sql`SELECT * FROM parse_plan` as unknown as Promise<ParsePlanRow[]>;

/** A progress row as reporting wants it: the plan, plus when it last moved. */
export interface ParseProgressRow extends ParsePlanRow {
  started_at: string | null;
  finished_at: string | null;
  updated_at: string | null;
}

/*
 * Deliberately NOT `SELECT * FROM parse_plan`.
 *
 * parse_plan is the PLANNER's view and is kept to exactly the columns
 * plan_parse_work reads, so that what the parser decides stays easy to reason
 * about. Reporting needs the timestamps as well — with 1,787 files under way
 * they are the only thing that separates a `parsing` row still advancing from
 * one whose worker died holding the row — and widening the planner's view to
 * serve an HTTP route would tie the two together for no reason.
 *
 * Same join, one more SELECT list. The duplication is the point.
 */
export const get_parse_progress = () =>
  sql`
    SELECT
      f.id                          AS file_id,
      f.file_path,
      COALESCE(p.status, 'pending') AS status,
      COALESCE(p.byte_offset, 0)    AS byte_offset,
      p.file_size,
      COALESCE(p.records, 0)        AS records,
      p.error,
      p.started_at,
      p.finished_at,
      p.updated_at
    FROM warc_files f
    LEFT JOIN file_progress p ON p.file_id = f.id
    ORDER BY f.file_path
  ` as unknown as Promise<ParseProgressRow[]>;

export const progress_start = (fileId: number, byteOffset: number, fileSize: number) =>
  sql`SELECT progress_start(${fileId}::bigint, ${byteOffset}::bigint, ${fileSize}::bigint)`;

export const progress_checkpoint = (fileId: number, byteOffset: number, records: number) =>
  sql`SELECT progress_checkpoint(${fileId}::bigint, ${byteOffset}::bigint, ${records}::bigint)`;

export const progress_finish = (
  fileId: number,
  byteOffset: number,
  records: number,
  error: string | null = null,
) =>
  sql`SELECT progress_finish(${fileId}::bigint, ${byteOffset}::bigint, ${records}::bigint, ${error})`;

/** What a planner decided to do with one file, and why. */
export interface ParseWork {
  fileId: number;
  filePath: string;
  /** Byte offset to hand mWarcDecode. Always a record boundary. */
  start: number;
  /** Records already counted for this file, so the totals do not restart. */
  records: number;
  /** Size on disk right now. */
  size: number;
  reason: "new" | "resume" | "grew" | "replaced" | "retry" | "done";
}

const numeric = (value: number | string | null | undefined): number => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};

/**
 * Decide, per file, whether to read it and from where.
 *
 * The five outcomes, and the reasoning behind each:
 *
 *   new       No progress row. Read from zero.
 *   resume    A run was interrupted — status is still 'parsing' because nothing
 *             marked it finished. This is the crash case and the ordinary
 *             restart case; they are indistinguishable and want the same answer.
 *   grew      Already 'parsed', but the file is BIGGER than when it was. WARCs
 *             are append-only, so the extra bytes are new records and the stored
 *             offset is still valid — read the tail.
 *   replaced  Already 'parsed', and the file is SMALLER. Append-only says that
 *             cannot happen to the same file, so this is a different file at the
 *             same path. Nothing about the old offset means anything now.
 *   retry     Previous attempt threw. Resume from the last good boundary rather
 *             than starting over, since everything before it is in the database.
 *   done      'parsed' and the same size. Skipped entirely — this is the case
 *             that makes a restart cheap.
 *
 * A file that has vanished from disk gets `size` 0 and is dropped by the caller;
 * this does not delete its rows, because a missing mount should not be able to
 * erase an archive.
 */
export const plan_parse_work = (
  rows: readonly ParsePlanRow[],
  sizeOf: (filePath: string) => number,
): ParseWork[] =>
  rows.map(row => {
    const fileId = numeric(row.file_id);
    const filePath = row.file_path;
    const size = sizeOf(filePath);
    const offset = numeric(row.byte_offset);
    const records = numeric(row.records);
    const previousSize = row.file_size === null ? null : numeric(row.file_size);

    const at = (start: number, reason: ParseWork["reason"]): ParseWork =>
      ({ fileId, filePath, start, records: start === 0 ? 0 : records, size, reason });

    if (row.status === "parsed") {
      if (previousSize !== null && size > previousSize) return at(offset, "grew");
      if (previousSize !== null && size < previousSize) return at(0, "replaced");
      return at(offset, "done");
    }

    if (row.status === "error") return at(offset, "retry");

    // 'parsing' with an offset is an interrupted run; 'parsing' at zero and
    // 'pending' are both "nothing banked yet", and all three resume the same way.
    if (row.status === "parsing" && offset > 0) return at(offset, "resume");

    return at(0, "new");
  });
