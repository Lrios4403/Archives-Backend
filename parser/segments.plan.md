# Parsing one `.warc` with several workers

**IMPLEMENTED, §1–7.** `mWarcFindRecordStart` and `start`/`end` in `mwarc.ts`, the
`segment` field through every worker message, `planTasks` splitting the work,
per-segment progress summed on the main thread, and work stealing via
`resegment`/`resegmented`.

**28 tests green** — 9 in `parser/segments.test.ts` (the union-equals-whole
invariant on four real archives, resync, the planted-header case) and 19 in
`frontend/.../segments.test.ts` (planning, the progress arithmetic, and the steal
including its race). Both typechecks at baseline; the browser bundle builds and
still passes its classic-worker guard.

One thing the plan got wrong, corrected below where it belongs:

- **The resync guard has a blind spot at EOF** (§2). It accepts a candidate it
  cannot confirm, so that truncated archives keep their last record — which also
  means a planted header whose own length reaches exactly the end of the file is
  accepted. Narrow, and the right way round, but it was stated as airtight and is
  not.


**The problem.** A 1.6 GB archive is one file, and one file is one worker. Twenty-three
cores idle while one grinds through it.

**The shape.** Split the file into byte segments, one per worker. A segment boundary
lands mid-record, so a worker scans forward to the next record header before it
starts. Progress stops being "where is this worker" and becomes "how much of the
file has anyone finished".

Scope: **plain `.warc` only.** §8 says why `.warc.gz` needs a different mechanism.

---

## 1. The ownership rule

Everything correctness-related follows from one sentence:

> **A worker parses every record whose START offset lies in `[start, end)`, and reads
> past `end` as far as it must to finish the last one.**

So for adjacent segments A = `[0, N)` and B = `[N, M)`, and a record that starts at
`S < N` and ends at `E > N`:

```
            S           N              E
  ──────────┬───────────┬──────────────┬────────
            │  record spanning the cut │
            A owns it (S < N)          │
                        B resyncs past it, starts at E
```

- A owns it, because it *started* in A. A reads past `N` to finish it.
- B resyncs from `N` and lands on the first header at or after `N`, which is `E`.

**No gaps and no duplicates, without the two workers communicating.** That is the
whole reason to define ownership by start offset rather than by overlap: the rule is
local, so each worker can apply it alone.

Two consequences worth stating:

- **A segment can legitimately parse zero records.** If one record spans an entire
  segment, that segment finds no header before its end. Not an error; report zero.
- **The last segment's `end` is the file size**, and the file's final record must be
  parsed even though it may be truncated. Same rule, no special case.

## 2. Resync — measured, then guarded

A worker at a mid-file offset must find the next record start. The scan is for
`WARC/1.` at the beginning of a line (`\n` immediately before, or offset 0).

**Measured false-positive rate: zero.** Every candidate found was a real record
start, across four archives and ~14,300 records:

```
                     records   "WARC/1." at line start   false positives
  lolcow.warc            253                       253                 0
  crystal.cafe.warc      457                       457                 0
  nekoweb.warc         1,629                     1,629                 0
  5am.warc             2,339                     2,339                 0
  onionfarms.warc     10,077                    10,077                 0   (first 400 MB of 1.6 GB)
```

(The first run on onionfarms reported one false positive at 419,430,102 — 298 bytes
short of the 400 MB cut. It was the truncation, not the data. Re-run counting only
candidates below `limit − 4 MB`: zero.)

**Guard it anyway, because the corpus is not the world.** A WARC stored *inside*
another WARC — a derived archive, a crawl of an archive — puts a real `WARC/1.0` at
a line start inside a payload, and nothing above would have caught it. Validation
after a candidate:

1. The header block parses, and carries `WARC-Type` and a numeric `Content-Length`.
2. **The next record starts exactly where this one says it ends.** `Content-Length`
   plus the separator must land on another `WARC/` at a line start, or on EOF.

Two-record confirmation is what kills the nested-WARC case: the inner archive's
records are inside a payload, so the outer bytes following one do not line up with
its own `Content-Length`. Cost is one extra header read per resync, of which there
is one per segment.

**Worst-case scan is one record.** Bounded by the largest record in the file:

```
                    record span   p50     p90      p99     MAX
  onionfarms.warc                 1 KB   113 KB   300 KB   16.6 MB
  nekoweb.warc                  973 B     52 KB   928 KB   28.1 MB
  5am.warc                        1 KB    89 KB   758 KB   11.3 MB
```

So a segment boundary costs at most ~30 MB of scanning on these files, and the p90
says it is usually a few hundred KB. That bound is also what sets the minimum
segment size (§5).

## 3. `mwarc.ts` — two options, no new concepts

`mWarcDecode` starts at 0 and runs to EOF. It needs to start somewhere and stop
somewhere:

```ts
export interface WarcDecodeOptions {
    // …existing…
    /** First byte this pass owns. `file.offset` starts here instead of 0. */
    start?: number;
    /**
     * One past the last byte this pass owns.
     *
     * Stop when a record's own START is >= this. The record that straddles it is
     * still parsed in full — see the ownership rule — so this bounds which records
     * are claimed, not how far the reader may read.
     */
    end?: number;
}
```

That is the entire change to the parser, and it is two comparisons: `file.offset =
start ?? 0` at the top, and `if (headerWarcOffset >= end) return` in the loop.

**Resync stays out of `mwarc`.** A new exported helper beside it:

```ts
export const mWarcFindRecordStart = async (
    read: (start: number, size: number) => Promise<ArrayBuffer | null>,
    from: number,
    limit: number,
): Promise<number | null>;
```

Separate because it is separately testable, because `mWarcDecode` should not grow a
mode, and because the worker wants the answer *before* it decides whether the
segment is worth parsing at all. `null` means "no record starts in this range",
which is the zero-record segment of §1.

## 4. Worker protocol

`parseStream` gains one optional field. Everything else follows from it.

```
  main -> worker   { action: "parseStream", handle: { …, segment? } }

    segment: {
      index: number      // 0..count-1, identifies this segment in progress messages
      count: number      // how many segments this file was cut into
      start: number      // first byte owned
      end:   number      // one past the last byte owned
    }
```

Absent means the whole file, which is today's behaviour and must stay byte-identical.

Every message the worker already posts gains `segment` (the index) so the main
thread can attribute it. `parsed` and `error` carry the segment's own byte range so
the main thread can close it out without having remembered.

**One worker still owns one message stream.** No new channel, no worker-to-worker
talk, no coordination — which is what the ownership rule bought.

## 5. Segmentation policy

Where the split happens is a main-thread decision, made once when a parse starts.

```
  segments = clamp(1, workers, floor(size / MIN_SEGMENT))
```

`MIN_SEGMENT` matters and is the thing to get wrong. Two floors compete:

- **Resync cost.** A boundary costs up to one record of scanning — up to 30 MB on
  the archives measured. A 16 MB segment whose boundary lands inside a 28 MB record
  scans past its own end and parses nothing, having read more than its whole share.
- **Startup cost.** A worker spawn plus its first reads is fixed overhead that a
  small segment cannot amortise.

**`MIN_SEGMENT = 64 MB`**, which is ~2× the largest record seen and gives the
1.6 GB file 25 possible segments — more than any core count in play. Below that
size a file is not segmented at all, which is the honest answer for a 40 MB archive:
one worker finishes it before four could agree on who parses what.

This is what the "chunk size × 2 would not be good" instinct was pointing at, made
concrete: the floor has to be set by the largest RECORD, not by the read chunk size.
A read chunk is 8 KB; a record can be 28 MB.

## 6. Progress

**This is the part that cannot be papered over.** Today `parsedOffset` is a single
absolute position and the bar is `parsedOffset / size`. With four workers on one
file there are four positions and none of them is the answer.

Per-segment progress, summed:

```
  handle.segments = [ { start, end, at }, … ]

  parsedOffset = Σ (at − start)      // bytes actually finished, by anyone
  percent      = parsedOffset / size
```

`at − start` rather than `at`, because a worker starting at 1.2 GB has not parsed
1.2 GB. Summing raw positions is the obvious mistake and would show ~75% before any
work happened.

Consequences to handle:

- **`applyProgress` must merge, not overwrite.** It currently assigns
  `handle.parsedOffset = progress.offset`. It has to write into the segment's slot
  and recompute the sum — and the sum is monotonic even though individual segments
  finish out of order, which keeps the "never walks backwards" property the
  progress tests already assert.
- **"last good record at byte N" on a failure** stays per-segment and should say
  which segment, because one segment failing no longer means the file failed. The
  other three keep going and their records are real.
- **A file is `parsed` when every segment is**, not when one is. That is the
  condition that replaces today's single `parsed` message.

## 7. Dynamic re-segmentation — built

Four workers, three go idle, split what is left.

Built as described, with three decisions worth recording:

- **The victim is picked by BYTES remaining, not percent.** A segment 90% through
  600 MB has more left than one 10% through 70 MB, and it is bytes that take time.
- **The cut is halfway through what REMAINS**, not halfway through the segment. The
  front half is already parsed; cutting there would hand over nothing.
- **`MIN_STEAL` is half of `MIN_SEGMENT`** — 32 MB. Below that the receiving worker's
  startup and resync cost more than the work, and the donor was about to finish
  anyway. A steal is only attempted when the victim has at least twice that left, so
  both halves clear the floor.

An idle worker asks *before* retiring, and then sits doing nothing until the reply
queues the tail. The `resegmented` handler nudges every idle worker, so whichever
takes it wins and the rest ask again.

**A stolen tail can itself be stolen from** — the tail is an ordinary segment with an
ordinary slot, so nothing special is needed for it. Tested to six segments on a file
planned as four.

The race is the whole difficulty, and it is why the protocol is a question rather
than an instruction:

```
  main -> worker   { action: "resegment",   segment, end }
  worker -> main   { action: "resegmented", segment, stoppedAt }
```

Between the main thread deciding to cut a segment at X and the worker receiving it,
the worker may already have parsed past X. So:

- The worker treats `resegment` as a request, and replies with the offset it
  **actually** stopped claiming at — the start of the next record it had not yet
  begun.
- The main thread hands the idle worker `[thatOffset, oldEnd)`, not `[X, oldEnd)`.

Never a guess, so records can neither be dropped nor parsed twice. It is one extra
round trip on a rebalance, which happens a handful of times per file.

The donor's slot shrinks to `stoppedAt` in the same breath as the tail's is created.
Missing that is the one way to break the sum: the tail would be counted twice, once
against the worker that gave it up and once against the worker that took it, and the
bar would sail past 100%. There is a test that adds up every slot before and after a
steal and insists the total is unchanged.

## 8. Not for `.warc.gz`

A `.warc.gz` cannot be cut at an arbitrary byte: the byte is inside a DEFLATE stream
and means nothing without the member it belongs to. Resync would have to scan for
gzip magic (`1f 8b 08`), which is three bytes and appears in compressed data by
chance far more readily than `WARC/1.` appears in payloads.

It *is* segmentable, but by **member boundary**, which is a different mechanism:
`indexWarcGz` already produces every boundary exactly (§7.3 of fflate.warc.gz.md,
873/873 verified against a CDXJ), so a gzipped archive would be split by assigning
member ranges rather than byte ranges. That needs the index first, which is a full
inflate — so it is only free where a WACZ ships a CDXJ.

Until then: `resolveSources` reports `gzipped`, and a gzipped source is not
segmented. One worker, as today.

Note this does not cost the `.wacz` case anything — a container is already expanded
into one handle per archive, so it already uses N workers.

## 9. Tests

The invariants, not the implementation. `nekoweb.warc` (1,629 records) and
`onionfarms.warc` (large, real) as fixtures.

1. **Union equals whole.** Parse a file in one pass; parse it again as N segments and
   concatenate. The set of record offsets must be **identical** — no gaps, no
   duplicates. Run for N = 2, 3, 4, 7 and for a boundary deliberately placed inside
   a known large record.
2. **Resync lands on real starts only.** For a few thousand arbitrary offsets,
   `mWarcFindRecordStart` returns either a real record start or null. Never anything
   else.
3. **Two-record confirmation rejects a planted header.** Build a WARC whose payload
   contains a valid-looking `WARC/1.0` block, and assert resync skips it. This is the
   case the corpus does not contain and the guard exists for.
4. **A record spanning a whole segment yields zero records there, and is parsed
   exactly once by the segment that owns its start.**
5. **Progress is monotonic and reaches exactly 100%** with segments completing out of
   order — the existing `progress.test.ts` invariant, extended to the summed figure.
6. **`segment` absent is byte-identical to today.** The regression guard for every
   single-worker parse.

## 10. Order

1. `mWarcFindRecordStart` + its tests. Standalone, no wiring, and it is the piece
   that could be subtly wrong.
2. `start`/`end` on `mWarcDecode`. Two comparisons; test 1 above is what proves them.
3. The `segment` field through `parseStream`, with the main thread still sending one
   whole-file segment. No behaviour change, ships alone.
4. Progress aggregation (§6). Also no behaviour change while there is one segment,
   and it is the part most likely to need a second look.
5. Turn segmentation on: the policy in §5.
6. `resegment` (§7), separately.

Steps 2–4 each land without changing what the user sees, which is deliberate — the
risky arithmetic goes in while the old path is still the one running.
