import { get_latest_archives } from "../db";

export const latestRoute = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const contentType = url.searchParams.get('contentType') ?? undefined;
    return get_latest_archives({ contentType }).then(latest => Response.json(latest));
}
