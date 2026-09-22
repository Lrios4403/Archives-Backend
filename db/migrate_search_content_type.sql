-- migrate_search_content_type.sql
-- Adds an optional content-type filter to search. Blank/absent => ignored.
-- Non-destructive to data; only replaces the two search functions.
--   psql "$DATABASE_URL" -f backend/db/migrate_search_content_type.sql

BEGIN;

-- Drop old (and any prior new) overloads so only the filtered versions remain.
DROP FUNCTION IF EXISTS search_responses(TEXT, BIGINT, BIGINT) CASCADE;
DROP FUNCTION IF EXISTS search_responses(TEXT, BIGINT, BIGINT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS search_responses_count(TEXT) CASCADE;
DROP FUNCTION IF EXISTS search_responses_count(TEXT, TEXT) CASCADE;

CREATE OR REPLACE FUNCTION search_responses(
  p_query        TEXT,
  p_offset       BIGINT DEFAULT 0,
  p_limit_count  BIGINT DEFAULT 100,
  p_content_type TEXT DEFAULT NULL
)
RETURNS TABLE(
  response_id    BIGINT,
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
LANGUAGE sql
AS $$
WITH
matched_uris AS (
  SELECT u.id, u.uri, u.recursion_level
  FROM uris u
  WHERE u.uri ILIKE ('%' || p_query || '%')
    AND (
      p_content_type IS NULL OR btrim(p_content_type) = ''
      OR EXISTS (
        SELECT 1
        FROM records rec
        JOIN responses resp ON resp.record_id = rec.id
        JOIN content_types ct ON ct.id = resp.content_type_id
        WHERE rec.uri_id = u.id
          AND ct.type ILIKE ('%' || p_content_type || '%')
      )
    )
  ORDER BY u.recursion_level ASC, u.uri ASC
  LIMIT p_limit_count
  OFFSET p_offset
),
matched AS (
  SELECT
    resp.id                        AS response_id,
    resp.status,
    resp.headers,
    resp.http_version,
    resp.last_modified,
    rec.archived_date,
    rec.warc_custom_id,
    mu.uri,
    mu.recursion_level,
    ip.ip                          AS ip,
    ct.type                        AS content_type
  FROM matched_uris mu
  JOIN records rec      ON rec.uri_id = mu.id
  JOIN responses resp   ON resp.record_id = rec.id
  LEFT JOIN ips ip      ON rec.ip_id = ip.id
  LEFT JOIN content_types ct ON resp.content_type_id = ct.id
  WHERE (
    p_content_type IS NULL OR btrim(p_content_type) = ''
    OR ct.type ILIKE ('%' || p_content_type || '%')
  )
)
SELECT
  response_id,
  status,
  headers,
  http_version,
  last_modified,
  archived_date,
  warc_custom_id,
  uri,
  ip,
  content_type
FROM matched
ORDER BY recursion_level ASC, uri ASC, archived_date DESC
$$;

CREATE OR REPLACE FUNCTION search_responses_count(p_query TEXT, p_content_type TEXT DEFAULT NULL)
RETURNS BIGINT
LANGUAGE sql
AS $$
  SELECT COUNT(*)::BIGINT
  FROM uris u
  WHERE u.uri ILIKE ('%' || p_query || '%')
    AND (
      p_content_type IS NULL OR btrim(p_content_type) = ''
      OR EXISTS (
        SELECT 1
        FROM records rec
        JOIN responses resp ON resp.record_id = rec.id
        JOIN content_types ct ON ct.id = resp.content_type_id
        WHERE rec.uri_id = u.id
          AND ct.type ILIKE ('%' || p_content_type || '%')
      )
    );
$$;

COMMIT;
