/**
 * HTTP/1.1 "Transfer-Encoding: chunked" helpers for the view route.
 *
 * The parser records each chunk's data size in payloads.chunks; these helpers
 * turn that column back into a usable body when serving an archived response.
 */

/**
 * Normalize a payloads.chunks value into an array of chunk data sizes.
 * Bun may return a JS array (BIGINT[] -> number/bigint/string elements) or a raw
 * Postgres array literal string like "{15667,16467,15187}".
 */
export function parseChunkSizes(chunks: unknown): number[] {
    if (!chunks) return [];
    const arr = Array.isArray(chunks)
        ? chunks
        : typeof chunks === "string"
            ? chunks.replace(/^\{|\}$/g, "").split(",").filter(Boolean)
            : [];
    return arr.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Reconstruct an HTTP body from its raw "Transfer-Encoding: chunked" bytes using
 * the per-chunk data sizes recorded by the parser (payloads.chunks).
 *
 * Framing is "<hex-size>[;ext]\r\n<data>\r\n ... 0\r\n\r\n". Each stored size is a
 * chunk's data length; we skip the size line (up to its CRLF), copy `size` bytes,
 * then skip the trailing CRLF. Returns the concatenated, de-framed body.
 */
export function dechunkBody(raw: Uint8Array, chunkSizes: number[]): Uint8Array {
    const out = new Uint8Array(chunkSizes.reduce((sum, n) => sum + n, 0));
    let src = 0;
    let dst = 0;

    for (const size of chunkSizes) {
        // Advance past the chunk-size line: to just after the next CRLF.
        while (src + 1 < raw.length && !(raw[src] === 0x0d && raw[src + 1] === 0x0a)) src++;
        src += 2; // consume CRLF after the size line

        const available = Math.max(0, Math.min(size, raw.length - src));
        out.set(raw.subarray(src, src + available), dst);
        dst += available;
        src += size + 2; // consume data + trailing CRLF

        if (available < size) break; // truncated payload -> stop cleanly
    }

    return dst === out.length ? out : out.subarray(0, dst);
}

/**
 * Compute the absolute [start, end) byte range of each chunk's *data* within the
 * stored payload, derived from the chunk sizes. This lets the view route serve a
 * chunked body as a concatenation of BunFile slices (streamed from disk, no copy)
 * instead of de-framing into memory.
 *
 * Assumes canonical chunk-size lines ("<lowercase-hex>\r\n", no chunk extensions),
 * which is what servers emit and what these WARCs contain. If you ever need to
 * support exotic framing, store the offsets in the parser instead of deriving.
 */
export function chunkDataRanges(payloadStart: number, chunkSizes: number[]): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let pos = payloadStart;

    for (const size of chunkSizes) {
        const sizeLineLen = size.toString(16).length + 2; // "<hex>" + CRLF
        const dataStart = pos + sizeLineLen;
        ranges.push([dataStart, dataStart + size]);
        pos = dataStart + size + 2; // skip the data and its trailing CRLF
    }

    return ranges;
}
