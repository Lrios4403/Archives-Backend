import type { BunRequest } from "bun";
import { get_redirect_path, get_site_responses } from "../db";
import { stripFragment } from "../uri";
import type { WarcSearchResponseRow } from "../db.types";

/**
 * Handles API requests to fetch site responses by either URI or WARC ID.
 * Example usage:
 *   /api/path?uri=https://example.com
 *   /api/path?id=some-warc-custom-id
 */
export const pathRoute = async (req: BunRequest): Promise<Response> => {
    const url = new URL(req.url);
    // Fragment stripped before any lookup: it is never stored, so it can only
    // produce a miss. JSON response, so there is nothing to redirect for.
    const rawUri = url.searchParams.get("uri");
    const uri = rawUri === null ? null : stripFragment(rawUri);
    const id = url.searchParams.get("id"); // warc_custom_id
    const dateParam = url.searchParams.get("date_archived");
    const maxHopsParam = url.searchParams.get("max_hops");

    const p_date_archived = dateParam ? new Date(dateParam) : null;
    // Validate date (if invalid -> treat as null)
    if (p_date_archived && isNaN(p_date_archived.getTime())) {
      return new Response(JSON.stringify({ error: "Invalid date_archived value" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const p_max_hops = (() => {
      const n = Number(maxHopsParam ?? "");
      if (!maxHopsParam) return 20;
      if (Number.isInteger(n) && n > 0) return n;
      return 20;
    })();

    // call the database function
    return get_redirect_path(uri ?? null, p_date_archived, id ?? null, p_max_hops).then(d=>Response.json(d));
}
