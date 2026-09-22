-- migrate_latest_feed.sql
--
-- Replaces the newest-N feed's query shape. Apply with:
--   psql "$DATABASE_URL" -f backend/db/migrate_latest_feed.sql
-- or:
--   docker compose exec -T postgres-archives \
--     psql -U postgres -d archives < backend/db/migrate_latest_feed.sql
--
-- WHY
--
-- The homepage feed ran `SELECT * FROM latest_responses WHERE content_type ILIKE
-- '%text/html%' ORDER BY archived_date DESC LIMIT 12`. Selecting from a view lets
-- the planner fold the filter into the joins, and it chose to work backwards:
--
--   Parallel Seq Scan on responses      632,641 rows
--   -> filter to text/html              291,524 rows
--   -> records_pkey  x 291,524
--   -> uris_pkey     x 291,524
--   -> sort 291,524 rows by archived_date
--   -> return 12
--
--   shared hit=2,305,611 read=67,955 written=12,675   Execution Time: 4,129 ms
--
-- Two things made that expensive beyond the row count: responses rows are
-- width=489 because of the headers JSONB, and all 291k of them were dragged
-- through the join before the sort threw them away.
--
-- The replacement walks records backward on archived_date, checks each one's
-- response via the (record_id, content_type_id, status) index, stops at the
-- limit, and only then fetches the wide columns for the survivors. ~46% of
-- responses are HTML, so finding 12 should examine a few dozen records.
--
-- Idempotent: CREATE OR REPLACE only, no data touched.

BEGIN;

----------------------------------------------------------------
-- 1. View loses its ORDER BY
--
-- It bought nothing (callers re-sort) and it made the view read as "the latest
-- responses" when it is really "all responses, joined" — which is the framing
-- that produced the plan above. Kept as a general-purpose join; the feed no
-- longer goes through it.
----------------------------------------------------------------
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

----------------------------------------------------------------
-- 2. The feed as its own two-phase function
----------------------------------------------------------------
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

  -- No filter: every record qualifies, so the index walk alone is the answer.
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

  -- Filtered: resolve the type to ids once, then probe per record while walking
  -- newest-first. LATERAL rather than EXISTS pins the nested loop so the ordered
  -- records scan stays the driver — EXISTS is what let the planner invert this.
  -- LIMIT 1 is redundant (responses.record_id is UNIQUE) but guards the join
  -- against that constraint ever relaxing.
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

COMMIT;

----------------------------------------------------------------
-- 3. Drop the write-only indexes flagged by pg_stat_user_indexes.
--    CONCURRENTLY cannot run inside a transaction block, hence after COMMIT.
--    Both are pure write amplification during ingest.
----------------------------------------------------------------
DROP INDEX CONCURRENTLY IF EXISTS idx_responses_content_type_notnull;
DROP INDEX CONCURRENTLY IF EXISTS idx_content_types_charset;

----------------------------------------------------------------
-- 4. Verify: this should now report a nested loop driven by
--    idx_records_archived_date with a few dozen loops on resp_check, not a
--    parallel seq scan of responses.
----------------------------------------------------------------
-- SET track_io_timing = on;
-- EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SUMMARY)
-- SELECT * FROM get_latest_responses('text/html', 12);
--
-- EXPLAIN (ANALYZE, BUFFERS, SUMMARY)
-- SELECT * FROM get_latest_responses(NULL, 12);
