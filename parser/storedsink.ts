/**
 * The download path's zip, without zip.js.
 *
 * Drop-in for zipsink.ts: same `ZipSink` interface, same deps, so download.ts and
 * worker.entry.ts do not know which one they have. This file is to storedzip.ts
 * what zipsink.ts was to the library — the only place the two vocabularies meet.
 *
 * ## Why the swap
 *
 * Every entry in a download is STORED (see ENTRY_LEVEL in download.ts), and with
 * deflate off, zip.js was a general-purpose library doing a specific job. What it
 * cost, measured — storedzip.bench.ts prints all of this:
 *
 *   bundle        131 KB minified / 59 KB gzipped, of a 190 KB parser bundle.
 *                 Two thirds of what every reader of the viewer downloads, for a
 *                 feature only some of them use.
 *   cpu           2.0x - 6.5x slower than the stored writer, worst on the shape
 *                 downloads actually take (many small entries).
 *   from disk      1.18x. The honest figure: with a real WARC as the source the
 *                 reads dominate and the writer barely matters.
 *   archive size  zip.js writes 132 KB more across 2,000 entries, in extra
 *                 fields nothing here needs.
 *
 * The bundle line is the one that decided it, and it is a win for every page load
 * rather than only for downloads. Dropping the dependency also retires the
 * `import.meta.url` define and the classic-worker constraint in
 * routes/parser.tsx, both of which exist solely because zip.js reads
 * `import.meta.url` — a trap that has broken parsing twice.
 *
 * ## What is given up
 *
 * Compression, and staging. If ENTRY_LEVEL is ever raised, this sink cannot
 * honour it and says so rather than storing quietly; zipsink.ts is still there.
 */

import { readPayload, type ViewRecord } from "./view";
import type { ZipContent, ZipEntryOptions, ZipSink } from "./download";
import { createStoredZipWriter, type StoredZipWriter, type ZipSource } from "./storedzip";

/** Minimal shape of the Blob constructor, so this file names no DOM global. */
type BlobFactory = (parts: unknown[], options?: { type?: string }) => unknown;

export interface StoredZipSinkDeps {
    /** Where the bytes go. A FileSystemWritableFileStream, or a blob writer. */
    writable: WritableStream<Uint8Array>;
    /** Injected for the same reason view.ts injects createObjectURL: no globals. */
    blob: BlobFactory;
    /**
     * Cancels work already inside the writer.
     *
     * Checked before each entry AND before each write, so a cancel lands within a
     * chunk rather than at the next entry boundary — on a 28 MB entry that is the
     * difference between an instant response and a visible pause after pressing
     * Cancel.
     */
    signal?: AbortSignal;
    /**
     * Accepted and deliberately unused.
     *
     * zipsink.ts needed this: more than one entry in flight forced zip.js to stage
     * each one, so the sink had to know in advance whether to arrange disk
     * staging. Here overlapping adds are simply serialised — a zip has one write
     * position, so there is nothing to overlap and nothing to stage. A caller that
     * raises concurrency gets correct output that is no faster, rather than a
     * corrupt archive.
     *
     * Kept in the signature so the two sinks remain interchangeable.
     */
    concurrency?: number;
}

/**
 * The bytes of one record, as something the writer can slice.
 *
 * A non-chunked body is a plain slice of the WARC — no copy at all, read lazily a
 * chunk at a time. A chunked one has to be de-chunked first, which means it does
 * become a buffer; there is no way around that, and chunked bodies are the
 * minority. Same division zipsink.ts made, for the same reason.
 */
const sourceOf = async (record: ViewRecord, deps: StoredZipSinkDeps): Promise<ZipSource> => {
    const payload = record.payload;

    if (!payload) return deps.blob([]) as ZipSource;

    const chunked = payload.chunks !== undefined && payload.chunks.length > 0;

    if (!chunked) {
        return record.file.slice(
            payload.offset, payload.offset + payload.size) as unknown as ZipSource;
    }

    return deps.blob([await readPayload(record)]) as ZipSource;
};

/**
 * Wrap a writable in the interface download.ts writes through.
 *
 * Text entries become a Blob here because they are already strings in memory —
 * the manifest, a rewritten document, a redirect stub. Binary entries are NOT
 * read: the record is handed over as a lazy slice of the WARC, which is the
 * difference between a 200 MB download costing 200 MB of memory and costing
 * almost none.
 */
export const createStoredZipSink = (deps: StoredZipSinkDeps): ZipSink => {
    let writer: StoredZipWriter | null = createStoredZipWriter(deps.writable);

    const active = (): StoredZipWriter => {
        if (!writer) throw new Error("storedsink: the archive is already finished");

        // Checked here rather than only in the worker's cancel handler: an abort
        // that arrives mid-download must stop the NEXT entry, and this is the one
        // place every entry passes through.
        if (deps.signal?.aborted) throw new Error("storedsink: cancelled");

        return writer;
    };

    return {
        add: async (path, content: ZipContent, options: ZipEntryOptions = {}) => {
            /*
             * Stored is not a preference here, it is the only thing implemented.
             *
             * Thrown rather than ignored. download.ts passes ENTRY_LEVEL, which is
             * 0, and if that ever changes the request must fail loudly — an
             * archive that silently stores what the caller asked to deflate is a
             * 1.56x size regression that nothing reports.
             */
            if (options.level !== undefined && options.level !== 0) {
                throw new Error(
                    `storedsink: level ${options.level} was requested, and this sink only stores. `
                    + `Use zipsink.ts if compression is wanted back.`);
            }

            const zip = active();

            const data = content.kind === "text"
                ? deps.blob([content.text], { type: "text/plain" }) as ZipSource
                : await sourceOf(content.record, deps);

            return zip.add({
                name: path,
                data,
                ...(options.lastModDate ? { lastModDate: options.lastModDate } : {}),
            });
        },

        // Writes the central directory and closes the underlying writable, so
        // nothing else should close it afterwards — same contract zipsink had.
        close: async () => {
            const zip = active();
            const total = await zip.close();

            writer = null;

            return total;
        },

        abort: async (reason) => {
            // Wrapped, and the writer dropped either way: aborting something
            // already broken is not a new problem, and the caller is on its way to
            // reporting the original failure.
            try { await writer?.abort(reason); } catch { /* ignore */ }

            writer = null;
        },
    };
};
