import type { BunRequest } from "bun";
import { get_url_history } from "../db";
import { stripFragment } from "../uri";

// GET /api/history?url=<url>  (also accepts ?uri= for consistency with other routes)
// Returns every archived response for that exact URL, newest first, or [] if none.
export const historyRoute = (req: BunRequest): Promise<Response> => {
  const url = new URL(req.url);
  // Fragment stripped: it is never stored, so leaving it on would turn every
  // "#section" link into an empty history. JSON response, so nothing to redirect.
  const target = stripFragment((url.searchParams.get("url") ?? url.searchParams.get("uri") ?? "").trim());

  // No URL to look up -> nothing to return.
  if (!target) return Promise.resolve(Response.json([]));

  return get_url_history(target)
    .then((rows) => Response.json(rows ?? []))
    .catch((err) => {
      console.error("historyRoute error:", err);
      return new Response(JSON.stringify({ error: "Failed to fetch history" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });
};
