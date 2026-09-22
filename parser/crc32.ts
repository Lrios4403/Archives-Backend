/**
 * CRC32, because every zip entry needs one and nothing else in the pipeline does.
 *
 * With entries STORED rather than deflated, this is no longer a rounding error
 * next to compression — it is the only computation the download path performs
 * over the bytes at all. So it gets measured and it gets a table.
 *
 * Two implementations, and the second is why this file exists separately.
 */

/** The standard reflected polynomial, 0xEDB88320. */
const POLYNOMIAL = 0xedb88320;

/**
 * The classic 256-entry table: one byte per iteration.
 *
 * Built once, lazily. Eight of these is 8 KB of typed array that a page which
 * never downloads anything has no reason to allocate.
 */
let tables: Uint32Array[] | null = null;

const buildTables = (): Uint32Array[] => {
    const built: Uint32Array[] = [new Uint32Array(256)];
    const first = built[0]!;

    for (let index = 0; index < 256; index++) {
        let value = index;

        for (let bit = 0; bit < 8; bit++) {
            value = value & 1 ? (value >>> 1) ^ POLYNOMIAL : value >>> 1;
        }

        first[index] = value >>> 0;
    }

    /*
     * Seven more tables, each the previous one advanced by a byte.
     *
     * This is "slicing by eight": table N holds the CRC contribution of a byte
     * that is N positions further from the end of the window, which is what makes
     * it possible to fold eight input bytes per iteration instead of one. The
     * tables are derived, not magic — table[n][i] is table[0] applied to
     * table[n-1][i] — so there is nothing to get wrong by hand.
     */
    for (let slice = 1; slice < 8; slice++) {
        const previous = built[slice - 1]!;
        const next = new Uint32Array(256);

        for (let index = 0; index < 256; index++) {
            next[index] = (first[previous[index]! & 0xff]! ^ (previous[index]! >>> 8)) >>> 0;
        }

        built.push(next);
    }

    return built;
};

const getTables = (): Uint32Array[] => (tables ??= buildTables());

/**
 * Fold one chunk into a running CRC.
 *
 * `previous` is the value so far — 0 to start — and the return feeds the next
 * call, so a multi-gigabyte entry is CRC'd without ever being one buffer.
 *
 * The one's complement is applied at both ends of each call rather than kept
 * outside, which costs two XORs per chunk and means callers never hold a value
 * in a half-finished representation. At one call per megabyte that is free.
 */
export const crc32 = (chunk: Uint8Array, previous = 0): number => {
    const [t0, t1, t2, t3, t4, t5, t6, t7] = getTables() as [
        Uint32Array, Uint32Array, Uint32Array, Uint32Array,
        Uint32Array, Uint32Array, Uint32Array, Uint32Array,
    ];

    let crc = (previous ^ 0xffffffff) >>> 0;
    let at = 0;

    /*
     * Eight bytes per iteration, as eight independent table lookups XORed
     * together.
     *
     * That independence is the whole trick. A byte-at-a-time loop carries a
     * serial dependency through `crc` on every single byte, so the CPU can never
     * have more than one lookup in flight; here the eight loads have no
     * relationship to each other and the processor can run them at once.
     *
     * The shape is not negotiable and is easy to get subtly wrong — the first
     * four bytes are XORed into the crc and read through tables 7 down to 4, the
     * second four are read through 3 down to 0 and NOT XORed into anything. An
     * earlier version here folded one byte in and then read the rest through the
     * wrong tables; it was fast, self-consistent, and produced a crc that no
     * other implementation agrees with. The known-answer test is what caught it.
     */
    while (at + 8 <= chunk.length) {
        crc = (crc ^ (
            chunk[at]!
            | (chunk[at + 1]! << 8)
            | (chunk[at + 2]! << 16)
            | (chunk[at + 3]! << 24)
        )) >>> 0;

        const next = chunk[at + 4]!
            | (chunk[at + 5]! << 8)
            | (chunk[at + 6]! << 16)
            | (chunk[at + 7]! << 24);

        crc = (
            t7[crc & 0xff]!
            ^ t6[(crc >>> 8) & 0xff]!
            ^ t5[(crc >>> 16) & 0xff]!
            ^ t4[(crc >>> 24) & 0xff]!
            ^ t3[next & 0xff]!
            ^ t2[(next >>> 8) & 0xff]!
            ^ t1[(next >>> 16) & 0xff]!
            ^ t0[(next >>> 24) & 0xff]!
        ) >>> 0;

        at += 8;
    }

    // The tail, and the whole chunk when it is shorter than a group.
    while (at < chunk.length) {
        crc = (t0[(crc ^ chunk[at]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
        at++;
    }

    return (crc ^ 0xffffffff) >>> 0;
};

/**
 * The same thing a byte at a time, kept for the benchmark to beat.
 *
 * Not dead code: it is the reference the wide version is checked against, on
 * random data, in crc32.test.ts. A CRC that is fast and wrong is worse than one
 * that is slow, because the zip it produces still opens — until it does not.
 */
export const crc32Simple = (chunk: Uint8Array, previous = 0): number => {
    const table = getTables()[0]!;

    let crc = (previous ^ 0xffffffff) >>> 0;

    for (let at = 0; at < chunk.length; at++) {
        crc = (table[(crc ^ chunk[at]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
    }

    return (crc ^ 0xffffffff) >>> 0;
};
