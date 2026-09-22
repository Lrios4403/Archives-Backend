# Reading `.warc.gz` with fflate

> **Scope: reading compressed archives. Nothing else.**
>
> The download writer stays on zip.js. The earlier version of this document
> planned to replace it and that plan is deleted — fflate's zip *writer* emits no
> zip64 records at all (verified in 0.8.2 and 0.8.3 source), which would have been
> a regression from `zip64: true`. Writing is not in scope here and does not need
> to be touched.
>
> Everything below is measured against `oacu-oir-nih.wacz.zip` and the four
> archives in `warc.null`, or read out of fflate's source. Nothing rests on a
> README.

---

## 1. What this buys

A `.warc.gz` is not one gzip stream. It is **one gzip member per record**,
concatenated — that is what the WARC spec's record-at-a-time compression means,
and it is what makes random access possible at all. Proven on the WACZ: 1,624
members in a 50.80 MB file.

Two capabilities follow:

- **Read one record** without touching the rest. Measured: 2.02 MB read out of a
  50.80 MB file — 4.0% — one inflate, correct `response` record.
- **Index the whole archive** in a single linear pass, so every later read is a
  seek.

Both need fflate. §3 explains why the browser's own decompressor cannot do it.

## 2. Two byte paths, both of which need the mapping

There are exactly two places the codebase turns an offset into bytes, and they are
independent.

**Path 1 — parsing.** `mWarcDecode(read, …)` where

```ts
read: (start: number, size: number) => Promise<ArrayBuffer | null>
```

Three call sites inside `mwarc.ts`, and `file.offset` is a purely **logical**
cursor — it is only ever fed back into `read`. `worker.entry.ts` supplies it as a
one-liner:

```ts
const read = (start, length) => file.slice(start, start + length).arrayBuffer();
```

**So a gzip-aware `read` makes the entire parser work unchanged.** No edit to
`mwarc.ts`. That is the whole design.

**Path 2 — serving payloads.** `view.ts` and `zipsink.ts` do *not* go through
`read`; they slice the file directly:

```ts
record.file.slice(payload.offset, payload.offset + payload.size)
```

That one needs the payload to say where its bytes really are — §6.

## 3. Why fflate and not `DecompressionStream`

The browser has a gzip decoder and it is tempting:

```js
blob.slice(offset, offset + length)
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
```

For **reading one record when you already have an index**, that works and costs
nothing in bundle size — slice to exactly one member and one member is a complete
gzip stream. Worth keeping for that.

For **building the index it is useless**, for two separate reasons:

1. `DecompressionStream('gzip')` accepts exactly **one** member. The open request
   to lift that — [whatwg/compression#42](https://github.com/whatwg/compression/issues/42)
   — cites *"parsing ISO WARC"* as its motivating use case.
2. Even one member at a time, it **never reports how many input bytes it
   consumed**, so there is no way to learn where the next member starts. It cannot
   be chained.

fflate has the exact primitive, and its own docstring says what it is for:

```ts
/**
 * Handler for new GZIP members in concatenated GZIP streams. Useful for building
 * indices used to perform random-access reads on compressed files.
 * @param offset The offset of the new member relative to the start of the stream
 */
export type GunzipMemberHandler = (offset: number) => void;
```

`onmember` is public API on both `Gunzip` and `AsyncGunzip` — checked in
`fflate@0.8.2/lib/index.d.ts`. Use the **synchronous** `Gunzip`: the `Async*`
family spawns Workers with ~50 ms startup each and we are already inside a worker.

## 4. Part one — the index

One pass, and it produces both coordinate spaces at once:

```ts
import { Gunzip } from "fflate";

export interface GzipMember {
    /** Offset of the member in the COMPRESSED file. */
    readonly frameOffset: number;
    /** Encoded length of the member. */
    readonly frameLength: number;
    /** Where this member's output begins in the DECOMPRESSED stream. */
    readonly logicalOffset: number;
    /** How much it decompresses to. */
    readonly logicalLength: number;
}

export const indexWarcGz = async (file: BlobLike): Promise<GzipMember[]> => {
    const members: GzipMember[] = [];
    let frameOffset = 0;         // set by onmember
    let logicalOffset = 0;
    let logicalLength = 0;

    const gunzip = new Gunzip((chunk) => { logicalLength += chunk.length; });

    gunzip.onmember = (offset) => {
        // Fires at the START of each member after the first, so this closes the
        // PREVIOUS one. The last is closed after the loop.
        members.push({ frameOffset, frameLength: offset - frameOffset, logicalOffset, logicalLength });
        frameOffset = offset;
        logicalOffset += logicalLength;
        logicalLength = 0;
    };

    for (let at = 0; at < file.size; at += READ_CHUNK) {
        const end = Math.min(at + READ_CHUNK, file.size);
        const slice = new Uint8Array(await file.slice(at, end).arrayBuffer());

        gunzip.push(slice, end === file.size);
    }

    members.push({ frameOffset, frameLength: file.size - frameOffset, logicalOffset, logicalLength });

    return members;
};
```

`frameLength` is derived as the gap to the next member start, and the last runs to
EOF. Both are exact — see the CDXJ check in §8.

**It is a single linear pass and it is fast**, but only if the input is fed in
bounded chunks. I measured this three times and got it wrong twice, both times by
accidentally making it quadratic:

```
  naive tail slice   15.43 s    copied the remaining buffer per member
  memoryview          6.84 s    zlib's unused_data still copied it
  bounded chunks       0.37 s   136 MB/s — O(n)
```

12 s for a 1.7 GB archive in C zlib; fflate in JS is ~30% slower on their own
benchmarks, so budget ~18 s. **And it is not extra work** — the viewer already
makes a full sequential pass to enumerate records, so `onmember` rides along on a
read that is happening anyway.

## 5. Part two — `ByteSource`, and the parser needs no changes

`read` becomes an injected function. `BlobLike`-backed today, member-backed for a
`.warc.gz`, and the parser cannot tell the difference.

```ts
export type ByteSource = (start: number, size: number) => Promise<ArrayBuffer | null>;

/** For a plain .warc — what worker.entry.ts already does. */
export const directSource = (file: BlobLike): ByteSource =>
    (start, size) => file.slice(start, start + size).arrayBuffer();

/**
 * For a .warc.gz. `start`/`size` are LOGICAL — offsets into the archive as if it
 * were decompressed, which is exactly what mwarc's file.offset already means.
 */
export const gzipSource = (file: BlobLike, index: GzipMember[]): ByteSource => {
    const cache = new Map<number, Uint8Array>();   // frameOffset -> decoded

    return async (start, size) => {
        if (size <= 0) return new ArrayBuffer(0);

        const out = new Uint8Array(size);
        let filled = 0;
        let at = start;

        while (filled < size) {
            const member = memberAt(index, at);
            if (!member) break;                    // past the end

            let decoded = cache.get(member.frameOffset);

            if (!decoded) {
                const raw = new Uint8Array(await file
                    .slice(member.frameOffset, member.frameOffset + member.frameLength)
                    .arrayBuffer());

                decoded = gunzipSync(raw);
                remember(cache, member.frameOffset, decoded);
            }

            const from = at - member.logicalOffset;
            const take = Math.min(size - filled, decoded.length - from);

            out.set(decoded.subarray(from, from + take), filled);
            filled += take;
            at += take;
        }

        return filled === 0 ? null : out.buffer.slice(0, filled);
    };
};
```

`memberAt` is a binary search on `logicalOffset`. The cache matters more than it
looks: mwarc reads the WARC header, then the HTTP header, then skips the body —
three or more `read` calls that all land in the **same member**, so a one-entry
cache already removes most of the inflation. A small LRU (say 4) covers reads that
straddle a boundary.

**Returning `null` at the end is the contract mwarc already relies on** —
`mWarcConsumeNextChunk` treats null or zero-length as EOF.

## 6. Part three — payloads

`view.ts` and `zipsink.ts` bypass `read`, so the payload has to carry its own
location. A discriminated union, not an optional field: absent-means-direct is a
bug generator, because forgetting it on a gzipped source returns **compressed
bytes that look like data** — no throw, just a corrupt page.

```ts
export type PayloadSource = DirectPayload | FramedPayload;

/** Bytes are literally at [offset, offset + size). A plain .warc. */
export interface DirectPayload { readonly kind: "direct" }

/**
 * Bytes live inside one independently-decodable frame. "Frame" not "member"
 * because the shape is identical for a zstd frame or a BGZF block — only the
 * decoder differs, which is what `codec` selects.
 */
export interface FramedPayload {
    readonly kind: "framed";
    readonly codec: FrameCodec;
    readonly frameOffset: number;      // absolute, in record.file
    readonly frameLength: number;      // encoded
    readonly offsetInFrame: number;    // into the frame's DECODED bytes
}

export type FrameCodec = "gzip";
```

String literals rather than a TS `enum`: these records cross `postMessage` and
`ViewRecord`'s own doc says *"Cloneable — no functions"*, and it is the convention
already used by `ZipContent.kind`, `WarcParseStatus` and `MissingRef.reason`.

Three facts from `view.ts` that the reader has to respect, all checked:

1. `chunks` is **decoded sizes**, not file offsets — so de-chunking works on the
   payload's own bytes and composes after any frame decoding. Had they been file
   offsets this design would not work.
2. `size` is the **encoded** length *including* chunk framing — which is why the
   frame decode must come **before** de-chunking.
3. `payload` is `| null`, and `file` is `BlobLike`: `slice()` and `arrayBuffer()`
   and nothing else.

```ts
const FRAME_DECODERS: Record<FrameCodec, (b: Uint8Array) => Uint8Array> = { gzip: gunzipSync };

const storedBytes = async (file: BlobLike, payload: NonNullable<ViewRecord["payload"]>) => {
    const source = payload.source;

    switch (source.kind) {
        case "direct":
            return bytesOf(file, payload.offset, payload.size);

        case "framed": {
            const frame = await bytesOf(file, source.frameOffset, source.frameLength);
            const decoded = FRAME_DECODERS[source.codec](frame);

            return decoded.subarray(source.offsetInFrame, source.offsetInFrame + payload.size);
        }

        default:
            return assertNever(source);   // adding a kind is a compile error
    }
};

/** Signature unchanged — all five existing call sites stand. */
export const readPayload = async (record: ViewRecord): Promise<Uint8Array> => {
    if (!record.payload) return EMPTY;

    const stored = await storedBytes(record.file, record.payload);
    const chunks = record.payload.chunks;

    return chunks && chunks.length > 0 ? dechunkBody(stored, chunks) : stored;
};
```

The diff against the current body is one `switch` around one line. Callers:
`view.ts:1584`, `worker.entry.ts:893`, `zipsink.ts:234`, and the `download.ts`
re-export — none move.

**What `payload.offset` means changes**, and this is the one ambiguity worth
stating. For a `.warc.gz` there is no physical uncompressed file, so `offset`
becomes **logical only** — the position the payload would have if the archive were
decompressed, which is exactly what §4 computes for free. It stays valid for
display (the timeline's "Offset" row keeps working) and stops being what the
reader trusts. Those were the same number before; that is the actual change.

## 7. WACZ needs no new kind

A WACZ is a zip of `.warc.gz` files. It needs nothing beyond §6 because
**Browsertrix stores rather than deflates** — the members are already compressed:

```
  archive/rec-…-3.warc.gz    STORED    data starts at 95
  archive/rec-…-0.warc.gz    STORED    data starts at 409645404
  indexes/index.cdx.gz       STORED    data starts at 460446876
```

So the archive is a contiguous slice of the `.wacz` and `frameOffset` is just
`entryDataStart + memberOffset`. Proven — one record out of a 464 MB `.wacz`, one
2.02 MB read, no extraction, no temp file:

```
  absolute read offset : 452,874,193   (409,645,404 + 43,228,789)
  WARC version line    : WARC/1.1
  WARC-Type            : response
```

**Verify, do not assume.** A DEFLATED entry is the one case this shape does not
cover; read the local header's compression method and refuse with a clear message
when it is not 0.

The WACZ also ships `indexes/index.cdx.gz`, which already contains
`offset` + `length` per record. When it is present, **§4 can be skipped
entirely** — parse the CDXJ instead of walking the members.

## 8. Measured

**Index correctness.** Every CDXJ entry in the WACZ lands exactly on a member:

```
  offsets that are member starts   : 873 / 873   (100.0%)
  lengths that equal member length : 873 / 873   (100.0%)
  members total (incl. request/warcinfo) : 1,624
```

A WARC record and a gzip member are **1:1**.

**Random reads, out of order.** 40 random members:

```
  correct length + WARC header : 40 / 40
  total inflated               : 0.82 MB  (file is 50.8 MB compressed)
  per read                     : 0.1 ms
```

**Cost of one read is one member** — the real answer to "can I read a byte range":

```
  median 1.9 KB    p90 59.9 KB    p99 967 KB    max 4.8 MB
```

So a 24-byte read typically costs inflating 1.9 KB, worst case 4.8 MB. Not the
50 MB, and not the 1.7 GB.

**Index size.** Four numbers per member: 51 KB for this file, ~938 KB for a
1.7 GB archive at ~30k members. Negligible, and it does not need persisting — the
viewer re-picks files each session and already re-parses.

## 9. What is impossible, so nobody tries

**A single-member `.gz` cannot be randomly read. At all.** deflate is a continuous
stream with a 32 KB sliding window of back-references, so byte N is defined by
every byte before it. To read the middle you must inflate from the start. If
someone ran `gzip whole.warc`, a record near the end costs inflating the whole
thing and no library changes that.

This is exactly why the WARC spec mandates record-at-a-time compression, and why
genomics invented BGZF rather than using plain gzip.

**Detection is free**: if `onmember` fires once, it is single-member — surface that
as "this archive cannot be browsed without decompressing it" rather than silently
taking minutes per record.

## 10. Order

1. `bun add fflate@^0.8.3`. 0.8.3 fixes a Zip64 extra-field over-read on the
   reader path and added multi-member GZIP support to streaming `Gunzip` in 0.8.0.
2. **`ByteSource` as a refactor with no behaviour change** (§5). Extract the
   existing one-liner in `worker.entry.ts` into `directSource`, thread it through.
   Ships on its own, proves nothing broke.
3. **`PayloadSource` as a type only** (§6) — every producer emits
   `{ kind: "direct" }`, `readPayload` gains its `switch`. Also no behaviour
   change, also ships alone.
4. **`indexWarcGz`** (§4) plus the single-member refusal (§9).
5. **`gzipSource`** (§5) with the member cache, and `framed` payload sources
   emitted by the parse pass.
6. **WACZ** (§7): read the zip central directory, verify STORED, bias by
   `entryDataStart`. Prefer the bundled CDXJ over walking members.

Steps 2 and 3 are pure refactors and worth landing first precisely because they
cannot break anything — everything risky is behind them.

## 11. Tests

The repo has **no test files** — `find` across `backend/` and `frontend/` returns
zero. These have to be written, not extended. `backend/parser/*.test.ts`, `bun test`.

1. `indexWarcGz` against the WACZ: 1,624 members, and every CDXJ `offset`/`length`
   matches a member exactly (§8 — this is a real ground truth, use it).
2. Out-of-order reads: pick members at random, assert each decodes to
   `logicalLength` and starts with `WARC/`.
3. `gzipSource` reads spanning a member boundary return the right bytes.
4. The member cache: three reads inside one member cause **one** inflate.
5. Single-member `.gz` is detected and refused, not read slowly.
6. `assertNever` — an unknown `source.kind` throws and names the value rather than
   falling through to a direct read.
7. **The differential test, and the one worth most.** Take a plain `.warc` you
   already have, gzip it record-at-a-time, index it, then assert `readPayload` over
   the `framed` records is **byte-identical** to `readPayload` over the same
   records read `direct` from the original. One assertion covers the index, the
   offsets, the codec and the de-chunk order, against ground truth rather than
   against itself.

## 12. Notes carried over

- **WARC 1.1 reading is already done** (this session): version-agnostic parsing,
  fractional `WARC-Date`, repeated fields joined instead of overwritten,
  case-insensitive field lookup, `Transfer-Encoding` as a list, bare-LF header
  blocks, and the buffered-path off-by-4. The WACZ is `WARC/1.1`, so that work is
  a prerequisite for this one and it is in place.
- **`revisit` records are still unhandled** — 329 of ~3,100 in the WACZ, 10.6%.
  They fall to mwarc's `default` branch and are skipped as opaque. Not a reading
  bug in the gzip sense, but it is the largest remaining gap for Browsertrix
  archives and 1.1's `WARC-Refers-To-Target-URI` / `WARC-Refers-To-Date` exist to
  make them resolvable.
- **`Content-Encoding: gzip` payloads are served raw** — 4 in 2,500 kiwifarms
  records, rendered as binary in the iframe. Unrelated to `.warc.gz` but it is the
  same `gunzipSync` call once fflate is in the tree, so it is nearly free to fix
  here. Strip the header when serving, or the browser decodes twice.
- **A remote archive would need a second axis.** `ByteSource` already has the right
  shape for it — `Range`-backed instead of `BlobLike`-backed — and every kind above
  then works remotely. Worth knowing; not worth building without one to point at.
