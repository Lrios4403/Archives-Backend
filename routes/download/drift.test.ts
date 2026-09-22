// bun test routes/download/drift.test.ts
//
// `crc32.ts` and `storedzip.ts` exist twice — once under parser/, bundled into the
// browser worker, and once here, for the server route.
//
// A duplicated format writer is the one kind of duplication where drift is
// genuinely dangerous: two versions producing archives that differ in a header
// field both look fine, open fine in most readers, and disagree with each other
// about what a valid zip is. Nothing else in the repo would notice.
//
// So the copies are asserted identical. If they ever need to diverge, this test is
// where the reason gets written down.

import { describe, expect, test } from "bun:test";

const pair = (name: string) => [
    new URL(`../../parser/${name}`, import.meta.url).pathname,
    new URL(`./${name}`, import.meta.url).pathname,
] as const;

describe("the two copies of the writer", () => {
    for (const name of ["crc32.ts", "storedzip.ts"]) {
        test(`${name} is byte-identical in parser/ and routes/download/`, async () => {
            const [source, copy] = pair(name);

            const a = await Bun.file(source).text();
            const b = await Bun.file(copy).text();

            // Hashes rather than the text, so a failure prints two numbers instead
            // of a thousand-line diff. `bun test` would try to render the whole
            // file otherwise.
            expect(Bun.hash(b)).toBe(Bun.hash(a));
        });
    }

    // A copy that has stopped being imported is worse than one that has drifted:
    // it looks maintained and is dead. Both directions are checked because the
    // route and the worker each import their own.
    test("each copy is the one its own directory imports", async () => {
        const route = await Bun.file(new URL("./entries.ts", import.meta.url).pathname).text();
        const worker = await Bun.file(new URL("../../parser/storedsink.ts", import.meta.url).pathname).text();

        expect(route).toContain('from "./storedzip"');
        expect(worker).toContain('from "./storedzip"');
    });
});
