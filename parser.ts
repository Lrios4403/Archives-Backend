import { progress_schema_ready, reset_database, waitForDatabase } from "./db";
import { parseFilesInWarc } from "./parse";

/*
 * The parser entry point.
 *
 * This used to call reset_database() unconditionally, and reset_database() runs
 * db/setup.sql, which DROPs every table before recreating it. So every restart —
 * a code change under `--hot`, a `docker compose restart`, a crash — threw the
 * whole archive away and read all of it again from zero.
 *
 * Now nothing is reset unless asked, and where the last run got to is read back
 * from `file_progress`. Restarting is cheap: files that finished are skipped,
 * files that were interrupted resume from their last committed record boundary,
 * files that have grown since (WARCs are append-only) read only the tail, and
 * files that appeared since are picked up as new.
 *
 * A real reset is still one command, and now reads like what it does:
 *
 *     RESET_DB=1 bun parser.ts
 */

console.log("Waiting for the database to accept connections...");
await waitForDatabase();

if (Bun.env.RESET_DB === "1") {
    console.warn("RESET_DB=1 — dropping and recreating every table.");
    await reset_database();
    console.log("Database reset.");
} else if (!(await progress_schema_ready())) {
    /*
     * Refused rather than repaired.
     *
     * setup.sql is the only thing that creates this table and it is a wipe, so
     * "fix it automatically" would mean deleting the archive to add a table. The
     * one case that reaches here is a database created before progress existed,
     * where the right move is a decision, not a default.
     */
    console.error(
        "The progress schema is missing (no `file_progress` table).\n" +
        "db/setup.sql creates it, and that script DROPS EVERY TABLE — so this is\n" +
        "not done for you. Re-initialise deliberately with:\n\n" +
        "    RESET_DB=1 bun parser.ts\n",
    );
    process.exit(1);
}

await parseFilesInWarc();
