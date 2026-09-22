import type { BunRequest } from "bun";
import { get_site_responses } from "../db";
import { stripFragment } from "../uri";

export const infoRoute = (req: BunRequest): Promise<Response> => {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    // Fragment stripped: it is never stored, so it can only produce a miss. This
    // one matters for the viewer — /warcs/view builds its capture timeline from
    // here, so a "#section" URL would show a page with no history at all.
    const rawUri = url.searchParams.get("uri");
    const uri = rawUri === null ? null : stripFragment(rawUri);

    return get_site_responses(uri, id).then(d=>Response.json(d));
}