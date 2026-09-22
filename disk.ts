import path from "node:path";
import { stat } from "node:fs/promises";
import { Glob } from "bun";

const warcGlob = new Glob("**/*.warc");

export async function listWarcFiles(dir: string): Promise<string[]> {
    const warcFiles: string[] = [];

    for await (
        const relativePath of warcGlob.scan({
            cwd: dir,
            onlyFiles: true,
            followSymlinks: false,
        })
    ) {
        warcFiles.push(path.join(dir, relativePath));
    }

    return warcFiles;
}

export interface WarcFolderStats {
    files: number;
    totalBytes: number;
    /** When this reading was taken (epoch ms). */
    at: number;
    /** How long the scan took. Worth logging — see the note below. */
    scanMs: number;
}

/**
 * How long a reading stays fresh.
 *
 * The folder changes when a parse run or a download finishes — minutes or hours
 * apart, never between two page loads. Five minutes is far shorter than the real
 * rate of change and long enough that the scan is amortised to nothing.
 */
const STATS_TTL_MS = 5 * 60_000;

/**
 * Stats issued at once during a scan.
 *
 * The NAS is CIFS, so every stat is an SMB2 QUERY_PATH_INFO round trip and the
 * mount is `actimeo=1`, which means the attribute cache has effectively expired
 * by the time the next request arrives. Serially that is one round trip per
 * file; in batches of 16 it is one per sixteen. Measured on this box: a
 * stat-every-file walk of ~1,831 files took 3m57s serially.
 *
 * Not unbounded: firing 1,831 concurrent stats at a consumer NAS is how you
 * make it stop answering, which is the failure this code is recovering from.
 */
const STAT_CONCURRENCY = 16;

let cached: WarcFolderStats | null = null;
let inFlight: Promise<WarcFolderStats> | null = null;

/**
 * Sum the sizes of `paths`, a bounded number at a time.
 *
 * Batched rather than one big Promise.all, and `fs/promises.stat` rather than
 * `Bun.file(p).size`, because the latter is SYNCHRONOUS. The previous version of
 * this function called it in a loop over every file, so a single status request
 * blocked the event loop for the entire duration of the walk — roughly four
 * minutes against this NAS. That is why an unresponsive backend showed almost no
 * CPU use and why EVERY route timed out, not just the one doing the scanning:
 * the thread was parked in cifs_revalidate_dentry_attr, not busy.
 *
 * A promise chain rather than await, so control returns to the event loop
 * between batches and the server keeps answering while a scan is running.
 */
const sumSizes = (paths: readonly string[]): Promise<number> => {
    let total = 0;

    const batch = (index: number): Promise<number> => {
        if (index >= paths.length) return Promise.resolve(total);

        const slice = paths.slice(index, index + STAT_CONCURRENCY);

        return Promise.all(
            slice.map((p) =>
                stat(p)
                    .then((s) => {
                        total += s.size;
                    })
                    // A file can vanish mid-scan — the extractor deletes a .gz and
                    // renames a .part while this is walking. A missing file is not
                    // an error, it is just not counted.
                    .catch(() => {}),
            ),
        ).then(() => batch(index + STAT_CONCURRENCY));
    };

    return batch(0);
};

const scanFolder = (dir: string): Promise<WarcFolderStats> => {
    const started = Date.now();

    // The name walk is cheap (~3s for 1,800 files) because readdir returns the
    // entries; it is the per-file stat that costs. Collect first, then size.
    return listWarcFiles(dir).then((paths) =>
        sumSizes(paths).then((totalBytes) => ({
            files: paths.length,
            totalBytes,
            at: Date.now(),
            scanMs: Date.now() - started,
        })),
    );
};

/**
 * Count the .warc files in `dir` (recursively) and sum their on-disk byte sizes.
 * This is the size of the raw archive files themselves, independent of how much
 * has been parsed into the database.
 *
 * Cached, single-flight, and stale-while-revalidate:
 *
 *   fresh      -> the cached reading, no I/O at all
 *   stale      -> the cached reading IMMEDIATELY, with a refresh started behind it
 *   cold       -> waits for the first scan, because there is nothing else to give
 *
 * The stale case is the important one. A refresh takes seconds, and a caller
 * that waited for it would be waiting on the NAS for a number that changes a few
 * times a day. Serving the previous reading is both faster and, for this data,
 * no less true.
 *
 * Single-flight matters just as much: without it, N concurrent requests during a
 * refresh would each start their own walk and multiply the load on the very
 * mount that is already the bottleneck.
 */
export function getWarcFolderStats(dir: string): Promise<WarcFolderStats> {
    const now = Date.now();

    if (cached && now - cached.at < STATS_TTL_MS) {
        return Promise.resolve(cached);
    }

    if (!inFlight) {
        inFlight = scanFolder(dir)
            .then((fresh) => {
                cached = fresh;
                inFlight = null;
                console.log(
                    `disk: scanned ${fresh.files} warc files in ${fresh.scanMs}ms`,
                );
                return fresh;
            })
            .catch((error) => {
                inFlight = null;
                // A failed refresh must not discard a good previous reading.
                if (cached) {
                    console.error("disk: scan failed, keeping the last reading:", error);
                    return cached;
                }
                throw error;
            });
    }

    // Stale but present: answer now, let the refresh land when it lands.
    if (cached) return Promise.resolve(cached);

    return inFlight;
}

/**
 * Start the first scan without blocking anything.
 *
 * Called at boot so the cold case is already paid for before a request arrives.
 * Failure is logged and otherwise ignored: a server that will not start because
 * a network mount was briefly unavailable is worse than one reporting no files.
 */
export function warmWarcFolderStats(dir: string): void {
    getWarcFolderStats(dir).catch((error) => {
        console.error("disk: initial warc folder scan failed:", error);
    });
}
