import { listWarcFiles } from "./disk";
import { logParseError, logParseSessionStart, writeParseError } from "./log";
import cliProgress from "cli-progress";
import type { WarcFile } from "./db.types";
import {
    get_parse_plan,
    insert_warc_files,
    plan_parse_work,
    progress_checkpoint,
    progress_finish,
    progress_start,
    type ParseWork,
} from "./db";

// Parse worker threads. Each one holds a file open, buffers up to
// RECORD_BATCH_SIZE composite rows and runs its own Postgres pool, so this
// scales connections and peak memory as well as throughput — see the POOL_MAX
// budget in db.ts before raising it much past 8.
const PARSE_WORKERS = Math.max(1, Number(Bun.env.PARSE_WORKERS ?? 8));

const WORKER_URL = new URL("./parse.worker.ts", import.meta.url).href;

/**
 * Everything on disk, crossed against what the last run managed.
 *
 * The registration step is what makes a NEW file visible: `warc_files` is
 * upserted on `file_path` before the plan is read, so a file dropped into the
 * folder since the last run comes back from the view with no progress row, which
 * the planner reads as "start at zero".
 *
 * Files are registered even when they turn out to be finished. That costs one
 * upsert each and keeps `warc_files` an honest list of what the archive holds
 * rather than a list of what happened to be parsed.
 */
export const parseFilesInWarc = async () => {
    console.log("Updating files...");

    const paths = await listWarcFiles("./warcs/");
    console.log("Found", paths.length, "warc files");

    if (paths.length === 0) {
        console.log("Nothing to parse.");
        return;
    }

    // Registered first, so the plan below sees every file including new ones.
    await insert_warc_files(paths.map(file_path => ({ file_path })));

    const plan = plan_parse_work(await get_parse_plan(), path => Bun.file(path).size || 0);

    /*
     * A planned file whose path is no longer on disk is dropped, not deleted.
     *
     * The plan comes from the database, which remembers every file ever seen; a
     * network mount that failed to come up should cost a run, not an archive.
     */
    const onDisk = new Set(paths);
    const known = plan.filter(work => onDisk.has(work.filePath));

    const todo = known.filter(work => work.reason !== "done");
    const done = known.length - todo.length;

    const by = (reason: ParseWork["reason"]) => todo.filter(w => w.reason === reason).length;

    console.log(
        `${done} already parsed · ${by("new")} new · ${by("resume")} interrupted · ` +
        `${by("grew")} appended · ${by("replaced")} replaced · ${by("retry")} previously failed`,
    );

    if (todo.length === 0) {
        console.log("Everything is up to date.");
        return;
    }

    await logParseSessionStart(`${todo.length} of ${known.length} files`);
    await parseFiles(todo);
    console.log("Done parsing all files.");
}

// Raw byte counts are unreadable once the corpus is hundreds of GB, so the bar
// renders its value/total scaled. 1024-based, matching formatBytes() in the
// frontend's lib/db.tsx so the CLI and the UI agree.
const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

// Slot lines stay aligned, and the tail of a warc path (domain + capture date)
// is the part worth reading — "warcs/sites.warcs." prefixes every entry.
const shortName = (path: string, width = 46) =>
    path.length <= width
        ? path.padEnd(width)
        : "…" + path.slice(path.length - (width - 1));

/**
 * Run-wide totals, shared by every slot. Drives the TOTAL line.
 *
 * value = bytesDone (files fully finished) + however far each active slot has
 * read. When a slot finishes a file, bytesDone gains that file's full size in
 * the same tick that the slot's offset drops to 0, so the total is monotonic.
 * recordsDone/records work the same way.
 */
interface RunProgress {
    bar: cliProgress.SingleBar;
    totalBytes: number;
    /** Bytes belonging to files that are fully finished. */
    bytesDone: number;
    /** Records from files that are fully finished. */
    recordsDone: number;
    filesDone: number;
    fileCount: number;
    /** Every slot, so the total can add up whatever is currently in flight. */
    slots: ParseSlot[];
}

/** One worker thread: one MultiBar line, one file at a time. */
interface ParseSlot {
    bar: cliProgress.SingleBar;
    run: RunProgress;
    /** Full path of the file this worker currently holds. */
    filename: string;
    /** Read offset within that file, as last reported. Zero while idle. */
    offset: number;
    /** Records found in that file, as last reported. */
    records: number;
    /** Bytes this worker still has to read for that file (size minus resume point). */
    size: number;
    /** Index into the file list, or -1 when idle. */
    index: number;
    /** Byte offset this file was resumed from. Zero for a fresh parse. */
    start: number;
    /** warc_files.id, so a checkpoint can be written without another lookup. */
    fileId: number;
    /** Highest checkpoint already written, so an unchanged one costs no write. */
    written: number;
}

const renderTotal = (run: RunProgress) => {
    let inFlightBytes = 0;
    let inFlightRecords = 0;
    for (const slot of run.slots) {
        inFlightBytes += slot.offset;
        inFlightRecords += slot.records;
    }
    run.bar.update(run.bytesDone + inFlightBytes, {
        totalRecords: (run.recordsDone + inFlightRecords).toLocaleString(),
        filesDone: run.filesDone,
        fileCount: run.fileCount,
    });
};

// Single place that builds a slot's payload, so every call site reports the same
// tokens. Repainting a slot always refreshes the total too.
const renderSlot = (slot: ParseSlot, barValue = slot.offset) => {
    slot.bar.update(barValue, {
        filename: shortName(slot.filename),
        records: slot.records.toLocaleString(),
    });
    renderTotal(slot.run);
};

/** What a worker sends back. Flat primitives only — see parse.worker.ts. */
type WorkerMessage =
    /*
     * `offset` is where the READER is; `checkpoint` is how far the DATABASE is.
     * They are different numbers on purpose — the second lags by whatever bulk
     * inserts are still in flight, and it is the second that gets persisted.
     */
    | { type: "progress"; index: number; offset: number; records: number; checkpoint: number }
    | { type: "error"; index: number; line: string; summary: string }
    | { type: "done"; index: number; records: number; checkpoint: number; error?: string }

/**
 * Parse every file across PARSE_WORKERS real threads.
 *
 * The main thread does no parsing and no inserting. It hands out files, owns the
 * MultiBar, and is the single writer for parse-errors.log; the workers decode and
 * insert. Files are claimed from a shared cursor as workers report done rather
 * than pre-sharded, so a thread that draws a 600 MB file doesn't hold up the work
 * queued behind it.
 */
export const parseFiles = async (files: ParseWork[]) => {
    if (files.length === 0) {
        console.log("No warc files to parse.");
        return;
    }

    // Sizes came from the planner, which already stat'd every file to decide
    // whether it had grown. Re-statting here would be a second syscall per file
    // and a chance for the two to disagree.
    const sizes = files.map(work => work.size);

    /*
     * The denominator counts only the bytes still to READ.
     *
     * A resumed file contributes what is left of it, not its whole length —
     * otherwise a run that picks up the last 200 MB of a 6 GB archive opens at
     * 97% and crawls, which says nothing about how much work is left.
     */
    const totalBytes = files.reduce((sum, work) => sum + Math.max(0, work.size - work.start), 0) || 1;

    const multibar = new cliProgress.MultiBar({
        barCompleteChar: '█',
        barIncompleteChar: '░',
        hideCursor: true,
        noTTYOutput: true,
        notTTYSchedule: 1000,
        etaBuffer: 64,
        clearOnComplete: false,
        // Bytes are the unit on both line types; leave percentage/eta alone.
        formatValue: (v, _options, type) =>
            (type === "value" || type === "total") ? formatBytes(Number(v)) : String(v),
    }, cliProgress.Presets.shades_classic);

    // Every payload token has to be seeded, otherwise the format string prints
    // "{totalRecords}" literally until the first update lands.
    const run: RunProgress = {
        bar: multibar.create(totalBytes, 0,
            { totalRecords: "0", filesDone: 0, fileCount: files.length },
            { format: 'TOTAL {bar} {percentage}% | {value}/{total} | {totalRecords} records | {filesDone}/{fileCount} files | ETA {eta_formatted}' }),
        totalBytes,
        bytesDone: 0,
        recordsDone: 0,
        filesDone: 0,
        fileCount: files.length,
        slots: [],
    };

    const workerCount = Math.max(1, Math.min(PARSE_WORKERS, files.length));
    for (let i = 0; i < workerCount; i++) {
        run.slots.push({
            // total is a placeholder — setTotal() gives it the real file size.
            bar: multibar.create(1, 0,
                { filename: shortName("(starting)"), records: "0" },
                { format: `  ${String(i + 1).padStart(2)} {bar} {percentage}% | {filename} | {records} rec` }),
            run,
            filename: "(starting)",
            offset: 0,
            records: 0,
            size: 0,
            index: -1,
            start: 0,
            fileId: 0,
            written: 0,
        });
    }

    let cursor = 0;
    let liveWorkers = workerCount;

    await new Promise<void>(resolve => {
        const workers: Worker[] = [];

        // Dedupe by worker index rather than counting events: a thread we kill
        // after an "error" may or may not also emit "close", and double-counting
        // would resolve the run early while other threads are still parsing —
        // while missing one would hang it forever.
        const finished = new Set<number>();
        const finish = (workerIndex: number) => {
            if (finished.has(workerIndex)) return;
            finished.add(workerIndex);
            if (finished.size === workerCount) resolve();
        };

        /** Mark a slot idle and draw its line as complete. */
        const retireSlot = (slot: ParseSlot, label: string) => {
            slot.filename = label;
            slot.offset = 0;
            slot.records = 0;
            slot.index = -1;
            slot.start = 0;
            slot.fileId = 0;
            slot.written = 0;
            renderSlot(slot, slot.bar.getTotal());
        };

        // Hand the next unclaimed file to this worker, or shut it down when the
        // list is exhausted. `cursor++` needs no lock: this all runs on the main
        // thread's event loop, and there is no await between read and increment.
        const assignNext = (workerIndex: number) => {
            const worker = workers[workerIndex]!;
            const slot = run.slots[workerIndex]!;
            const index = cursor++;

            if (index >= files.length) {
                retireSlot(slot, "(done)");
                worker.postMessage({ type: "shutdown" });
                return;
            }

            const work = files[index]!;
            const size = sizes[index]!;
            const remaining = Math.max(0, size - work.start);

            slot.index = index;
            slot.filename = work.filePath;
            slot.offset = 0;
            slot.records = work.records;
            slot.size = remaining;
            slot.start = work.start;
            slot.fileId = work.fileId;
            slot.bar.setTotal(remaining || 1);
            renderSlot(slot);

            /*
             * Claimed in the database BEFORE the worker is told to start.
             *
             * If the process dies between the two, the row says 'parsing' at the
             * offset it was going to resume from — which is exactly what the
             * planner wants to see next time. Claiming afterwards would leave a
             * window where a crash looks like the file was never touched, and the
             * run would repeat work it had already done.
             *
             * Not awaited: it is one small write and the worker has nothing to
             * wait for. A failure is logged rather than fatal — losing a
             * checkpoint costs re-reading a file, not correctness.
             */
            void progress_start(work.fileId, work.start, size).catch(err =>
                void logParseError({ file: work.filePath, stage: "progress" }, err));

            worker.postMessage({
                type: "parse",
                index,
                filePath: work.filePath,
                worker: workerIndex + 1,
                start: work.start,
                records: work.records,
            });
        };

        for (let i = 0; i < workerCount; i++) {
            const worker = new Worker(WORKER_URL);
            workers.push(worker);

            worker.addEventListener("message", event => {
                const msg = event.data as WorkerMessage | undefined;
                if (!msg) return;
                const slot = run.slots[i]!;

                switch (msg.type) {
                    case "progress":
                        // Ignore anything from a file this slot has already moved
                        // past — a stale message would drag the total backwards.
                        if (msg.index !== slot.index) return;

                        // Bytes read THIS run, so the bar measures the work in
                        // front of it rather than the size of the file.
                        slot.offset = Math.max(0, msg.offset - slot.start);
                        slot.records = msg.records;
                        renderSlot(slot);

                        /*
                         * Persisted only when it actually moved.
                         *
                         * The worker posts every 250ms per file, so eight of them
                         * is ~32 messages a second; most carry a checkpoint that
                         * has not advanced because the batch behind it is still in
                         * flight. Writing those would be pure round trips.
                         */
                        if (slot.fileId && msg.checkpoint > slot.written) {
                            slot.written = msg.checkpoint;

                            void progress_checkpoint(slot.fileId, msg.checkpoint, msg.records)
                                .catch(err => void logParseError(
                                    { file: slot.filename, stage: "progress" }, err));
                        }
                        return;

                    case "error":
                        // The worker formatted it; the main thread is the only
                        // writer, so lines can't interleave.
                        void writeParseError({ line: msg.line, summary: msg.summary });
                        return;

                    case "done": {
                        // Credit the bytes this run was responsible for — the last
                        // record's offset stops short of EOF — and zero the slot in
                        // the same tick so the total counts them exactly once.
                        const size = msg.index === slot.index ? slot.size : 0;
                        const fileId = slot.fileId;
                        const filename = slot.filename;
                        const fullSize = slot.start + slot.size;

                        slot.offset = 0;
                        slot.records = 0;
                        run.bytesDone += size;
                        run.recordsDone += msg.records;
                        run.filesDone++;
                        renderSlot(slot, size || slot.bar.getTotal());

                        /*
                         * Finished, one way or the other.
                         *
                         * On success the offset banked is the file's SIZE, not the
                         * last record's offset: the decoder stopped because there
                         * was nothing left, so the whole file is in. Recording the
                         * last record instead would make the next run re-read the
                         * tail and, worse, make a `grew` check compare against the
                         * wrong number.
                         *
                         * On failure it is the worker's checkpoint, so a retry
                         * starts where this attempt got to.
                         */
                        if (fileId) {
                            void progress_finish(
                                fileId,
                                msg.error ? msg.checkpoint : fullSize,
                                msg.records,
                                msg.error ?? null,
                            ).catch(err => void logParseError({ file: filename, stage: "progress" }, err));
                        }

                        assignNext(i);
                        return;
                    }
                }
            });

            // An uncaught throw inside the worker (module load failure, OOM, a
            // bug outside parseOneFile's try) would otherwise strand this slot
            // forever, so treat it as the thread being gone and carry on with the
            // rest. The file it held is reported and skipped.
            worker.addEventListener("error", event => {
                const slot = run.slots[i]!;
                void logParseError(
                    { file: slot.filename, stage: "worker", worker: i + 1 },
                    (event as ErrorEvent).error ?? new Error((event as ErrorEvent).message ?? "worker error"),
                );
                retireSlot(slot, "(failed)");
                liveWorkers--;
                worker.terminate();
                // Don't rely on terminate() also producing "close" — finish() is
                // idempotent, so calling both is safe and neither can hang the run.
                finish(i);
            });

            worker.addEventListener("close", () => finish(i));
        }

        // Kick every worker off with its first file. Bun queues messages until a
        // worker is ready, so there's no need to wait for "open".
        for (let i = 0; i < workerCount; i++) assignNext(i);
    });

    multibar.stop();

    const unprocessed = files.length - run.filesDone;
    console.log(
        `Parsed ${run.recordsDone.toLocaleString()} response records from ` +
        `${run.filesDone}/${files.length} files (${formatBytes(totalBytes)}) ` +
        `across ${workerCount} worker threads.`,
    );
    if (unprocessed > 0) {
        console.error(
            `${unprocessed} file(s) were not parsed — ${workerCount - liveWorkers} worker thread(s) died. ` +
            `See parse-errors.log.`,
        );
    }
};
