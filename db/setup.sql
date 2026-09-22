-- ############################################################################
-- ## DANGER: THIS FILE DOES NOT DESCRIBE PRODUCTION.                        ##
-- ############################################################################
--
-- Running this against the live database would be a regression, not a rebuild.
-- Three specific ways, all verified against the running server on 2026-09-16:
--
--   1. search_responses() below still holds the OLD four-case body whose CASE 1
--      is `uri_candidates AS MATERIALIZED (...)` — the trigram-then-sort shape.
--      That is the ~19-second plan. Production runs a different body that walks
--      idx_uris_recursion_level_uri and stops at the limit (112 ms on page 1).
--      Installing this file puts the slow plan under the fast function's name.
--
--   2. search_responses_count() below is an uncapped COUNT(*). Production stops
--      at 10000+1. The cap is what took that query from 10.5 s to 75 ms, and
--      backend/db.ts's SEARCH_COUNT_CAP is documented to match the deployed
--      LIMIT — it would silently stop matching.
--
--   3. search_responses_broad() is NOT DEFINED ANYWHERE IN THIS FILE, or in any
--      other .sql in this repo. backend/db.ts calls it. Installing this file
--      leaves that call pointing at a function that does not exist.
--
-- The deployed bodies are captured in db/DEPLOYED.recovered.sql (pg_get_functiondef
-- straight off the running server). Reconcile FROM that file, not from this one.
-- Until this warning is removed, treat `reset_database()` in backend/db.ts as
-- destructive to the search path as well as to the data.
--
-- ############################################################################

-- minimal_schema.sql
-- Minimal schema: no hashes, no triggers, no generated columns.
-- Only unique constraints and simple indexes for lookups.

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- optional, keep if you want trigram searches
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- optional, used only if you need digest functions later

-- -----------------------------------------------------------------------------
-- CLEANUP: drop views, functions, tables, and types (targeted, safe)
-- -----------------------------------------------------------------------------
BEGIN;

-- 1) Remove views first (they depend on tables)
DROP VIEW IF EXISTS latest_responses CASCADE;
DROP VIEW IF EXISTS response_payloads CASCADE;
DROP VIEW IF EXISTS record_payloads CASCADE;
DROP VIEW IF EXISTS response_history CASCADE;

-- 2) Remove functions (use exact arg types)
-- old signature (pre recursion_level) and the current one; drop both so re-runs
-- don't leave a stale overload behind. 
DROP FUNCTION IF EXISTS insert_warc_response_full(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, INET, TEXT, TEXT, JSONB, INT, TIMESTAMPTZ, BIGINT, BIGINT, BIGINT[], TEXT, INT
) CASCADE;

DROP FUNCTION IF EXISTS get_site_responses(
  TEXT,
  TEXT
) CASCADE;

DROP FUNCTION IF EXISTS search_responses(TEXT, BIGINT, BIGINT) CASCADE;
DROP FUNCTION IF EXISTS search_responses(TEXT, BIGINT, BIGINT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS search_responses_count(TEXT) CASCADE;
DROP FUNCTION IF EXISTS search_responses_count(TEXT, TEXT) CASCADE;

-- 3) Drop dependent tables (order mostly doesn't matter because of CASCADE on views/functions above)
DROP TABLE IF EXISTS file_progress CASCADE;
DROP TABLE IF EXISTS uri_content_types CASCADE;
DROP TABLE IF EXISTS responses CASCADE;
DROP TABLE IF EXISTS requests CASCADE;
DROP TABLE IF EXISTS records CASCADE;
DROP TABLE IF EXISTS payloads CASCADE;
DROP TABLE IF EXISTS warc_files CASCADE;
DROP TABLE IF EXISTS content_types CASCADE;
DROP TABLE IF EXISTS uris CASCADE;
DROP TABLE IF EXISTS ips CASCADE;

-- 4) Drop custom type(s)
DROP TYPE IF EXISTS parse_status CASCADE;
DROP TYPE IF EXISTS warc_record_type CASCADE;
DROP TYPE IF EXISTS warc_response_bulk_input CASCADE;

COMMIT;


----------------------------------------------------------------
-- types
---------------------------------------------------------------- 
CREATE TYPE warc_record_type AS ENUM (
      'request',
      'response',
      'warcinfo',
      'revisit',
      'metadata',
      'resource'
);  

CREATE TYPE warc_response_bulk_input AS (
    warc_custom_id        TEXT,
    warc_record_id        UUID,
    warc_archived_date    TIMESTAMPTZ,
    file_path             TEXT,
    ip                    INET,
    uri                   TEXT,
    http_content_type     TEXT,
    http_headers          JSONB,
    http_status           INT,
    http_last_modified    TIMESTAMPTZ,
    payload_byte_offset   BIGINT,
    payload_byte_length   BIGINT,
    payload_chunks        BIGINT[],
    payload_digest        TEXT,
    recursion_level       INT
);

----------------------------------------------------------------
-- content_types
----------------------------------------------------------------
CREATE TABLE  IF NOT EXISTS content_types (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL UNIQUE,
  -- Decomposed parts of `type` ("text/html; charset=utf-8"), filled by
  -- insert_warc_response_full via content_type_base()/content_type_charset() so
  -- results can be ordered/searched by base MIME type or charset independently.
  base_type TEXT,
  charset TEXT
);

----------------------------------------------------------------
-- uris
----------------------------------------------------------------
CREATE TABLE  IF NOT EXISTS uris (
  id BIGSERIAL PRIMARY KEY,
  uri TEXT NOT NULL UNIQUE,
  -- Number of path segments after the host (0 = homepage, e.g. example.com/).
  -- Computed in TypeScript via recursionLevel() and passed into
  -- insert_warc_response_full; used to order search/browse results
  -- homepages-first (shallowest), then alphabetically.
  recursion_level INT NOT NULL DEFAULT 0,

  -- Every content_types.id this URI has ever been captured as, denormalized here
  -- ON PURPOSE and maintained by insert_warc_responses_full.
  --
  -- It lives on `uris` rather than in a side table because that is the only way
  -- the two search predicates end up on the same relation:
  --
  --     uri ILIKE '%q%'                 -> idx_uris_trgm            (GIN)
  --     content_type_ids && ARRAY[...]  -> idx_uris_content_type_ids (GIN)
  --
  -- Postgres can BitmapAnd two GIN scans over one table, producing the
  -- qualifying URIs directly. Any design with the types in another table forces a
  -- probe PER CANDIDATE URI instead: a measured plan did 7,021 probes (records ->
  -- responses -> content_types) to return 100 rows, and those probes were 97.7%
  -- of the query's buffer traffic. Cheapening the probe doesn't help, because the
  -- ORDER BY is (recursion_level, uri) and GIN cannot return rows in order, so
  -- every candidate must be tested before a page can be chosen.
  --
  -- No FK: Postgres has no referential integrity for array elements. content_type
  -- rows are never deleted, and the search resolves ids from content_types on
  -- every call, so a stale id would simply never match.
  content_type_ids BIGINT[] NOT NULL DEFAULT '{}'
);

----------------------------------------------------------------
-- ips
----------------------------------------------------------------
CREATE TABLE  IF NOT EXISTS ips (
  id BIGSERIAL PRIMARY KEY,
  ip INET NOT NULL UNIQUE
);

----------------------------------------------------------------
-- warc_files
----------------------------------------------------------------
CREATE TABLE  IF NOT EXISTS warc_files (
  id BIGSERIAL PRIMARY KEY,
  warcinfo_id UUID UNIQUE,
  file_path TEXT NOT NULL UNIQUE,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

----------------------------------------------------------------
-- payloads
----------------------------------------------------------------
CREATE TABLE  IF NOT EXISTS payloads (
  id BIGSERIAL PRIMARY KEY,
  file_id BIGINT REFERENCES warc_files(id) ON DELETE SET NULL,
  chunks BIGINT[], 
  byte_offset BIGINT,
  byte_length BIGINT,
  payload_digest TEXT,
  UNIQUE (file_id, byte_offset, byte_length)
);

----------------------------------------------------------------
-- records
----------------------------------------------------------------
CREATE TABLE  IF NOT EXISTS records (
  id BIGSERIAL PRIMARY KEY,
  warc_file_id BIGINT REFERENCES warc_files(id) ON DELETE SET NULL,
  warc_record_id UUID,
  warc_custom_id TEXT UNIQUE NOT NULL,
  record_type warc_record_type NOT NULL,
  archived_date TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  uri_id BIGINT NOT NULL REFERENCES uris(id) ON DELETE SET NULL,
  ip_id BIGINT REFERENCES ips(id) ON DELETE SET NULL,
  payload_id BIGINT REFERENCES payloads(id) ON DELETE SET NULL,
  block_digest TEXT,
  payload_digest TEXT,
  is_truncated BOOLEAN DEFAULT FALSE
);

----------------------------------------------------------------
-- requests & responses
----------------------------------------------------------------
CREATE TABLE  IF NOT EXISTS requests (
  id BIGSERIAL PRIMARY KEY,
  record_id BIGINT NOT NULL UNIQUE REFERENCES records(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  http_version TEXT NOT NULL,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE  IF NOT EXISTS responses (
  id BIGSERIAL PRIMARY KEY,
  record_id BIGINT NOT NULL UNIQUE REFERENCES records(id) ON DELETE CASCADE,
  http_version TEXT NOT NULL,
  status INT NOT NULL,
  content_type_id BIGINT REFERENCES content_types(id),
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_modified TIMESTAMPTZ,
  concurrent_to BIGINT REFERENCES requests(id)
);

-----------------------------------------------------------------------------
---
-----------------------------------------------------------------------------

-- For URI search with leading wildcard
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_uris_trgm ON uris USING gin (uri gin_trgm_ops);

-- The other half of the filtered search. Together with idx_uris_trgm this lets
-- `uri ILIKE '%q%' AND content_type_ids && ARRAY[...]` resolve as a BitmapAnd of
-- two GIN scans on one table — qualifying URIs straight out, no per-candidate
-- probe. Overlap (&&) is the array_ops strategy GIN provides.
CREATE INDEX IF NOT EXISTS idx_uris_content_type_ids
ON uris USING gin (content_type_ids);

-- Orders search/browse results homepages-first (recursion_level ASC) then A->Z.
-- For empty queries (browse: ILIKE '%%' matches everything) the planner can walk
-- this btree in order instead of sorting the whole uris table on each page.
CREATE INDEX IF NOT EXISTS idx_uris_recursion_level_uri ON uris(recursion_level, uri);

-- Foreign keys for joins
CREATE INDEX idx_records_uri_id ON records(uri_id);
CREATE INDEX idx_records_ip_id ON records(ip_id);
CREATE INDEX idx_responses_content_type_id ON responses(content_type_id);

CREATE INDEX idx_records_uri_id_record_id ON records(uri_id, id);

-- Accelerates the /view "nearest capture to a date for a URI" lookup
-- (get_warc_response_payload_near): filter records by uri_id, probe archived_date
-- before/after the target, with the join columns covered so candidate selection
-- stays index-only. A btree on (uri_id, archived_date) scans both directions, so a
-- separate DESC index is unnecessary.
CREATE INDEX IF NOT EXISTS idx_records_uri_archived_date_cover
ON records(uri_id, archived_date)
INCLUDE (id, warc_custom_id, warc_file_id, payload_id);

-- Drives the global newest-first feed (get_latest_responses): walk backward and
-- stop after n instead of sorting every record. Only actually stops early if the
-- query is shaped to let it — see the two-phase function below, and note that the
-- old view-based feed did NOT (it sorted ~291k rows to return 12).
--
-- NOT extended to (archived_date DESC, id DESC) INCLUDE (uri_id, ip_id,
-- warc_custom_id), which would make phase 1 index-only, because: records is one
-- of the two tables ingest hammers, so a wider index is write amplification on
-- exactly the hot path, and during ingest the visibility map is dirty enough that
-- the scan would visit the heap anyway. Phase 1 touches ~n rows, so the heap
-- fetches it avoids number in the dozens. Revisit only if measurement says so.
CREATE INDEX IF NOT EXISTS idx_records_archived_date
ON records(archived_date DESC);
CREATE INDEX idx_responses_record_id_content_type_status
ON responses(record_id, content_type_id, status);

-- DROPPED: idx_responses_content_type_notnull, a partial duplicate of
-- idx_responses_content_type_id. It had 3 scans against that one's 135, and
-- `responses` is one of the two tables ingest hammers — every index on it is
-- write amplification on every inserted row, which is what leaves readers
-- flushing dirty buffers. The summary table now answers the content-type
-- question anyway.

-- Order/search content types by base MIME type and/or charset. The composite
-- covers base_type-only lookups (leftmost) and (base_type, charset) ordering,
-- and now genuinely gets used: the search filter matches on base_type.
CREATE INDEX IF NOT EXISTS idx_content_types_base_charset ON content_types(base_type, charset);

-- DROPPED: idx_content_types_charset — zero scans, and nothing searches by
-- charset alone. content_types is ~156 rows, so it bought no read speed either.

-----------------------------------------------------------------------------
---
-----------------------------------------------------------------------------
CREATE OR REPLACE VIEW record_payloads AS
SELECT
    rec.id,
    rec.warc_custom_id,
    wf.file_path,
    pl.byte_offset,
    pl.byte_length,
    u.uri                      
FROM records rec
LEFT JOIN warc_files wf
    ON rec.warc_file_id = wf.id
LEFT JOIN payloads pl
    ON rec.payload_id = pl.id
LEFT JOIN responses resp
    ON resp.record_id = rec.id
LEFT JOIN uris u
    ON rec.uri_id = u.id;

CREATE OR REPLACE VIEW response_payloads AS
SELECT
    resp.id,      -- base is response
    resp.record_id               AS record_id,        -- original record id
    rec.warc_custom_id,
    wf.file_path,
    pl.byte_offset,
    pl.byte_length,
    pl.chunks,
    -- Needed by the download route's recursive mode: two captures with the same
    -- digest are the same bytes, which is how http:// and https:// of one page
    -- become a single zip entry rather than two identical copies. Absent from this
    -- list the merge silently never fires, and the only symptom is a bigger
    -- archive than it should be.
    pl.payload_digest,
    resp.status,
    resp.http_version,
    resp.headers,
    ct.type                     AS content_type,
    u.uri,
    rec.archived_date
FROM responses resp
JOIN records rec
    ON resp.record_id = rec.id
LEFT JOIN warc_files wf
    ON rec.warc_file_id = wf.id
LEFT JOIN payloads pl
    ON rec.payload_id = pl.id
LEFT JOIN content_types ct
    ON resp.content_type_id = ct.id
LEFT JOIN uris u
    ON rec.uri_id = u.id;


-- One row per captured response, flattened for "history of a URL" lookups.
-- The /api/history endpoint filters this by uri and orders by archived_date.
CREATE OR REPLACE VIEW response_history AS
SELECT
    resp.id,                       -- response id
    resp.record_id,                -- originating record id
    rec.warc_custom_id,
    u.uri,
    rec.archived_date,
    resp.status,
    resp.http_version,
    resp.last_modified,
    ct.type            AS content_type,
    i.ip               AS ip,
    resp.headers
FROM responses resp
JOIN records rec           ON resp.record_id = rec.id
LEFT JOIN uris u           ON rec.uri_id = u.id
LEFT JOIN content_types ct ON resp.content_type_id = ct.id
LEFT JOIN ips i            ON rec.ip_id = i.id;


CREATE OR REPLACE VIEW latest_responses AS
SELECT 
    r.id,
    r.status,
    r.headers,
    r.http_version,
    r.last_modified,
    rec.archived_date,
    rec.warc_custom_id,
    u.uri,
    i.ip,
    c.type            AS content_type
FROM responses r
JOIN records rec
    ON r.record_id = rec.id
LEFT JOIN uris u
    ON rec.uri_id = u.id
LEFT JOIN ips i
    ON rec.ip_id = i.id
LEFT JOIN content_types c
    ON r.content_type_id = c.id;
-- Deliberately NOT ordered. The ORDER BY that used to live here bought nothing —
-- any caller re-sorts anyway — but it made the view look like "the latest
-- responses" when it is really "all responses". That framing is how the feed
-- ended up asking for `WHERE content_type ILIKE ... ORDER BY archived_date DESC
-- LIMIT 12` against the whole join and getting a plan that scanned 632k
-- responses, did 291k+291k PK lookups and sorted 291k rows to return 12.
-- The newest-N feed is its own access pattern; see get_latest_responses().


-----------------------------------------------------------------------------
-- get_latest_responses — the newest-N feed
--
-- Two phases, because the point is to touch as few wide rows as possible:
--
--   phase 1  walk records backward on archived_date, keep only ones whose
--            response matches, STOP at p_limit. Carries just ids and dates.
--   phase 2  fetch headers/uri/ip for those n rows and nothing else.
--
-- responses.headers is JSONB and made those rows width=489; the old plan dragged
-- all of them through a 291k-row join before sorting. Phase 1 carries only ids
-- and dates, so the wide rows are fetched for the n survivors and nobody else.
--
-- Measured note on the probe: it does NOT come out index-only. Postgres picks
-- responses_record_id_key (record_id is UNIQUE, so it knows the lookup yields
-- exactly one row and no wider index can beat that) and applies
-- content_type_id = ANY(...) as a filter after the heap fetch —
-- idx_responses_record_id_content_type_status goes unused here.
--
-- That is fine for a COMMON content type: HTML is ~46% of responses, so the walk
-- finds n matches almost immediately (a real plan showed 12 rows from the index
-- scan and 12 probes — no misses). It is the weak spot for a RARE type: the walk
-- keeps going, one heap fetch per record, until n match. Worth measuring with
-- something scarce before assuming the feed is safe for every dropdown value.
--
-- Branching on the filter for the same reason search_responses does: the two
-- workloads want different plans, and one query serving both gets the planner to
-- compromise badly.
-----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_latest_responses(
  p_content_type TEXT DEFAULT NULL,
  p_limit        INT  DEFAULT 12
)
RETURNS TABLE(
  id             BIGINT,
  status         INT,
  headers        JSONB,
  http_version   TEXT,
  last_modified  TIMESTAMPTZ,
  archived_date  TIMESTAMPTZ,
  warc_custom_id TEXT,
  uri            TEXT,
  ip             INET,
  content_type   TEXT
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
ROWS 12
AS $$
#variable_conflict use_column
BEGIN

  --------------------------------------------------------------------------
  -- No filter: every record qualifies, so the index walk alone is the answer.
  --------------------------------------------------------------------------
  IF COALESCE(btrim(p_content_type), '') = '' THEN
    RETURN QUERY
    WITH latest_records AS MATERIALIZED (
      SELECT rec.id, rec.archived_date, rec.warc_custom_id, rec.uri_id, rec.ip_id
      FROM records rec
      ORDER BY rec.archived_date DESC
      LIMIT p_limit
    )
    SELECT resp.id, resp.status, resp.headers, resp.http_version, resp.last_modified,
           lr.archived_date, lr.warc_custom_id, u.uri, i.ip, ct.type
    FROM latest_records lr
    JOIN responses resp        ON resp.record_id = lr.id
    LEFT JOIN uris u           ON u.id = lr.uri_id
    LEFT JOIN ips i            ON i.id = lr.ip_id
    LEFT JOIN content_types ct ON ct.id = resp.content_type_id
    ORDER BY lr.archived_date DESC, lr.id DESC;
    RETURN;
  END IF;

  --------------------------------------------------------------------------
  -- Filtered: resolve the type to a list of ids once, then probe per record
  -- while walking newest-first.
  --
  -- LATERAL rather than EXISTS on purpose. EXISTS is what let the planner
  -- invert the whole thing — scan every text/html response, probe records by
  -- PK 291k times, hash the result — which is the 4-second plan. LATERAL pins
  -- the nested loop so the ordered records scan stays the driver.
  --
  -- LIMIT 1 inside is redundant: responses.record_id is UNIQUE, so at most one
  -- row can match and the outer row cannot be multiplied. Kept as a guard in
  -- case that constraint ever relaxes.
  --------------------------------------------------------------------------
  RETURN QUERY
  WITH matching_content_types AS MATERIALIZED (
    SELECT COALESCE(array_agg(ct.id), '{}'::BIGINT[]) AS ids
    FROM content_types ct
    WHERE ct.base_type = content_type_base(p_content_type)
       OR ct.type ILIKE ('%' || p_content_type || '%')
  ),
  latest_records AS MATERIALIZED (
    SELECT rec.id, rec.archived_date, rec.warc_custom_id, rec.uri_id, rec.ip_id
    FROM records rec
    CROSS JOIN matching_content_types mct
    JOIN LATERAL (
      SELECT 1
      FROM responses resp_check
      WHERE resp_check.record_id = rec.id
        AND resp_check.content_type_id = ANY (mct.ids)
      LIMIT 1
    ) has_response ON TRUE
    -- archived_date only, matching idx_records_archived_date exactly. Adding
    -- id DESC here would need a sort on top of the index scan and could cost
    -- the early stop; the n rows are tie-broken in phase 2 instead, so ties
    -- exactly at the cutoff are arbitrary. Fine for an unpaginated feed.
    ORDER BY rec.archived_date DESC
    LIMIT p_limit
  )
  SELECT resp.id, resp.status, resp.headers, resp.http_version, resp.last_modified,
         lr.archived_date, lr.warc_custom_id, u.uri, i.ip, ct.type
  FROM latest_records lr
  JOIN responses resp        ON resp.record_id = lr.id
  LEFT JOIN uris u           ON u.id = lr.uri_id
  LEFT JOIN ips i            ON i.id = lr.ip_id
  LEFT JOIN content_types ct ON ct.id = resp.content_type_id
  ORDER BY lr.archived_date DESC, lr.id DESC;

END;
$$;


-----------------------------------------------------------------------------
---
-----------------------------------------------------------------------------

-- Decompose a Content-Type into parts so results can be ordered/searched by base
-- type or charset. IMMUTABLE + PARALLEL SAFE so they're cheap in the insert path
-- and usable anywhere. base = the MIME type before the first ';' (lowercased);
-- charset = the charset param value (lowercased, quotes/space stripped), or NULL.
CREATE OR REPLACE FUNCTION content_type_base(p_type TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(lower(btrim(split_part(p_type, ';', 1))), '')
$$;

CREATE OR REPLACE FUNCTION content_type_charset(p_type TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(btrim(substring(lower(p_type) FROM 'charset[[:space:]]*=[[:space:]]*([^;]+)'), ' "'), '')
$$;

/*
 * Path depth of a URI: 0 for a homepage, n for n path segments after the host.
 * This is the FIRST search/browse sort key — results are ordered shallowest-first
 * (homepages), then A->Z within a level.
 *
 * Derived here rather than trusted from the caller. It used to be computed in
 * TypeScript and passed in through the bulk-insert composite, and the parse worker
 * shipped a hardcoded `recursion_level: 0` with a TODO next to it — so every URI
 * in the database was level 0, the first sort key was constant, and the ordering
 * silently collapsed to plain uri ASC. It is a pure function of the URI, so the
 * database is the right place for it and there is nothing to forget.
 *
 * Mirrors recursionLevel() in db.ts:
 *   https://example.com          -> 0
 *   https://example.com/         -> 0
 *   https://example.com/a        -> 1
 *   https://example.com/a/b/     -> 2
 *   https://example.com/a?x=1#f  -> 1   (query and fragment are not path)
 */
CREATE OR REPLACE FUNCTION uri_recursion_level(p_uri TEXT)
RETURNS INT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    array_length(
      array_remove(
        string_to_array(
          regexp_replace(                      -- 3) drop ?query and #fragment
            regexp_replace(                    -- 2) drop the host
              regexp_replace(                  -- 1) drop the scheme
                COALESCE(p_uri, ''),
                '^[a-z][a-z0-9+.-]*://', '', 'i'
              ),
              '^[^/?#]*', ''
            ),
            '[?#].*$', ''
          ),
          '/'
        ),
        ''                                     -- 4) ignore empty segments
      ),
      1
    ),
    0
  )
$$;

CREATE OR REPLACE FUNCTION insert_warc_response_full(
  p_warc_custom_id        TEXT,
  p_warc_record_id        TEXT,
  p_warc_archived_date    TIMESTAMPTZ,
  p_file_path             TEXT,
  p_ip                    INET,
  p_uri                   TEXT,
  p_http_content_type     TEXT,
  p_http_headers          JSONB,
  p_http_status           INT,
  p_http_last_modified    TIMESTAMPTZ,
  p_payload_byte_offset   BIGINT,
  p_payload_byte_length   BIGINT,
  p_payload_chunks        BIGINT[],
  p_payload_digest        TEXT,
  p_recursion_level       INT DEFAULT 0
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_file_id     BIGINT;
  v_ip_id       BIGINT;
  v_ct_id       BIGINT;
  v_uri_id      BIGINT;
  v_payload_id  BIGINT;
  v_record_id   BIGINT;
  v_response_id BIGINT;
BEGIN
  -- Each entity below is a single INSERT ... ON CONFLICT ... RETURNING upsert:
  -- one round-trip that returns the id whether the row already existed or not,
  -- replacing the old SELECT-then-INSERT pairs.

  -- 1) warc_files
  INSERT INTO warc_files (file_path) VALUES (p_file_path)
    ON CONFLICT (file_path) DO UPDATE SET file_path = EXCLUDED.file_path
    RETURNING id INTO v_file_id;

  -- 2) ips (WARC-IP-Address is optional; skip cleanly when absent)
  IF p_ip IS NOT NULL THEN
    INSERT INTO ips (ip) VALUES (p_ip)
      ON CONFLICT (ip) DO UPDATE SET ip = EXCLUDED.ip
      RETURNING id INTO v_ip_id;
  ELSE
    v_ip_id := NULL;
  END IF;

  -- 3) content_types (optional)
  IF p_http_content_type IS NOT NULL AND length(trim(p_http_content_type)) > 0 THEN
    INSERT INTO content_types (type, base_type, charset)
      VALUES (
        p_http_content_type,
        content_type_base(p_http_content_type),
        content_type_charset(p_http_content_type)
      )
      ON CONFLICT (type) DO UPDATE
        SET base_type = EXCLUDED.base_type,
            charset   = EXCLUDED.charset
      RETURNING id INTO v_ct_id;
  ELSE
    v_ct_id := NULL;
  END IF;

  -- 4) uris: required by records.uri_id
  IF p_uri IS NULL OR length(trim(p_uri)) = 0 THEN
    RAISE EXCEPTION 'p_uri is required';
  END IF;

  INSERT INTO uris (uri, recursion_level) VALUES (p_uri, COALESCE(p_recursion_level, 0))
    ON CONFLICT (uri) DO UPDATE SET recursion_level = EXCLUDED.recursion_level
    RETURNING id INTO v_uri_id;

  -- 5) payloads: keyed by (file_id, byte_offset, byte_length); refresh digest+chunks
  IF p_payload_byte_offset IS NOT NULL AND p_payload_byte_length IS NOT NULL THEN
    INSERT INTO payloads (file_id, byte_offset, byte_length, payload_digest, chunks)
      VALUES (v_file_id, p_payload_byte_offset, p_payload_byte_length, p_payload_digest, p_payload_chunks)
      ON CONFLICT (file_id, byte_offset, byte_length) DO UPDATE
        SET payload_digest = EXCLUDED.payload_digest,
            chunks         = EXCLUDED.chunks
      RETURNING id INTO v_payload_id;
  ELSE
    v_payload_id := NULL;
  END IF;

  -- 6) records: keyed by warc_custom_id; refresh linkage on re-parse
  INSERT INTO records (
    warc_file_id, warc_record_id, warc_custom_id, record_type, archived_date,
    uri_id, ip_id, payload_id, payload_digest, is_truncated
  )
  VALUES (
    v_file_id, p_warc_record_id::uuid, p_warc_custom_id, 'response', p_warc_archived_date,
    v_uri_id, v_ip_id, v_payload_id, p_payload_digest, FALSE
  )
  ON CONFLICT (warc_custom_id) DO UPDATE
    SET warc_file_id   = EXCLUDED.warc_file_id,
        archived_date  = EXCLUDED.archived_date,
        uri_id         = EXCLUDED.uri_id,
        ip_id          = EXCLUDED.ip_id,
        payload_id     = EXCLUDED.payload_id,
        payload_digest = EXCLUDED.payload_digest
  RETURNING id INTO v_record_id;

  -- 7) responses: keyed by record_id; merge headers, keep existing where new is null
  INSERT INTO responses (
    record_id, http_version, status, content_type_id, headers, last_modified, concurrent_to
  )
  VALUES (
    v_record_id, 'HTTP/1.1', COALESCE(p_http_status, 0), v_ct_id,
    COALESCE(p_http_headers, '{}'::jsonb), p_http_last_modified, NULL
  )
  ON CONFLICT (record_id) DO UPDATE
    SET http_version    = 'HTTP/1.1',
        status          = COALESCE(EXCLUDED.status, responses.status),
        content_type_id = EXCLUDED.content_type_id,
        headers         = COALESCE(responses.headers, '{}'::jsonb) || COALESCE(EXCLUDED.headers, '{}'::jsonb),
        last_modified   = COALESCE(EXCLUDED.last_modified, responses.last_modified)
  RETURNING id INTO v_response_id;

  RETURN v_response_id;
END;
$$;

CREATE OR REPLACE FUNCTION insert_warc_responses_full(
    p_rows warc_response_bulk_input[]
)
RETURNS TABLE (
    warc_custom_id TEXT,
    record_id      BIGINT,
    response_id    BIGINT
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
BEGIN
    ---------------------------------------------------------------------------
    -- EMPTY
    ---------------------------------------------------------------------------
    IF p_rows IS NULL OR cardinality(p_rows) = 0 THEN
        RETURN;
    END IF;


    ---------------------------------------------------------------------------
    -- VALIDATION
    ---------------------------------------------------------------------------
    IF EXISTS (
        SELECT 1
        FROM unnest(p_rows) AS r
        WHERE r.uri IS NULL
           OR btrim(r.uri) = ''
    ) THEN
        RAISE EXCEPTION
            'insert_warc_responses_full: uri is required';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM unnest(p_rows) AS r
        WHERE r.warc_custom_id IS NULL
           OR btrim(r.warc_custom_id) = ''
    ) THEN
        RAISE EXCEPTION
            'insert_warc_responses_full: warc_custom_id is required';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM unnest(p_rows) AS r
        GROUP BY r.warc_custom_id
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION
            'insert_warc_responses_full: duplicate warc_custom_id in batch';
    END IF;


    ---------------------------------------------------------------------------
    -- 1. WARC FILES
    --
    -- Always lock/insert unique keys in deterministic order.
    ---------------------------------------------------------------------------
    INSERT INTO warc_files (
        file_path
    )
    SELECT x.file_path
    FROM (
        SELECT DISTINCT r.file_path
        FROM unnest(p_rows) AS r
    ) AS x
    ORDER BY x.file_path
    ON CONFLICT (file_path) DO NOTHING;


    ---------------------------------------------------------------------------
    -- 2. IP ADDRESSES
    ---------------------------------------------------------------------------
    INSERT INTO ips (
        ip
    )
    SELECT x.ip
    FROM (
        SELECT DISTINCT r.ip
        FROM unnest(p_rows) AS r
        WHERE r.ip IS NOT NULL
    ) AS x
    ORDER BY x.ip
    ON CONFLICT (ip) DO NOTHING;


    ---------------------------------------------------------------------------
    -- 3. CONTENT TYPES
    --
    -- IMPORTANT:
    -- Do not UPDATE these during normal ingestion.
    --
    -- base_type/charset are deterministic functions of type.
    ---------------------------------------------------------------------------
    INSERT INTO content_types (
        type,
        base_type,
        charset
    )
    SELECT
        x.type,
        content_type_base(x.type),
        content_type_charset(x.type)
    FROM (
        SELECT DISTINCT
            r.http_content_type AS type
        FROM unnest(p_rows) AS r
        WHERE r.http_content_type IS NOT NULL
          AND btrim(r.http_content_type) <> ''
    ) AS x
    ORDER BY x.type
    ON CONFLICT (type) DO NOTHING;


    ---------------------------------------------------------------------------
    -- 4. URIS
    --
    -- recursion_level is derived with uri_recursion_level(r.uri), NOT taken from
    -- r.recursion_level. The caller's value is ignored on purpose: the parse
    -- worker sent a hardcoded 0 for every record, which left every URI at level 0
    -- and quietly disabled the homepages-first half of the search ordering. It is
    -- a pure function of the URI, so deriving it here removes the possibility.
    --
    -- DO NOTHING rather than DO UPDATE: the value can't change for a given URI, so
    -- re-parsing has nothing to correct, and updating `uris` is a non-HOT update
    -- that has to reindex the trigram GIN. Rows written before this fix need the
    -- one-time backfill in migrate_recursion_level_backfill.sql — re-parsing alone
    -- will NOT repair them, precisely because of this DO NOTHING.
    ---------------------------------------------------------------------------
    INSERT INTO uris (
        uri,
        recursion_level
    )
    SELECT
        x.uri,
        uri_recursion_level(x.uri) AS recursion_level
    FROM (
        SELECT DISTINCT ON (r.uri)
            r.uri
        FROM unnest(p_rows) WITH ORDINALITY AS r
        ORDER BY
            r.uri,
            r.ordinality DESC
    ) AS x
    ORDER BY x.uri
    ON CONFLICT (uri) DO NOTHING;


    ---------------------------------------------------------------------------
    -- 5. PAYLOADS
    --
    -- Payload identity is:
    --
    --     file_id + byte_offset + byte_length
    --
    -- WARC files are immutable, so an existing payload does not need to
    -- continually update digest/chunks during normal ingestion.
    ---------------------------------------------------------------------------
    WITH payload_source AS (
        SELECT DISTINCT ON (
            wf.id,
            r.payload_byte_offset,
            r.payload_byte_length
        )
            wf.id                 AS file_id,
            r.payload_byte_offset AS byte_offset,
            r.payload_byte_length AS byte_length,
            r.payload_digest      AS payload_digest,
            r.payload_chunks      AS chunks

        FROM unnest(p_rows) WITH ORDINALITY AS r

        JOIN warc_files wf
          ON wf.file_path = r.file_path

        WHERE r.payload_byte_offset IS NOT NULL
          AND r.payload_byte_length IS NOT NULL

        ORDER BY
            wf.id,
            r.payload_byte_offset,
            r.payload_byte_length,
            r.ordinality DESC
    )

    INSERT INTO payloads (
        file_id,
        byte_offset,
        byte_length,
        payload_digest,
        chunks
    )
    SELECT
        p.file_id,
        p.byte_offset,
        p.byte_length,
        p.payload_digest,
        p.chunks
    FROM payload_source AS p
    ORDER BY
        p.file_id,
        p.byte_offset,
        p.byte_length

    ON CONFLICT (
        file_id,
        byte_offset,
        byte_length
    )
    DO NOTHING;


    ---------------------------------------------------------------------------
    -- 6. RECORDS
    --
    -- warc_custom_id is the identity.
    --
    -- Explicit ORDER BY gives concurrent ingest transactions the same
    -- conflict acquisition order.
    ---------------------------------------------------------------------------
    INSERT INTO records (
        warc_file_id,
        warc_record_id,
        warc_custom_id,
        record_type,
        archived_date,
        uri_id,
        ip_id,
        payload_id,
        payload_digest,
        is_truncated
    )
    SELECT
        wf.id,
        r.warc_record_id,
        r.warc_custom_id,
        'response'::warc_record_type,
        r.warc_archived_date,
        u.id,
        ip.id,
        pl.id,
        r.payload_digest,
        FALSE

    FROM unnest(p_rows) AS r

    JOIN warc_files wf
      ON wf.file_path = r.file_path

    JOIN uris u
      ON u.uri = r.uri

    LEFT JOIN ips ip
      ON ip.ip = r.ip

    LEFT JOIN payloads pl
      ON pl.file_id     = wf.id
     AND pl.byte_offset = r.payload_byte_offset
     AND pl.byte_length = r.payload_byte_length

    ORDER BY r.warc_custom_id

    ON CONFLICT (warc_custom_id)
    DO NOTHING;


    ---------------------------------------------------------------------------
    -- 7. RESPONSES
    ---------------------------------------------------------------------------
    INSERT INTO responses (
        record_id,
        http_version,
        status,
        content_type_id,
        headers,
        last_modified,
        concurrent_to
    )
    SELECT
        rec.id,
        'HTTP/1.1',
        COALESCE(r.http_status, 0),
        ct.id,
        COALESCE(r.http_headers, '{}'::jsonb),
        r.http_last_modified,
        NULL

    FROM unnest(p_rows) AS r

    JOIN records rec
      ON rec.warc_custom_id = r.warc_custom_id

    LEFT JOIN content_types ct
      ON ct.type = r.http_content_type
     AND r.http_content_type IS NOT NULL
     AND btrim(r.http_content_type) <> ''

    -- record_id is the unique conflict key.
    ORDER BY rec.id

    ON CONFLICT (record_id)
    DO NOTHING;


    ---------------------------------------------------------------------------
    -- 8. URI -> CONTENT TYPE SETS
    --
    -- Merges this batch's content types into uris.content_type_ids, which is what
    -- the filtered search paths test with && so they never derive the answer from
    -- records/responses.
    --
    -- Reads back from the rows just inserted rather than from p_rows, so it picks
    -- up resolved uri_id/content_type_id and stays correct across re-parses.
    --
    -- The WHERE is what keeps this cheap. Updating `uris` is a non-HOT update —
    -- uris carries a trigram GIN plus the array GIN, and every new tuple version
    -- has to be indexed in all of them — so we only write when the set actually
    -- gains something. A batch is normally many captures of URIs already known to
    -- have this type, and those update zero rows. Cost is therefore bounded by
    -- the number of NEW (uri, type) pairs, not by the number of captures.
    ---------------------------------------------------------------------------
    WITH batch_types AS (
        SELECT
            rec.uri_id,
            array_agg(DISTINCT resp.content_type_id) AS ids

        FROM unnest(p_rows) AS r

        JOIN records rec
          ON rec.warc_custom_id = r.warc_custom_id

        JOIN responses resp
          ON resp.record_id = rec.id

        WHERE resp.content_type_id IS NOT NULL
          AND rec.uri_id IS NOT NULL

        GROUP BY rec.uri_id
    )
    UPDATE uris u
    SET content_type_ids = (
        -- Union, sorted so equal sets compare equal and the stored order is
        -- stable across re-parses.
        SELECT array_agg(DISTINCT e ORDER BY e)
        FROM unnest(u.content_type_ids || bt.ids) AS e
    )
    FROM batch_types bt
    WHERE u.id = bt.uri_id
      AND NOT (u.content_type_ids @> bt.ids);


    ---------------------------------------------------------------------------
    -- RESULT
    ---------------------------------------------------------------------------
    RETURN QUERY
    SELECT
        r.warc_custom_id,
        rec.id,
        resp.id

    FROM unnest(p_rows) WITH ORDINALITY AS r

    JOIN records rec
      ON rec.warc_custom_id = r.warc_custom_id

    JOIN responses resp
      ON resp.record_id = rec.id

    ORDER BY r.ordinality;

END;
$$;

-- Four explicit planner paths.
--
-- One SQL plan cannot serve all four workloads well, and two of them were
-- pathological:
--
--   * query + no filter: the planner used idx_uris_recursion_level_uri to get
--     ORDER BY for free, then tested `uri ILIKE '%q%'` row by row — rejecting
--     141,129 URI entries to find 116, ~1.5s. Sorting 1,000 trigram candidates
--     costs nothing next to filtering 140k index entries, but the planner has no
--     way to know that from its (badly underestimated) trigram selectivity.
--
--   * query + filter: it inverted the content-type lookup — scanned ~201,126
--     text/html responses, did 201,126 records_pkey probes, hashed the URI set,
--     then intersected with ~1,000 trigram URIs. ~2.8s and ~800k buffer hits.
--
-- Both are the planner folding everything together and picking a shape that is
-- right for its estimate and wrong for the data. plpgsql + MATERIALIZED CTEs are
-- optimization fences: plpgsql is never inlined into the caller, and MATERIALIZED
-- stops the outer ORDER BY/LIMIT from being pushed back into the candidate scan.
--
-- STABLE lets the caller use a parallel plan (functions are VOLATILE by default,
-- which forbids it). ROWS 100 replaces the default 1000-row guess.
--
-- PROJECTION: only the six columns the results UI actually renders. It used to
-- also return headers (JSONB), http_version, ip and content_type — nothing read
-- any of them. headers was the expensive one: it drove row width to 815 bytes,
-- had to be detoasted per row, and routes/search.tsx then JSON.parse'd it before
-- serializing it into a response the frontend discarded. ip and content_type each
-- cost a LEFT JOIN to produce, so dropping them removes two joins from all four
-- paths as well. Add a column back only when something renders it.
CREATE OR REPLACE FUNCTION search_responses(
  p_query        TEXT,
  p_offset       BIGINT DEFAULT 0,
  p_limit_count  BIGINT DEFAULT 100,
  p_content_type TEXT DEFAULT NULL
)
RETURNS TABLE(
  response_id    BIGINT,
  status         INT,
  last_modified  TIMESTAMPTZ,
  archived_date  TIMESTAMPTZ,
  warc_custom_id TEXT,
  uri            TEXT
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
ROWS 100
AS $$
#variable_conflict use_column
DECLARE
  v_has_query BOOLEAN := COALESCE(btrim(p_query), '') <> '';
  v_has_type  BOOLEAN := COALESCE(btrim(p_content_type), '') <> '';
  -- Resolved once, into a variable rather than a CTE, so the filtered paths below
  -- see a plain array constant. That is what lets the planner pick
  -- idx_uris_content_type_ids for `content_type_ids && v_ct_ids`; a correlated
  -- subquery there would not be indexable.
  v_ct_ids    BIGINT[];
BEGIN

  IF v_has_type THEN
    -- content_types is a few hundred rows, so the predicate can be as loose as we
    -- like here — it runs once. base_type equality is what the UI sends
    -- (get_content_types returns content_type_base(type)) and correctly groups
    -- "text/html" with "text/html; charset=utf-8"; the substring fallback
    -- preserves behaviour for a partial like "image" sent straight to the API.
    SELECT COALESCE(array_agg(ct.id ORDER BY ct.id), '{}'::BIGINT[])
      INTO v_ct_ids
    FROM content_types ct
    WHERE ct.base_type = content_type_base(p_content_type)
       OR ct.type ILIKE ('%' || p_content_type || '%');

    -- No such content type: nothing can match, so skip the work entirely.
    IF array_length(v_ct_ids, 1) IS NULL THEN
      RETURN;
    END IF;
  END IF;

  --------------------------------------------------------------------------
  -- CASE 1: query, no content-type filter.
  --
  -- uri_candidates is fenced so the trigram index produces the candidate set
  -- FIRST; matched_uris then sorts that small set. Without the fence the
  -- planner walks idx_uris_recursion_level_uri instead and filters 140k rows.
  --------------------------------------------------------------------------
  IF v_has_query AND NOT v_has_type THEN
    RETURN QUERY
    WITH uri_candidates AS MATERIALIZED (
      SELECT u.id, u.uri, u.recursion_level
      FROM uris u
      WHERE u.uri ILIKE ('%' || p_query || '%')
    ),
    matched_uris AS MATERIALIZED (
      SELECT uc.id, uc.uri, uc.recursion_level
      FROM uri_candidates uc
      ORDER BY uc.recursion_level ASC, uc.uri ASC
      LIMIT p_limit_count OFFSET p_offset
    )
    SELECT resp.id, resp.status, resp.last_modified,
           rec.archived_date, rec.warc_custom_id, mu.uri
    FROM matched_uris mu
    JOIN records rec    ON rec.uri_id = mu.id
    JOIN responses resp ON resp.record_id = rec.id
    ORDER BY mu.recursion_level ASC, mu.uri ASC, rec.archived_date DESC;
    RETURN;
  END IF;

  --------------------------------------------------------------------------
  -- CASE 2: query + content-type filter.
  --
  -- Both predicates are on `uris`, so this is one BitmapAnd of idx_uris_trgm
  -- and idx_uris_content_type_ids — qualifying URIs come straight out of the
  -- bitmap and only then get sorted and paginated. No per-candidate probe.
  --
  -- The shape this replaces tested each trigram candidate against
  -- records -> responses -> content_types: 7,021 probes and 97.7% of the
  -- query's buffers to return 100 rows. Cheapening the probe couldn't fix that,
  -- because ORDER BY (recursion_level, uri) means every candidate has to be
  -- tested before a page can be chosen.
  --------------------------------------------------------------------------
  IF v_has_query AND v_has_type THEN
    RETURN QUERY
    WITH matched_uris AS MATERIALIZED (
      SELECT u.id, u.uri, u.recursion_level
      FROM uris u
      WHERE u.uri ILIKE ('%' || p_query || '%')
        AND u.content_type_ids && v_ct_ids
      ORDER BY u.recursion_level ASC, u.uri ASC
      LIMIT p_limit_count OFFSET p_offset
    )
    SELECT resp.id, resp.status, resp.last_modified,
           rec.archived_date, rec.warc_custom_id, mu.uri
    FROM matched_uris mu
    JOIN records rec    ON rec.uri_id = mu.id
    JOIN responses resp ON resp.record_id = rec.id
    -- Within a matched URI, keep only the captures of the requested type. Same
    -- id set as the URI filter, so returned rows can't disagree with counted
    -- rows, and it's an integer test rather than a per-row ILIKE.
    WHERE resp.content_type_id = ANY (v_ct_ids)
    ORDER BY mu.recursion_level ASC, mu.uri ASC, rec.archived_date DESC;
    RETURN;
  END IF;

  --------------------------------------------------------------------------
  -- CASE 3: browse everything, no content-type filter.
  --
  -- The opposite of case 1: with no ILIKE to satisfy,
  -- idx_uris_recursion_level_uri is exactly right — walk it in display order
  -- and stop after OFFSET+LIMIT. Only the LIMITed page is materialized.
  --------------------------------------------------------------------------
  IF NOT v_has_type THEN
    RETURN QUERY
    WITH matched_uris AS MATERIALIZED (
      SELECT u.id, u.uri, u.recursion_level
      FROM uris u
      ORDER BY u.recursion_level ASC, u.uri ASC
      LIMIT p_limit_count OFFSET p_offset
    )
    SELECT resp.id, resp.status, resp.last_modified,
           rec.archived_date, rec.warc_custom_id, mu.uri
    FROM matched_uris mu
    JOIN records rec    ON rec.uri_id = mu.id
    JOIN responses resp ON resp.record_id = rec.id
    ORDER BY mu.recursion_level ASC, mu.uri ASC, rec.archived_date DESC;
    RETURN;
  END IF;

  --------------------------------------------------------------------------
  -- CASE 4: browse everything + content-type filter.
  --
  -- No ILIKE to combine with, so the useful shape is the reverse of case 2:
  -- walk idx_uris_recursion_level_uri in display order and test the array per
  -- row, stopping once OFFSET+LIMIT qualify. The test is on the same tuple the
  -- index scan already fetched, so there is nothing to probe.
  --------------------------------------------------------------------------
  RETURN QUERY
  WITH matched_uris AS MATERIALIZED (
    SELECT u.id, u.uri, u.recursion_level
    FROM uris u
    WHERE u.content_type_ids && v_ct_ids
    ORDER BY u.recursion_level ASC, u.uri ASC
    LIMIT p_limit_count OFFSET p_offset
  )
  SELECT resp.id, resp.status, resp.last_modified,
         rec.archived_date, rec.warc_custom_id, mu.uri
  FROM matched_uris mu
  JOIN records rec    ON rec.uri_id = mu.id
  JOIN responses resp ON resp.record_id = rec.id
  WHERE resp.content_type_id = ANY (v_ct_ids)
  ORDER BY mu.recursion_level ASC, mu.uri ASC, rec.archived_date DESC;

END;
$$;


-- MUST keep the same URI predicate as search_responses' matched_uris CTEs, or the
-- page count and the pages disagree. Both are now:
--
--     uri ILIKE '%q%'  AND  content_type_ids && <resolved ids>
--
-- (with either half dropped when that parameter is blank), so they can be
-- compared mechanically.
CREATE OR REPLACE FUNCTION search_responses_count(p_query TEXT, p_content_type TEXT DEFAULT NULL)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $$
#variable_conflict use_column
DECLARE
  v_has_query BOOLEAN := COALESCE(btrim(p_query), '') <> '';
  v_has_type  BOOLEAN := COALESCE(btrim(p_content_type), '') <> '';
  v_ct_ids    BIGINT[];
  v_count     BIGINT;
BEGIN
  IF v_has_type THEN
    SELECT COALESCE(array_agg(ct.id ORDER BY ct.id), '{}'::BIGINT[])
      INTO v_ct_ids
    FROM content_types ct
    WHERE ct.base_type = content_type_base(p_content_type)
       OR ct.type ILIKE ('%' || p_content_type || '%');

    IF array_length(v_ct_ids, 1) IS NULL THEN
      RETURN 0;
    END IF;
  END IF;

  IF v_has_query AND v_has_type THEN
    SELECT COUNT(*) INTO v_count FROM uris u
    WHERE u.uri ILIKE ('%' || p_query || '%')
      AND u.content_type_ids && v_ct_ids;
  ELSIF v_has_query THEN
    SELECT COUNT(*) INTO v_count FROM uris u
    WHERE u.uri ILIKE ('%' || p_query || '%');
  ELSIF v_has_type THEN
    SELECT COUNT(*) INTO v_count FROM uris u
    WHERE u.content_type_ids && v_ct_ids;
  ELSE
    SELECT COUNT(*) INTO v_count FROM uris u;
  END IF;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION get_site_responses(
  p_uri TEXT DEFAULT NULL,
  p_warc_custom_id TEXT DEFAULT NULL
)
RETURNS TABLE(
  id BIGINT,
  record_id BIGINT,
  warc_custom_id TEXT,
  file_path TEXT,
  byte_offset BIGINT,
  byte_length BIGINT,
  chunks BIGINT[],
  status INT,
  http_version TEXT,
  headers JSONB,
  content_type TEXT,
  uri TEXT,
  archived_date TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_uri TEXT;
BEGIN
  -- Require at least one input
  IF p_uri IS NULL AND p_warc_custom_id IS NULL THEN
    RAISE EXCEPTION 'get_site_responses: must provide p_uri or p_warc_custom_id';
  END IF;

  -- Case 1: warc_custom_id provided
  IF p_warc_custom_id IS NOT NULL THEN
    -- Look up the URI for that ID
    SELECT u.uri
    INTO v_uri
    FROM records rec
    JOIN uris u ON rec.uri_id = u.id
    WHERE rec.warc_custom_id = p_warc_custom_id
    LIMIT 1;

    -- If not found, return nothing
    IF v_uri IS NULL THEN
      RETURN;
    END IF;

    RETURN QUERY
    SELECT
      rp.id,
      rp.record_id,
      rp.warc_custom_id,
      rp.file_path,
      rp.byte_offset,
      rp.byte_length,
      rp.chunks,
      rp.status,
      rp.http_version,
      rp.headers,
      rp.content_type,
      rp.uri,
      rp.archived_date
    FROM response_payloads rp
    WHERE rp.uri = v_uri
    ORDER BY rp.archived_date DESC;

    RETURN;
  END IF;

  -- Case 2: p_uri provided (exact match only)
  RETURN QUERY
  SELECT
    rp.id,
    rp.record_id,
    rp.warc_custom_id,
    rp.file_path,
    rp.byte_offset,
    rp.byte_length,
    rp.chunks,
    rp.status,
    rp.http_version,
    rp.headers,
    rp.content_type,
    rp.uri,
    rp.archived_date
  FROM response_payloads rp
  WHERE rp.uri = p_uri
  ORDER BY rp.archived_date DESC;
END;
$$;

CREATE OR REPLACE FUNCTION get_redirect_path(
  p_uri TEXT DEFAULT NULL,
  p_date_archived TIMESTAMPTZ DEFAULT NULL,
  p_warc_custom_id TEXT DEFAULT NULL,
  p_max_hops INT DEFAULT 20
)
RETURNS TABLE(
  id BIGINT,
  record_id BIGINT,
  warc_custom_id TEXT,
  file_path TEXT,
  byte_offset BIGINT,
  byte_length BIGINT,
  chunks BIGINT[],
  status INT,
  http_version TEXT,
  headers JSONB,
  content_type TEXT,
  uri TEXT,
  archived_date TIMESTAMPTZ,
  hop INT,
  location_header TEXT,
  resolved_location TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  start_resp_id BIGINT;
BEGIN
  -- determine start response id
  IF p_warc_custom_id IS NOT NULL THEN
    SELECT resp.id INTO start_resp_id
    FROM responses resp
    JOIN records rec ON resp.record_id = rec.id
    WHERE rec.warc_custom_id = p_warc_custom_id
    LIMIT 1;
  ELSIF p_uri IS NOT NULL THEN
    IF p_date_archived IS NOT NULL THEN
      SELECT resp.id INTO start_resp_id
      FROM responses resp
      JOIN records rec ON resp.record_id = rec.id
      JOIN uris u ON rec.uri_id = u.id
      WHERE u.uri = p_uri
      ORDER BY abs(extract(epoch FROM COALESCE(resp.last_modified, rec.archived_date) - p_date_archived))
      LIMIT 1;
    ELSE
      SELECT resp.id INTO start_resp_id
      FROM responses resp
      JOIN records rec ON resp.record_id = rec.id
      JOIN uris u ON rec.uri_id = u.id
      WHERE u.uri = p_uri
      ORDER BY COALESCE(resp.last_modified, rec.archived_date) DESC
      LIMIT 1;
    END IF;
  ELSE
    RAISE EXCEPTION 'get_redirect_path: must provide p_uri or p_warc_custom_id';
  END IF;

  IF start_resp_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH RECURSIVE path AS (
    -- start node
    SELECT
      resp.id AS cte_resp_id,
      rec.id AS cte_rec_id,
      rec.warc_custom_id AS cte_warc_custom_id,
      wf.file_path AS cte_file_path,
      pl.byte_offset AS cte_byte_offset,
      pl.byte_length AS cte_byte_length,
      pl.chunks AS cte_chunks,
      resp.status AS cte_status,
      resp.http_version AS cte_http_version,
      resp.headers AS cte_headers,
      ct.type AS cte_content_type,
      u.uri AS cte_uri,
      rec.archived_date AS cte_archived_date,
      COALESCE(resp.last_modified, rec.archived_date) AS cte_ref_time,
      COALESCE(resp.headers->>'location', resp.headers->>'Location', resp.headers->>'LOCATION') AS cte_location_header,
      NULL::text AS cte_resolved_location,
      ARRAY[u.uri] AS cte_visited_uris,
      1 AS cte_hop
    FROM responses resp
    JOIN records rec ON resp.record_id = rec.id
    LEFT JOIN payloads pl ON rec.payload_id = pl.id
    LEFT JOIN warc_files wf ON rec.warc_file_id = wf.id
    LEFT JOIN content_types ct ON resp.content_type_id = ct.id
    LEFT JOIN uris u ON rec.uri_id = u.id
    WHERE resp.id = start_resp_id

    UNION ALL

    -- recursive step
    SELECT
      nr.cte_resp_id,
      nr.cte_rec_id,
      nr.cte_warc_custom_id,
      nr.cte_file_path,
      nr.cte_byte_offset,
      nr.cte_byte_length,
      nr.cte_chunks,
      nr.cte_status,
      nr.cte_http_version,
      nr.cte_headers,
      nr.cte_content_type,
      nr.cte_uri,
      nr.cte_archived_date,
      COALESCE(nr.last_modified, nr.cte_archived_date) AS cte_ref_time,
      COALESCE(nr.cte_headers->>'location', nr.cte_headers->>'Location', nr.cte_headers->>'LOCATION') AS cte_location_header,
      r.cte_resolved_location,
      path.cte_visited_uris || nr.cte_uri,
      path.cte_hop + 1
    FROM path
    CROSS JOIN LATERAL (
      SELECT
        CASE
          WHEN path.cte_location_header IS NULL THEN NULL
          WHEN path.cte_location_header ~ '^//' THEN
            regexp_replace(path.cte_uri, '^(https?):.*$', '\1') || ':' || path.cte_location_header
          WHEN path.cte_location_header LIKE '/%' THEN
            regexp_replace(path.cte_uri, '^(https?://[^/]+).*$', '\1') || path.cte_location_header
          WHEN path.cte_location_header ~* '^[a-zA-Z][a-zA-Z0-9+.\-]*:' THEN
            path.cte_location_header
          ELSE
            regexp_replace(path.cte_uri, '^(https?://[^/]+).*$', '\1') || '/' || path.cte_location_header
        END AS cte_resolved_location
    ) AS r
    CROSS JOIN LATERAL (
      SELECT
        resp2.id AS cte_resp_id,
        rec2.id AS cte_rec_id,
        rec2.warc_custom_id AS cte_warc_custom_id,
        wf2.file_path AS cte_file_path,
        pl2.byte_offset AS cte_byte_offset,
        pl2.byte_length AS cte_byte_length,
        pl2.chunks AS cte_chunks,
        resp2.status AS cte_status,
        resp2.http_version AS cte_http_version,
        resp2.headers AS cte_headers,
        ct2.type AS cte_content_type,
        u2.uri AS cte_uri,
        rec2.archived_date AS cte_archived_date,
        resp2.last_modified
      FROM responses resp2
      JOIN records rec2 ON resp2.record_id = rec2.id
      LEFT JOIN payloads pl2 ON rec2.payload_id = pl2.id
      LEFT JOIN warc_files wf2 ON rec2.warc_file_id = wf2.id
      LEFT JOIN content_types ct2 ON resp2.content_type_id = ct2.id
      LEFT JOIN uris u2 ON rec2.uri_id = u2.id
      WHERE u2.uri = r.cte_resolved_location
      ORDER BY abs(extract(epoch FROM COALESCE(resp2.last_modified, rec2.archived_date) - path.cte_ref_time))
      LIMIT 1
    ) nr
    WHERE path.cte_hop < p_max_hops
      AND r.cte_resolved_location IS NOT NULL
      AND NOT (r.cte_resolved_location = ANY(path.cte_visited_uris))
  )
  SELECT
    cte_resp_id AS id,
    cte_rec_id AS record_id,
    cte_warc_custom_id AS warc_custom_id,
    cte_file_path AS file_path,
    cte_byte_offset AS byte_offset,
    cte_byte_length AS byte_length,
    cte_chunks AS chunks,
    cte_status AS status,
    cte_http_version AS http_version,
    cte_headers AS headers,
    cte_content_type AS content_type,
    cte_uri AS uri,
    cte_archived_date AS archived_date,
    cte_hop AS hop,
    cte_location_header AS location_header,
    cte_resolved_location AS resolved_location
  FROM path
  ORDER BY cte_hop;
END;
$$;


-----------------------------------------------------------------------------
-- PLANNER STATISTICS
--
-- `uri ILIKE '%foo%'` selectivity is guessed from uris.uri's MCV list and
-- histogram, and at the default statistics target of 100 the guess is off by
-- 30-40x on this data (a trigram bitmap scan estimated at 18 rows returning
-- 670). That is survivable at 80k URIs because the plan happens to be right
-- anyway; at millions it is how you end up with a nested loop chosen for an
-- estimated 10 rows that actually processes thousands.
--
-- Estimates were still swinging at 500 (47 estimated vs 1,033 actual on one run,
-- thousands on another), so 1000. The cost is a longer ANALYZE and a bigger
-- pg_statistic entry, both negligible next to a wrong join order — and the
-- estimate is what decides between the three plans this query has shown, which
-- ranged from 289ms to 2.8s.
-----------------------------------------------------------------------------
ALTER TABLE uris ALTER COLUMN uri SET STATISTICS 1000;

-- Bulk loads outrun autoanalyze, so seed statistics now rather than waiting.
-- Worth re-running after any large ingest: autovacuum also maintains the
-- visibility map that decides whether the index-only scans above actually stay
-- index-only.
ANALYZE uris;
ANALYZE records;
ANALYZE responses;
ANALYZE content_types;


-- ===========================================================================
-- Parse progress
--
-- What has been read out of each WARC, and how far. This is what lets the
-- parser restart without re-reading the archive: it used to run this whole file
-- on every boot, and since this file DROPs every table, every restart was a full
-- wipe followed by a full re-parse.
--
-- Running setup.sql is therefore an explicit act now (RESET_DB=1), not something
-- that happens on boot. The parser only reads from these objects.
--
-- ## What a row means
--
-- One row per warc file. `byte_offset` is a RESUME POINT: the offset of a record
-- boundary such that everything before it is known to be in the database.
--
-- It is deliberately allowed to lag. Rows are inserted by bulk batches that
-- settle out of order, so the only offset that can be trusted is the start of
-- the oldest batch still in flight — anything later may or may not have landed.
-- Resuming a little early costs a few re-parsed records and nothing else,
-- because every insert in insert_warc_responses_full is ON CONFLICT DO NOTHING,
-- from `uris` all the way down to `responses`. Resuming a little LATE would lose
-- records silently, so the bias is the whole design.
--
-- No `warc_` prefix on these names. Everything in this database is warcs; the
-- prefix on the older objects distinguishes them from nothing, and they keep it
-- only because renaming them would be a migration rather than a decision.
-- ===========================================================================

CREATE TYPE parse_status AS ENUM (
    -- Known to the database, nothing read yet.
    'pending',
    -- A worker claimed it. Also what a row looks like after a crash, which is
    -- why resuming treats it exactly like 'pending' with an offset rather than
    -- as something to avoid.
    'parsing',
    -- Read to the end of the file as it stood at `file_size`.
    'parsed',
    -- The decoder threw. `error` holds why; the offset still points at the last
    -- good boundary so a retry does not start over.
    'error'
);

CREATE TABLE IF NOT EXISTS file_progress (
    file_id BIGINT PRIMARY KEY REFERENCES warc_files(id) ON DELETE CASCADE,

    status parse_status NOT NULL DEFAULT 'pending',

    -- Where to start reading next time. MUST be a record boundary — mWarcDecode's
    -- `start` does not go looking for one — and every value written here is a
    -- `header-warc.offset` handed back by the decoder, so it is one by
    -- construction.
    byte_offset BIGINT NOT NULL DEFAULT 0,

    -- Size of the file when that offset was written: the change detector. A WARC
    -- is append-only, so a file that has GROWN can be resumed from the stored
    -- offset and the new records picked up; one that has SHRUNK or been replaced
    -- cannot, and is re-read from zero.
    file_size BIGINT,

    -- Records inserted from this file. Reporting only — never resume logic.
    records BIGINT NOT NULL DEFAULT 0,

    error TEXT,

    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The planner's question on startup is "what is not finished", asked once per
-- run over a table with one row per file.
CREATE INDEX IF NOT EXISTS idx_file_progress_status ON file_progress (status);

-- Claim a file and record where reading began. Upsert rather than insert: the
-- common case is a row that already exists from a previous run, and the whole
-- point is to keep its offset.
CREATE OR REPLACE FUNCTION progress_start(
    p_file_id BIGINT,
    p_byte_offset BIGINT,
    p_file_size BIGINT
) RETURNS VOID AS $$
    INSERT INTO file_progress (file_id, status, byte_offset, file_size, started_at, updated_at)
    VALUES (p_file_id, 'parsing', p_byte_offset, p_file_size, now(), now())
    ON CONFLICT (file_id) DO UPDATE SET
        status      = 'parsing',
        byte_offset = EXCLUDED.byte_offset,
        file_size   = EXCLUDED.file_size,
        error       = NULL,
        started_at  = now(),
        updated_at  = now();
$$ LANGUAGE sql;

-- Move the resume point forward. GREATEST, so a checkpoint that arrives out of
-- order can never drag the offset backwards — the messages come from eight
-- worker threads and the database is the only place their ordering is resolved.
CREATE OR REPLACE FUNCTION progress_checkpoint(
    p_file_id BIGINT,
    p_byte_offset BIGINT,
    p_records BIGINT
) RETURNS VOID AS $$
    UPDATE file_progress
    SET byte_offset = GREATEST(byte_offset, p_byte_offset),
        records     = GREATEST(records, p_records),
        updated_at  = now()
    WHERE file_id = p_file_id;
$$ LANGUAGE sql;

-- Read to the end. `p_byte_offset` is the file size that was actually reached.
CREATE OR REPLACE FUNCTION progress_finish(
    p_file_id BIGINT,
    p_byte_offset BIGINT,
    p_records BIGINT,
    p_error TEXT DEFAULT NULL
) RETURNS VOID AS $$
    UPDATE file_progress
    SET status      = CASE WHEN p_error IS NULL THEN 'parsed' ELSE 'error' END::parse_status,
        byte_offset = GREATEST(byte_offset, p_byte_offset),
        records     = GREATEST(records, p_records),
        error       = p_error,
        finished_at = now(),
        updated_at  = now()
    WHERE file_id = p_file_id;
$$ LANGUAGE sql;

-- Everything the planner needs, in one round trip. A LEFT JOIN because a file
-- added since the last run has no progress row yet, and "no row" is a real
-- answer meaning start at zero.
CREATE OR REPLACE VIEW parse_plan AS
SELECT
    f.id                          AS file_id,
    f.file_path,
    COALESCE(p.status, 'pending') AS status,
    COALESCE(p.byte_offset, 0)    AS byte_offset,
    p.file_size,
    COALESCE(p.records, 0)        AS records,
    p.error
FROM warc_files f
LEFT JOIN file_progress p ON p.file_id = f.id;
