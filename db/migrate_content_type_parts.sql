-- migrate_content_type_parts.sql
-- Adds decomposed content-type columns (base_type, charset) to content_types so
-- results can be ordered/searched by base MIME type or charset independently.
-- Non-destructive; safe on an existing database with data. Self-backfills.
--   psql "$DATABASE_URL" -f backend/db/migrate_content_type_parts.sql

BEGIN;

-- 1) Decomposition helpers (IMMUTABLE) — used by the insert path and the backfill.
CREATE OR REPLACE FUNCTION content_type_base(p_type TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(lower(btrim(split_part(p_type, ';', 1))), '')
$$;

CREATE OR REPLACE FUNCTION content_type_charset(p_type TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(btrim(substring(lower(p_type) FROM 'charset[[:space:]]*=[[:space:]]*([^;]+)'), ' "'), '')
$$;

-- 2) New columns (nullable; backfilled below).
ALTER TABLE content_types ADD COLUMN IF NOT EXISTS base_type TEXT;
ALTER TABLE content_types ADD COLUMN IF NOT EXISTS charset TEXT;

-- 3) Replace insert_warc_response_full so new inserts fill base_type/charset.
--    Same signature as the current function (recursion_level included), so
--    CREATE OR REPLACE swaps only the body.
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

  -- 3) content_types (optional): store the full type plus its decomposed parts.
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

-- 4) Backfill existing rows using the same helpers.
UPDATE content_types
SET base_type = content_type_base(type),
    charset   = content_type_charset(type);

-- 5) Indexes for ordering/searching.
CREATE INDEX IF NOT EXISTS idx_content_types_base_charset ON content_types(base_type, charset);
CREATE INDEX IF NOT EXISTS idx_content_types_charset ON content_types(charset);

COMMIT;
