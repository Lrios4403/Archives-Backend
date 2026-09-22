// The parse worker's outbound protocol, and what a selected file turns out to be.
//
// Split out of worker.entry.ts for one hard reason: THE WORKER ENTRY MUST NOT
// EXPORT ANY RUNTIME VALUE.
//
// The bundle is spawned as a classic worker — `new Worker(blobUrl)`, no
// { type: "module" } — where a top-level `export` is a SyntaxError that kills the
// whole script. It does not fail loudly either: the UI reports "The parser stopped
// unexpectedly" at 0%, naming neither the file nor the cause.
//
// worker.entry.ts got away with `export interface` and `export type` because types
// are erased. The moment two FUNCTIONS were exported so tests could reach them,
// the bundler emitted `export { … }` and every archive failed at 0%. Setting
// `format: "iife"` in routes/parser.tsx also prevents it, but that is a
// belt-and-braces measure depending on bundler behaviour; keeping runtime values
// out of the entry is the fix that cannot regress.
//
// So: anything a test needs to import lives HERE, not there.

import type { WarcRecord } from "../mwarc";
import { looksGzipped, type BlobLike, type GzipLocation } from "./gzip";
import { looksZipped, waczArchives } from "./wacz";

/**
 * Everything about a record except the bytes.
 *
 * A WARC's payloads are the gigabytes; the headers are what a listing needs. So
 * every WARC header and every HTTP header is carried verbatim (spread, not
 * whitelisted, so vendor headers survive), along with the payload's LOCATION and
 * SHAPE — offset, encoded size, de-chunked size, per-chunk sizes — and never its
 * content.
 */
export interface WireWarcRecord {
    /** WARC-Type: "response", "request", "warcinfo", ... */
    type: string;
    /**
     * WARC-Target-URI, unwrapped and trimmed — see extractTargetUri. Added
     * alongside the raw header rather than replacing it, so `warc` stays a
     * verbatim copy of the file while consumers get something `new URL()` will
     * actually accept. Empty string when the record has no target (warcinfo).
     */
    url: string;
    /** Byte offset of the record's start. Logical when the archive is compressed. */
    offset: number;
    /** Every WARC header verbatim, plus `offset`. Includes WARC-Payload-Digest. */
    warc: Record<string, string | number>;
    /**
     * Every HTTP header verbatim, plus httpVersion/statusCode/statusText and
     * `offset`. Absent on non-response records — mwarc only parses an HTTP header
     * block for "response", so this missing is normal, not an error.
     */
    http?: Record<string, string | number>;
    /** Absent on non-response records, for the same reason. */
    payload?: {
        /**
         * Offset of the first body byte.
         *
         * A real file position for a plain .warc. For a .warc.gz it is LOGICAL
         * ONLY — the position the body would have if the archive were
         * decompressed. Correct to display, and useless to slice with: slicing the
         * compressed file here returns compressed bytes, with no error. Use `gzip`
         * below when it is present.
         */
        offset: number;
        /** Encoded body length. For a chunked body this INCLUDES the framing. */
        size: number;
        /** Decoded length. Only when the parser ran with returnFullSize. */
        fullSize?: number;
        /** Per-chunk decoded sizes. Only when the parser ran with returnChunkSizes. */
        chunks?: number[];
        /** From Transfer-Encoding, so callers needn't re-derive it. */
        chunked: boolean;
        /**
         * Where the bytes really are, when the source was a .warc.gz.
         *
         * Absent for a plain .warc, and then `offset` is a real position. Carried
         * verbatim through every hop — the frontend never reads a field of it, it
         * only hands it back so the view worker can read the payload.
         */
        gzip?: GzipLocation;
    };
    /** statusCode as a number; mwarc keeps it as a string off the status line. */
    status?: number;
}

/**
 * WARC-Target-URI as a URL you can actually parse.
 *
 * Most crawlers write it bare — "http://example.com/" — but plenty wrap it in
 * angle brackets, "<http://example.com/>", which is legal in the WARC/ARC lineage
 * and which `new URL()` rejects outright. Left alone it means every record from
 * such a crawl fails to parse and never reaches the tree.
 *
 * Mirrors extractUri in parse.worker.ts, which is where the Bun-side parser has
 * always handled this.
 */
function extractTargetUri(raw: string | number | null | undefined): string {
    if (raw === null || raw === undefined) return "";

    const value = String(raw).trim();
    if (!value) return "";

    const bracketed = /^<(.+)>$/.exec(value);

    return (bracketed ? bracketed[1]!.trim() : value) || "";
}

/**
 * Convert a parsed record to the wire shape, dropping the payload bytes.
 *
 * mwarc yields `header-content.content` as null whenever it runs with
 * content:false, which the worker forces — but the key is left out here as well
 * rather than relying on that. A payload must never be able to leak into a
 * message by way of an option someone flips later.
 */
export function toWire(record: WarcRecord, gzip?: GzipLocation): WireWarcRecord {
    const warcHeaders = record["header-warc"];
    const httpHeaders = record["header-meta"];
    const content = record["header-content"];

    const wire: WireWarcRecord = {
        type: String(warcHeaders["WARC-Type"] ?? ""),
        url: extractTargetUri(warcHeaders["WARC-Target-URI"]),
        offset: Number(warcHeaders["offset"] ?? 0),
        warc: { ...warcHeaders },
    };

    if (httpHeaders) {
        wire.http = { ...httpHeaders };

        const rawStatus = httpHeaders["statusCode"];
        const status = Number(rawStatus);
        if (Number.isFinite(status)) wire.status = status;
    }

    if (content) {
        const transferEncoding =
            httpHeaders?.["Transfer-Encoding"] ?? httpHeaders?.["transfer-encoding"];

        wire.payload = {
            offset: Number(content["offset"] ?? 0),
            size: Number(content["size"] ?? 0),
            chunked: String(transferEncoding ?? "").toLowerCase() === "chunked",
        };

        const fullSize = content["fullSize"];
        if (typeof fullSize === "number") wire.payload.fullSize = fullSize;

        const chunks = content["chunks"];
        if (Array.isArray(chunks)) wire.payload.chunks = chunks as number[];

        // Set only for a .warc.gz. mwarc knows nothing about this — the caller
        // resolves it from the gzip reader's member table, which is why mwarc.ts
        // needs no changes at all to read compressed archives.
        if (gzip) wire.payload.gzip = gzip;
    }

    return wire;
}

/**
 * One archive to parse, whether it came from a file or from inside a .wacz.
 *
 * `dataOffset` is what makes the two cases uniform: 0 for a file the user picked
 * directly, and the entry's position in the zip for a .wacz. Everything that has
 * to be expressed relative to the SELECTED FILE rather than the archive — the
 * payload location, the progress figure — adds it.
 */
export interface ParseSource {
    /** For diagnostics. The entry name inside a .wacz, else the file name. */
    readonly name: string;
    readonly file: BlobLike;
    readonly dataOffset: number;
    readonly gzipped: boolean;
}

/**
 * What a selected file actually contains.
 *
 * Sniffed from the bytes in both cases, never the extension: a `.warc` that is
 * really gzipped and a `.wacz` named `.zip` are both things that turn up, and both
 * fail confusingly if the name is trusted.
 */
export async function resolveSources(file: BlobLike, name: string): Promise<ParseSource[]> {
    if (await looksZipped(file)) {
        // Throws WaczError with a readable message when the entries are deflated
        // rather than stored, which is the one shape that cannot be read in place.
        const archives = await waczArchives(file);

        return Promise.all(archives.map(async archive => ({
            name: archive.name,
            file: archive.file,
            dataOffset: archive.dataOffset,
            // Sniffed per entry rather than assumed from the .warc.gz name. Two
            // bytes each, and the alternative is handing a plain .warc to the gzip
            // reader and failing inside fflate.
            gzipped: await looksGzipped(archive.file),
        })));
    }

    return [{
        name,
        file,
        dataOffset: 0,
        gzipped: await looksGzipped(file),
    }];
}
