// Reading a .wacz without extracting it.
//
// A WACZ is a zip containing `archive/*.warc.gz`, and Browsertrix writes those
// entries STORED rather than deflated — they are already compressed, so deflating
// them again would only cost CPU. Verified on a real 464 MB .wacz: all eleven
// entries have compression method 0.
//
// That makes each archive a CONTIGUOUS BYTE RANGE of the .wacz, which is the whole
// trick here. This module's job is to find that range and hand back a BlobLike
// view of it — and then everything in gzip.ts works unchanged, because a slice of
// a zip is indistinguishable from a standalone .warc.gz. No biasing in
// GzipLocation, no new fields on the wire, nothing else to change.
//
// A Blob is structured-cloneable, so the view survives postMessage the same way
// the File it came from does.

import type { BlobLike, GzipLocation } from "./gzip";

/* Signatures, little-endian. */
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;

const EOCD_MIN = 22;
/** Max comment length is 0xFFFF, so the EOCD starts within this of the end. */
const EOCD_SEARCH = 0xffff + EOCD_MIN;

const STORED = 0;
const DEFLATED = 8;

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

export class WaczError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WaczError";
    }
}

export interface ZipEntry {
    readonly name: string;
    /** 0 = stored, 8 = deflated. Only 0 can be read as a byte range. */
    readonly method: number;
    /** Absolute offset of the entry's DATA, past its local header. */
    readonly dataOffset: number;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
}

/** A `.warc.gz` inside a `.wacz`, as something gzip.ts can read directly. */
export interface WaczArchive {
    readonly name: string;
    /** A view of just this entry's bytes. Pass straight to createGzipWarcReader. */
    readonly file: BlobLike;
    readonly size: number;
    /**
     * Absolute offset of this entry's data within the `.wacz`.
     *
     * Needed because a location produced while reading `file` is relative to the
     * ENTRY, and a ViewRecord that carries the whole `.wacz` needs it relative to
     * the FILE. See absoluteLocation.
     */
    readonly dataOffset: number;
}

/**
 * An entry-relative gzip location, rebased onto the whole `.wacz`.
 *
 * Two coordinate systems meet here and picking the wrong one is silent: the
 * reader sees a slice starting at zero, while a ViewRecord may carry the enclosing
 * `.wacz`. Reading an unbiased location against the whole file lands
 * `dataOffset` bytes early — inside the previous entry — and inflates whatever
 * happens to be there.
 *
 * Only `compressedOffset` moves. `payloadOffsetInMember` is inside the member's
 * decoded output and does not depend on where the member sits.
 */
export const absoluteLocation = (
    location: GzipLocation,
    archive: Pick<WaczArchive, "dataOffset">,
): GzipLocation => ({
    compressedOffset: location.compressedOffset + archive.dataOffset,
    compressedLength: location.compressedLength,
    payloadOffsetInMember: location.payloadOffsetInMember,
});

const view = (bytes: Uint8Array): DataView =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * Where the End Of Central Directory record starts.
 *
 * Scanned backward because the record is at the end but not at a fixed position —
 * a zip comment can push it up to 64 KiB earlier. Backward rather than forward so
 * a comment that happens to contain the signature cannot be mistaken for it.
 */
const findEocd = (tail: Uint8Array): number => {
    const data = view(tail);

    for (let at = tail.length - EOCD_MIN; at >= 0; at--) {
        if (data.getUint32(at, true) === EOCD) return at;
    }

    return -1;
};

/**
 * Every entry in a zip's central directory.
 *
 * Reads the central directory rather than walking local headers: local headers do
 * not reliably carry sizes (a streaming writer sets them to zero and puts the real
 * values in a trailing data descriptor), while the central directory always does.
 */
export const readZipEntries = async (file: BlobLike): Promise<ZipEntry[]> => {
    if (file.size < EOCD_MIN) throw new WaczError(`not a zip: ${file.size} bytes`);

    const tailSize = Math.min(file.size, EOCD_SEARCH);
    const tail = new Uint8Array(await file.slice(file.size - tailSize, file.size).arrayBuffer());

    const eocdAt = findEocd(tail);
    if (eocdAt < 0) throw new WaczError("no zip end-of-central-directory record found");

    const eocd = view(tail);

    let entryCount = eocd.getUint16(eocdAt + 10, true);
    let directorySize = eocd.getUint32(eocdAt + 12, true);
    let directoryAt = eocd.getUint32(eocdAt + 16, true);

    // Zip64: the 32-bit fields saturate and the real values live in a separate
    // record found via a locator immediately before the EOCD. A .wacz can exceed
    // 4 GB, so this is reachable in normal use rather than theoretical.
    if (entryCount === U16_MAX || directorySize === U32_MAX || directoryAt === U32_MAX) {
        const locatorAt = eocdAt - 20;

        if (locatorAt < 0 || eocd.getUint32(locatorAt, true) !== EOCD64_LOCATOR) {
            throw new WaczError("zip needs zip64 but has no zip64 EOCD locator");
        }

        const eocd64At = Number(eocd.getBigUint64(locatorAt + 8, true));
        const head = new Uint8Array(await file.slice(eocd64At, eocd64At + 56).arrayBuffer());
        const wide = view(head);

        if (wide.getUint32(0, true) !== EOCD64) {
            throw new WaczError(`zip64 EOCD not found at ${eocd64At}`);
        }

        entryCount = Number(wide.getBigUint64(32, true));
        directorySize = Number(wide.getBigUint64(40, true));
        directoryAt = Number(wide.getBigUint64(48, true));
    }

    const directory = new Uint8Array(
        await file.slice(directoryAt, directoryAt + directorySize).arrayBuffer(),
    );
    const cd = view(directory);
    const names = new TextDecoder();

    const entries: ZipEntry[] = [];
    let at = 0;

    for (let i = 0; i < entryCount; i++) {
        if (at + 46 > directory.length) {
            throw new WaczError(`central directory truncated at entry ${i} of ${entryCount}`);
        }

        if (cd.getUint32(at, true) !== CENTRAL_HEADER) {
            throw new WaczError(`bad central directory signature at entry ${i}`);
        }

        const method = cd.getUint16(at + 10, true);
        const nameLength = cd.getUint16(at + 28, true);
        const extraLength = cd.getUint16(at + 30, true);
        const commentLength = cd.getUint16(at + 32, true);

        let compressedSize = cd.getUint32(at + 20, true);
        let uncompressedSize = cd.getUint32(at + 24, true);
        let localHeaderAt = cd.getUint32(at + 42, true);

        const name = names.decode(directory.subarray(at + 46, at + 46 + nameLength));

        // Zip64 extra field (id 0x0001). The saturated fields appear in a fixed
        // order but only the ones that actually overflowed are present, so each has
        // to be consumed conditionally rather than read at a fixed offset.
        if (compressedSize === U32_MAX || uncompressedSize === U32_MAX || localHeaderAt === U32_MAX) {
            const extraAt = at + 46 + nameLength;
            let cursor = extraAt;
            const extraEnd = extraAt + extraLength;

            while (cursor + 4 <= extraEnd) {
                const id = cd.getUint16(cursor, true);
                const size = cd.getUint16(cursor + 2, true);
                let field = cursor + 4;

                if (id === 0x0001) {
                    if (uncompressedSize === U32_MAX) { uncompressedSize = Number(cd.getBigUint64(field, true)); field += 8; }
                    if (compressedSize === U32_MAX) { compressedSize = Number(cd.getBigUint64(field, true)); field += 8; }
                    if (localHeaderAt === U32_MAX) { localHeaderAt = Number(cd.getBigUint64(field, true)); field += 8; }
                    break;
                }

                cursor += 4 + size;
            }
        }

        // The local header's extra field may differ in length from the central
        // one's — commonly it does, because writers put alignment padding there —
        // so the data offset has to come from the local header, not be derived
        // from the central directory.
        const local = new Uint8Array(await file.slice(localHeaderAt, localHeaderAt + 30).arrayBuffer());
        const lh = view(local);

        if (lh.getUint32(0, true) !== LOCAL_HEADER) {
            throw new WaczError(`bad local header for ${JSON.stringify(name)} at ${localHeaderAt}`);
        }

        const dataOffset = localHeaderAt + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);

        entries.push({ name, method, dataOffset, compressedSize, uncompressedSize });

        at += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
};

/** Is this a zip (and so possibly a .wacz) rather than a bare .warc.gz? */
export const looksZipped = async (file: BlobLike): Promise<boolean> => {
    if (file.size < 4) return false;

    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());

    // "PK\x03\x04" for a normal zip, "PK\x05\x06" for an empty one.
    return head[0] === 0x50 && head[1] === 0x4b
        && ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06));
};

const isArchiveEntry = (name: string): boolean =>
    /^archive\/.+\.warc\.gz$/i.test(name) || /\.warc\.gz$/i.test(name);

/**
 * The `.warc.gz` files inside a `.wacz`, each as a readable byte range.
 *
 * Refuses DEFLATED entries rather than silently mis-reading them: a deflated entry
 * is not a contiguous gzip stream, so a slice of it is meaningless, and the
 * resulting failure would surface much later as a corrupt record.
 */
export const waczArchives = async (file: BlobLike): Promise<WaczArchive[]> => {
    const entries = (await readZipEntries(file)).filter(entry => isArchiveEntry(entry.name));

    if (entries.length === 0) {
        throw new WaczError("no archive/*.warc.gz entries found — is this a .wacz?");
    }

    const deflated = entries.filter(entry => entry.method !== STORED);

    if (deflated.length > 0) {
        const which = deflated.map(e => `${e.name} (method ${e.method}${e.method === DEFLATED ? " = deflate" : ""})`);

        throw new WaczError(
            `this .wacz deflates its archives, so they are not contiguous byte ranges ` +
            `and cannot be read in place: ${which.join(", ")}. Extract it first.`,
        );
    }

    return entries.map(entry => ({
        name: entry.name,
        size: entry.compressedSize,
        dataOffset: entry.dataOffset,
        // The whole of WACZ support. A slice of the zip IS the .warc.gz.
        file: file.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize),
    }));
};

/**
 * The bundled CDXJ index, when there is one.
 *
 * Browsertrix ships `indexes/index.cdx.gz` with an offset and length per record,
 * and every one of its 873 entries matched a gzip member boundary exactly on the
 * archive tested. Where it is present the member walk can be skipped entirely.
 * Returned as a byte range rather than parsed — the caller decides whether it
 * wants it.
 */
export const waczIndex = async (file: BlobLike): Promise<BlobLike | null> => {
    const entries = await readZipEntries(file);
    const index = entries.find(entry => /^indexes\/.*\.cdx(\.gz)?$/i.test(entry.name));

    if (!index || index.method !== STORED) return null;

    return file.slice(index.dataOffset, index.dataOffset + index.compressedSize);
};
