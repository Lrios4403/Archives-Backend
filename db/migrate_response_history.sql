-- migrate_response_history.sql
-- Non-destructive: adds the response_history view used by GET /api/history.
-- Safe to run on an existing database (CREATE OR REPLACE, touches no data):
--   psql "$DATABASE_URL" -f backend/db/migrate_response_history.sql

CREATE OR REPLACE VIEW response_history AS
SELECT
    resp.id,                       -- response id
    resp.record_id,                -- originating record id
    rec.warc_custom_id,
    u.uri,
    rec.archived_date,
    resp.status,
    resp.http_version,
    resp.last_modified,
    ct.type            AS content_type,
    i.ip               AS ip,
    resp.headers
FROM responses resp
JOIN records rec           ON resp.record_id = rec.id
LEFT JOIN uris u           ON rec.uri_id = u.id
LEFT JOIN content_types ct ON resp.content_type_id = ct.id
LEFT JOIN ips i            ON rec.ip_id = i.id;
