-- diagnose_io.sql
--
-- Run this WHILE ingest is active — that's the only time the problem shows.
--   docker compose exec -T postgres-archives psql -U postgres -d archives \
--     < backend/db/diagnose_io.sql
--
-- WHAT WE'RE TESTING
--
-- EXPLAIN BUFFERS on the same logical search during ingest reported:
--
--   fast run:  shared hit=9076    read=1320   written=363     289 ms
--   slow run:  shared hit=796466  read=18822  written=11326  2837 ms
--
-- `written` counts dirty shared buffers that THIS backend had to evict and write
-- before it could get a clean buffer. A search doing 11k of those isn't slow
-- because of its plan — it's paying off ingest's dirty pages. Normally the
-- background writer keeps enough clean buffers available that ordinary backends
-- never do this.
--
-- The plan fixes are in; these numbers say whether what's left is bgwriter
-- capacity, checkpoints firing too often, too little cache, too many concurrent
-- ingest writers, or storage simply saturated.

\echo '=============== 1. per-backend-type I/O (PG 16+) ==============='
-- The row that matters: backend_type='client backend', context='normal'.
-- Non-zero `writes` there means query backends are flushing. If instead the
-- writes sit under 'background writer' or 'checkpointer', the split is healthy.
SELECT
    backend_type,
    object,
    context,
    reads,
    read_bytes,
    round(read_time::numeric, 1)      AS read_ms,
    writes,
    write_bytes,
    round(write_time::numeric, 1)     AS write_ms,
    writebacks,
    round(writeback_time::numeric, 1) AS writeback_ms,
    fsyncs,
    round(fsync_time::numeric, 1)     AS fsync_ms,
    evictions
FROM pg_stat_io
WHERE reads > 0 OR writes > 0
ORDER BY write_bytes DESC, read_bytes DESC;

\echo ''
\echo '=============== 2. background writer ==============='
-- buffers_clean is what the bgwriter wrote to keep clean buffers available.
-- maxwritten_clean counts times it stopped early because it hit
-- bgwriter_lru_maxpages — a high value means it is being throttled and backends
-- pick up the slack, which is exactly the symptom above.
SELECT * FROM pg_stat_bgwriter;

\echo ''
\echo '=============== 3. checkpointer ==============='
-- num_requested >> num_timed means checkpoints are being forced by max_wal_size
-- rather than by checkpoint_timeout. Forced checkpoints flush hard and are a
-- classic cause of ingest-time stalls; the fix is usually a larger max_wal_size.
SELECT * FROM pg_stat_checkpointer;

\echo ''
\echo '=============== 4. relevant settings ==============='
-- WAL settings are in here because a read-only search was observed emitting
-- 95 MB of WAL: 11,860 records, every one a full-page image, with WAL buffers
-- filling 6,812 times. That happens when a reader is first to touch pages ingest
-- just wrote — it sets hint bits, and with data checksums on (default in PG18)
-- the first touch after a checkpoint logs the entire page. Bigger max_wal_size
-- (fewer checkpoints => fewer first-touches) and larger wal_buffers both reduce
-- it; wal_compression shrinks the FPIs themselves.
--
-- jit_above_cost is here because a bad plan estimated at 152,178 triggered JIT
-- and paid 44 ms compiling 87 functions. Fixing the plan removes the trigger, but
-- it's worth knowing the threshold.
SELECT name, setting, unit, source
FROM pg_settings
WHERE name IN (
    'shared_buffers', 'effective_cache_size',
    'bgwriter_delay', 'bgwriter_lru_maxpages', 'bgwriter_lru_multiplier',
    'backend_flush_after',
    'checkpoint_timeout', 'checkpoint_completion_target',
    'max_wal_size', 'min_wal_size',
    'wal_buffers', 'wal_compression', 'wal_log_hints', 'full_page_writes',
    'data_checksums',
    'effective_io_concurrency', 'maintenance_io_concurrency',
    'io_method', 'io_workers', 'io_max_concurrency',
    'max_parallel_workers', 'max_parallel_workers_per_gather',
    'jit', 'jit_above_cost',
    'random_page_cost', 'seq_page_cost',
    'max_connections', 'default_statistics_target'
)
ORDER BY name;

\echo ''
\echo '=============== 5. how many connections is ingest actually using ==============='
-- Cross-check against PARSE_WORKERS x PG_POOL_MAX_WORKER from db.ts.
SELECT state, count(*), min(backend_start) AS oldest
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state
ORDER BY count(*) DESC;

\echo ''
\echo '=============== 6. is the summary table healthy + all-visible ==============='
-- The BitmapAnd in search_responses rechecks ILIKE on the uris heap, so dead
-- tuples there cost every filtered search. A large n_dead_tup or a stale
-- last_autovacuum on `uris` is the thing to act on.
SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE relname IN ('uris', 'records', 'responses', 'content_types')
ORDER BY relname;

\echo ''
\echo '=============== 7. index usage — find the write-only indexes ==============='
-- idx_scan = 0 on a table ingest writes heavily is pure write amplification.
SELECT
    relname,
    indexrelname,
    idx_scan,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE relname IN ('uris', 'records', 'responses', 'content_types')
ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;

\echo ''
\echo '=============== 8. the four search paths, timed ==============='
-- Each hits a different branch of search_responses. Run with ingest active.
SET track_io_timing = on;

\echo '--- CASE 1: query, no filter (was ~1.5s: ILIKE over 141k index entries) ---'
EXPLAIN (ANALYZE, BUFFERS, SUMMARY)
SELECT * FROM search_responses('test', 16, 100, NULL);

\echo '--- CASE 2: query + filter (was ~2.8s: 201k response-first scan) ---'
EXPLAIN (ANALYZE, BUFFERS, SUMMARY)
SELECT * FROM search_responses('test', 16, 100, 'text/html');

\echo '--- CASE 3: browse, no filter ---'
EXPLAIN (ANALYZE, BUFFERS, SUMMARY)
SELECT * FROM search_responses('', 16, 100, NULL);

\echo '--- CASE 4: browse + filter ---'
EXPLAIN (ANALYZE, BUFFERS, SUMMARY)
SELECT * FROM search_responses('', 16, 100, 'text/html');

\echo '--- count path (must agree with CASE 2 on which URIs qualify) ---'
EXPLAIN (ANALYZE, BUFFERS, SUMMARY)
SELECT search_responses_count('test', 'text/html');
