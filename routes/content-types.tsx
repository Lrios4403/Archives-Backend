import { get_content_types } from "../db";

// GET /api/warcs/content-types
// Distinct base content types currently stored, sorted A->Z, e.g.
//   ["application/json", "image/png", "text/html", ...]
// Powers the search filter dropdown. Returns [] on error.
export const contentTypesRoute = (): Promise<Response> =>
  get_content_types()
    .then((rows) => Response.json(rows.map((r) => r.content_type).filter(Boolean)))
    .catch((err) => {
      console.error("contentTypesRoute error:", err);
      return new Response(JSON.stringify({ error: "Failed to fetch content types" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });
