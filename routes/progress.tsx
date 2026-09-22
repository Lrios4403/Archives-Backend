import { get_parse_progress, type ParseProgressRow, type ParseStatus } from "../db";

/*
 * GET /api/warcs/progress
 *
 * Every warc file the database knows about and how far the parser has got
 * through it, as JSON.
 *
 * Answers from `file_progress` alone — no disk access, no stat() storm. That
 * matters because the archive now lives on a CIFS share: statting 1,787 files
 * over SMB to answer one request would make this endpoint slower than the parse
 * it is reporting on, and unusable for polling. Pass `?disk=1` when you
 * genuinely need on-disk sizes and can afford them.
 *
 * Query parameters:
 *   status=parsing|parsed|pending|error   only that state
 *   limit=N&offset=N                      page the `files` array
 *   disk=1                                add real on-disk totals (slow)
 *
 * `summary` is always computed over EVERY row, never over the filtered page.
 * A summary that changed when you asked for page two would be worse than no
 * summary at all.
 */

/*
 * Ordering: interesting first.
 *
 * Sorting by path looks tidier and is useless in practice — with 1,638 files
 * pending, anything actually happening is buried thousands of entries down. The
 * two states worth a human's attention lead, and `parsed` sinks to the bottom
 * because a finished file is the one thing nobody needs to look at.
 */
const RANK: Record<ParseStatus, number> = { parsing: 0, error: 1, pending: 2, parsed: 3 };

/*
 * BIGINT does not survive JSON intact.
 *
 * Postgres hands back int8 as a string (byte_offset, file_size and records are
 * all bigint), so without this the payload carries "12884901888" for one file
 * and 0 for another and every consumer has to guess which. Everything numeric
 * goes through here so the shape is stable.
 */
const n = (value: number | string | null | undefined): number => {
    if (value === null || value === undefined) return 0;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Percent complete, or null when the denominator is genuinely unknown.
 *
 * `file_size` is only written by progress_start, so a file the parser has not
 * opened yet has no size on record. Reporting that as 0% would be a lie of the
 * confident kind: 0% implies "started, got nowhere", and null says "not begun".
 */
const percent = (read: number, total: number | null): number | null =>
    total === null || total <= 0 ? null : Math.round((read / total) * 10_000) / 100;

const describe = (row: ParseProgressRow) => {
    const read = n(row.byte_offset);
    const size = row.file_size === null ? null : n(row.file_size);

    return {
        file_id: n(row.file_id),
        file_path: row.file_path,
        /** Basename, because the CIFS paths are long and mostly identical. */
        name: row.file_path.split("/").pop() ?? row.file_path,
        status: row.status,
        records: n(row.records),
        bytes_read: read,
        bytes_total: size,
        percent: percent(read, size),
        error: row.error,
        started_at: row.started_at,
        finished_at: row.finished_at,
        updated_at: row.updated_at,
    };
};

export const progressRoute = async (req: Request): Promise<Response> => {
    try {
        const url = new URL(req.url);
        const wanted = url.searchParams.get("status");
        const limitParam = url.searchParams.get("limit");
        const offset = Math.max(0, n(url.searchParams.get("offset")));

        const rows = await get_parse_progress();
        const all = rows.map(describe);

        // Over every row, before any filtering or paging.
        const by_status: Record<string, number> = { pending: 0, parsing: 0, parsed: 0, error: 0 };
        let records = 0;
        let bytes_read = 0;
        let bytes_known = 0;
        let sizes_unknown = 0;

        for (const file of all) {
            by_status[file.status] = (by_status[file.status] ?? 0) + 1;
            records += file.records;
            bytes_read += file.bytes_read;
            if (file.bytes_total === null) sizes_unknown++;
            else bytes_known += file.bytes_total;
        }

        const filtered = wanted ? all.filter(file => file.status === wanted) : all;

        const ordered = [...filtered].sort((a, b) =>
            RANK[a.status] - RANK[b.status] || a.file_path.localeCompare(b.file_path));

        const limit = limitParam === null ? ordered.length : Math.max(0, n(limitParam));
        const page = ordered.slice(offset, offset + limit);

        /*
         * The true denominator, only when asked for.
         *
         * bytes_known counts only files that have been STARTED, so early in a run
         * it is a small fraction of the archive and `percent_of_known` reads far
         * higher than the real figure. This is the honest total, and it costs a
         * recursive walk of the share to get.
         */
        let disk: { files: number; total_bytes: number } | null = null;
        if (url.searchParams.get("disk") === "1") {
            const { getWarcFolderStats } = await import("../disk");
            const stats = await getWarcFolderStats("./warcs/");
            disk = { files: stats.files, total_bytes: stats.totalBytes };
        }

        return Response.json({
            status: "ok",
            date: new Date().toISOString(),
            summary: {
                files: all.length,
                by_status,
                records,
                bytes_read,
                /** Sum of sizes for files the parser has opened. NOT the archive total. */
                bytes_known,
                /** Files with no size on record yet, i.e. never started. */
                sizes_unknown,
                percent_of_known: percent(bytes_read, bytes_known || null),
                percent_of_disk: disk ? percent(bytes_read, disk.total_bytes) : null,
                disk,
            },
            returned: page.length,
            offset,
            files: page,
        });
    } catch (err) {
        console.error("progressRoute error:", err);

        return Response.json({
            status: "error",
            message: err instanceof Error ? err.message : "Failed to read parse progress",
            date: new Date().toISOString(),
        }, { status: 500 });
    }
};
