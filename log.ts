import { appendFile } from "fs/promises";

// Append-only parse error log. Lives at ./parse-errors.log which, in the
// container, is /app/parse-errors.log — and since ./backend is bind-mounted to
// /app, it shows up on the host at backend/parse-errors.log. Override with the
// PARSE_ERROR_LOG env var if you want it elsewhere.
const ERROR_LOG = process.env.PARSE_ERROR_LOG ?? "./parse-errors.log";

async function append(line: string): Promise<void> {
  try {
    await appendFile(ERROR_LOG, line.endsWith("\n") ? line : line + "\n");
  } catch (e) {
    // Never let logging failures crash the parser.
    console.error("Failed to write to parse error log:", e);
  }
}

/** Write a separator so each parser run is distinguishable in the log. */
export async function logParseSessionStart(note = ""): Promise<void> {
  await append(`\n==== parse run ${new Date().toISOString()} ${note} ====`);
}

export interface ParseErrorContext {
  /** WARC file being parsed. */
  file?: string | null;
  /** Byte offset of the record (or last record seen, for decode failures). */
  offset?: number | null;
  uri?: string | null;
  warcRecordId?: string | null;
  warcType?: string | null;
  /** Where it failed: "insert", "decode", "file", "worker", ... */
  stage?: string;
  /** Which parse worker thread hit it, when the run is multi-threaded. */
  worker?: number | null;
}

/**
 * Postgres errors carry the useful part in fields the stack trace omits.
 * `detail`/`hint`/`position` are what actually say WHICH value Postgres
 * choked on — without them "invalid input syntax for type json" is
 * unactionable. Pull whatever is present; all fields are optional.
 */
function postgresErrorFields(err: unknown): Record<string, unknown> | null {
  if (typeof err !== "object" || err === null) return null;

  const e = err as Record<string, unknown>;
  const keys = [
    "code",       // SQLSTATE, e.g. 22P02 (invalid_text_representation)
    "detail",
    "hint",
    "position",   // byte offset into the statement
    "where",      // plpgsql call stack: which statement inside the function
    "schema",
    "table",
    "column",
    "dataType",
    "constraint",
    "routine",
  ] as const;

  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (e[k] !== undefined && e[k] !== null && e[k] !== "") out[k] = e[k];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** A formatted error, ready to be written by whoever owns the log file. */
export interface FormattedParseError {
  /** One JSON object, destined for a single line of parse-errors.log. */
  line: string;
  /** Condensed one-liner for the console. */
  summary: string;
}

/**
 * Format an error WITHOUT touching the filesystem.
 *
 * Split out from logParseError so parse worker threads can turn a caught error
 * into a log line and hand the strings to the main thread over postMessage. Two
 * plain strings keep the message on Bun's postMessage fast path, and keeping the
 * main thread as the only writer means eight threads never interleave partial
 * lines into parse-errors.log.
 */
export function formatParseError(context: ParseErrorContext, err: unknown): FormattedParseError {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const pg = postgresErrorFields(err);
  const entry = {
    ts: new Date().toISOString(),
    stage: context.stage ?? "unknown",
    worker: context.worker ?? null,
    file: context.file ?? null,
    offset: context.offset ?? null,
    uri: context.uri ?? null,
    warc_record_id: context.warcRecordId ?? null,
    warc_type: context.warcType ?? null,
    error: message,
    ...(pg ? { pg } : {}),
  };

  const summary =
    `[parse-error] ${entry.stage}` +
    (entry.worker !== null ? ` w${entry.worker}` : "") +
    ` | ${entry.file ?? "?"} @${entry.offset ?? "?"} | ${entry.uri ?? ""} | ${message.split("\n")[0]}` +
    (pg?.detail ? ` | detail: ${pg.detail}` : "");

  return { line: JSON.stringify(entry), summary };
}

/**
 * Write an already-formatted error. Main thread only — this is the single writer
 * for parse-errors.log.
 */
export async function writeParseError({ line, summary }: FormattedParseError): Promise<void> {
  await append(line);
  console.error(summary);
}

/**
 * Append one JSON line describing a parse/insert failure, plus a concise line to
 * the console. One JSON object per line (JSONL) so the log is easy to grep/scan.
 */
export async function logParseError(context: ParseErrorContext, err: unknown): Promise<void> {
  await writeParseError(formatParseError(context, err));
}
