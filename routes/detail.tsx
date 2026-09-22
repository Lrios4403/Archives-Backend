import type { BunRequest } from "bun";
import { get_record_detail, get_redirect_path } from "../db";

// Bun may hand JSONB back as an object or as a string; normalize to an object.
const parseHeaders = (h: unknown): Record<string, unknown> => {
  if (!h) return {};
  if (typeof h === "string") {
    try {
      return JSON.parse(h);
    } catch {
      return { raw: h };
    }
  }
  return h as Record<string, unknown>;
};

// GET /api/warcs/detail?id=<warc_custom_id>
// Returns the capture's response + request info. When the response is a 3xx
// redirect, also returns the resolved redirect chain (each hop's status, uri,
// Location header and where it resolved to).
export const detailRoute = async (req: BunRequest): Promise<Response> => {
  const url = new URL(req.url);
  const id = (url.searchParams.get("id") ?? url.searchParams.get("warc_custom_id") ?? "").trim();

  if (!id) {
    return new Response(JSON.stringify({ error: "missing id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const rows = await get_record_detail(id);
    const row = rows?.[0];

    if (!row) {
      return new Response(JSON.stringify({ error: "record not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const status = row.response_status;
    const isRedirect = typeof status === "number" && status >= 300 && status < 400;

    const detail: Record<string, unknown> = {
      warc_custom_id: row.warc_custom_id,
      record_type: row.record_type,
      uri: row.uri,
      archived_date: row.archived_date,
      ip: row.ip,
      response:
        row.response_id == null
          ? null
          : {
              id: row.response_id,
              status: row.response_status,
              http_version: row.response_http_version,
              content_type: row.content_type,
              last_modified: row.response_last_modified,
              headers: parseHeaders(row.response_headers),
            },
      request:
        row.request_id == null
          ? null
          : {
              id: row.request_id,
              method: row.request_method,
              http_version: row.request_http_version,
              headers: parseHeaders(row.request_headers),
            },
      is_redirect: isRedirect,
    };

    // Only follow + attach the chain when this response actually redirects.
    if (isRedirect) {
      const hops = await get_redirect_path(null, null, id);
      detail.redirect_chain = (hops ?? []).map((hop) => ({
        ...hop,
        headers: parseHeaders(hop.headers),
      }));
    }

    return Response.json(detail);
  } catch (err) {
    console.error("detailRoute error:", err);
    return new Response(JSON.stringify({ error: "Failed to fetch record detail" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
