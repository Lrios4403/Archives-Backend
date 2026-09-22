-- migrate_recursion_level.sql
-- Non-destructive migration: adds uris.recursion_level, orders search/browse
-- results shallowest-first (homepages) then A->Z, and updates
-- insert_warc_response_full to accept + store the level.
--
-- Safe to run on an existing database WITH data — it does NOT drop any tables.
-- After running this, backfill existing rows:
--   cd backend && bun run scripts/backfill_recursion_level.ts
--
-- Apply with e.g.:
--   psql "$DATABASE_URL" -f backend/db/migrate_recursion_level.sql

BEGIN;

-- 1) New column (defaults to 0 so existing rows stay valid until backfilled).
ALTER TABLE uris ADD COLUMN IF NOT EXISTS recursion_level INT NOT NULL DEFAULT 0;

-- 2) Index that lets the planner return results already ordered.
CREATE INDEX IF NOT EXISTS idx_uris_recursion_level_uri ON uris(recursion_level, uri);

-- 3) Replace insert_warc_response_full: drop the old (pre-recursion_level)
--    overload, then create the new one that stores the level on the uri upsert.
DROP FUNCTION IF EXISTS insert_warc_response_full(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, INET, TEXT, TEXT, JSONB, INT, TIMESTAMPTZ, BIGINT, BIGINT, BIGINT[], TEXT
) CASCADE;

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
  -- 1) warc_files
  INSERT INTO warc_files (file_path) VALUES (p_file_path)
    ON CONFLICT (file_path) DO UPDATE SET file_path = EXCLUDED.file_path
    RETURNING id INTO v_file_id;

  -- 2) ips (optional)
  IF p_ip IS NOT NULL THEN
    INSERT INTO ips (ip) VALUES (p_ip)
      ON CONFLICT (ip) DO UPDATE SET ip = EXCLUDED.ip
      RETURNING id INTO v_ip_id;
  ELSE
    v_ip_id := NULL;
  END IF;

  -- 3) content_types (optional)
  IF p_http_content_type IS NOT NULL AND length(trim(p_http_content_type)) > 0 THEN
    INSERT INTO content_types (type) VALUES (p_http_content_type)
      ON CONFLICT (type) DO UPDATE SET type = EXCLUDED.type
      RETURNING id INTO v_ct_id;
  ELSE
    v_ct_id := NULL;
  END IF;

  -- 4) uris: required by records.uri_id; store recursion_level.
  IF p_uri IS NULL OR length(trim(p_uri)) = 0 THEN
    RAISE EXCEPTION 'p_uri is required';
  END IF;

  INSERT INTO uris (uri, recursion_level) VALUES (p_uri, COALESCE(p_recursion_level, 0))
    ON CONFLICT (uri) DO UPDATE SET recursion_level = EXCLUDED.recursion_level
    RETURNING id INTO v_uri_id;

  -- 5) payloads
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

  -- 6) records
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

  -- 7) responses
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

-- 4) Replace search_responses so results come back shallowest-first, then A->Z.
CREATE OR REPLACE FUNCTION search_responses(
  p_query        TEXT,
  p_offset       BIGINT DEFAULT 0,
  p_limit_count  BIGINT DEFAULT 100
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
  SELECT id, uri, recursion_level
  FROM uris
  WHERE uri ILIKE ('%' || p_query || '%')
  ORDER BY recursion_level ASC, uri ASC
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

COMMIT;
