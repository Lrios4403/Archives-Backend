-- RECOVERED FROM THE RUNNING DATABASE. Do not hand-edit to change behaviour.
--
-- Why this file exists
-- --------------------
-- The search functions that production actually runs were created by hand against
-- the live database and were never written back to the repo. Three consequences,
-- all of them live before this file was written:
--
--   * search_responses_broad() appeared in NO .sql file at all. The only traces in
--     the repo were a comment and a call in backend/db.ts. It could not be rebuilt.
--   * backend/db/setup.sql's search_responses() still held the OLD four-case body
--     whose CASE 1 is the MATERIALIZED trigram-then-sort shape -- i.e. the ~19s
--     "broad" plan, sitting under the fast function's name.
--   * backend/db/setup.sql's search_responses_count() is an uncapped COUNT(*),
--     while the deployed one stops at 10000+1. The cap is what took that query
--     from 10.5s to 75ms.
--
-- So running setup.sql against production would have installed the slow plan under
-- the fast name, removed the count cap, and left backend/db.ts calling a function
-- that no longer exists. reset_database() in backend/db.ts runs setup.sql.
--
-- Captured 2026-09-17T00:43:30.224Z from postgres://<host>/warcs via pg_get_functiondef.

-- ===================== FUNCTIONS =====================

-- ----------------------------------------------------------------------
-- content_type_base
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.content_type_base(p_type text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT nullif(lower(btrim(split_part(p_type, ';', 1))), '')
$function$
;

-- ----------------------------------------------------------------------
-- search_responses
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_responses(p_query text, p_offset bigint DEFAULT 0, p_limit_count bigint DEFAULT 100, p_content_type text DEFAULT NULL::text)
 RETURNS TABLE(response_id bigint, status integer, last_modified timestamp with time zone, archived_date timestamp with time zone, warc_custom_id text, uri text)
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE ROWS 100
AS $function$
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
    -- ONE cte: filter, order and limit together.
    --
    -- This was two, the first MATERIALIZED and unlimited. MATERIALIZED is an
    -- optimisation FENCE, so every matching uri was built and stored before the
    -- ORDER BY/LIMIT could run - 1.69M rows for 'kiwifarms' to return 16.
    -- Merged, the planner walks idx_uris_recursion_level_uri in the order the
    -- query already wants and stops at the 16th match. Measured: 10,904ms -> 31ms.
    --
    -- The old shape is NOT gone: it lives in search_responses_broad(), because
    -- it still wins where matches sit late in that ordering ('onionfarms' is
    -- 187ms fenced against 1,189ms here). db.ts tries this one under a short
    -- statement_timeout and falls back to that when it does not land.
    WITH matched_uris AS MATERIALIZED (
      SELECT u.id, u.uri, u.recursion_level
      FROM uris u
      WHERE u.uri ILIKE ('%' || p_query || '%')
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
$function$
;

-- ----------------------------------------------------------------------
-- search_responses_broad
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_responses_broad(p_query text, p_offset bigint DEFAULT 0, p_limit_count bigint DEFAULT 100, p_content_type text DEFAULT NULL::text)
 RETURNS TABLE(response_id bigint, status integer, last_modified timestamp with time zone, archived_date timestamp with time zone, warc_custom_id text, uri text)
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE ROWS 100
AS $function$
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
$function$
;

-- ----------------------------------------------------------------------
-- search_responses_count
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_responses_count(p_query text, p_content_type text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$
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
    SELECT COUNT(*) INTO v_count FROM (
      SELECT 1 FROM uris u
      WHERE u.uri ILIKE ('%' || p_query || '%')
      AND u.content_type_ids && v_ct_ids
      LIMIT 10000+1
    ) capped;
  ELSIF v_has_query THEN
    SELECT COUNT(*) INTO v_count FROM (
      SELECT 1 FROM uris u
      WHERE u.uri ILIKE ('%' || p_query || '%')
      LIMIT 10000+1
    ) capped;
  ELSIF v_has_type THEN
    SELECT COUNT(*) INTO v_count FROM uris u
    WHERE u.content_type_ids && v_ct_ids;
  ELSE
    SELECT COUNT(*) INTO v_count FROM uris u;
  END IF;

  RETURN v_count;
END;
$function$
;

-- ===================== INDEXES ON uris =====================
-- idx_uris_content_type_ids
CREATE INDEX idx_uris_content_type_ids ON public.uris USING gin (content_type_ids);
-- idx_uris_recursion_level_uri
CREATE INDEX idx_uris_recursion_level_uri ON public.uris USING btree (recursion_level, uri);
-- idx_uris_trgm
CREATE INDEX idx_uris_trgm ON public.uris USING gin (uri gin_trgm_ops);
-- uris_pkey
CREATE UNIQUE INDEX uris_pkey ON public.uris USING btree (id);
-- uris_uri_key
CREATE UNIQUE INDEX uris_uri_key ON public.uris USING btree (uri);

-- ===================== NON-DEFAULT SETTINGS =====================
--   autovacuum_worker_slots = 16   (source: configuration file)
--   DateStyle = ISO, MDY   (source: configuration file)
--   default_text_search_config = pg_catalog.english   (source: configuration file)
--   dynamic_shared_memory_type = posix   (source: configuration file)
--   lc_messages = en_US.utf8   (source: configuration file)
--   lc_monetary = en_US.utf8   (source: configuration file)
--   lc_numeric = en_US.utf8   (source: configuration file)
--   lc_time = en_US.utf8   (source: configuration file)
--   listen_addresses = *   (source: configuration file)
--   log_timezone = Etc/UTC   (source: configuration file)
--   max_connections = 100   (source: configuration file)
--   max_wal_size = 1024MB   (source: configuration file)
--   min_wal_size = 80MB   (source: configuration file)
--   shared_buffers = 5242888kB   (source: configuration file)
--   TimeZone = Etc/UTC   (source: configuration file)
