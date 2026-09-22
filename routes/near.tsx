import { get_response_by_uri } from "../db";
import { stripFragment } from "../uri";

/**
 * The single row out of what the query hands back.
 *
 * `get_response_by_uri` resolves to a row ARRAY — Bun's SQL client does that even
 * for a `LIMIT 1` query — and this file read `.status` and `.headers` straight
 * off it. `undefined >= 300` is false, so the follow below never once fired and
 * `redirect=true` silently did nothing for every caller that ever passed it.
 *
 * The response shape is deliberately left as the array it has always been:
 * clients already unwrap it, and changing that here would fix this endpoint by
 * breaking them.
 */
const firstRow = (rows: any): any => (Array.isArray(rows) ? rows[0] : rows);

const getNear = (uri: string, dateNear: string | null, redirect: boolean) =>
  // Fragments are never stored (they never reach a server), so they must not reach
  // a lookup either. Stripped rather than redirected: this endpoint returns JSON,
  // and a fragment on a JSON response means nothing to the client.
  get_response_by_uri(stripFragment(uri), dateNear ? new Date(dateNear) : new Date()).then(near => {
    if (!redirect) return near;

    const row = firstRow(near);

    // Only follow 3xx redirects
    if (row?.status >= 300 && row.status < 400) {
      const headers = typeof row.headers === "string" ? JSON.parse(row.headers) : row.headers;
      const location = headers?.location || headers?.Location;

      if (location) {
        /*
         * Return the response of the redirect URI. A Location header can carry a
         * fragment, and that one is the server's own output, so strip it too.
         *
         * Resolved against the redirect's own address first: a relative Location
         * ("/threads/x", "../y") is legal and common, and looking one up verbatim
         * finds nothing. Only one hop is followed — a chain is something the
         * reader should be shown rather than silently walked to the end of.
         */
        let target = location;

        try {
          target = new URL(location, row.uri ?? row.full_uri ?? uri).href;
        } catch {
          // Not resolvable against anything. Try it as given.
        }

        return get_response_by_uri(stripFragment(target), dateNear ? new Date(dateNear) : new Date());
      }
    }

    return near;
  });

export const nearRoute = (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const uri = url.searchParams.get("uri") ?? "";
  const dateNear = url.searchParams.get("dateNear");
  const redirect = url.searchParams.get("redirect") === "true";

  return getNear(uri, dateNear, redirect)
    .then(near => Response.json(near))
    .catch(err => {
      console.error("nearRoute error:", err);
      return new Response(JSON.stringify({ error: "Failed to fetch response" }), { status: 500 });
    });
};
