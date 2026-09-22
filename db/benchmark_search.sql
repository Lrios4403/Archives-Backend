-- benchmark_search.sql
--
--   docker compose exec -T postgres-archives psql -U postgres -d archives \
--     < backend/db/benchmark_search.sql
--
-- Exercises the CURRENT functions, and refuses to let you misread the result.
--
-- Two traps this avoids:
--
--   1. Benchmarking an OFFSET past the end of the result set. A plan whose Limit
--      reports rows=0 measures nothing — everything below it says "never
--      executed" — and it looks fast. Section 2 prints how many URIs actually
--      match before section 4 uses an offset.
--
--   2. Benchmarking a half-ingested archive. Section 1 prints table sizes so the
--      numbers are interpretable; buffers that scale down with row count mean the
--      plan didn't change, it just had less to read.
--
-- Run it against a settled archive, ideally twice: once with ingest active and
-- once idle. The difference between those two is the I/O contention question,
-- and it is separate from plan shape.

\timing on
\pset pager off

\echo '=============== 1. is the archive actually populated? ==============='
\echo '(compare against the run you are comparing to — earlier plans were taken'
\echo ' at ~80k uris / ~633k responses / ~291k text/html)'
SELECT 'uris'              AS table, count(*) FROM uris
UNION ALL SELECT 'records',            count(*) FROM records
UNION ALL SELECT 'responses',          count(*) FROM responses
UNION ALL SELECT 'content_types',      count(*) FROM content_types
UNION ALL SELECT 'ips',                count(*) FROM ips;

\echo ''
\echo '=============== 2. how many rows does the test query even have? ==============='
\echo 'Pick an OFFSET below the matching-URI count, or the plan measures nothing.'
SELECT
    search_responses_count('test', NULL)        AS uris_matching_test,
    search_responses_count('test', 'text/html') AS uris_matching_test_html,
    search_responses_count('', NULL)            AS uris_total,
    search_responses_count('', 'text/html')     AS uris_total_html;

\echo ''
\echo '=============== 3. is uris.content_type_ids populated and correct? ==============='
-- mismatched_uris must be 0. If it equals the URI count, the ingest predates the
-- column: apply migrate_uri_content_type_ids.sql or reparse. CASE 2/4 return
-- nothing when the arrays are empty, which looks like a fast query returning no
-- rows — the same false negative as benchmarking past the end of a result set.
SELECT
    (SELECT count(*) FROM uris)                                  AS uris,
    (SELECT count(*) FROM uris WHERE content_type_ids <> '{}')    AS uris_with_types,
    (SELECT count(*) FROM uris u
       LEFT JOIN (
         SELECT rec.uri_id,
                array_agg(DISTINCT resp.content_type_id ORDER BY resp.content_type_id) AS ids
         FROM records rec
         JOIN responses resp ON resp.record_id = rec.id
         WHERE resp.content_type_id IS NOT NULL AND rec.uri_id IS NOT NULL
         GROUP BY rec.uri_id
       ) d ON d.uri_id = u.id
       WHERE u.content_type_ids <> COALESCE(d.ids, '{}'::BIGINT[])
    )                                                             AS mismatched_uris;

\echo ''
\echo '=============== 3b. VACUUM first, or the bitmap heap scan reads bloat ==============='
-- Ingest and the backfill both leave `uris` with dead tuples and a
-- visibility map full of zeroes. The BitmapAnd in CASE 2 still has to recheck
-- ILIKE on the heap, so it reads those pages — bloated ones cost extra — and any
-- index-only scan degrades to heap fetches. ANALYZE does NOT set visibility-map
-- bits; only VACUUM does. Watch "Heap Blocks" and "Heap Fetches" below.
VACUUM (ANALYZE) uris;

\echo ''
\echo '=============== 4. the four search paths, OFFSET 0 ==============='
SET track_io_timing = on;

\echo '--- CASE 1: query, no filter (previously ~1.5s: ILIKE over 141k index entries) ---'
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, SUMMARY)
SELECT * FROM search_responses('test', 0, 100, NULL);

\echo '--- CASE 2: query + filter (previously ~2.8s: 201k response-first scan) ---'
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, SUMMARY)
SELECT * FROM search_responses('test', 0, 100, 'text/html');

\echo '--- CASE 3: browse, no filter ---'
EXPLAIN (ANALYZE, BUFFERS, SUMMARY)
SELECT * FROM search_responses('', 0, 100, NULL);

\echo '--- CASE 4: browse + filter ---'
EXPLAIN (ANALYZE, BUFFERS, SUMMARY)
SELECT * FROM search_responses('', 0, 100, 'text/html');

\echo ''
\echo '=============== 5. second run: plan is cached, so this is execution only ==============='
\echo '(the ad-hoc version spent 13.7ms planning vs 0.6ms executing — plpgsql'
\echo ' functions cache their plans per session, so the steady state is run 2)'
EXPLAIN (ANALYZE, BUFFERS, SUMMARY)
SELECT * FROM search_responses('test', 0, 100, 'text/html');

\echo ''
\echo '=============== 6. the newest-N feed (previously 4.1s / 2.3M buffers) ==============='
\echo 'Want: nested loop driven by idx_records_archived_date, a few dozen loops on'
\echo 'resp_check, NOT a parallel seq scan of responses.'
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SUMMARY)
SELECT * FROM get_latest_responses('text/html', 12);

EXPLAIN (ANALYZE, BUFFERS, SUMMARY)
SELECT * FROM get_latest_responses(NULL, 12);

\echo ''
\echo '=============== 7. are the index-only scans actually index-only? ==============='
-- "Heap Fetches" well above 0 in the plans above means the visibility map is
-- dirty from ingest, so an Index Only Scan is still visiting the heap. That is an
-- ingest-contention symptom, not a plan problem — one earlier run showed 16 heap
-- fetches out of 24 probes.
SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS pct_dead,
    last_autovacuum,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE relname IN ('uris','records','responses','content_types')
ORDER BY relname;

\echo ''
\echo '=============== 8. planner estimate accuracy for the trigram scan ==============='
-- The persistent problem: `uri ILIKE %x%` selectivity. Compare estimated vs
-- actual on the Bitmap Index Scan in CASE 1/2 above. Still off by >10x after
-- ANALYZE means the statistics target needs raising again, or that ANALYZE ran
-- mid-ingest and was stale before it finished.
SELECT
    attname,
    attstattarget AS statistics_target,
    n_distinct,
    array_length(most_common_vals::text::text[], 1) AS mcv_count
FROM pg_stats
JOIN pg_attribute a ON a.attname = pg_stats.attname
  AND a.attrelid = 'uris'::regclass
WHERE schemaname = 'public' AND tablename = 'uris' AND pg_stats.attname = 'uri';
