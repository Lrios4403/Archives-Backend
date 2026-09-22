-- migrate_bulk_insert_fix.sql
--
-- Repairs insert_warc_responses_full() on a LIVE database. setup.sql is only
-- replayed by reset_database(), so an already-populated instance needs this.
--
-- Apply with:
--   psql "$DATABASE_URL" -f backend/db/migrate_bulk_insert_fix.sql
-- or, from the compose stack:
--   docker compose exec -T postgres-archives \
--     psql -U postgres -d archives < backend/db/migrate_bulk_insert_fix.sql
--
-- WHAT WAS BROKEN
--
-- The RETURNS TABLE output names (warc_custom_id, record_id, response_id) are
-- plpgsql variables inside the body. Both bulk upserts infer their conflict
-- target by bare column name -- `ON CONFLICT (warc_custom_id)` in step 6 and
-- `ON CONFLICT (record_id)` in step 7 -- and an inference target cannot be
-- table-qualified, so the names resolve ambiguously and every call fails with:
--
--     column reference "warc_custom_id" is ambiguous
--
-- (Step 6 raises first; step 7 is the same bug waiting behind it.)
--
-- The fix is the `#variable_conflict use_column` directive. Nothing else in the
-- function changes -- the body below is identical to db/setup.sql.
--
-- Idempotent: CREATE OR REPLACE, no data is touched.

BEGIN;

CREATE OR REPLACE FUNCTION insert_warc_responses_full(
    p_rows warc_response_bulk_input[]
)
RETURNS TABLE (
    warc_custom_id TEXT,
    record_id      BIGINT,
    response_id    BIGINT
)
LANGUAGE plpgsql
-- Resolve names that are both an OUT variable and a column to the COLUMN.
-- Safe: this function never reads or assigns its OUT variables -- every row it
-- returns comes from the RETURN QUERY at the bottom. The directive must be the
-- first thing inside $$, ahead of DECLARE/BEGIN.
AS $$
#variable_conflict use_column
BEGIN
    ---------------------------------------------------------------------------
    -- Empty batch: nothing to do.
    ---------------------------------------------------------------------------
    IF p_rows IS NULL OR cardinality(p_rows) = 0 THEN
        RETURN;
    END IF;


    ---------------------------------------------------------------------------
    -- Validate required URI.
    --
    -- Matches insert_warc_response_full(), which explicitly requires p_uri.
    ---------------------------------------------------------------------------
    IF EXISTS (
        SELECT 1
        FROM unnest(p_rows) AS r
        WHERE r.uri IS NULL
           OR length(trim(r.uri)) = 0
    ) THEN
        RAISE EXCEPTION 'insert_warc_responses_full: uri is required';
    END IF;


    ---------------------------------------------------------------------------
    -- warc_custom_id uniquely identifies a record.
    --
    -- Do not permit the same record twice inside a single batch. Apart from
    -- protecting against parser bugs, this prevents INSERT ... ON CONFLICT
    -- from attempting to affect the same records row twice.
    ---------------------------------------------------------------------------
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
    ---------------------------------------------------------------------------
    INSERT INTO warc_files (
        file_path
    )
    SELECT DISTINCT
        r.file_path
    FROM unnest(p_rows) AS r
    ON CONFLICT (file_path) DO NOTHING;


    ---------------------------------------------------------------------------
    -- 2. IP ADDRESSES
    ---------------------------------------------------------------------------
    INSERT INTO ips (
        ip
    )
    SELECT DISTINCT
        r.ip
    FROM unnest(p_rows) AS r
    WHERE r.ip IS NOT NULL
    ON CONFLICT (ip) DO NOTHING;


    ---------------------------------------------------------------------------
    -- 3. CONTENT TYPES
    ---------------------------------------------------------------------------
    INSERT INTO content_types (
        type,
        base_type,
        charset
    )
    SELECT DISTINCT
        r.http_content_type,
        content_type_base(r.http_content_type),
        content_type_charset(r.http_content_type)
    FROM unnest(p_rows) AS r
    WHERE r.http_content_type IS NOT NULL
      AND length(trim(r.http_content_type)) > 0

    ON CONFLICT (type) DO UPDATE
    SET
        base_type = EXCLUDED.base_type,
        charset   = EXCLUDED.charset

    WHERE content_types.base_type
              IS DISTINCT FROM EXCLUDED.base_type
       OR content_types.charset
              IS DISTINCT FROM EXCLUDED.charset;


    ---------------------------------------------------------------------------
    -- 4. URIS
    ---------------------------------------------------------------------------
    INSERT INTO uris (
        uri,
        recursion_level
    )
    SELECT
        src.uri,
        src.recursion_level
    FROM (
        SELECT DISTINCT ON (r.uri)
            r.uri,
            COALESCE(r.recursion_level, 0) AS recursion_level
        FROM unnest(p_rows) WITH ORDINALITY AS r
        ORDER BY
            r.uri,
            r.ordinality DESC
    ) AS src

    ON CONFLICT (uri) DO UPDATE
    SET recursion_level = EXCLUDED.recursion_level

    WHERE uris.recursion_level
              IS DISTINCT FROM EXCLUDED.recursion_level;


    ---------------------------------------------------------------------------
    -- 5. PAYLOADS
    ---------------------------------------------------------------------------
    WITH payload_source AS (
        SELECT DISTINCT ON (
            wf.id,
            r.payload_byte_offset,
            r.payload_byte_length
        )
            wf.id                       AS file_id,
            r.payload_byte_offset       AS byte_offset,
            r.payload_byte_length       AS byte_length,
            r.payload_digest            AS payload_digest,
            r.payload_chunks            AS chunks

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
        file_id,
        byte_offset,
        byte_length,
        payload_digest,
        chunks
    FROM payload_source

    ON CONFLICT (
        file_id,
        byte_offset,
        byte_length
    )
    DO UPDATE
    SET
        payload_digest = EXCLUDED.payload_digest,
        chunks         = EXCLUDED.chunks

    WHERE payloads.payload_digest
              IS DISTINCT FROM EXCLUDED.payload_digest
       OR payloads.chunks
              IS DISTINCT FROM EXCLUDED.chunks;


    ---------------------------------------------------------------------------
    -- 6. RECORDS
    --
    -- `ON CONFLICT (warc_custom_id)` below is the reference that used to be
    -- ambiguous with the OUT variable of the same name.
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

    ON CONFLICT (warc_custom_id) DO UPDATE
    SET
        warc_file_id   = EXCLUDED.warc_file_id,
        archived_date  = EXCLUDED.archived_date,
        uri_id         = EXCLUDED.uri_id,
        ip_id          = EXCLUDED.ip_id,
        payload_id     = EXCLUDED.payload_id,
        payload_digest = EXCLUDED.payload_digest

    -- Avoid rewriting a record if reparsing produced exactly the same data.
    WHERE records.warc_file_id
              IS DISTINCT FROM EXCLUDED.warc_file_id

       OR records.archived_date
              IS DISTINCT FROM EXCLUDED.archived_date

       OR records.uri_id
              IS DISTINCT FROM EXCLUDED.uri_id

       OR records.ip_id
              IS DISTINCT FROM EXCLUDED.ip_id

       OR records.payload_id
              IS DISTINCT FROM EXCLUDED.payload_id

       OR records.payload_digest
              IS DISTINCT FROM EXCLUDED.payload_digest;


    ---------------------------------------------------------------------------
    -- 7. RESPONSES
    --
    -- `ON CONFLICT (record_id)` was the same ambiguity, one step behind.
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
     AND length(trim(r.http_content_type)) > 0

    ON CONFLICT (record_id) DO UPDATE
    SET
        http_version = 'HTTP/1.1',

        status =
            COALESCE(
                EXCLUDED.status,
                responses.status
            ),

        content_type_id =
            EXCLUDED.content_type_id,

        headers =
            COALESCE(
                responses.headers,
                '{}'::jsonb
            )
            ||
            COALESCE(
                EXCLUDED.headers,
                '{}'::jsonb
            ),

        last_modified =
            COALESCE(
                EXCLUDED.last_modified,
                responses.last_modified
            );


    ---------------------------------------------------------------------------
    -- Return one mapping for every input response.
    --
    -- WITH ORDINALITY preserves the order in which Bun supplied the batch.
    ---------------------------------------------------------------------------
    RETURN QUERY
    SELECT
        r.warc_custom_id,
        rec.id  AS record_id,
        resp.id AS response_id

    FROM unnest(p_rows) WITH ORDINALITY AS r

    JOIN records rec
      ON rec.warc_custom_id = r.warc_custom_id

    JOIN responses resp
      ON resp.record_id = rec.id

    ORDER BY r.ordinality;

END;
$$;

COMMIT;
