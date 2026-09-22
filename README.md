# archives-backend

The server half of a WARC web archive: an HTTP API over a Postgres index of
archived captures, plus the parser that builds that index by reading WARC files
off disk.

It is two long-running programs sharing one database and one directory of
archives:

| | |
|---|---|
| `webserver.ts` | The HTTP API. Search, view a capture, download captures as a zip, timelines, status. |
| `parser.ts` | The ingest daemon. Walks `warcs/`, parses every record, writes them to Postgres. Resumable. |

The web UI that consumes this API lives in a separate repository:
[Archives-Frontend](https://github.com/Lrios4403/Archives-Frontend). Nothing here
depends on it — the API is usable on its own.

## Requirements

- [Bun](https://bun.sh) 1.2 or newer (developed against 1.3)
- PostgreSQL 18, with the `pg_trgm` extension available
- A directory of `.warc` files to index

## Setup

```bash
bun install
```

Create a database, then load the schema into it:

```bash
psql "$DATABASE_URL" -f db/setup.sql
```

Copy the environment template and fill in the connection string:

```bash
cp .env.example .env
```

`DATABASE_URL` is the only required variable and has **no default** — the server
throws at startup without it, rather than connecting somewhere unintended. Every
other variable is documented with its default in `.env.example`.

Put your WARC files in `warcs/`, or bind-mount a directory there.

## Running

```bash
bun start          # the HTTP API on :3000
bun run parse      # the ingest daemon
```

Both read the same `DATABASE_URL` and the same `warcs/`. Run the parser first, or
run both — the API answers from whatever is indexed so far, and `/api/warcs/progress`
reports how far ingest has got.

Under `--hot` for development:

```bash
bun run dev
bun run parse:dev
```

### Docker

```bash
docker build -t archives-backend .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgres://user:password@host:5432/warcs \
  -v /path/to/warcs:/usr/src/app/warcs \
  archives-backend
```

The image's entrypoint is the web server. The parser is the same image with the
entrypoint overridden:

```bash
docker run --rm --entrypoint bun archives-backend run parser.ts
```

## API

All routes are `GET` and live under `/api/warcs/`, except history.

| Route | What it returns |
|---|---|
| `/api/warcs/search` | URI search across the index, with content-type filtering and seek pagination |
| `/api/warcs/view` | An archived capture, rewritten so its links and assets resolve back into the archive |
| `/api/warcs/download` | Selected captures bundled into a zip, streamed from the WARCs on disk |
| `/api/warcs/near` | The capture closest to a given time for a URL |
| `/api/warcs/info` | Capture timeline for a URL — when it was archived, and how often |
| `/api/warcs/detail` | Full record detail for one capture |
| `/api/warcs/path` | Records under a path prefix |
| `/api/warcs/latest` | Most recently archived captures |
| `/api/warcs/content-types` | Distinct content types present in the index |
| `/api/warcs/status` | Index size, on-disk archive size, health |
| `/api/warcs/progress` | Per-file ingest progress |
| `/api/warcs/parser/index.js` | Browser build of the parse worker, bundled on first request |
| `/api/history` | Site history for a record |

`/api/warcs/parser/index.js` is the one endpoint a browser fetches directly, so
it is also the only one that sends CORS headers — see `CORS_ALLOW_ORIGIN` in
`.env.example`.

## Layout

```
webserver.ts        HTTP entry point; route table and Bun.serve config
parser.ts           Ingest entry point
parse.ts            Worker pool that drives parsing
parse.worker.ts     One parse worker: decode records, bulk-insert
db.ts               The single Postgres pool, and every query in the app
db.types.tsx        Row shapes
disk.ts             Archive directory scanning and size accounting
mwarc.ts            WARC format reader
uri.ts              URI normalisation
log.ts              Append-only parse error log

routes/             One file per endpoint
routes/download/    Zip streaming: entry building, recursive capture pulls
routes/view/        Capture rendering and link rewriting

parser/             Streaming zip/gzip machinery shared with the browser build
db/                 Schema, migrations, and the tuning write-up
```

## Schema

`db/setup.sql` creates everything from scratch and is what the setup step above
runs. Be aware of two things before you rely on it:

- **It is destructive.** Every table is dropped before it is created, ingest
  progress included. `RESET_DB=1 bun run parse` does the same thing deliberately.
- **It has drifted from what was deployed.** Its `search_responses()` is an older,
  much slower materialized shape, its count function has no cap, and it does not
  define `search_responses_broad()` at all — which `db.ts` calls. The bodies
  actually running in production were recovered with `pg_get_functiondef` and are
  in `db/DEPLOYED.recovered.sql`. Reconcile from that file, not from memory.

`db/*.sql` also holds the incremental migrations, in the order they were applied.
`db/postgresql.tuning.conf` is not a config file despite the extension — nothing
loads it. It is the measurement write-up behind the server settings, kept because
the numbers in it are not re-derivable from the code.

## Tests

```bash
bun test
```

164 tests across 14 files, concentrated in `parser/` and `routes/download/` — the
zip and gzip writers, where an off-by-one produces an archive that looks fine
until something tries to open it.

**They do not all pass on Windows, and the failures are environmental rather than
logic.** A clean run there is 95 pass / 26 skip / 43 fail, for two reasons:

- Most of the zip tests validate their output by shelling out to `python3`
  (`zipfile` is the independent reader that proves the writer is right). Without
  python3 on `PATH` they fail at spawn, not at an assertion.
- A handful build a filesystem path from `new URL(...).pathname`, which yields a
  leading-slash URL path — so on Windows they look for `/C:/Users/...` and get
  ENOENT. `routes/download/drift.test.ts` is the clearest case.

Some tests also read WARC fixtures from a sibling directory that is not part of
this repository, and skip or fail without it.

On Linux with python3 available, the first two categories go away.

## License

None yet. Without one, default copyright applies and nobody else has permission
to use, copy or modify this.
