/** Chunk framing only. Header blocks are split leniently — see mWarcExtractHeader. */
const CRLF = '\r\n';
const CHUNK_SIZE = 1024; // Increased chunk size for better performance

const decoder = new TextDecoder();

export interface WarcDecodeOptions {
  content?: boolean;
  returnChunkSizes?: boolean;
  /** Also report the full (de-chunked) content size on each response record. */
  returnFullSize?: boolean;

  /**
   * Bytes per `read` call while scanning for headers. Defaults to CHUNK_SIZE.
   *
   * WarcFileContext has carried this field and mWarcConsumeNextChunk has honoured
   * it since the beginning, but nothing ever set it — so it was a knob wired to
   * nothing and every caller got 1 KiB. It matters most in the browser, where
   * each read is a Blob.slice().arrayBuffer() promise: a profile of the offline
   * viewer showed the parse workers 85% idle, waiting on ~11 read round trips per
   * record rather than on any actual work.
   *
   * Bigger is not automatically better. Only the WARC header plus, for a
   * response, the HTTP header need to be READ — the payload is skipped by moving
   * the offset (see the record-advance below), so a chunk far larger than those
   * two header blocks just reads bytes to throw away.
   */
  chunkSize?: number;

  /**
   * First byte this pass owns. Defaults to the start of the file.
   *
   * MUST already be a record boundary — this does not go looking for one. Use
   * mWarcFindRecordStart to turn an arbitrary offset into one, which is what a
   * segmented parse does before it gets here.
   */
  start?: number;

  /**
   * One past the last byte this pass owns. Defaults to no limit.
   *
   * Stops when a record's own START reaches this, so the record that STRADDLES the
   * boundary is still parsed in full. That asymmetry is the whole ownership rule
   * for a segmented parse: a record belongs to whichever segment its first byte
   * falls in, and that segment reads past its own end to finish it. Adjacent
   * segments therefore neither skip a record nor parse one twice, and never have to
   * know anything about each other.
   */
  end?: number;
}

export type WarcRecordContentTType = "arrayBuffer" | "readableStream";

export interface WarcRecord {
  'header-warc': Record<string, string | number>;
  'header-meta'?: Record<string, string | number>;
  'header-content'?: Record<string, ArrayBuffer | string | number | number[] | null | undefined>;
}

export interface WarcFileContext {
  read: (start: number, size: number) => Promise<ArrayBuffer | null>,
  offset: number,
  buffer: ArrayBuffer,
  isEOF: boolean,
  chunkSize?: number,
}

export class WarcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarcParseError';
  }
}

const concatArrays = (arrays: ArrayBuffer[]): ArrayBuffer => {
  // Calculate the total length of all buffers
  const totalLength = arrays.reduce((acc, arr) => acc + arr.byteLength, 0);

  // Create a new ArrayBuffer to hold the concatenated data
  const result = new ArrayBuffer(totalLength);
  const resultView = new Uint8Array(result); // Create a Uint8Array view for manipulation

  let offset = 0;
  for (const arr of arrays) {
    const arrView = new Uint8Array(arr); // Create a Uint8Array view for the current buffer
    resultView.set(arrView, offset); // Copy the data to the result buffer
    offset += arrView.length;
  }

  return result;
};

/**
 * A status line, matched by SHAPE rather than by counting words.
 *
 * `HTTP/1.1 302` — with no reason phrase at all — is a legal status line. RFC 9110
 * §15.1 makes the reason phrase optional and tells clients not to act on its
 * content, so a server is free to send none, and some do: funnyjunk.com's
 * `/imgrd/rd/` redirect endpoint runs openresty and emits exactly that.
 *
 * This used to be `statusLine.split(' ').length >= 3`, which threw on the bare
 * form and took the entire archive down with it. Measured on the 2018 kiwifarms
 * set: `-00062.warc` died 1.3% in at record 2,113, `-00066` at 517, `-00010` at
 * 6,058, `-00007` at 6,477 — every one of them on the first bare `HTTP/1.1 302`
 * from that one host, in files of 6 to 10 GB.
 *
 * Matching the shape is also STRICTER than counting was: `some random text here`
 * satisfied "three or more parts" and was accepted as a status line. It is not now.
 */
const HTTP_STATUS_LINE = /^(HTTP\/\d(?:\.\d)?) (\d{3})(?: (.*))?$/;

/** `WARC/1.0`, `WARC/1.1`, and whatever comes next. */
const WARC_VERSION_LINE = /^WARC\/\d+\.\d+$/;

/**
 * A field by name, case-insensitively.
 *
 * Both specs say field names are case-insensitive — WARC 1.1 §4 for the record
 * headers, RFC 9110 §5.1 for the HTTP ones — and this parser was reading three
 * fields by exact string: `headerWarc['WARC-Type']`, `headerHTTP['Transfer-
 * Encoding']`, and a `['Content-Length'] || ['content-length']` hedge that shows
 * somebody already hit this once and patched the single instance.
 *
 * A writer using `warc-type:` would have had every record fall to the default
 * branch and be skipped as opaque. None of the archives on hand do that, so this
 * is latent rather than observed — but it costs one map walk over a dozen keys
 * and removes a whole class of "this archive reads as empty".
 */
const field = (headers: Record<string, string>, name: string): string | undefined => {
  const direct = headers[name];
  if (direct !== undefined) return direct;

  const want = name.toLowerCase();

  for (const key in headers) {
    if (key.toLowerCase() === want) return headers[key];
  }

  return undefined;
};

export const mWarcDecodeHeader = (headerStr: string, options?: { isHttp?: boolean }): Record<string, string> => {
  if (!headerStr.trim()) {
    throw new WarcParseError('Invalid or empty header string');
  }

  const headerObj: Record<string, string> = {};
  /*
   * Split on CRLF *or* bare LF, and tolerate a stray CR on the end of a line.
   *
   * `split(CRLF)` on an LF-delimited block returns ONE element — the whole header
   * block — so every field was lost and the status-line check saw a 500-byte
   * "line". WARC's own headers are always CRLF, but the HTTP block is whatever the
   * server sent, and these 2018 captures include plenty of bare LF.
   *
   * The trailing-CR strip covers mixed endings: a block that is mostly CRLF with
   * one LF-only line splits unevenly and would otherwise leave `\r` on the end of
   * a value, which then fails an exact-match comparison like `chunked`.
   */
  const lines = headerStr.split(/\r?\n/).map(line => line.replace(/\r+$/, ''));

  // Parse HTTP status line if `isHttp` is set to true
  if (options?.isHttp) {
    const statusLine = lines.shift(); // Get and remove the first line

    if (statusLine) {
      const status = HTTP_STATUS_LINE.exec(statusLine);

      if (!status) {
        // The offending line, in the message. Without it this error named neither
        // a cause nor a location, which is most of why the bare-status-line bug
        // cost a day: "Invalid HTTP status line" on a 6.6 GB file says nothing
        // about which of its million records is at fault.
        throw new WarcParseError(
          `Invalid HTTP status line: ${JSON.stringify(statusLine.slice(0, 120))}`,
        );
      }

      headerObj['httpVersion'] = status[1]!;       // "HTTP/1.1"
      headerObj['statusCode'] = status[2]!;        // "302"
      // Empty string, not undefined: an absent reason phrase is an empty one, and
      // every consumer reads this as a string.
      headerObj['statusText'] = status[3] ?? '';
    }
  }

  /*
   * The WARC version line.
   *
   * It carries no colon, so the field loop below skips it — and nothing else
   * looked at it, so the version was thrown away entirely and no consumer could
   * tell a 1.0 record from a 1.1 one. Kept under a synthetic key, matching the
   * httpVersion/statusCode/statusText convention above.
   *
   * Not read for dispatch: 1.1 is a superset in every way that affects parsing,
   * so the parser stays version-agnostic and this is for consumers that care
   * (revisit resolution needs to know which fields it may rely on).
   */
  if (!options?.isHttp) {
    const version = lines[0]?.trim();

    if (version && WARC_VERSION_LINE.test(version)) headerObj['warcVersion'] = version;
  }

  /*
   * Repeated fields are JOINED, not overwritten.
   *
   * This used to be a plain assignment, so the last occurrence won and the rest
   * vanished. WARC 1.1 §5 explicitly permits multiple `WARC-Concurrent-To` on one
   * record, which made silent loss a spec violation rather than a nuisance; on the
   * HTTP side the four local archives carry 244 repeated `Vary` and 104 repeated
   * `Set-Cookie`.
   *
   * Comma-joining is what RFC 9110 §5.3 prescribes for list-valued fields, which
   * covers WARC-Concurrent-To, Vary and Cache-Control. `Set-Cookie` is the famous
   * exception that must NOT be combined — nothing in this codebase reads it, so
   * joining is merely inelegant here rather than wrong, but anything that starts
   * replaying cookies needs to keep them apart.
   *
   * Keyed case-insensitively, so `Set-Cookie` and `set-cookie` in one block join
   * rather than becoming two entries.
   */
  const seen = new Map<string, string>();

  lines.forEach(line => {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      const first = seen.get(key.toLowerCase());

      if (first === undefined) {
        seen.set(key.toLowerCase(), key);
        headerObj[key] = value;
      } else {
        headerObj[first] = `${headerObj[first]}, ${value}`;
      }
    }
  });

  return headerObj;
};

/**
 * The header block, terminator included — accepting `\n\n` as well as `\r\n\r\n`.
 *
 * WARC mandates CRLF for its own headers, but the HTTP block inside a `response`
 * record is whatever the origin server actually sent, and plenty of 2018-era
 * servers sent bare LF. This used to scan only for CRLFCRLF, so on an LF-delimited
 * block it ran straight past the real terminator and kept going until it found a
 * CRLFCRLF somewhere in the BODY — returning a "header" with image bytes on the
 * end. The visible symptom was:
 *
 *   Invalid HTTP status line: "HTTP/1.1 200 \nContent-Type: image/gif\n…\n\nGIF"
 *
 * The whole block came back as one line because splitting it on CRLF found no
 * separator at all.
 *
 * The record advance survived it — `headerHTTPRaw.byteLength` cancels out of that
 * arithmetic — which is why this presented as a parse error rather than as a
 * desync, and why it always died on the first LF-delimited record instead of
 * quietly corrupting everything after one.
 *
 * There is no ambiguity in accepting both: CRLFCRLF is `0D 0A 0D 0A` and contains
 * no `0A 0A`, so a CRLF block can never match the LF terminator early. Whichever
 * appears first wins, and the returned slice includes it so the caller's length
 * arithmetic stays honest for a 2-byte terminator as well as a 4-byte one.
 */
export const mWarcExtractHeader = (buffer: ArrayBuffer): ArrayBuffer | null => {
  const byteView = new Uint8Array(buffer);
  const CR = 0x0d;
  const LF = 0x0a;

  for (let i = 0; i + 1 < byteView.length; i++) {
    if (byteView[i] !== LF) continue;

    // \n\n — bare LF block.
    if (byteView[i + 1] === LF) return buffer.slice(0, i + 2);

    // \r\n\r\n — the spec form. Checked from the first LF so one pass finds either.
    if (
      byteView[i + 1] === CR &&
      i + 2 < byteView.length &&
      byteView[i + 2] === LF
    ) {
      return buffer.slice(0, i + 3);
    }
  }

  // No terminator in what we have yet; the caller reads more and asks again.
  return null;
};

/**
 * Longest "<hex-size>[;ext]\r\n" line the walkers will look in for a CRLF.
 *
 * 64 bytes is far more than any realistic size line needs, and it is also the
 * amount the old implementation read per chunk — kept identical so the cutoff for
 * "this framing is malformed" does not move.
 */
const MAX_SIZE_LINE = 64;

/**
 * Bytes fetched per read while walking chunk framing.
 *
 * The walkers used to issue one 64-byte read per chunk: almost no bytes, one
 * round trip each. Measured against the archives on hand that was 65-97% of ALL
 * reads a parse performed — on slice1.warc, 1720 of 1778 — and a browser profile
 * had the parse workers 63-93% idle waiting on exactly this.
 *
 * A block spans several size lines, so the walk usually finds the next one
 * already in memory. It reads the chunk data it passes over, but because the
 * cursor is clamped to the body's end (see createFramingCursor) it can never read
 * past anything the walk might need — so bytes read approach the size of the
 * chunked bodies themselves and stop there, rather than growing with the block.
 *
 * Chosen at the knee of the measured curve. Across the five archives on hand,
 * whose chunked bodies total 88.3 MB — the floor for bytes read:
 *
 *     block      reads   bytes read   vs 64-byte reads
 *     64 B        5710      0.3 MB    —
 *     8 KiB       4672     30.4 MB    -18%
 *     32 KiB      3272     73.1 MB    -43%
 *     64 KiB      2154     73.8 MB    -62%
 *     128 KiB     1662     82.7 MB    -71%
 *     256 KiB     1425     85.7 MB    -75%     <- here
 *     512 KiB     1303     87.3 MB    -77%
 *     1 MiB       1241     88.1 MB    -78%
 *
 * Past 256 KiB another 2-3% of reads costs most of the remaining headroom for no
 * real return. Peak cost is one block per walker, and walkers run one at a time
 * per worker, so this is a megabyte across four threads.
 */
const FRAMING_BLOCK_SIZE = 256 * 1024;

/**
 * A one-block read cache for walking chunk framing forward.
 *
 * Only ever asked for increasing offsets, so it keeps a single block and refills
 * whenever the next size line falls outside it — no eviction policy, no map.
 */
const createFramingCursor = (
  read: (start: number, size: number) => Promise<ArrayBuffer> | Promise<null>,
  blockSize: number = FRAMING_BLOCK_SIZE,
  /**
   * Absolute offset the walk cannot pass, when the caller knows it.
   *
   * Without this the last read of every body overshoots its end by most of a
   * block, and for a body smaller than a block that is the whole read. Measured
   * over the archives on hand, an unclamped 256 KiB block read 204 MB to walk
   * roughly 75 MB of chunk data — nearly threefold waste, all of it past the ends
   * of short bodies. Clamping makes a larger block strictly better rather than a
   * trade, since it can no longer read anything the walk might not need.
   */
  limit?: number,
) => {
  const want = Math.max(blockSize, MAX_SIZE_LINE);

  let block = new Uint8Array(0);
  let blockStart = 0;
  let short = false; // the last read came back partial, so the source ends inside `block`

  /** Bytes from `pos` onward, refilling if the block cannot cover a size line. */
  return async (pos: number): Promise<Uint8Array | null> => {
    const offset = pos - blockStart;
    const available = offset >= 0 ? block.byteLength - offset : -1;

    // A short block means there is nothing further to read, so however few bytes
    // remain are all there will ever be — return them rather than re-reading EOF.
    if (available >= MAX_SIZE_LINE || (available > 0 && short)) {
      return block.subarray(offset);
    }

    // Never less than a size line, even at the very end of the body: the
    // terminating "0\r\n\r\n" sits at `limit` and has to be readable.
    const size = limit === undefined
      ? want
      : Math.max(MAX_SIZE_LINE, Math.min(want, limit - pos));

    const buffer = await read(pos, size);
    if (!buffer || buffer.byteLength === 0) return null;

    block = new Uint8Array(buffer);
    blockStart = pos;
    short = buffer.byteLength < size;

    return block;
  };
};

/**
 * Byte offset of the first CRLF within a size line's worth of bytes, or -1.
 *
 * Scans bytes rather than decoding to a string and using indexOf. Cheaper, since
 * it never decodes the chunk data a block happens to contain — and more correct:
 * the returned index is used as a BYTE advance, so a string index would be wrong
 * the moment a malformed body put a multi-byte sequence ahead of the CRLF.
 */
const indexOfCrlf = (bytes: Uint8Array): number => {
  const limit = Math.min(bytes.byteLength, MAX_SIZE_LINE) - 1;

  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x0D && bytes[i + 1] === 0x0A) return i;
  }

  return -1;
};

/** The chunk size a size line declares. NaN when it is not hex. */
const parseChunkSize = (bytes: Uint8Array, lineLength: number): number =>
  // parseInt stops at the first non-hex character, which is what makes a
  // ";chunk-ext" suffix free to ignore.
  parseInt(decoder.decode(bytes.subarray(0, lineLength)), 16);

/**
 * Walk the HTTP/1.1 "Transfer-Encoding: chunked" framing of a response body and
 * return the byte size of each data chunk, in order.
 *
 * Chunk framing is:  <hex-size>[;chunk-ext]\r\n<data>\r\n ... 0\r\n\r\n
 *
 * Reads chunk headers directly from the source via `read`, so the result never
 * depends on the decoder's sliding buffer or on where its read boundaries happen
 * to fall. Chunk extensions are handled transparently: parseInt() stops at the
 * first non-hex character, and the byte advance uses the full size-line length
 * (up to the CRLF), so any ";ext" is skipped as well.
 */
const collectChunkSizes = async (
  read: (start: number, size: number) => Promise<ArrayBuffer> | Promise<null>,
  bodyOffset: number,
  bodyLength: number,
  blockSize?: number,
): Promise<number[]> => {
  const sizes: number[] = [];
  const end = bodyOffset + bodyLength;
  // The body's end is known here, so no read can stray past it.
  const nextBytes = createFramingCursor(read, blockSize, end);
  let pos = bodyOffset;

  while (pos < end) {
    const bytes = await nextBytes(pos);
    if (!bytes || bytes.byteLength === 0) break;

    const lineLength = indexOfCrlf(bytes);
    if (lineLength < 0) break; // no size line found -> malformed or truncated

    const size = parseChunkSize(bytes, lineLength);
    if (Number.isNaN(size)) break;
    if (size === 0) break; // terminating "0\r\n\r\n" chunk

    sizes.push(size);

    // Advance past: <size-line> CRLF <data> CRLF
    pos += lineLength + CRLF.length + size + CRLF.length;
  }

  return sizes;
};

/**
 * Like collectChunkSizes, but for when the record's byte length is NOT known up
 * front: walk the chunk framing all the way to the terminating "0\r\n\r\n" and
 * report both the per-chunk data sizes and the TOTAL raw framed length consumed
 * (size-lines + CRLFs + data + terminator). This lets us recover records whose
 * WARC Content-Length header is missing — a chunked body is self-delimiting.
 */
const measureChunkedBody = async (
  read: (start: number, size: number) => Promise<ArrayBuffer> | Promise<null>,
  bodyOffset: number,
  blockSize?: number,
): Promise<{ sizes: number[]; rawLength: number }> => {
  const sizes: number[] = [];
  // No limit: this walker exists precisely because the body's length is unknown,
  // so there is no end to clamp to. It stops at the terminating chunk instead.
  const nextBytes = createFramingCursor(read, blockSize);
  let pos = bodyOffset;

  // Guard against runaway loops on malformed / non-terminating data.
  for (let guard = 0; guard < 5_000_000; guard++) {
    const bytes = await nextBytes(pos);
    if (!bytes || bytes.byteLength === 0) break;

    const lineLength = indexOfCrlf(bytes);
    if (lineLength < 0) break;

    const size = parseChunkSize(bytes, lineLength);
    if (Number.isNaN(size)) break;

    if (size === 0) {
      // Terminating chunk: "0" CRLF [trailers] CRLF — assume no trailer headers.
      pos += lineLength + CRLF.length + CRLF.length;
      break;
    }

    sizes.push(size);
    pos += lineLength + CRLF.length + size + CRLF.length;
  }

  return { sizes, rawLength: pos - bodyOffset };
};

const mWarcConsumeNextChunk = (file:WarcFileContext) => 
  file.read(file.offset, file.chunkSize ?? CHUNK_SIZE).then(buffer => {
      if (buffer === null || buffer.byteLength === 0) {
        file.isEOF = true;
        buffer = new ArrayBuffer(0)
        return buffer;
      }
      file.offset += buffer.byteLength;
      return buffer
      });

const mWarcConsumeNextHeader = async (file:WarcFileContext, options?: { isHttp?: boolean }) => {
    let headerBuffer: ArrayBuffer | null = mWarcExtractHeader(file.buffer ?? new ArrayBuffer(0));
    while (headerBuffer == null) {
      if (file.isEOF) return null;

      file.buffer = concatArrays([file.buffer ?? new ArrayBuffer(0), await mWarcConsumeNextChunk(file)]);
      headerBuffer = mWarcExtractHeader(file.buffer ?? new ArrayBuffer(0));
    }

    const raw = file.buffer?.slice(0, headerBuffer.byteLength);
    const header = mWarcDecodeHeader(decoder.decode(headerBuffer), options);
    file.buffer = file.buffer?.slice(headerBuffer.byteLength, file.buffer.byteLength) ?? new ArrayBuffer(0);

    return { raw, length: headerBuffer.byteLength, header }
  }


/* ---------------------------------------------------------------------------
 * Finding a record boundary from an arbitrary offset.
 *
 * A segmented parse cuts the file on byte counts, so a segment's first byte is
 * almost never a record start. This is what turns it into one.
 * ------------------------------------------------------------------------ */

/** "WARC/1." — the start of a version line. */
const VERSION_NEEDLE = [0x57, 0x41, 0x52, 0x43, 0x2f, 0x31, 0x2e];

/**
 * Bytes between the end of a record's content block and the next version line.
 *
 * Four: the spec's two CRLFs. Confirmed arithmetically against a real archive
 * rather than taken from the spec — a response at 1,235 with Content-Length 59,301
 * whose header block ends at 1,764 is followed by the next record at 61,069, and
 * 1,764 + 59,301 + 4 = 61,069.
 *
 * Note the record-advance below adds 8 rather than 4. That is not a contradiction:
 * `remainingContentLength` there is already `contentSize - 4`, so the two agree.
 */
const RECORD_TRAILER = 4;

/**
 * How far the next version line may sit from where the arithmetic says.
 *
 * Real writers disagree with the spec's two CRLFs, and treating 4 as exact does
 * not reject those files - it silently guts them. Confirmation fails on EVERY
 * boundary, so a resync scan concludes there are no records and skips the lot:
 * ne.jp.asahi yielded 3 records instead of 13,063, stefangagne 3 instead of 387.
 *
 * Measured gaps in this corpus are 4 and 8 (wget writes four CRLFs after the
 * content block), so 0..8 inclusive covers it.
 *
 * Kept deliberately tight. The confirmation exists to reject a "WARC/1." that
 * merely appears inside a payload - a nested archive, a crawl of an archive -
 * and it works because such a header's arithmetic end lands somewhere
 * unrelated. A generous window would trade that away.
 */
const TRAILER_SLACK = 8;

/** The gaps actually seen: the spec's two CRLFs, and wget's four. */
const ALLOWED_TRAILERS = [RECORD_TRAILER, RECORD_TRAILER + 4];

/**
 * How much to read when probing a candidate's header block.
 *
 * Real WARC headers run 400–800 bytes. 8 KiB is room for an unusually field-heavy
 * one — Browsertrix writes WARC-Page-ID, WARC-Protocol, WARC-Resource-Type and
 * WARC-JSON-Metadata on top of the standard set — without reading a payload's worth
 * per candidate.
 */
const MAX_HEADER_PROBE = 8 * 1024;

/** Two byte arrays, joined. `concatArrays` above works on ArrayBuffers. */
const concatBytes = (first: Uint8Array, second: Uint8Array): Uint8Array => {
  const out = new Uint8Array(first.length + second.length);

  out.set(first);
  out.set(second, first.length);

  return out;
};

/**
 * How much to read at a time while scanning, and how much to carry over.
 *
 * The overlap has to be at least the needle length minus one, or a version line
 * straddling two reads is invisible. One extra byte on top so the "preceded by a
 * newline" test can see the character before a candidate at a window's start.
 */
const SCAN_WINDOW = 1 << 20;
const SCAN_OVERLAP = VERSION_NEEDLE.length;

/**
 * Does `at` look like a real record start, confirmed against the NEXT record?
 *
 * A bare "WARC/1." at a line start is not proof. It occurs inside a payload
 * whenever a WARC is archived inside another WARC — a derived archive, or a crawl
 * of an archive — and there is nothing about those bytes to distinguish them.
 *
 * The confirmation is arithmetic rather than pattern-matching: read this record's
 * header, take its Content-Length, and check that the record ends where it says it
 * does — that is, that another version line (or EOF) sits at
 * `headerEnd + contentLength + separator`. A planted header inside a payload does
 * not line up, because the bytes after it belong to the enclosing record.
 *
 * Measured on the corpus to hand — lolcow, crystal.cafe, nekoweb, 5am, and 400 MB
 * of onionfarms, ~14,300 records — the bare scan produced ZERO false positives, so
 * this is belt-and-braces. It is here because the corpus is not the world and the
 * failure it prevents is silent: a segment that starts mid-payload parses garbage
 * and reports it as records.
 */
const looksLikeRecordStart = async (
  read: (start: number, size: number) => Promise<ArrayBuffer | null>,
  at: number,
  fileEnd: number,
): Promise<boolean> => {
  const probe = await read(at, MAX_HEADER_PROBE);
  if (!probe || probe.byteLength === 0) return false;

  const headerBuffer = mWarcExtractHeader(probe);
  if (!headerBuffer) return false;

  const header = mWarcDecodeHeader(decoder.decode(headerBuffer));

  // A version line with no type and no length is not a record header.
  if (!field(header, 'WARC-Type')) return false;

  const contentLength = parseInt(field(header, 'Content-Length') ?? '', 10);
  if (!Number.isFinite(contentLength) || contentLength < 0) return false;

  // Where the next record must begin. RECORD_TRAILER is the separator between the
  // content block and the next version line.
  const next = at + headerBuffer.byteLength + contentLength + RECORD_TRAILER;

  /*
   * Ran off the end. Accepted, and this is the guard's one blind spot.
   *
   * A truncated archive — an interrupted crawl, a partial download — ends with a
   * record that has nothing after it to confirm against. Refusing it would lose the
   * tail of every such file, which is worse than the alternative: a planted header
   * whose own Content-Length happens to reach exactly the end of the enclosing file
   * is accepted.
   *
   * That combination is narrow. A nested WARC inside a payload is followed by the
   * REST of the outer archive, so `next` lands mid-payload and the check below
   * rejects it; it only slips through when the nested record is the last thing in
   * the file. Taking the tail of real truncated archives is worth that.
   */
  if (next >= fileEnd) return true;

  const after = await read(next - RECORD_TRAILER, TRAILER_SLACK + VERSION_NEEDLE.length);
  if (!after || after.byteLength < VERSION_NEEDLE.length) return true;

  const bytes = new Uint8Array(after);

  /*
   * Two discrete positions, not a window.
   *
   * A sliding 0..8 scan recovered the same records but cost the guard its
   * reason for existing: the "planted version line inside a payload" test
   * started passing the check, because nine chances to match is most of the way
   * to no check at all.
   *
   * Both gaps actually observed are whole CRLF pairs - 4 (the spec) and 8 (what
   * wget writes) - so only those two are allowed. A planted header has to land
   * on one of exactly two offsets rather than anywhere in a nine-byte span.
   */
  for (const trailer of ALLOWED_TRAILERS) {
    const skew = trailer - RECORD_TRAILER;
    if (skew + VERSION_NEEDLE.length > bytes.length) continue;
    if (VERSION_NEEDLE.every((byte, index) => bytes[skew + index] === byte)) return true;
  }

  return false;
};

/**
 * The first record start at or after `from`, or null if there is none before
 * `limit`.
 *
 * Null is a normal answer, not an error: a single record can span an entire
 * segment, in which case that segment owns no records at all and the segment
 * before it is the one parsing the record in question.
 *
 * `from` of 0 is answered immediately — the file starts on a record by definition,
 * and scanning would be a waste as well as a chance to be wrong.
 */
/**
 * How far to scan for the next record before giving up.
 *
 * 1 GiB, sized from the corpus rather than picked: the largest gap measured is
 * shallowsky's 447.83 MB NUL run, and openxcom's is 65.59 MB. A limit gives up
 * on a file that is genuinely garbage instead of reading terabytes to prove it,
 * and the scan itself is streamed in 1 MiB windows either way — this bounds the
 * WORK, not the memory.
 */
const RESYNC_LIMIT = 1 << 30;

/**
 * Is there a version line exactly at `at`?
 *
 * Deliberately a cheap byte compare and NOT mWarcFindRecordStart: this runs once
 * per record on the happy path, where the answer is yes and the arithmetic
 * confirmation the scanner does would mean an extra read per record for nothing.
 * The expensive confirmed scan is only paid when this says no.
 */
const mWarcAtRecordStart = async (
  read: (start: number, size: number) => Promise<ArrayBuffer | null>,
  at: number,
): Promise<boolean> => {
  const buffer = await read(at, VERSION_NEEDLE.length);

  // A short read means EOF here, and EOF is a legitimate end of stream rather
  // than a broken boundary. Reported as "at a boundary" so the caller's normal
  // header read runs and terminates the loop the way it always has.
  if (!buffer || buffer.byteLength < VERSION_NEEDLE.length) return true;

  const bytes = new Uint8Array(buffer);

  return VERSION_NEEDLE.every((byte, index) => bytes[index] === byte);
};

export const mWarcFindRecordStart = async (
  read: (start: number, size: number) => Promise<ArrayBuffer | null>,
  from: number,
  limit: number,
  fileEnd: number = Number.MAX_SAFE_INTEGER,
): Promise<number | null> => {
  if (from <= 0) return 0;

  let at = from;
  let carry: Uint8Array = new Uint8Array(0);
  let carryAt = from;

  while (at < limit) {
    const buffer = await read(at, SCAN_WINDOW);
    if (!buffer || buffer.byteLength === 0) return null;

    const fresh = new Uint8Array(buffer);

    // Joined to the tail of the previous window so a version line split across
    // two reads is still found. `window` therefore begins at carryAt, not at.
    const window = carry.length === 0 ? fresh : concatBytes(carry, fresh);
    const windowAt = carry.length === 0 ? at : carryAt;

    for (let i = 0; i + VERSION_NEEDLE.length <= window.length; i++) {
      if (window[i] !== VERSION_NEEDLE[0]) continue;

      let matched = true;
      for (let k = 1; k < VERSION_NEEDLE.length; k++) {
        if (window[i + k] !== VERSION_NEEDLE[k]) { matched = false; break; }
      }
      if (!matched) continue;

      const candidate = windowAt + i;

      // At a line start only. A version line is the first thing in a record, so
      // anything mid-line is text that happens to read "WARC/1." — which is most
      // of what a scan over HTML finds.
      //
      // At windowAt itself the preceding byte is in the previous window; the
      // carry is what makes it visible, so this only guesses at the very first
      // window, where `from` was handed to us as a segment boundary and the byte
      // before it belongs to the previous segment.
      if (i > 0) {
        if (window[i - 1] !== 0x0a) continue;
      } else if (candidate !== 0) {
        continue;
      }

      if (candidate >= limit) return null;

      if (await looksLikeRecordStart(read, candidate, fileEnd)) return candidate;
    }

    // Nothing found. Carry the tail so a needle straddling the seam survives.
    const keep = Math.min(SCAN_OVERLAP, window.length);
    carry = window.slice(window.length - keep);
    carryAt = windowAt + window.length - keep;
    at = windowAt + window.length;

    // A short read means the source ended inside this window.
    if (fresh.byteLength < SCAN_WINDOW) return null;
  }

  return null;
};

export const mWarcDecode = async function* (
  read: (start: number, size: number) => Promise<ArrayBuffer | null>,
  options?: WarcDecodeOptions
): AsyncIterableIterator<WarcRecord> {
  const { content: returnContent = false, returnChunkSizes = false, returnFullSize = false, chunkSize, start, end } = { ...options };

  const file: WarcFileContext = {
    read,
    // `start` must already be a record boundary — see the option's note.
    offset: start && start > 0 ? start : 0,
    buffer: new ArrayBuffer(0),
    isEOF: false,
    // Left undefined when not asked for, so mWarcConsumeNextChunk falls back to
    // CHUNK_SIZE and an existing caller behaves exactly as before.
    chunkSize: chunkSize && chunkSize > 0 ? chunkSize : undefined,
  };

  while (!file.isEOF) {
    const headerWarcOffset = file.offset - file.buffer.byteLength;

    // Past this pass's share. Checked on the record's own START, before reading
    // its header, so the record straddling the boundary has already been yielded
    // by the check failing on the PREVIOUS iteration — see the `end` note.
    if (end !== undefined && headerWarcOffset >= end) return;

    /*
     * Are we actually AT a record boundary?
     *
     * Nothing checked this before, and real archives are not as tidy as the
     * arithmetic assumes. Seven files in a 1,780-file corpus fail here, in two
     * shapes that turn out to be the same problem:
     *
     *   1. NUL holes. wget-written WARCs contain sparse runs where a record
     *      should be — 0.11 MB in stefangagne, 0.58 MB in ne.jp.asahi, 65.59 MB
     *      in openxcom, 447.83 MB in shallowsky — with perfectly valid records
     *      resuming on the far side. Handing that to the header reader is what
     *      produced "RangeError: Out of memory": indexOfCrlf never finds a CRLF
     *      in a NUL run, so the buffer grows until the process dies. Nearly half
     *      a gigabyte, times eight worker threads.
     *
     *   2. Off-by-two framing. tmp.win98mcom.warc desynchronises on its FIRST
     *      record: the computed next-record offset lands two bytes inside
     *      "WARC/1.0", so the reader parses "RC/1.0..." as a header, finds no
     *      Content-Length, and threw.
     *
     * Both are recoverable, and the machinery was already here —
     * mWarcFindRecordStart scans in bounded 1 MiB windows and confirms a
     * candidate arithmetically against the NEXT record, so it cannot resync onto
     * a "WARC/1." that merely appears inside a payload. It just was never called
     * from the read path; it existed for picking a segment's start offset.
     *
     * Checking BEFORE reading rather than recovering after is the whole point:
     * once a NUL run is being consumed as a header, the memory is already gone.
     */
    if (!(await mWarcAtRecordStart(read, headerWarcOffset))) {
      const resumeAt = await mWarcFindRecordStart(
        read,
        headerWarcOffset + 1,
        RESYNC_LIMIT,
        end ?? Number.MAX_SAFE_INTEGER,
      );

      /*
       * No further record: the file ends in padding. animesuki-forum does
       * exactly this — 1,113 good records, then trailing NULs at 98.3%. That is
       * a clean end of stream, not an error, and throwing lost 1,113 records
       * over bytes that contain nothing.
       */
      if (resumeAt === null) return;

      file.offset = resumeAt;
      file.buffer = new ArrayBuffer(0);
      file.isEOF = false;

      console.warn(
        `mwarc: skipped ${resumeAt - headerWarcOffset} bytes of non-record data at `
        + `offset ${headerWarcOffset}, resuming at ${resumeAt}`,
      );

      continue;
    }

    const headerWarcObject = await mWarcConsumeNextHeader(file);

    if (!headerWarcObject) return;

    const { header: headerWarc, raw: headerWarcRaw } = headerWarcObject;
    let remainingContentLength = parseInt(field(headerWarc, 'Content-Length') ?? '', 10)

    // A missing WARC Content-Length isn't necessarily fatal: for a chunked response
    // the body is self-delimiting, so we can walk its framing to derive the length
    // (handled in the "response" case below). Defer the decision until we know the
    // WARC-Type.
    const contentLengthMissing = isNaN(remainingContentLength);

    switch (field(headerWarc, 'WARC-Type')) {
      case "response": {
        const headerHTTPOffset = file.offset - file.buffer.byteLength;
        const headerHTTPObject = await mWarcConsumeNextHeader(file, { isHttp: true });

        if (!headerHTTPObject) throw new WarcParseError(`ERROR: Malformed warc 'response' header ${JSON.stringify(headerWarc, null, 2)}`);

        const { header: headerHTTP, raw: headerHTTPRaw } = headerHTTPObject;

        if (headerHTTPRaw?.byteLength === undefined) throw new WarcParseError(`ERROR: Malformed warc 'response' header ${JSON.stringify(headerWarc, null, 2)}`);

        /*
         * A transfer-coding LIST, not a single value.
         *
         * `=== "chunked"` missed `Chunked` and, more importantly, `gzip, chunked`
         * — a legal RFC 9112 §6.1 stack where chunked framing wraps gzipped
         * content. Reading that as unchunked does not throw: it takes the body
         * length from the wrong place and desynchronises the record stream, which
         * surfaces later as an "Invalid HTTP status line" somewhere unrelated.
         * Exactly the failure mode we just spent a day on, from a different cause.
         */
        const transferEncoding = (field(headerHTTP, 'Transfer-Encoding') ?? '').toLowerCase();
        const isChunked = transferEncoding.split(',').some(coding => coding.trim() === 'chunked');
        const contentOffset =   file.offset - file.buffer.byteLength; // absolute start of the HTTP body

        // Recover a missing WARC Content-Length. A chunked body is self-delimiting,
        // so walk its framing to learn the raw body length, then rebuild the value
        // the math below expects: WARC Content-Length = HTTP header bytes + body bytes.
        let measured: { sizes: number[]; rawLength: number } | null = null;
        if (contentLengthMissing) {
          if (!isChunked) {
            throw new WarcParseError(`ERROR: Content-Length missing and body is not chunked; cannot determine record length.\r\n${JSON.stringify(headerWarc, null, 2)}`);
          }
          measured = await measureChunkedBody(read, contentOffset);
          remainingContentLength = headerHTTPRaw.byteLength + measured.rawLength;
        }

        remainingContentLength -= headerHTTPRaw.byteLength + 4;

        // remainingContentLength is 4 short of the real HTTP body: the extra 4 was
        // subtracted above so the record-advance skips the trailing CRLFCRLF. The
        // payload itself is those 4 bytes longer, so report the true length here —
        // otherwise every non-chunked body is served truncated by 4 bytes.
        const contentSize = remainingContentLength + 4;

        // Chunk data sizes, needed for the `chunks` output and/or the full size.
        // Reuse the sizes measured above when we had to derive the length.
        let chunkSizes: number[] | undefined;
        if (isChunked && (returnChunkSizes || returnFullSize)) {
          chunkSizes = measured
            ? measured.sizes
            : await collectChunkSizes(read, contentOffset, remainingContentLength);
        }
        const chunks = returnChunkSizes ? chunkSizes : undefined;

        // Full (de-chunked) content size: sum of the chunk data for chunked bodies,
        // otherwise the plain content size.
        const fullSize = returnFullSize
          ? (isChunked ? (chunkSizes?.reduce((a, b) => a + b, 0) ?? 0) : contentSize)
          : undefined;

        /*
         * `>= … + 8`, because `… + 8` is exactly what the skip below consumes.
         *
         * This read `> remainingContentLength + 4`, which is `>= + 5` — so for a
         * buffer holding rcl+5, rcl+6 or rcl+7 bytes it took this branch and then
         * asked for rcl+8. `ArrayBuffer.slice(start, end)` with start past end
         * returns EMPTY rather than throwing, so the 1-3 bytes it was short by
         * simply vanished: file.offset never moved to cover them, and the next
         * record began mid-separator.
         *
         * Traced on -00017 record 277: buffer 7,407, rcl 7,402, so 7,407 > 7,406
         * took this path and skipped 7,410 from 7,407. Three bytes lost, the next
         * header read at 17,761,878 instead of 17,761,881, and the parser saw
         * "\n\r\n" — the tail of the record separator — as a header block.
         *
         * Alignment-dependent, so it fires on a different record in every file and
         * on none at all in some. That is why -00014 completes and its neighbours
         * die at 0%, 2%, 47% and 86%. It is also why this only surfaced now: the
         * status-line and bare-LF bugs were killing these files long before the
         * parse ran far enough to hit an unlucky buffer boundary.
         */
        if (file.buffer.byteLength >= remainingContentLength + 8) {
          const content = returnContent ? file.buffer.slice(0, remainingContentLength) : null;

          file.buffer = file.buffer.slice(remainingContentLength + 8, file.buffer.byteLength)

          yield {
            'header-warc': { ...headerWarc, offset: headerWarcOffset },
            'header-meta': { ...headerHTTP, offset: headerHTTPOffset },
            'header-content': { content, offset: contentOffset, size: contentSize, chunks, fullSize }
          }

        } else {
          const content = returnContent ? concatArrays([file.buffer, await read(file.offset, remainingContentLength - file.buffer.byteLength) ?? new ArrayBuffer(0)]) : null;

          // Advance to the next WARC record. The WARC Content-Length already
          // accounts for the entire raw body (chunk framing included), so this
          // jump is identical whether or not the body used chunked encoding.
          file.offset = contentOffset + remainingContentLength + 8;
          file.buffer = new ArrayBuffer(0);

          yield {
            'header-warc': { ...headerWarc, offset: headerWarcOffset },
            'header-meta': { ...headerHTTP, offset: headerHTTPOffset },
            'header-content': { content, offset: contentOffset, size: contentSize, chunks, fullSize }
          }

        }

        break;
      }

      default:
        // Non-response records aren't self-delimiting, so a missing Content-Length
        // is unrecoverable here — surface it clearly.
        if (contentLengthMissing) {
          throw new WarcParseError(`ERROR: Content-Length is not defined in the WARC header!\r\n${JSON.stringify({ ...headerWarc, raw: decoder.decode(headerWarcRaw) }, null, 2)}`)
        }

        if (file.buffer.byteLength > remainingContentLength + 4) {
          yield {
            'header-warc': { ...headerWarc, offset: headerWarcOffset },
          }

          file.buffer = file.buffer.slice(remainingContentLength + 4, file.buffer.byteLength)
        }
        else {
          yield {
            'header-warc': { ...headerWarc, offset: headerWarcOffset },
          }

          file.offset = file.offset - file.buffer.byteLength + remainingContentLength + 4;
          file.buffer = new ArrayBuffer(0);
        }
    }
  }
}