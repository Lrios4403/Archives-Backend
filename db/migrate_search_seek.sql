-- Seek ("keyset") pagination for search, alongside the existing OFFSET path.
--
-- ## Why
--
-- OFFSET pagination re-pays a fixed prefix on every page. Measured on the live
-- database for q = 'kiwifarms.net' (3,592,000 matching uris):
--
--     OFFSET  320 LIMIT 16   ->  1,386 ms   shared hit = 846,549
--     OFFSET 3200 LIMIT 16   ->  1,525 ms
--     SEEK past page 20      ->     34 ms   shared hit =   8,857
--     SEEK past page 200     ->     14 ms
--
-- That is 40-100x, and flat in depth rather than merely cheaper. The reason is
-- visible in the plan: to produce 336 matches in (recursion_level, uri) order
-- starting from the beginning, Postgres must apply the ILIKE to 1,078,036
-- non-matching index entries and discard them. The seek form starts the index
-- scan AT the previous page's last row, so it filters 11,075 instead.
--
--     Index Cond: (ROW(recursion_level, uri) > ROW(1, 'https://ghostarchive...'))
--
-- The row-comparison is what makes this an Index Cond rather than a Filter, and
-- it is why the sort key and the index must stay (recursion_level, uri) in that
-- order. Comparing the columns separately (a > x OR (a = x AND b > y)) does NOT
-- produce an Index Cond and would undo the whole thing.
--
-- ## Deliberately narrow
--
-- Only the no-content-type case. With ?content_type= set, the planner uses a
-- BitmapAnd of idx_uris_trgm and idx_uris_content_type_ids rather than walking
-- idx_uris_recursion_level_uri, so a seek predicate on that index does not apply
-- and the match set is small enough that OFFSET is not the problem. db.ts only
-- calls this when p_content_type IS NULL; everything else keeps the existing
-- path unchanged.
--
-- ## The extra column
--
-- Returns recursion_level as well, because the caller cannot build the NEXT
-- cursor without it. The existing search_responses() is untouched.
--
-- Safe to run against a live database: CREATE OR REPLACE of a function that did
-- not previously exist. No table is read or locked beyond normal query access.

CREATE OR REPLACE FUNCTION search_responses_after(
  p_query        TEXT,
  p_after_level  INT,
  p_after_uri    TEXT,
  p_limit_count  BIGINT DEFAULT 16
)
RETURNS TABLE(
  response_id     BIGINT,
  status          INTEGER,
  last_modified   TIMESTAMPTZ,
  archived_date   TIMESTAMPTZ,
  warc_custom_id  TEXT,
  uri             TEXT,
  recursion_level INTEGER
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
ROWS 100
AS $$
#variable_conflict use_column
DECLARE
  v_has_query  BOOLEAN := COALESCE(btrim(p_query), '') <> '';
  -- A NULL cursor means "from the beginning", which is page 1 and is already
  -- fast. Treated as the lowest possible key rather than special-cased, so there
  -- is one query shape and not two.
  v_level      INT  := COALESCE(p_after_level, -1);
  v_uri        TEXT := COALESCE(p_after_uri, '');
BEGIN
  RETURN QUERY
  WITH matched_uris AS MATERIALIZED (
    SELECT u.id, u.uri, u.recursion_level
    FROM uris u
    WHERE (NOT v_has_query OR u.uri ILIKE ('%' || p_query || '%'))
      AND (u.recursion_level, u.uri) > (v_level, v_uri)
    ORDER BY u.recursion_level ASC, u.uri ASC
    LIMIT p_limit_count
  )
  SELECT resp.id, resp.status, resp.last_modified,
         rec.archived_date, rec.warc_custom_id, mu.uri, mu.recursion_level
  FROM matched_uris mu
  JOIN records rec    ON rec.uri_id = mu.id
  JOIN responses resp ON resp.record_id = rec.id
  ORDER BY mu.recursion_level ASC, mu.uri ASC, rec.archived_date DESC;
END;
$$;
