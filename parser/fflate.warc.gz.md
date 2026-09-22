# Reading `.warc.gz` in `backend/parser` — trial run

**Scope: `backend/parser/` — the bundle the browser runs.** `worker.entry.ts`,
`view.ts`, and one new file. The DB ingest path (`db.ts`, `parse.worker.ts`,
`db/setup.sql`) is **deliberately untouched**; §12 records what this trial is meant
to settle before that moves, and §9 covers the server view route, which is the one
place the trial's design has to be forward-compatible rather than free.

`mwarc.ts` needs **no changes**. §2 is the evidence.

**IMPLEMENTED, browser side end to end.** `backend/parser/gzip.ts` and
`wacz.ts`, the descriptor threaded through every hop in §6, `worker.entry.ts`
restructured so one selected file can be N archives, and the frontend picker
accepting `.warc.gz` / `.wacz`. **59 tests green**, and after the work in §15 the
parse runs within 12% of raw inflate:

```
  backend  gzip.test.ts             13   the reader, the index, the guards
           wacz.test.ts              9   reading in place, STORED, offset biasing
           payload.test.ts          21   resolveSources, toWire, readPayload,
                                         content-encoding, the wire hops
           parser.bundle.test.ts    10   the built bundle runs as a classic worker,
                                         under iife AND esm
           progress.test.ts          5   posted offsets bounded and monotonic
  frontend wire.test.ts             10   toWarcRecord + toPostedRecord relays
```

`wacz.test.ts` and two of `payload.test.ts`'s cases skip when
`warc.null/oacu-oir-nih.wacz.zip` is absent — deliberate, so a checkout without the
464 MB container still runs everything else. The `.warc.gz` tests need only the
48 MB archive.

`tsc --noEmit` is at baseline on both sides with **zero errors in any file
touched**, and the browser bundle builds (52 modules, 0.39 MB). Plain `.warc`
parsing is unchanged — 1,629 / 253 / 457 records, `readPayload` byte-identical to a
direct slice on 200 payloads.

**The build format was silently module-only.** `routes/parser.tsx` built with
`format: "esm"`, which worked only by accident: the worker entry exported nothing
but TYPES, and types are erased, so there was no top-level `export` for ESM to
emit. Exporting two functions so the tests could reach them made Bun emit
`export { … }`, and since the bundle is spawned as a **classic** worker every parse
died with `Uncaught SyntaxError: Unexpected token 'export'` before reading a byte —
reported in the UI as "The parser stopped unexpectedly" at 0%, which names neither
the file nor the cause. Exactly the shape of the `import.meta` failure already
documented in that file.

Fixed at the root: **`toWire` and `resolveSources` moved to
`backend/parser/wire.ts`, and the entry now exports no runtime value at all.**
Setting `format: "iife"` also prevents the symptom and is kept as a second layer,
but it is the weaker fix — it depends on bundler behaviour, and it would still pass
a test suite while the entry quietly re-acquired runtime exports, ready to break
the next time anyone set the format back. The invariant worth holding is *the entry
exports nothing at runtime*, so `parser.bundle.test.ts` builds under **both** `iife`
and `esm` and asserts each is export-free and parses under `new Function` — the same
scope a classic worker gives it.

**Why the first fix appeared to do nothing:** `routes/parser.tsx` was not in its own
`SOURCES` list. The build options are part of what the output depends on, so
changing `format` moved no *source* mtime, the running server kept serving the
cached ESM build, and the fix looked inert. The cache was correct about its inputs
and wrong about what its inputs were. That file is now in the list, alongside
`wacz.ts` and `wire.ts` which were also missing — the fourth and fifth time that
list has been the thing out of date, exactly as its own comment predicts.

**A bug the reader-level tests could not have caught, and did not.** `toPostedRecord`
in `frontend/components/Offline/view.ts` rebuilds the payload block field by field
rather than spreading it, and did not copy `gzip` — so the location was dropped on
the way *out* to the view worker. Every one of the 33 tests passing at the time
still passed, because the reader was correct; the location simply never reached it.
Fixed, and `wire.test.ts` now covers both directions. Verified the hard way: putting
the bug back fails three tests, removing it passes ten.

Still open: the server view route (§9), which is out of scope for this trial.

**Status: the read path is verified, including against real Browsertrix output.**
3,133 records across four archives — 1,509 from synthetic per-record gzip of
`nekoweb`/`lolcow`/`crystal.cafe`, and 1,624 from a genuine
`rec-…-0.warc.gz` — with **every read byte-compared against the uncompressed
original and zero divergence** (§7.5, §7.7), plus a synthetic 6 MB chunked body for
the case the corpus lacks (§7.6). Cold random-access retrieval works at 0.97 ms per
payload.

What is designed but *not* yet run: the descriptor's trip through `postMessage`
(§6), the server view route (§9), and WACZ biasing (§10).

Measurements came from running the real transpiled `mwarc.ts` over
`warc.null/{nekoweb,lolcow,crystal.cafe}.warc` and from `oacu-oir-nih.wacz.zip`.
Estimates say so.

---

## 1. The shape

```
        compressed .warc.gz
                 │
                 ▼
      ┌──────────────────────┐
      │ GzipWarcReader       │   physical  ⇄  logical
      │  member table        │   offsets      offsets
      │  256 KB window       │
      └──────────┬───────────┘
                 │  read(start, size)   ← logical, contract unchanged
                 ▼
           mWarcDecode()               ← untouched
                 │
                 ▼
        WarcRecord + GzipLocation
```

## 2. Why `mwarc.ts` needs no changes

`read` is the only way the parser touches bytes. Three call sites:

| line | caller | read size |
|---|---|---|
| `mwarc.ts:359` | chunked-framing cursor | `FRAMING_BLOCK_SIZE` = 256 KB, clamped to the body |
| `mwarc.ts:481` | `mWarcConsumeNextChunk`, via `file.read` | `chunkSize ?? CHUNK_SIZE` = 1 KB |
| `mwarc.ts:633` | the `content: true` tail concat | remainder |

`file.offset` is **logical throughout** — every use at `:487 :525 :541 :562 :638
:671` either advances it or subtracts `buffer.byteLength` to name a position. It is
never handed to anything but `read`. The seam is already in the type:

```ts
export interface WarcFileContext {
  read: (start: number, size: number) => Promise<ArrayBuffer | null>,
  offset: number,
  buffer: ArrayBuffer,
  isEOF: boolean,
  chunkSize?: number,
}
```

`worker.entry.ts:303` is the entire current implementation:

```ts
const read = (start: number, length: number): Promise<ArrayBuffer | null> =>
    file.slice(start, start + length).arrayBuffer();
```

Substitute a gzip-aware function and the parser is none the wiser. What was a seek
becomes inflate-and-discard, which it also does not care about — it only ever asked
for bytes.

## 3. The measurement that shapes the design

The obvious guess is "cache one decoded member". **That is wrong.** Instrumenting
every `read`:

```
                        records   reads   reads starting    worst backward
                                          behind the HWM    distance
  nekoweb.warc           1,629    2,584    819  (31.7%)      1,020 B
  lolcow.warc              253      545    267  (49.0%)        848 B
  crystal.cafe.warc        457      892    287  (32.2%)        876 B

  backward distance, nekoweb:  p50 55 B   p90 798 B   p99 892 B   max 1,020 B
```

**Backward reads are normal, not exceptional** — a third to a half of all reads
start behind the furthest byte already consumed. By call site (nekoweb):

```
  main-loop (mWarcConsumeNextChunk)   2,018 reads   270 backward   worst    55 B
  framing cursor                        566 reads   549 backward   worst 1,020 B
```

55 B is the unconsumed buffer tail re-read at a record boundary. 1 KB is the
framing cursor re-seeking inside a chunked body.

Treating each record start as a member start (1:1 in a record-compressed
`.warc.gz`):

```
                        reads spanning >1 member    widest span   reach-back
  nekoweb.warc           1,228  (47.5%)             3 members     9 reads, ≤2 members
  lolcow.warc              220  (40.4%)             3 members     6 reads, ≤1 member
```

**Two load-bearing conclusions:**

1. **Nearly half of all reads cross a member boundary, up to three wide.** A
   one-member cache would re-inflate constantly and a member-at-a-time reader
   would return short.
2. **Reads reach backward into passed members** — rarely (9 in 2,584) but really,
   up to two back.

So the indexing reader needs a **byte window**, not a member cache. Size it at
`FRAMING_BLOCK_SIZE` (256 KB): that is the *provable* bound, because the framing
cursor is the only thing that seeks back further than a buffer tail and it never
re-reads further than one of its own blocks. Measured worst is 1,020 B, so 256 KB
is ~250× headroom — the gap exists only because these bodies are small; a large
chunked body would use the full block.

## 4. Two modes, not one — and only one of them needs state

Indexing and retrieval have opposite access patterns, so they get different
implementations. The asymmetry is sharper than it first looks:

| | indexing | retrieval |
|---|---|---|
| what a read is | a 1 KB header probe, landing anywhere | one whole payload |
| members touched | **1–3 (47.5% span >1)** | **exactly 1** |
| fflate | one `Gunzip`, fed forward | `gunzipSync` per member |
| state | 256 KB sliding window | **none** |
| cost | one linear inflate, whole file | one member |

**Retrieval needs no cache, and this is worth being explicit about because the
instinct is to add one.** A record is one gzip member, so a record's payload lives
inside that one member and nowhere else. Two different records are two different
members. A member LRU would therefore have a ~0% hit rate on the path that looks
like it needs caching most — building a view, which reads one payload per
subresource. §3's 47.5% figure is an *indexing* property, produced by mwarc probing
1 KB at a time across boundaries. It does not transfer.

So: the window exists for indexing only, and `readGzipPayloadSlice` is a pure
function.

### The 1:1 assumption, and the guard for when it does not hold

"One record = one member" is what record-at-a-time compression means, and it held
exactly on the WACZ — 873/873 CDXJ offsets *and* lengths landed on member
boundaries. But nothing in the gzip format forces it: a writer is free to split one
record across several members, and a reader that assumes otherwise returns a short
payload with no error.

Cheap guard, so the reader should just handle it:

```ts
if (loc.payloadOffsetInMember + wantedLength > member.uncompressedLength) {
    // spills into the following member(s) — keep inflating forward
}
```

Detect rather than assume, continue rather than throw. It costs one comparison and
removes a class of silent truncation.

Indexing itself is not extra work — the viewer already makes a full sequential pass
to enumerate records, so `onmember` rides along. The index is a by-product.

## 5. The location descriptor

One descriptor, and the rule that makes the protocol simple:

> **A `GzipLocation` is self-contained. Nothing needs the member index to read a
> payload.**

That is the whole reason this works across process boundaries. The index exists
only during the parse pass, in one worker. A view request may be served by a
different worker, and the server has no index at all. Because a gzip member is a
complete gzip stream, a record's location is three numbers that are valid
forever — so the index never has to be shipped, cached, or rebuilt.

```ts
// backend/parser/gzip.ts  (new)

/** One gzip member: a record, in both coordinate spaces. Parse-time only. */
export interface GzipMember {
    readonly compressedOffset: number;
    readonly compressedLength: number;
    readonly uncompressedOffset: number;
    readonly uncompressedLength: number;
}

/**
 * Where a payload's bytes are. Everything a cold read needs, and nothing else.
 *
 * Plain data — no functions, no classes — because this crosses postMessage in
 * both directions and will later cross JSON to the server view route.
 */
export interface GzipLocation {
    /** Start inflating here. A member is a complete gzip stream. */
    readonly compressedOffset: number;
    readonly compressedLength: number;
    /** Payload start relative to this member's DECODED output. */
    readonly payloadOffsetInMember: number;
}
```

**Never store a "compressed offset of the payload".** It does not exist as a
resumable point: mid-member you would need the live Huffman tables, the bit
alignment and the 32 KB history. Always member start + decoded offset within.

## 6. Every hop it crosses

Two directions, then one independent server path. The gzip location is attached
once — in the worker that owns the `GzipWarcReader` — and everything downstream
carries it verbatim.

```
FORWARD — parsing
  mwarc  WarcRecord                                     ← + gzip?: GzipLocation
    │    worker.entry.ts:224 toWire()
    ▼
  WireWarcRecord.payload  ═══ postMessage ═══▶          ← + gzip?
    │    frontend wire.ts
    ▼
  frontend WarcPayloadLocation                          ← + gzip?   (opaque)

BACKWARD — viewing
  frontend ViewRecord { file: File, payload, … }
    │    ═══ postMessage ═══▶  worker.entry.ts:867, :924 handleViewRecord
    ▼
  view.ts readPayload  →  INTERPRETS gzip

SERVER — independent (§8)
  parse.worker.ts → payloads table
    │
    ▼
  routes/view/index.tsx  →  INTERPRETS gzip
```

**Only two places interpret it**: `view.ts readPayload` and
`routes/view/index.tsx`. Every hop between is a relay. The frontend in particular
never reads a field of it — which keeps the blast radius to one added optional
property per type and one line in `wire.ts`.

### 6.1 `mwarc.ts` — a new top-level field, not inside `header-content`

`WarcRecord['header-content']` is typed:

```ts
'header-content'?: Record<string, ArrayBuffer | string | number | number[] | null | undefined>;
```

**An object does not fit that union**, so the gzip location cannot be stuffed
alongside `offset`/`size`/`chunks`. It goes on `WarcRecord` — which is also more
honest, since it describes *where the record was*, not its content header:

```ts
export interface WarcRecord {
  'header-warc': Record<string, string | number>;
  'header-meta'?: Record<string, string | number>;
  'header-content'?: Record<string, ArrayBuffer | string | number | number[] | null | undefined>;
  /** Present only when the source was a .warc.gz. */
  gzip?: GzipLocation;
}
```

Additive and optional, so `parse.worker.ts` and every other consumer keep
compiling untouched. `mWarcDecode` does not set it — `worker.entry.ts` does, after
the yield, from `memberAtUncompressedOffset`.

### 6.2 `worker.entry.ts` — `WireWarcRecord.payload`

Today (`:178–189`) it is `{ offset, size, fullSize?, chunks?, chunked }`, and its
doc says *"To get bytes later, slice `payload.offset .. offset + size` out of the
same File."* **That sentence stops being true for a `.warc.gz`** and the comment
has to change with the field:

```ts
    payload?: {
        offset: number;      // logical — see below
        size: number;
        fullSize?: number;
        chunks?: number[];
        chunked: boolean;
        /**
         * Absent for a plain .warc, and then `offset` is a real file position.
         * Present for a .warc.gz, and then `offset` is a position in the archive
         * as it WOULD BE decompressed — correct for display, useless for slicing.
         */
        gzip?: GzipLocation;
    };
```

Set in `toWire()` (`:244–259`), one line beside the existing `fullSize`/`chunks`
conditionals.

### 6.3 What `offset` means now

This is the one semantic change, and the one thing likely to cause a silent bug if
it goes unwritten.

| | plain `.warc` | `.warc.gz` |
|---|---|---|
| `payload.offset` | real file position | **logical only** — where it would be if decompressed |
| slicing the file at it | correct | **returns compressed garbage** |
| showing it in the UI | correct | correct |

Keeping `offset` rather than replacing it is deliberate: it stays the value the
timeline's "Offset" row displays, and it stays a payload's natural identity — which
matters downstream, because `payloads` is `UNIQUE (file_id, byte_offset,
byte_length)` (§11).

The failure mode if a consumer forgets: no throw, no error, just compressed bytes
rendered as a corrupt page. Which is the argument for §6.6.

### 6.4 Frontend — `WarcPayloadLocation`, opaque

`frontend/components/Offline/types.ts`. The frontend never interprets this; it
carries it so the view worker gets it back.

```ts
export interface WarcPayloadLocation {
    offset: number;
    size: number;
    chunks?: number[];
    fullSize?: number;
    digest: string | null;
    /** Opaque. Carried so the view worker can read the payload; never read here. */
    gzip?: GzipLocation;
}
```

`wire.ts` copies it across in the same place it builds the rest of the payload
block. One line, and it must not be forgotten — `wire.ts` is the *only* module that
knows both shapes, by its own docstring.

### 6.5 `view.ts` — `ViewRecord.payload`, and the interpreter

```ts
    payload: {
        offset: number;
        size: number;
        chunks?: number[];
        digest?: string | null;
        gzip?: GzipLocation;
    } | null;
```

`readPayload` (`view.ts:317`) is four lines today:

```ts
export const readPayload = async (record: ViewRecord): Promise<Uint8Array> => {
    if (!record.payload) return new Uint8Array(0);

    const { offset, size, chunks } = record.payload;
    const raw = new Uint8Array(await record.file.slice(offset, offset + size).arrayBuffer());

    return chunks && chunks.length > 0 ? dechunkBody(raw, chunks) : raw;
};
```

It becomes five, and the compressed reader is **the same `record.file`** — no new
plumbing, no extra field, because a `BlobLike` read of the compressed range is what
`readGzipPayloadSlice` wants anyway:

```ts
export const readPayload = async (record: ViewRecord): Promise<Uint8Array> => {
    if (!record.payload) return new Uint8Array(0);

    const { offset, size, chunks, gzip } = record.payload;
    const raw = gzip
        ? await readGzipPayloadSlice(record.file, gzip, 0, size)
        : new Uint8Array(await record.file.slice(offset, offset + size).arrayBuffer());

    return chunks && chunks.length > 0 ? dechunkBody(raw, chunks) : raw;
};
```

Two existing invariants fix the order, both verified in the source:

- `payload.chunks` holds **decoded** sizes, not file offsets — de-chunking operates
  on the payload's own bytes and composes *after* inflation.
- `payload.size` is the **encoded** length including chunk framing — so inflate
  first, de-chunk second.

The signature does not change, which is what makes this the whole of the work.
**Four callers get `.warc.gz` support for free:**

| caller | what it is |
|---|---|
| `view.ts:1584` | `buildOne` — every page and every subresource of a view |
| `worker.entry.ts:893` | the raw payload for the page's own `fetch`/XHR shim |
| `zipsink.ts:234` | a zip entry's bytes, so **downloads work too** |
| `download.ts:1221` | re-export, no separate read path |

`view.ts:1584` is the volume: `buildOne` recurses through `resolveToBlobUrl`, so one
page with fifty images is fifty `readPayload` calls. Distinct urls are memoised in
`built` (`view.ts:1363`), so each is read once per view — and per §4 each is one
member, so fifty subresources is fifty small inflates, not fifty scans.

### 6.6 Make the mistake impossible, not just documented

§6.3's failure mode is silent corruption, which is the worst kind. Two cheap
guards, both worth having:

1. **A branded logical offset.** `type LogicalOffset = number & { readonly __logical?: unique symbol }`
   on `payload.offset` makes handing it to a raw `file.slice()` a type error at the
   call sites that matter, while staying a plain number over the wire.
2. **A gzip magic check in the plain branch.** When `payload.gzip` is absent, the
   first two bytes of a payload should not be `1f 8b`. If they are, the location
   was dropped somewhere in §6 — throw and name the field rather than rendering
   binary. Costs two byte comparisons and turns the silent case loud.

The second is the one that would actually have caught the bug; the first is what
stops it being written.

## 7. Indexing and retrieval

### 7.1 Deciding it is gzipped at all

**Sniff the bytes, never the filename.** Read the first two and look for `1f 8b`:

```ts
const GZIP_MAGIC = 0x1f8b;

const looksGzipped = async (file: BlobLike): Promise<boolean> => {
    if (file.size < 2) return false;
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    return head[0] === 0x1f && head[1] === 0x8b;
};
```

Filenames lie in both directions, and both directions are worse than a two-byte
read: a `.warc` that is actually gzipped fails with a header parse error pointing at
the wrong thing, and a `.warc.gz` that is not gzipped fails inside fflate. The
existing corpus already demonstrates the general principle — the parse bugs fixed
this session were all cases of trusting a declared shape over the actual bytes.

This is one extra 2-byte read per file, once, against files measured in gigabytes.

### 7.2 The windowed reader

The only genuinely fiddly code. `read(start, size)` has to serve three cases, and
§3 says all three are common:

```
  window:   [════════════ retained 256 KB ════════════]
                  ▲                          ▲
  (a) start ──────┘  fully inside            │        → copy, no inflate
  (b) start ─────────────────────────────────┘ ...──▶ → copy what is there,
                                                        inflate forward for the rest
  (c) start ──▶ beyond the window's end                → inflate forward to reach it
      start ──▶ before the window's start               → cannot serve; see below
```

```ts
interface GzipWarcReader {
    read(start: number, size: number): Promise<ArrayBuffer | null>;
    readonly members: readonly GzipMember[];
    memberAtUncompressedOffset(offset: number): GzipMember | undefined;
    /** Compressed bytes consumed. For progress — see §8. */
    readonly compressedPosition: number;
    /** Logical bytes produced so far. */
    readonly uncompressedPosition: number;
}
```

**The window is anchored to the consumer, not to the production frontier.** It
retains from `start - FRAMING_BLOCK_SIZE` forward — *not* "the last 256 KB
produced". Those sound equivalent and are not: a single 64 KB compressed `push` can
inflate to megabytes, so production runs far ahead of the reader, and trimming to
the last 256 KB *of production* throws away bytes mwarc has not reached yet.

Two invariants, both of which I established the hard way by violating them (§7.5):

```
  I1   winStart + win.length === produced          the window always ends at the frontier
  I2   winStart <= start                           never trim past the consumer
```

The trim that satisfies both — note the **clamp to `win.length`**, which is the
whole of I1:

```ts
const trimTo = (start: number): void => {
    const drop = Math.min(win.length, Math.max(0, (start - FRAMING_BLOCK_SIZE) - winStart));
    if (drop > 0) { win = win.subarray(drop); winStart += drop; }
};
```

Without the clamp, `winStart` can advance *past* `produced` on a long forward seek.
The window then claims to begin somewhere no data exists, every later output chunk
is filed at the wrong logical offset, and reads return plausible-looking garbage —
measured: valid bytes from the wrong part of the archive, which the header parser
then rejects with a misleading `Content-Length is not defined`.

**Memory is not `FRAMING_BLOCK_SIZE`, and the window setting barely affects it.**
256 KB is the *retention*; the peak *allocation* is that plus however much a single
`push` inflates to, because `ondata` appends before the next trim can run. Measured
peaks on the three real archives: 1,049 / 909 / 839 KB. On a synthetic record with a
6 MB chunked body, 6,163 KB — the whole record, because at 762:1 the entire body
came out of one 64 KB push.

The knob is the **compressed push size, not the window**:

```
  6 MB chunked body, one record          peak window
    push 4 KB                              3,585 KB
    push 16 KB                             6,163 KB
    push 64 KB                             6,163 KB
    push 256 KB                            6,163 KB
```

So the honest bound is **≈ `FRAMING_BLOCK_SIZE` + the largest single record's
decompressed size** — for the measured corpus that is p99 967 KB, max 4.8 MB, so
call it ~5 MB worst case. Bounded and fine, but not the 256 KB the constant
suggests, and worth knowing before sizing a worker's budget off it. Smaller pushes
trade syscalls for a lower ceiling if that ever matters.

Serving a read is then:

1. If `start` is below `windowStart`, **throw** — do not silently restart the
   stream. §3 proves the parser never reaches back more than 1,020 B against a
   256 KB window, so this is unreachable in practice and a bug if it fires. A
   restart would be a silent O(n²), which is exactly the failure mode I hit three
   times while measuring (§7.3).
2. Copy whatever the window already holds from `start`.
3. While short and not EOF: read the next compressed slice, `push` it, let the
   output callback extend the window, and keep copying.
4. Return short — or `null` when nothing at all was available, which is the EOF
   signal `mWarcConsumeNextChunk` already relies on.

Point 1 is the important one. The temptation is to make a too-far-back read "work"
by re-opening the stream from the last member boundary; that turns a bounded bug
into an unbounded performance cliff that only shows up on large files. Loud and
impossible beats quiet and quadratic — and in practice this throw is what located
the second of the two bugs above, so it earns its keep during development, not just
in production.

### 7.3 Indexing

`onmember`'s documented purpose is exactly this:

```ts
/**
 * Handler for new GZIP members in concatenated GZIP streams. Useful for building
 * indices used to perform random-access reads on compressed files.
 * @param offset The offset of the new member relative to the start of the stream
 */
export type GunzipMemberHandler = (offset: number) => void;
```

It fires at the *start* of each member after the first, so each call closes the
previous entry. Seed member 0 at `{0, 0}`; close the last after the final `push`:

```ts
const members: GzipMember[] = [];
let compressedOffset = 0;
let uncompressedOffset = 0;
let produced = 0;

const gunzip = new Gunzip(chunk => { produced += chunk.length; /* + window append */ });

gunzip.onmember = (offset) => {
    members.push({
        compressedOffset,
        compressedLength: offset - compressedOffset,
        uncompressedOffset,
        uncompressedLength: produced,
    });
    compressedOffset = offset;
    uncompressedOffset += produced;
    produced = 0;
};
```

`compressedLength` is the gap to the next member start; the last runs to EOF. Both
exact — 873/873 CDXJ lengths in the WACZ matched member lengths exactly.

**Feed it bounded slices.** I got this wrong twice by re-slicing the tail per
member, which is quadratic:

```
  naive tail slice   15.43 s     copied the remainder each member
  memoryview          6.84 s     still copied
  bounded chunks       0.37 s    136 MB/s — O(n)
```

136 MB/s was C zlib; fflate benchmarks ~30% slower, so budget **~18 s for 1.7 GB**,
estimated. Index memory is four numbers per member — 51 KB for the WACZ's 1,624,
under 1 MB for 1.7 GB.

Use the **synchronous** `Gunzip`. The `Async*` variants spawn their own workers at
~50 ms each and we are already inside one.

**Single-member `.gz` is detected and warned about — not refused.** If `onmember`
never fires, someone ran `gzip whole.warc`: one continuous DEFLATE stream with a
32 KB sliding dictionary, so byte *N* depends on every byte before it and there are
**no seek points at all**. This is why the WARC spec mandates per-record
compression.

The plan said "refuse". Measurement says otherwise, so the plan was wrong:

```
  single-member .gz, 2.6 MB compressed -> 8.0 MB logical
    members discovered          1
    parse of 40 records       114 ms      <- normal speed, fully correct
    first locate()            105 ms      <- forced inflate to EOF
    compressedLength stored   2.6 MB      <- the whole file, on every record
    ONE payload read           31 ms      <- to extract 6,260 bytes
```

**The parse is fine.** Every record is found, at normal speed, and the listing is
perfectly usable. What is ruined is *reading a payload* — re-inflating the entire
archive to pull out a few kilobytes, linearly, so a 5 GB archive costs roughly 20
seconds per page view. Refusing would throw away a working record listing to prevent
slow viewing; warning keeps both and explains the slowness.

`GzipWarcReader.singleMember` reports it, and it is **free**: `opens` is built by the
pass that was happening anyway, and a single-member file forces `finished` on its
very first `locate()` — so it is known before any payload is ever read, which is the
only place it hurts. The worker collects the affected archive names and the `parsed`
message carries a plain-text explanation.

Two things this cost, both worth recording:

- **The guard was written in the first pass and never wired.** `isSingleMember` had
  zero non-test call sites. It was in the plan's step 3 — *"before anything can be
  slow, make it impossible"* — and it sat there as dead code until someone went
  looking. Written ≠ reachable.
- **`workers.ts` dropped `message` on the `parsed` path**, relaying it only on
  `error`. So even once the worker reported it, nothing displayed it. A parse can
  succeed and still have something worth saying.

The standalone `isSingleMember()` remains for tooling with no reader, but it costs a
full inflate to answer a yes/no and the reader's getter should be preferred.

### 7.4 Retrieval

```
huge.warc.gz
─────────────────|■■■ member ■■■|──────────────────
                 ▲
                 compressedOffset — fresh DEFLATE state

decoded member:
0     payloadOffsetInMember   +start        +end
|── WARC + HTTP headers ──|─ discard ─|■ return ■|─ discard ─|
```

`readGzipPayloadSlice(readCompressed, loc, sliceStart, sliceEnd)` inflates in 64 KB
pushes, copies only the overlap into a pre-sized output, and throws `RangeError` if
it comes up short. Measured on the WACZ: 40 random out-of-order members, all
correct, **0.1 ms each, 0.82 MB inflated out of 50.8 MB**.

Cost per read is one member — the honest answer to "can I read 24 bytes":

```
  member decoded size:  median 1.9 KB   p90 59.9 KB   p99 967 KB   max 4.8 MB
```

A 24-byte read typically costs 1.9 KB of inflate. Not 50 MB, not 1.7 GB. The
pathological case is a slice deep inside one huge member, which would need DEFLATE
checkpointing; nothing here asks for it.

### 7.5 This has been run, not just designed

The whole path was executed against real archives before writing any of it into the
codebase: build a per-record `.warc.gz` from a plain `.warc` using the real record
boundaries, index it with `Gunzip`/`onmember`, then drive `mWarcDecode` through the
windowed gzip-backed `read` and compare **every read** against the plain original
byte-for-byte.

```
                        nekoweb    lolcow    crystal.cafe
  records                   801       252             456
  plain → gz            31.0 MB   45.9 MB         60.9 MB
                     →  24.4 MB → 19.1 MB      → 50.8 MB

  member start == record start    801/801   252/252   456/456   ✓
  member len   == record len      801/801   252/252   456/456   ✓
  records parsed via wrapper      801/801   252/252   456/456   ✓
  reads returning wrong bytes           0         0         0   ✓
  window invariant violations           0         0         0   ✓
  reads below window                    0         0         0   ✓
  payloads byte-identical         398/398   122/122   224/224   ✓
  peak window                     1049 KB    909 KB    839 KB
```

1,509 records and 744 sampled payloads, zero divergence. `onmember` was also
verified against real installed source rather than a README —
`fflate@0.8.3/lib/index.d.ts:537` declares `GunzipMemberHandler` with the quoted
docstring, and `:554` puts `onmember?` on `Gunzip` itself, so it is public API.

### 7.6 The large-body worry, tested and dismissed

No body in the three archives exceeds the 256 KB framing block — the largest
chunked body in nekoweb's first 40 records is 58,294 B. So the natural worry was
that §3's 1,020 B backward reach is an artefact of small bodies, and that a
multi-megabyte chunked body would reach back further than the window retains.

**It does not.** Synthesised a WARC of `8 KB, 16 KB, 8 KB, 6 MB, 8 KB, 16 KB, 8 KB`
chunked bodies, verified it parses as a plain `.warc` (7/7), gzipped per record, and
ran the wrapper at four window sizes:

```
  window     records   below-window   wrong bytes
    64 KB      7/7          0              0      ✓
   256 KB      7/7          0              0      ✓
     1 MB      7/7          0              0      ✓
     8 MB      7/7          0              0      ✓
```

A 6 MB chunked body parses correctly on a **64 KB** window — a quarter of the
planned size. The reason is structural: the framing cursor walks chunk framing
strictly forward, so backward reads come from re-reading an unconsumed *buffer
tail*, whose size is set by `CHUNK_SIZE` and the block bound, **not** by how long
the body is. Body size does not enter into it. 256 KB stays the right choice for its
provable-bound argument, but it is not load-bearing against this case.

What replaced that worry is the memory finding in §7.2 — peak allocation tracks the
largest record, not the window.

### 7.7 Verified against real Browsertrix output

Everything above used `.warc.gz` files the harness produced itself, which left one
gap: a real crawler's writer might not behave the same. Closed, using
`warc.null/rec-7c53beba8825-oacu-oir-nih-20260622221651890-0.warc.gz` — the `-0`
entry from the WACZ, 50,801,406 B, extracted. `gunzip -c` gives a 77,519,230 B plain
reference to compare every read against.

```
  ── indexing ──────────────────────────────────────────────────────
  members indexed                       1,624   in 605 ms (80 MB/s compressed)
  decompressed total               77,519,230 B  == gunzip -c output          ✓
  plain records                         1,624   == member count               ✓
  record starts on a member boundary  1,624/1,624                             ✓
  payloads spilling past their member        0   1:1 holds exactly            ✓

  ── through the gzip-backed windowed read ─────────────────────────
  records                         1,624/1,624                                 ✓
  reads returning wrong bytes               0                                 ✓
  window invariant violations               0                                 ✓
  reads below window                        0                                 ✓
  peak window                        1,337 KB
  throughput                          113 MB/s logical  (654 ms)

  ── cold random-access retrieval (§7.4) ───────────────────────────
  random payload reads                  40/40   0.97 ms each                  ✓

  record types   warcinfo 1 · response 626 · request 750 · resource 123 · revisit 124
```

**The 1:1 assumption is not just approximately true here, it is exact** — 1,624
members, 1,624 records, every record starting on a member boundary and not one
payload crossing one. The §4 guard stays in as cheap insurance, but no file to hand
exercises it.

Two incidental findings from the type census:

- **`revisit` is 124 of 1,624 (7.6%) in this file**, and `resource` another 123
  (7.6%). Both currently fall to mwarc's `default` branch and yield header-only, so
  they parse without error but carry no payload — 15% of this archive is records the
  viewer cannot show. Unrelated to gzip; see §14.
- **mwarc parses this archive completely**, all 1,624 records, no error. That is
  WARC/1.1 with fractional dates and revisit records, so it is also an independent
  confirmation that the 1.1 work from earlier this session is sound on real
  Browsertrix output.

## 8. Progress reporting — the fix, and the half of it I missed first

**The bar reached 100% two thirds of the way in and sat there, still parsing.**

The diagnosis in this section was right and the fix was incomplete. The worker's own
`percent` field was corrected to use the compressed position — but **the UI never
reads `percent`.** `progress.ts:107` recomputes it:

```ts
handle.parsedOffset = progress.offset;          // applyProgress
percentOf(handle.parsedOffset, handle.size)     // ...and the bar divides these
```

So the number that matters is `parsedOffset`, and the worker was still posting
mwarc's **logical** offset while `size` stayed the file on disk. At 50.8 MB
compressed to 77.5 MB the ratio crosses 1.0 at about 65%.

Two messages carry it — `progress` and `newRecords` — and **both** land in
`applyProgress`, so they must agree or the bar jitters as well as overruns. Both now
report `physicalOffset()`. Three places, three different right answers:

| message | offset reported | why |
|---|---|---|
| `progress`, `newRecords` | physical (`dataOffset + compressedPosition`) | same space as `size`; monotonic; bounded by construction |
| `parsed` | `size` exactly | a finished parse must read 100%, and the last record starts before EOF |
| `error` | **logical** | the card says "last good record at byte N" — that names a RECORD, and a member boundary is a different question |

`parser/progress.test.ts` drives the real worker with a stubbed `postMessage` and
asserts the invariant directly: **every offset the main thread will apply is
monotonic and never exceeds `size`.** Verified by reintroducing the bug — two tests
fail, and tellingly the plain-`.warc` control still passes, which is exactly why
nothing caught this. `percent` also still passed while broken, since the worker's
own figure was right and only the reported offset was wrong.

## 8b. Why it happened at all

Found while tracing the wire protocol, not predicted. The offline parse reports
progress as a byte offset, and the percentage is computed in
`frontend/components/Offline/progress.ts:45`:

```ts
const percentOf = (offset: number, size: number | undefined) =>
    size && size > 0 ? Math.floor((offset / size) * 100) : 0;
```

- `offset` is `parsedOffset`, which is mwarc's **logical** offset.
- `size` is `handle.size`, which is `File.size` — the **compressed** length.

On a `.warc.gz` at a typical 3:1 ratio, the logical offset passes the compressed
size about a third of the way in. So `percentOf` returns values above 100 from that
point on. `fileListing.tsx:130` clamps for *display*
(`Math.min(100, Math.round(...))`), so it does not render "312%" — it renders a bar
that races to 100% at a third of the archive and then sits there for the remaining
two thirds, looking hung. Worse, `percentOf` is also the change-detection gate
(`progress.ts:128`), so once it saturates, progress messages stop coalescing on a
value that no longer moves.

**Report the compressed position instead.** `GzipWarcReader.compressedPosition`
(§7.2) is monotonic, is bounded by `File.size` by construction, and is a truer
measure of a progress bar's actual subject: work done, not logical position. It also
needs no total to be discovered first — the decompressed total is not known until
the pass finishes, so a logical percentage is not merely wrong, it is unavailable.

One consequence to keep straight: `parsedOffset` is also shown as a number in the
failure card — *"last good record at byte N"* (`fileListing.tsx:74`). That must stay
**logical**, because it names a record position a reader might go looking for, not
progress. So the two diverge for a `.warc.gz`, and they should: one is "how far
through the file are we", the other is "where in the archive was the bad record".
Worth a comment at both sites, since they were the same number until now.

## 9. The server view route — where this gets expensive

`routes/view/index.tsx` is the other interpreter, and it is **not** a
one-line branch. It currently hands lazy `Bun.file()` slices straight to
`new Response(...)` so Bun can stream them with `sendfile(2)`:

| line | what it does | on a `.warc.gz` |
|---|---|---|
| `:177` | `fh.slice(start,end).arrayBuffer()` for HTML/CSS rewriting | compressed bytes |
| `:208` | `new Response(fh.slice(...))` — Range 206 | compressed bytes |
| `:211` | `new Response(fh.slice(start,end))` — full body | compressed bytes |
| `:216` | `new Blob(chunkDataRanges(...).map(([s,e]) => fh.slice(s,e)))` | compressed bytes |

All four break. The fix is the same for each: **inflate the member once, then serve
from the decoded buffer.** `sendfile(2)` is lost; correctness is not. §7.2's size
distribution is what makes this acceptable — median 1.9 KB, p99 967 KB, max 4.8 MB
per member, so materializing one is bounded and small. A 4.8 MB buffer to serve a
range request is a fair trade against not being able to serve it at all.

**The Range arithmetic survives untouched**, which is the good news and worth being
explicit about. `totalLen` comes from `byte_length`, which is a **decoded** length
in both worlds. So `parseRange` (`:36–64`), the 416 handling, `Content-Range` and
`Content-Length` are all still correct. Only the fetch primitive changes:

```
  fh.slice(start + range.start, start + range.end + 1)
      ↓
  decoded.subarray(payloadOffsetInMember + range.start,
                   payloadOffsetInMember + range.end + 1)
```

`chunkDataRanges` (`:216`) needs the same treatment — it maps chunk ranges to file
offsets to build a lazy multi-part Blob, and on a gzipped source those ranges are
offsets into the decoded member instead.

**Detect from the data, not the filename.** The signal is `gzip_offset IS NOT NULL`
on the row, never `file_path.endsWith('.gz')`. Filenames lie in both directions —
a `.warc` that is gzipped, a `.warc.gz` that is not — and the row is authoritative
because the parser wrote it.

None of this is in scope for the trial. It is in the plan because the descriptor in
§5 has to be sufficient for it, and it is: `compressedOffset`, `compressedLength`,
`payloadOffsetInMember` are exactly what the route needs, with no index.

## 10. WACZ — built, and it did come free

`backend/parser/wacz.ts`. Browsertrix **stores** rather than deflates its
`.warc.gz` entries, so each archive is a contiguous byte range of the `.wacz` and a
`BlobLike` slice of the zip *is* a readable `.warc.gz`. `gzip.ts` needed no changes
at all — `createGzipWarcReader(archive.file)` parses an archive out of a 464 MB
`.wacz` with no extraction step anywhere.

Verified on the real file (`bun test parser/wacz.test.ts`, 9/9):

```
  central directory read, all entries inside the file          ✓
  every archive/*.warc.gz has method 0 (STORED)                ✓
  an archive read in place is byte-identical to the extracted   ✓
  createGzipWarcReader parses it out of the .wacz              ✓  1,624 records
  indexes/index.cdx.gz located                                  ✓
  a non-zip is rejected with WaczError                          ✓
```

Two things worth knowing, both of which the tests pin:

- **`dataOffset` matters, and getting it wrong is silent.** A location produced
  while reading an entry view is ENTRY-relative; a `ViewRecord` that carries the
  whole `.wacz` needs it FILE-relative. Reading an unbiased location against the
  whole file lands `dataOffset` bytes early — inside the *previous* entry — and
  inflates whatever is there. `absoluteLocation()` does the rebasing, and its test
  asserts both that the biased read matches and that the **unbiased** read does
  *not*, so the test cannot pass with the bias removed.
- **The data offset comes from the local header, not the central directory.** The
  two extra-field lengths routinely differ, because writers put alignment padding
  in the local one. Deriving the offset from the central directory alone is off by
  that padding.

Zip64 is handled on the read path (EOCD64 locator plus the 0x0001 extra field),
since a `.wacz` over 4 GB is ordinary rather than hypothetical. Not exercised by
this file, which is 464 MB.

The bundled `indexes/index.cdx.gz` carries an offset and length per record, and all
873 of its entries matched member boundaries exactly, so where it is present §7.3's
walk can be skipped. `waczIndex()` returns it as a byte range; parsing it is not
built.

**Built: one selected file can now be N archives.** `worker.entry.ts` gained
`ParseSource` and `resolveSources`, and `parseStream` loops over them. Three
decisions worth recording:

- **Progress is `dataOffset + compressedPosition`.** Each archive's reader counts
  from zero, so the raw figure would snap back to 0% at every archive boundary.
  Adding where the archive starts in the zip keeps it rising across the whole
  container and bounded by the file size.
- **Locations are rebased at the point they leave the worker**, via
  `absoluteLocation`, because a `ViewRecord` carries the file the user picked
  rather than the slice the reader saw.
- **Archives are parsed sequentially, not concurrently.** Each reader holds an
  inflate window; four at once multiplies peak memory by four for no throughput,
  since one reader already saturates on inflate.

Two things a reader should know: `payload.offset` is logical *per archive*, so two
records in different archives inside one `.wacz` can share an offset — nothing keys
on it (`customId` is `file::url::uuid`), but the timeline displays it. And a
malformed record ends the whole container rather than skipping to the next archive,
which is deliberate: records already found are posted, and a `.wacz` whose third
archive is bad is more likely truncated than selectively corrupt.

What is *not* done is the frontend file picker offering `.wacz` at all.

## 10b. WACZ, as originally planned

Browsertrix **stores** rather than deflates its `.warc.gz` entries, so the archive
is a contiguous slice of the `.wacz` and `compressedOffset` is just
`entryDataStart + memberOffset`. Verified — one record out of a 464 MB `.wacz`, one
2.02 MB read, no extraction:

```
  absolute read offset : 452,874,193   (409,645,404 + 43,228,789)
  WARC version line    : WARC/1.1
  WARC-Type            : response
```

**Verify, don't assume** — read the local header's compression method and refuse
clearly when it is not 0. A WACZ also ships `indexes/index.cdx.gz` with `offset`
and `length` per record, so when present §7.3 can be skipped entirely.

## 11. Order

1. `bun add fflate@^0.8.3` — 0.8.0 added multi-member streaming `Gunzip`, 0.8.3
   fixed a Zip64 extra-field over-read on the reader path.
2. `gzip.ts`: `GzipMember`, `GzipLocation`, `indexWarcGz`. Standalone, testable, no
   wiring.
3. Single-member refusal (§7.3). Before anything can be slow, make it impossible.
4. `GzipWarcReader.read` with the 256 KB window; swap in at `worker.entry.ts:303`
   behind a check on the source, not the filename.
5. **The descriptor through every hop (§6), all optional, no behaviour change** —
   `WarcRecord.gzip`, `WireWarcRecord.payload.gzip`, `WarcPayloadLocation.gzip`,
   `ViewRecord.payload.gzip`, and the `wire.ts` copy. Populate from
   `memberAtUncompressedOffset(header-warc.offset)` minus `header-content.offset`
   (built today at `worker.entry.ts:232` and `:249–250`). Ships alone and does
   nothing yet, which is the point.
6. `readGzipPayloadSlice` + the `readPayload` branch (§6.5). First point at which a
   `.warc.gz` actually renders.
7. The §6.6 guards. Immediately after the first thing that can drop the field.
8. WACZ biasing (§10).

Steps 2–3 and 5 land alone and cannot affect the plain-`.warc` path.

## 12. What this trial is for

Left alone on purpose: `db/setup.sql`, `db.ts`'s `formatWarcComposite`,
`parse.worker.ts`, and the four interfaces in `db.types.tsx` (`WarcPayload`,
`WarcResponsePayload`, `WarcResponseBulkInput`, `WarcInsertResponseFull`).

Three things the backend will need, cheaper to learn here:

1. **`formatWarcComposite` is a positional composite literal** — its comment says
   *"Order must perfectly match your CREATE TYPE declaration order"*. Two gzip
   columns mean editing `CREATE TYPE warc_response_bulk_input` (15 fields today,
   `db/setup.sql:66`), `formatWarcComposite`'s array, the `response_payloads` view
   (`db/setup.sql:293`), `insert_warc_responses_full`
   (`db/migrate_bulk_insert_fix.sql:31`), and four interfaces — in lockstep.
2. **The logical offset has to stay.** `payloads` is
   `UNIQUE (file_id, byte_offset, byte_length)`, so `byte_offset` is part of a
   record's identity and cannot be dropped for gzip coordinates even though
   retrieval no longer needs it. Keeping `payload.offset` (§6.3) is the same
   decision made early.
3. **Where the columns go.** `payloads` is keyed per `file_id`, not deduplicated
   globally by digest, so `gzip_offset`/`gzip_length` can live there without one
   file's coordinates being wrong for another's identical bytes. Confirmed from the
   DDL; the whole backend migration rests on it.

The DB columns are the same three numbers as §5 — `gzip_offset`, `gzip_length`,
`gzip_payload_offset` — so if the descriptor is right here it is right there.

## 13. Tests

`backend/parser/` has **no test files today** — `find` returns zero across
`backend/` and `frontend/`. These are new.

1. `indexWarcGz` on the WACZ: 1,624 members, and every CDXJ `offset`/`length`
   matches a member exactly. Real external ground truth.
2. **Reads spanning 2 and 3 members return correct bytes.** §3 says 47.5% of real
   reads do this — the common path, not an edge case.
3. **A backward read of 1 KB, then continue forward** — what the framing cursor
   actually produces. Assert no re-inflate from the member start.
4. A backward read beyond 256 KB fails *loudly* rather than returning wrong bytes.
5. Single-member `.gz` is refused, not read slowly.
6. **Round-trip the descriptor through `structuredClone`** and assert it survives.
   It crosses postMessage twice (§6) and a class instance or a getter would be
   dropped silently — the same trap `WarcFileHande` already documents about
   functions on the record graph.
7. The §6.6 magic check fires when `gzip` is stripped from a gzipped record.
8. **The differential test, worth more than the rest combined.** Take
   `nekoweb.warc`, gzip it per-record, index it, and assert `readPayload` over the
   gzipped records is **byte-identical** to `readPayload` over the plain original,
   and that the record count matches (1,629). One assertion covers the index, both
   coordinate spaces, the member lookup and the de-chunk order — against ground
   truth rather than against itself.

## 14. Carried over

- **WARC 1.1 reading is already in** — version-agnostic parsing, fractional
  `WARC-Date`, repeated fields joined, case-insensitive lookup,
  `Transfer-Encoding` as a list, bare-LF header blocks, the buffered off-by-4. The
  WACZ is `WARC/1.1`, so that work is a prerequisite and it is done.
- **`revisit` records are still unhandled** — 329 of ~3,100 in the WACZ (10.6%).
  They hit `mwarc`'s default branch and are skipped. Orthogonal to gzip, but the
  largest remaining gap for Browsertrix archives.
- **`Content-Encoding: gzip` payloads — FIXED.** They were served raw, rendering as
  binary (4 in a 2,500-record sample), because a blob url carries no header telling
  the browser to inflate. `readPayload` now decodes it, and the composition order
  §5 implied is what the code does: member, then chunked framing, then
  `Content-Encoding`, since that is the order they were applied in. `gzip`,
  `x-gzip` and `deflate` are handled; `br` warns and serves raw, there being no
  Brotli decoder in the bundle. An undecodable body also serves raw rather than
  failing the page — one bad asset should not take a document with it.

  This needed a new field on the wire: the posted record carries no headers, so the
  worker cannot derive the encoding and `PostedViewRecord.contentEncoding` had to
  be added and relayed.
- **`mWarcExtractHeader` has no size cap**, and a member that decodes to garbage is
  a new way to reach that. Worth a bound while in here.


## 15. Performance

Measured on the 48.4 MB / 73.9 MB-logical Browsertrix archive, 1,624 members, from
an **in-memory** source so the numbers are CPU and not the sandbox's network mount
(which reads at ~5 ms per 64 KB and swamps everything). Best of three.

### What it was, and what fixed it

```
                                      before    after
  full parse + locate() per record    1343 ms   788 ms
  overhead above raw inflate           536 ms    83 ms
  locate() x1624                       459 ms    30 ms
```

**The window was quadratic.** It was a plain `Uint8Array` reallocated and copied
whole on every output chunk — O(n) per chunk, O(n²) per file. It went unnoticed
because it only bites when production runs ahead of the consumer, which is exactly
what `locate()` causes: resolving a record's member forces inflation one member
past the reader, the window balloons to a megabyte, and then every subsequent chunk
copies all of it. That is the same quadratic trap `indexWarcGz`'s own comment warns
about, reproduced one level down in the code that warns about it.

Now a buffer with a live span `[head, tail)`: append into spare capacity, compact
only when the tail runs out of room, grow only when the live span genuinely does not
fit. Amortised O(1) per byte. `trimTo` just moves `head`.

Also removed a second copy in `read()` — `out.buffer.slice(0, filled)` copied the
whole result again on the common path where `filled === size`.

### Where the time goes now

```
  inflate only (fflate, floor)          705 ms   105 MB/s
  indexWarcGz                           785 ms
  full parse                            758 ms
  full parse + locate()                 788 ms    94 MB/s
  mwarc on already-decompressed bytes    27 ms  2730 MB/s
```

**The parse is within 12% of raw inflate.** mwarc costs 27 ms. There is nothing left
to win in this codebase's own code — the remaining 90% is fflate inflating bytes.

Tuning knobs were measured and are already at their best: `chunkSize` 8 KB beats
32 KB and 128 KB (857 / 917 / 913 ms), `pushBytes` 64 KB beats 16 KB and 256 KB
(896 / 1027 / 980 ms).

### Native decompression — 3.6x, and taken

```
  fflate streaming, whole file            711 ms   104 MB/s
  fflate gunzipSync per member            606 ms   122 MB/s
  native DecompressionStream per member   197 ms   376 MB/s
```

`readGzipPayloadSlice` now uses `DecompressionStream` when it exists, with fflate as
the fallback. **590 payload reads in 155 ms, 263 µs each.** This is the latency a
reader actually feels — every page and every subresource of a view goes through it.

It can only be used here, and the reason matters: the spec allows **one** gzip
member per stream and never reports bytes consumed, so it is useless for the index
walk. A single member is a complete gzip stream, so once a location is known the
limitation does not apply. (Bun's implementation happens to accept concatenated
members; the browser's does not, so that cannot be relied on.)

### What is left, in order of value

1. **Parse a `.wacz`'s archives in parallel.** They are independent files and are
   currently walked in sequence by one worker, so a four-archive container uses one
   core out of twenty-four. The file-selection flow already hands one file per
   worker; splitting a container into N handles would be roughly a 4x wall-clock win
   on exactly the format being tested. Peak memory multiplies by N (§7.2).
2. **Headers-only inflation, given an index.** A full pass inflates 73.9 MB to read
   ~1.6 MB of headers. Inflating only the first 4 KB of compressed data per member
   takes **152 ms against 711 ms — 4.7x** — and the headers are at the member start,
   so they are exactly what a truncated inflate gets. It needs member boundaries up
   front, which is circular for a bare `.warc.gz`, **but a `.wacz` already ships
   them** in `indexes/index.cdx.gz` (873/873 offsets matched member boundaries
   exactly). `waczIndex()` already locates that file; parsing it is not built. This
   is the largest available win and the most architectural: the reader would need to
   seek between members rather than stream through them.
3. **Nothing else.** Both remaining items are about doing less work, not doing it
   faster, because the work itself is already at the platform floor.
