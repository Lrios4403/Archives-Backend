-- migrate_recursion_level_backfill.sql
--
--   docker compose exec -T postgres-archives \
--     psql -U postgres -d archives < backend/db/migrate_recursion_level_backfill.sql
--
-- WHAT WAS WRONG
--
-- uris.recursion_level is the FIRST sort key for search and browse: results come
-- back shallowest-first (homepages), then A->Z within a level. search_responses
-- has always ordered by (recursion_level, uri).
--
-- But the value was computed in TypeScript and passed in through the bulk-insert
-- composite, and parse.worker.ts sent a hardcoded zero:
--
--     recursion_level: 0, // TODO: implement recursion level calculation
--
-- So every URI in the database is level 0. A constant first sort key does nothing,
-- and the ordering silently collapsed to plain uri ASC — homepages were never
-- lifted above deep pages.
--
-- setup.sql now derives it in SQL with uri_recursion_level(), so new rows are
-- correct. Existing rows are NOT repaired by re-parsing: step 4 of
-- insert_warc_responses_full uses ON CONFLICT (uri) DO NOTHING, which by design
-- never touches an existing URI row. Hence this one-time backfill.
--
-- Safe to re-run; only rows whose stored level is already wrong are written.

BEGIN;

----------------------------------------------------------------
-- 1. The function, in case setup.sql hasn't been replayed here.
--    Mirrors recursionLevel() in db.ts.
----------------------------------------------------------------
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

----------------------------------------------------------------
-- 2. Spot-check the function before trusting it with a mass UPDATE.
--    Every row should read t.
----------------------------------------------------------------
SELECT
  uri_recursion_level('https://example.com')             = 0 AS homepage_no_slash,
  uri_recursion_level('https://example.com/')            = 0 AS homepage_slash,
  uri_recursion_level('http://example.com/a')            = 1 AS one_segment,
  uri_recursion_level('http://example.com/a/b')          = 2 AS two_segments,
  uri_recursion_level('http://example.com/a/b/')         = 2 AS trailing_slash,
  uri_recursion_level('http://example.com/a?x=1')        = 1 AS query_ignored,
  uri_recursion_level('http://example.com/a#frag')       = 1 AS fragment_ignored,
  uri_recursion_level('http://example.com/a//b')         = 2 AS empty_segment_ignored,
  uri_recursion_level('example.com/a/b')                 = 2 AS scheme_optional,
  uri_recursion_level(NULL)                              = 0 AS null_safe;

----------------------------------------------------------------
-- 3. Backfill.
--
-- The WHERE keeps this to the rows that are actually wrong. On an archive ingested
-- before the fix that is effectively every non-homepage URI, so expect a large
-- rewrite and matching bloat — step 4 handles it.
----------------------------------------------------------------
UPDATE uris u
SET recursion_level = uri_recursion_level(u.uri)
WHERE u.recursion_level <> uri_recursion_level(u.uri);

COMMIT;

----------------------------------------------------------------
-- 4. VACUUM. The UPDATE above leaves a dead tuple per changed row, and
--    idx_uris_recursion_level_uri — the index CASE 3/4 walk in display order —
--    now points at the old versions too. ANALYZE alone does not reclaim them or
--    set visibility-map bits.
----------------------------------------------------------------
VACUUM (ANALYZE) uris;

----------------------------------------------------------------
-- 5. Verify. mismatched must be 0, and the distribution should no longer be
--    100% level 0 unless the archive genuinely only holds homepages.
----------------------------------------------------------------
SELECT count(*) AS mismatched
FROM uris u
WHERE u.recursion_level <> uri_recursion_level(u.uri);

SELECT
    recursion_level,
    count(*) AS uris,
    round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM uris
GROUP BY recursion_level
ORDER BY recursion_level
LIMIT 15;

----------------------------------------------------------------
-- 6. What the ordering now produces. Homepages first, then A->Z within a level.
----------------------------------------------------------------
SELECT recursion_level, uri
FROM uris
ORDER BY recursion_level ASC, uri ASC
LIMIT 25;
