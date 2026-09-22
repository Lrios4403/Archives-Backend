-- migrate_uri_content_type_ids.sql
--
-- Denormalizes the set of content types per URI onto `uris` and repoints the
-- filtered search paths at it. SUPERSEDES migrate_uri_content_types.sql — this
-- drops the uri_content_types table that one created. Applying this alone on a
-- database that never had that table is fine.
--
--   docker compose exec -T postgres-archives \
--     psql -U postgres -d archives < backend/db/migrate_uri_content_type_ids.sql
--
-- WHY, with the measurement that forced it
--
-- The filter asks one question — "does this URI have a response of type X?" —
-- and every previous design answered it PER CANDIDATE URI:
--
--   records -> responses -> content_types, 7,021 probes, to return 100 rows.
--   That subplan was 97.7% of the query's buffer hits (54,084 of 55,376) and
--   1.77s. Within it, content_types_pkey alone burned 13,970 buffers looking up
--   a 297-row table 7,021 times.
--
-- Moving that to a summary table made each probe cheaper (~8 buffers per URI down
-- to ~3) but could not reduce the NUMBER of probes, because the result is ordered
-- by (recursion_level, uri) and GIN cannot return rows in order — so every
-- candidate must be tested before a page can be chosen. ~7,000 probes was the
-- floor for any design with the types in a different table.
--
-- Putting the ids on `uris` removes the floor: both predicates are now on one
-- relation, so
--
--     uri ILIKE '%q%'  AND  content_type_ids && ARRAY[...]
--
-- resolves as a BitmapAnd of two GIN indexes. Qualifying URIs come out of the
-- bitmap directly; nothing is probed.
--
-- THE TRADE-OFF, stated plainly: this adds an UPDATE on `uris` for every NEW
-- (uri, content type) pair during ingest, and `uris` carries a trigram GIN index,
-- so those are non-HOT updates that must re-index the new tuple version. It is
-- bounded by new pairs rather than by captures (the insert function skips URIs
-- whose set already contains the batch's types), and it is offset by dropping
-- uri_content_types and its two indexes from the ingest path. Ingest pays a
-- little so that interactive search doesn't.
--
-- Safe to re-run.

BEGIN;

----------------------------------------------------------------
-- 1. Column
--
-- No FK: Postgres has no referential integrity for array elements. content_type
-- rows are never deleted, and search re-resolves ids from content_types on every
-- call, so a stale id would simply never match.
----------------------------------------------------------------
ALTER TABLE uris
  ADD COLUMN IF NOT EXISTS content_type_ids BIGINT[] NOT NULL DEFAULT '{}';

----------------------------------------------------------------
-- 2. Backfill
--
-- One pass over records x responses, grouped per URI. Sorted so equal sets
-- compare equal and the stored order is stable across re-parses.
--
-- On a large archive this is the slow step and it rewrites most of `uris`, so
-- expect bloat — step 5's VACUUM deals with it. Prefer running this while ingest
-- is idle.
----------------------------------------------------------------
WITH per_uri AS (
    SELECT
        rec.uri_id,
        array_agg(DISTINCT resp.content_type_id ORDER BY resp.content_type_id) AS ids
    FROM records rec
    JOIN responses resp
      ON resp.record_id = rec.id
    WHERE resp.content_type_id IS NOT NULL
      AND rec.uri_id IS NOT NULL
    GROUP BY rec.uri_id
)
UPDATE uris u
SET content_type_ids = pu.ids
FROM per_uri pu
WHERE u.id = pu.uri_id
  AND u.content_type_ids <> pu.ids;

COMMIT;

----------------------------------------------------------------
-- 3. The index that makes the BitmapAnd possible.
--
-- CONCURRENTLY so ingest isn't blocked; it cannot run inside a transaction.
-- Overlap (&&) is the array_ops strategy GIN provides.
----------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_uris_content_type_ids
ON uris USING gin (content_type_ids);

----------------------------------------------------------------
-- 4. Functions
----------------------------------------------------------------
BEGIN;

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
  -- Into a variable, not a CTE, so the filtered paths see a plain array constant
  -- and idx_uris_content_type_ids is usable.
  v_ct_ids    BIGINT[];
BEGIN

  IF v_has_type THEN
    SELECT COALESCE(array_agg(ct.id ORDER BY ct.id), '{}'::BIGINT[])
      INTO v_ct_ids
    FROM content_types ct
    WHERE ct.base_type = content_type_base(p_content_type)
       OR ct.type ILIKE ('%' || p_content_type || '%');

    IF array_length(v_ct_ids, 1) IS NULL THEN
      RETURN;
    END IF;
  END IF;

  -- CASE 1: query, no filter. Fenced so the trigram index builds the candidate
  -- set first; without it the planner walks idx_uris_recursion_level_uri for
  -- free ordering and ILIKE-filters 141k index entries instead.
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

  -- CASE 2: query + filter. One BitmapAnd of idx_uris_trgm and
  -- idx_uris_content_type_ids. No per-candidate probe.
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
    WHERE resp.content_type_id = ANY (v_ct_ids)
    ORDER BY mu.recursion_level ASC, mu.uri ASC, rec.archived_date DESC;
    RETURN;
  END IF;

  -- CASE 3: browse, no filter. idx_uris_recursion_level_uri in display order,
  -- stop after OFFSET+LIMIT.
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

  -- CASE 4: browse + filter. Walk in display order, test the array on the tuple
  -- the index scan already fetched, stop once OFFSET+LIMIT qualify.
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

-- MUST keep the same URI predicate as the CTEs above, or the page count and the
-- pages disagree.
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

COMMIT;

----------------------------------------------------------------
-- 5. VACUUM. NOT optional after step 2.
--
-- The backfill rewrote most of `uris`, leaving a dead tuple per updated row and a
-- visibility map full of zeroes. Until this runs, index-only scans on uris visit
-- the heap for every row and the bitmap heap scan reads bloated pages. ANALYZE
-- alone does not set visibility-map bits; only VACUUM does.
----------------------------------------------------------------
VACUUM (ANALYZE) uris;

----------------------------------------------------------------
-- 6. Retire the superseded table and its indexes.
----------------------------------------------------------------
DROP TABLE IF EXISTS uri_content_types CASCADE;

DROP INDEX CONCURRENTLY IF EXISTS idx_responses_content_type_notnull;
DROP INDEX CONCURRENTLY IF EXISTS idx_content_types_charset;

----------------------------------------------------------------
-- 7. Statistics
----------------------------------------------------------------
ALTER TABLE uris ALTER COLUMN uri SET STATISTICS 1000;
ANALYZE uris;
ANALYZE content_types;

----------------------------------------------------------------
-- 8. Verify. Both columns should be 0.
----------------------------------------------------------------
-- SELECT
--   -- URIs whose stored set disagrees with what records/responses imply
--   (SELECT count(*) FROM uris u
--      LEFT JOIN (
--        SELECT rec.uri_id,
--               array_agg(DISTINCT resp.content_type_id ORDER BY resp.content_type_id) AS ids
--        FROM records rec
--        JOIN responses resp ON resp.record_id = rec.id
--        WHERE resp.content_type_id IS NOT NULL AND rec.uri_id IS NOT NULL
--        GROUP BY rec.uri_id
--      ) d ON d.uri_id = u.id
--      WHERE u.content_type_ids <> COALESCE(d.ids, '{}'::BIGINT[])
--   ) AS mismatched_uris,
--   -- ids in the arrays that no longer exist in content_types
--   (SELECT count(*) FROM (
--       SELECT DISTINCT e FROM uris, unnest(content_type_ids) e
--     ) x WHERE NOT EXISTS (SELECT 1 FROM content_types ct WHERE ct.id = x.e)
--   ) AS orphan_ids;
