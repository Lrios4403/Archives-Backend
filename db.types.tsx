// generic JSON type for JSONB columns
export type Json =
    | string
    | number
    | boolean
    | null
    | Json[]
    | { [key: string]: Json };

// Type for rows from the `latest_responses` view
export interface WarcLatestRecords {
    /** responses.id (BIGINT) — may be returned as string by some DB drivers */
    id: number | string;

    /** responses.status (INT) */
    status: number;

    /** responses.headers (JSONB) */
    headers: Json;

    /** responses.http_version (TEXT) */
    http_version: string;

    /** responses.last_modified (TIMESTAMPTZ) — may be null */
    last_modified: string | null;

    /** records.archived_date (TIMESTAMPTZ) */
    archived_date: string;

    /** records.warc_custom_id (TEXT) */
    warc_custom_id: string;

    /** uris.uri (TEXT) */
    uri: string | null;

    /** ips.ip (INET) — may be null */
    ip: string | null;

    /** content_types.type (TEXT) — may be null */
    content_type: string | null;
}


export type WarcRecordType =
    | "request"
    | "response"
    | "warcinfo"
    | "revisit"
    | "metadata"
    | "resource";


export interface WarcFile {
    id?: number;                    // BIGSERIAL
    warcinfo_id?: string;           // UUID, optional because it can be null
    file_path: string;              // TEXT NOT NULL
    metadata?: Record<string, any>; // JSONB, optional, defaults to empty object
    created_at?: Date;              // TIMESTAMPTZ, optional because DB sets default
}

// content_types
export interface WarcContentType {
    id?: number;
    type: string;
    content_type_base?: string; // generated column, lower/trimmed base type
}

// content_type_tokens
export interface WarcContentTypeToken {
    id?: number;
    content_type_id?: number; // FK -> content_types.id
    token?: string;
}

// uris
export interface WarcUri {
    id?: number;
    uri: string;
    recursion_level?: number; // path segments after host (0 = homepage)
    uri_lc?: string; // generated lowercase URI
    uri_host?: string; // generated from regex
    uri_path?: string; // generated from regex
    uri_hash?: string | null;
    uri_lc_hash?: string | null;
}

// ips
export interface WarcIp {
    id?: number;
    ip: string; // stored as INET in Postgres
    ip_text?: string; // generated host(ip)
    ip_octets?: number[]; // generated int[]
}

// payloads
export interface WarcPayload {
    id?: number;
    file_id: string | null;
    byte_offset: number;
    byte_length: number;
    chunks?: number[] | null;
    payload_digest?: string | null;
    created_at?: Date;
}

// records
export interface WarcRecordEntry {
    id?: number;
    warc_file_id: number; // FK -> warc_files.id
    warc_record_id: string; // UUID
    record_type: WarcRecordType;
    archived_date: Date;
    uri_id: number; // FK -> uris.id
    content_length?: number | null;
    ip_id?: number | null; // FK -> ips.id
    payload_id?: number | null; // FK -> payloads.id
    block_digest?: string | null;
    payload_digest?: string | null;
    is_truncated?: boolean;
    refers_to?: string | null; // UUID
    created_at?: Date,
}

// requests
export interface WarcRequestEntry {
    id?: number;
    record_id: number; // FK -> records.id
    method: string;    // NOT NULL in DB
    http_version: string; // NOT NULL in DB
    headers: Record<string, unknown>; // JSONB NOT NULL
}

// responses
export interface WarcResponseEntry {
    id?: number;
    record_id: number; // FK -> records.id
    http_version: string; // NOT NULL in DB
    status: number;       // NOT NULL in DB (100-599)
    content_type_id?: number | null; // nullable FK -> content_types.id
    headers: Record<string, unknown>; // JSONB NOT NULL
    last_modified?: Date | null;    // TIMESTAMPTZ -> ISO string or null
    concurrent_to?: number | null;    // FK -> requests.id (nullable)
}

export interface WarcContentType {
    id?: number;                 // BIGSERIAL (generated)
    type: string;                // TEXT NOT NULL UNIQUE
}

// Interface matching insert_warc_response_full
export interface WarcInsertResponseFull {
    warc_custom_id: string;                     // required
    warc_record_id?: string | null;             // optional
    warc_archived_date: Date,
    file_path: string;                          // required
    ip: string;                                 // optional (INET)
    uri: string;                                // required
    http_content_type?: string | null;          // optional
    http_headers?: Record<string, any> | null;  // optional (JSONB)
    http_status?: number | null;                // optional
    http_last_modified?: Date | null;           // optional (TIMESTAMPTZ)
    payload_byte_offset?: number | null;        // optional
    payload_byte_length?: number | null;        // optional
    payload_digest?: string | null;             // optional
    payload_chunks?: number[] | null;
}

// Exactly what search_responses() returns, which is exactly what the results UI
// renders. headers/http_version/ip/content_type were dropped: nothing read them,
// and headers cost a JSONB detoast per row plus a JSON.parse in the search route
// before being serialized into a response the frontend threw away. ip and
// content_type each needed a LEFT JOIN to produce.
export interface WarcSearchResponseRow {
    response_id: number;
    status: number;
    last_modified: string | null; // TIMESTAMPTZ -> ISO string when returned
    archived_date: string;        // TIMESTAMPTZ -> ISO string
    warc_custom_id: string;
    uri: string;
}


/** One group (all responses for a single URI) */
export interface WarcSearchGroup {
    uri: string;                         // the URI string (or "__unknown__")
    count: number;                       // number of responses in this group
    responses: WarcSearchResponseRow[];  // rows returned from DB (normalized)
}

/** Root payload returned by the search route */
export interface WarcSearchResult {
    total_count: number;        // overall total (sum of group counts)
    groups: WarcSearchGroup[];
}

/** Error shape returned when the route fails */
export interface WarcErrorResult {
    error: string;
}

// Row shape for the Postgres `response_history` view (one per captured response)
export interface WarcHistoryRow {
    /** responses.id (BIGINT) — may be returned as string by some DB drivers */
    id: number | string;
    /** responses.record_id (BIGINT) — FK -> records.id */
    record_id: number | string;
    /** records.warc_custom_id (TEXT) */
    warc_custom_id: string;
    /** uris.uri (TEXT) — may be null */
    uri: string | null;
    /** records.archived_date (TIMESTAMPTZ) — ISO string when returned */
    archived_date: string;
    /** responses.status (INT) */
    status: number;
    /** responses.http_version (TEXT) */
    http_version: string;
    /** responses.last_modified (TIMESTAMPTZ) — may be null */
    last_modified: string | null;
    /** content_types.type (TEXT) — may be null */
    content_type: string | null;
    /** ips.ip (INET) — may be null */
    ip: string | null;
    /** responses.headers (JSONB) */
    headers: Json;
}

// Single-row detail for one capture (used by GET /api/warcs/detail): the record's
// response fields plus its associated request fields (may be null when the WARC
// stored no linked request). Redirect chain is attached separately by the route.
export interface WarcRecordDetailRow {
    warc_custom_id: string;
    record_type: WarcRecordType;
    archived_date: string;
    uri: string | null;
    ip: string | null;
    response_id: number | string | null;
    response_status: number | null;
    response_http_version: string | null;
    response_headers: Json | null;
    response_last_modified: string | null;
    content_type: string | null;
    request_id: number | string | null;
    request_method: string | null;
    request_http_version: string | null;
    request_headers: Json | null;
}

// Row shape for the Postgres `response_payloads` view
export interface WarcResponsePayload {
    /** responses.id (BIGINT) — may be returned as string by some DB drivers */
    id: number | string;
  
    /** responses.record_id (BIGINT) — FK -> records.id */
    record_id: number;
  
    /** records.warc_custom_id (TEXT) */
    warc_custom_id: string;
  
    /** warc_files.file_path (TEXT) — may be null if no warc_file linked */
    file_path: string | null;
  
    /** payloads.byte_offset (BIGINT) — may be null */
    byte_offset: number | null;
  
    /** payloads.byte_length (BIGINT) — may be null */
    byte_length: number | null;
  
    /** payloads.chunks (BIGINT[]) — may be null; use number[] when present */
    chunks: string | number[] | null;
  
    /** responses.status (INT) */
    status: number;
  
    /** responses.http_version (TEXT) */
    http_version: string;
  
    /** responses.headers (JSONB) */
    headers: Json;
  
    /** content_types.type (TEXT) — may be null */
    content_type: string | null;
  
    /** uris.uri (TEXT) — may be null */
    uri: string | null;
  
    /** records.archived_date (TIMESTAMPTZ) — ISO string when returned by DB */
    archived_date: string;
  }
  

export interface WarcResponseBulkInput {
  warc_custom_id: string;
  warc_record_id: string; // UUID string
  warc_archived_date: string; // ISO timestamp string
  file_path: string;
  ip: string;
  uri: string;
  http_content_type: string;
  http_headers: Record<string, any>; // Will be JSON.stringify'd
  http_status: number;
  http_last_modified: string | null;
  payload_byte_offset: number;
  payload_byte_length: number;
  payload_chunks: number[]; // e.g. [1, 2, 3] -> '{1,2,3}'
  payload_digest: string;
  recursion_level: number;
}
