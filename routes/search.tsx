import type { BunRequest } from "bun";
import {
  get_uri_sort_position,
  SEARCH_COUNT_CAP,
  get_warc_search_responses,
  get_warc_search_responses_after,
  get_warc_search_responses_count,
} from "../db";
import type { WarcSearchResponseRow } from "../db.types";

export const searchRoute = (req: BunRequest): Promise<Response> => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "16");
  // Optional content-type filter (?content_type= or ?type=). Blank/absent => null => ignored.
  const contentType = (url.searchParams.get("content_type") ?? url.searchParams.get("type") ?? "").trim() || null;

  /*
   * Optional cursor: where the PREVIOUS page ended.
   *
   * `after_uri` alone decides whether this is a cursor request — `after_level` is
   * an integer that is legitimately 0, so testing it for truthiness would silently
   * drop every cursor into recursion level 0.
   *
   * Only honoured without a content-type filter; see
   * get_warc_search_responses_after for why that path cannot use the seek index.
   * When a cursor is present `offset` is ignored, because the two would disagree
   * and the cursor is the one that names an actual position.
   */
  const afterUri = url.searchParams.get("after_uri");
  const afterLevelRaw = url.searchParams.get("after_level");
  const afterLevel = afterLevelRaw === null ? null : Number(afterLevelRaw);
  const useCursor =
    afterUri !== null && contentType === null && afterLevel !== null && Number.isFinite(afterLevel);

  return Promise.all([
    /*
     * `req.signal` is forwarded so a reader who navigates away, hits stop, or
     * whose frontend abort fires takes their query with them.
     *
     * Bun fires this within a millisecond of the client disconnecting but does
     * NOT cancel the handler — measured. Without forwarding it, the handler ran
     * to completion for a page nobody would read, holding a connection and
     * evicting shared_buffers that the reader's retry then had to re-read.
     *
     * Not passed to the seek path: that one is 8-34 ms, so there is no window in
     * which anyone could abandon it, and no count query to wait on either.
     */
    useCursor
      ? get_warc_search_responses_after(q, afterLevel, afterUri, limit)
      : get_warc_search_responses(q, offset, limit, contentType, req.signal),
    get_warc_search_responses_count(q, contentType),
  ])
    .then((res) => {
      const [rows, total_count] = res;

      // Normalize the two numeric columns; some drivers hand back BIGINT/INT as
      // strings. The headers JSONB that used to be parsed here is no longer
      // selected — nothing rendered it, so it was a detoast per row plus a
      // JSON.parse per row to produce a field the frontend discarded.
      const normalized = rows.map((row: any) => ({
        ...row,
        response_id: typeof row.response_id === "string" ? Number(row.response_id) : row.response_id,
        status: typeof row.status === "string" ? Number(row.status) : row.status,
      })) as WarcSearchResponseRow[];

      // aggregate by uri
      const map = new Map<string, { uri: string; responses: typeof normalized }>();
      normalized.forEach((r:any) => {
        const key = r.uri ?? "__unknown__";
        const cur = map.get(key);
        if (cur) cur.responses.push(r);
        else map.set(key, { uri: key, responses: [r] });
      });

      const groups = Array.from(map.values()).map((g) => ({
        uri: g.uri,
        count: g.responses.length,
        responses: g.responses,
      }));

      /*
       * The count arrives as a BIGINT, which the driver hands back as a string
       * ("2409"). It was passed straight through, so `total_count` on the wire
       * was a string while the frontend's own type declared `number` — every
       * arithmetic use worked only on JS coercion. Normalised here, alongside
       * the two columns above that already were.
       */
      const counted = Number(total_count[0].search_responses_count);

      /*
       * Whether the count stopped at the cap rather than finishing.
       *
       * Sent explicitly instead of leaving the client to test `>= 10000` for
       * itself: the cap lives in one place (db.ts), and a reader of the JSON
       * can tell "10,000+" from "exactly 10,001" without knowing the number.
       */
      const count_capped = counted > SEARCH_COUNT_CAP;

      /*
       * Where this page ended, so the next one can be asked for by position
       * instead of by "skip N". See get_warc_search_responses_after: following
       * this is 49-227x cheaper than the equivalent OFFSET, and flat in depth.
       *
       * The level comes free on the seek path and needs one indexed lookup on the
       * OFFSET path — which is the important case, because page 1 is an OFFSET
       * query and page 2 is the transition that matters most.
       *
       * Omitted rather than faked when the page is empty or the uri has somehow
       * gone: a client that gets no cursor falls back to `offset`, which always
       * works. The cursor is an optimisation, never the only way to paginate.
       */
      const lastUri = groups.length > 0 ? groups[groups.length - 1].uri : null;

      const withCursor = (next_cursor: { level: number; uri: string } | null) =>
        Response.json({ total_count: counted, count_capped, groups, next_cursor });

      if (lastUri === null || lastUri === "__unknown__") return withCursor(null);

      // Already known on the seek path; only the OFFSET path has to ask.
      const known = (rows as any[]).find((r) => r.uri === lastUri && r.recursion_level != null);

      if (known) return withCursor({ level: Number(known.recursion_level), uri: lastUri });

      return get_uri_sort_position(lastUri)
        .then((found: any) =>
          withCursor(
            found?.[0]?.recursion_level == null
              ? null
              : { level: Number(found[0].recursion_level), uri: lastUri },
          ),
        )
        .catch(() => withCursor(null));
    })
    .catch((err: any) => {
      console.error("searchRoute error:", err);
      return new Response(JSON.stringify({ error: err?.message ?? "Internal Server Error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });
};
