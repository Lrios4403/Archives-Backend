-- migrate_uri_content_types.sql
--
-- Brings a LIVE database up to the current search implementation without a
-- reparse. Apply with:
--   docker compose exec -T postgres-archives \
--     psql -U postgres -d archives < backend/db/migrate_uri_content_types.sql
--
-- Function bodies here are duplicated from db/setup.sql. That duplication is
-- inherent to SQL migrations, so it is checked mechanically rather than by eye —
-- the verification script asserts the definitions in this file and in setup.sql
-- are identical after stripping comments and whitespace.
--
-- WHAT THIS FIXES
--
-- 1. The content-type filter derived "does this URI have a response of type X?"
--    through records -> responses -> content_types for EVERY candidate URI. At
--    ~80k URIs that subplan ran 633 times and was ~90% of the query's buffer
--    reads; at ~1M records the planner instead de-correlated it into a hashed
--    subplan that scanned all 1.69M responses and did 997,159 records_pkey
--    probes — 3.95M buffer hits and 10.8s to return 100 rows.
--
-- 2. One SQL plan served four different workloads. Two were pathological: query
--    without a filter walked idx_uris_recursion_level_uri and ILIKE-tested 141k
--    index entries to find 116 rows; query with a filter inverted as above.
--
-- 3. The projection returned headers (JSONB), http_version, ip and content_type.
--    Nothing rendered them. headers drove row width to 815 bytes, needed a
--    detoast per row, and was JSON.parse'd in the API before being serialized
--    into a response the frontend discarded.
--
-- Safe to re-run: IF NOT EXISTS / ON CONFLICT DO NOTHING / CREATE OR REPLACE
-- throughout. No existing row is modified.

BEGIN;

----------------------------------------------------------------
-- 1. The summary table
--
-- One row per (uri, content type) instead of one probe per capture. A page with
-- 9 yearly HTML captures needed 9 record+response lookups to establish a fact
-- this states once, so the old cost grew with the archive's depth as well as its
-- width. It also keeps search off records/responses entirely for the filter —
-- the two tables ingest writes hardest — and because it only changes when a NEW
-- pair appears, its pages settle and stay all-visible, which is what lets the
-- probe remain a real Index Only Scan.
--
-- content_type_id is stored rather than the base type string, so refreshing
-- content_types.base_type/charset cannot leave this table stale.
----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS uri_content_types (
  uri_id          BIGINT NOT NULL REFERENCES uris(id) ON DELETE CASCADE,
  content_type_id BIGINT NOT NULL REFERENCES content_types(id) ON DELETE CASCADE,
  -- (uri_id, content_type_id) in this order: every lookup knows the URI and
  -- tests a set of content types, so the probe is covered by the PK alone.
  PRIMARY KEY (uri_id, content_type_id)
);

-- Reverse direction, for "which URIs are of type X" without a URI filter.
CREATE INDEX IF NOT EXISTS idx_uri_content_types_ct
  ON uri_content_types(content_type_id, uri_id);

----------------------------------------------------------------
-- 2. Backfill
--
-- One pass over records x responses. On a large archive this is the slow part;
-- it takes no lock on records/responses beyond the read, so ingest can continue,
-- though both will go faster if they aren't competing.
----------------------------------------------------------------
INSERT INTO uri_content_types (uri_id, content_type_id)
SELECT DISTINCT
    rec.uri_id,
    resp.content_type_id
FROM records rec
JOIN responses resp
  ON resp.record_id = rec.id
WHERE resp.content_type_id IS NOT NULL
  AND rec.uri_id IS NOT NULL
ON CONFLICT (uri_id, content_type_id) DO NOTHING;

----------------------------------------------------------------
-- 3. search_responses — four explicit planner paths
----------------------------------------------------------------
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
BEGIN

  -- CASE 1: query, no content-type filter. uri_candidates is fenced so the
  -- trigram index produces the candidate set FIRST; matched_uris then sorts that
  -- small set. Without the fence the planner walks
  -- idx_uris_recursion_level_uri and ILIKE-filters 141k rows instead.
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

  -- CASE 2: query + content-type filter. Trigram candidates first, then ONE
  -- index-only probe of uri_content_types' PK per candidate. LATERAL ... LIMIT 1
  -- rather than EXISTS: a LATERAL join cannot be de-correlated into the hashed
  -- subplan that produced the 10.8s plan.
  IF v_has_query AND v_has_type THEN
    RETURN QUERY
    WITH matching_content_types AS MATERIALIZED (
      SELECT ct.id
      FROM content_types ct
      WHERE ct.base_type = content_type_base(p_content_type)
         OR ct.type ILIKE ('%' || p_content_type || '%')
    ),
    uri_candidates AS MATERIALIZED (
      SELECT u.id, u.uri, u.recursion_level
      FROM uris u
      WHERE u.uri ILIKE ('%' || p_query || '%')
    ),
    matched_uris AS MATERIALIZED (
      SELECT uc.id, uc.uri, uc.recursion_level
      FROM uri_candidates uc
      JOIN LATERAL (
        SELECT 1
        FROM uri_content_types uct
        WHERE uct.uri_id = uc.id
          AND uct.content_type_id IN (SELECT id FROM matching_content_types)
        LIMIT 1
      ) has_type ON TRUE
      ORDER BY uc.recursion_level ASC, uc.uri ASC
      LIMIT p_limit_count OFFSET p_offset
    )
    SELECT resp.id, resp.status, resp.last_modified,
           rec.archived_date, rec.warc_custom_id, mu.uri
    FROM matched_uris mu
    JOIN records rec    ON rec.uri_id = mu.id
    JOIN responses resp ON resp.record_id = rec.id
    -- Same id set as the URI filter, so returned rows can't disagree with
    -- counted rows. Integer compare, not a per-row ILIKE. No join to
    -- content_types needed — the ids are all the filter requires.
    WHERE resp.content_type_id IN (SELECT id FROM matching_content_types)
    ORDER BY mu.recursion_level ASC, mu.uri ASC, rec.archived_date DESC;
    RETURN;
  END IF;

  -- CASE 3: browse everything, no filter. The opposite of case 1: with no ILIKE
  -- to satisfy, idx_uris_recursion_level_uri is exactly right — walk it in
  -- display order and stop after OFFSET+LIMIT.
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

  -- CASE 4: browse everything + filter. Walk uris in display order and probe the
  -- summary per URI, stopping once OFFSET+LIMIT qualify.
  RETURN QUERY
  WITH matching_content_types AS MATERIALIZED (
    SELECT ct.id
    FROM content_types ct
    WHERE ct.base_type = content_type_base(p_content_type)
       OR ct.type ILIKE ('%' || p_content_type || '%')
  ),
  matched_uris AS MATERIALIZED (
    SELECT u.id, u.uri, u.recursion_level
    FROM uris u
    JOIN LATERAL (
      SELECT 1
      FROM uri_content_types uct
      WHERE uct.uri_id = u.id
        AND uct.content_type_id IN (SELECT id FROM matching_content_types)
      LIMIT 1
    ) has_type ON TRUE
    ORDER BY u.recursion_level ASC, u.uri ASC
    LIMIT p_limit_count OFFSET p_offset
  )
  SELECT resp.id, resp.status, resp.last_modified,
         rec.archived_date, rec.warc_custom_id, mu.uri
  FROM matched_uris mu
  JOIN records rec    ON rec.uri_id = mu.id
  JOIN responses resp ON resp.record_id = rec.id
  WHERE resp.content_type_id IN (SELECT id FROM matching_content_types)
  ORDER BY mu.recursion_level ASC, mu.uri ASC, rec.archived_date DESC;

END;
$$;

----------------------------------------------------------------
-- 4. search_responses_count — MUST keep the same URI predicate as CASE 2/4's
--    matched_uris, or the page count and the pages disagree.
----------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_responses_count(p_query TEXT, p_content_type TEXT DEFAULT NULL)
RETURNS BIGINT
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  WITH matching_content_types AS MATERIALIZED (
    SELECT ct.id
    FROM content_types ct
    WHERE p_content_type IS NOT NULL
      AND btrim(p_content_type) <> ''
      AND (
        ct.base_type = content_type_base(p_content_type)
        OR ct.type ILIKE ('%' || p_content_type || '%')
      )
  )
  SELECT COUNT(*)::BIGINT
  FROM uris u
  WHERE u.uri ILIKE ('%' || p_query || '%')
    AND (
      p_content_type IS NULL OR btrim(p_content_type) = ''
      OR EXISTS (
        SELECT 1
        FROM uri_content_types uct
        WHERE uct.uri_id = u.id
          AND uct.content_type_id IN (SELECT id FROM matching_content_types)
      )
    );
$$;

COMMIT;

----------------------------------------------------------------
-- 5. VACUUM the freshly-backfilled table. NOT optional.
--
-- After a bulk INSERT the visibility map is all zeroes, so EVERY "Index Only
-- Scan" on uri_content_types still visits the heap to check MVCC visibility.
-- CASE 2 probes once per trigram candidate — thousands of random heap reads that
-- should have been index-only. ANALYZE alone does not fix this; only VACUUM sets
-- visibility-map bits.
--
-- Outside the transaction: VACUUM cannot run inside one.
----------------------------------------------------------------
VACUUM (ANALYZE) uri_content_types;

----------------------------------------------------------------
-- 6. Statistics
--
-- `uri ILIKE '%foo%'` selectivity comes from uris.uri's MCV list and histogram.
-- At the default target of 100 it was off by 37-43x; at 1000 the most recent
-- measurement was 6,323 estimated against 5,715 actual, ~10%. That estimate is
-- what decides between plans that have measured anywhere from 0.5ms to 10.8s.
----------------------------------------------------------------
ALTER TABLE uris ALTER COLUMN uri SET STATISTICS 1000;

ANALYZE uris;
ANALYZE content_types;

----------------------------------------------------------------
-- 7. Drop the write-only indexes. CONCURRENTLY cannot run in a transaction.
--    Both were pure write amplification on the tables ingest hammers:
--    idx_responses_content_type_notnull had 3 scans against the 135 of the
--    index it duplicates; idx_content_types_charset had 0.
----------------------------------------------------------------
DROP INDEX CONCURRENTLY IF EXISTS idx_responses_content_type_notnull;
DROP INDEX CONCURRENTLY IF EXISTS idx_content_types_charset;

----------------------------------------------------------------
-- 8. Verify. summary_rows and derived_rows must be equal.
----------------------------------------------------------------
-- SELECT
--   (SELECT count(*) FROM uri_content_types) AS summary_rows,
--   (SELECT count(*) FROM (
--      SELECT DISTINCT rec.uri_id, resp.content_type_id
--      FROM records rec
--      JOIN responses resp ON resp.record_id = rec.id
--      WHERE resp.content_type_id IS NOT NULL
--    ) d) AS derived_rows;
