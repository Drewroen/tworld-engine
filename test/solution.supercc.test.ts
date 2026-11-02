// Decoder coverage over real-world solution files.
//
// The ten .tws files vendored under test/fixtures/supercc/ are the public
// solution sets that ship with SicklySilverMoon/SuperCC (testData/tws). Each
// contains ~149 recorded playthroughs spanning every move-stream encoding
// (formats #1-#4) and, between them, tens of thousands of moves. This test
// parses each container and runs every per-level record through
// decodeSolution, checking structural invariants against the metadata stored
// alongside each move stream.
//
// The replay counterpart (test/supercc/*.test.ts) then proves the decoded moves
// actually reproduce each recorded win.

import { describe, expect, it } from "vitest";
import { decodeSolution } from "../src/solution";
import { SUPERCC_SETS, readSuperCcFixture } from "./helpers/superccFixtures";
import { parseTwsFile } from "./helpers/twsFile";

// solution.c:122-140 — 3-bit direction index -> 4-bit direction bitmask.
const IDX_TO_DIR = [1, 2, 4, 8, 3, 6, 9, 12] as const;

// Validates one decoded record, throwing a descriptive error on the first
// violated invariant. Kept as a plain function (rather than a per-move
// `expect`) so the ~150k moves across all ten sets validate quickly.
function validateRecord(record: ReturnType<typeof parseTwsFile>["records"][number]): void {
  const where = `level ${record.levelNumber}`;
  const sol = decodeSolution(record.recordBytes);

  // Per-level header fields must round-trip from the raw bytes.
  if (sol.flags !== record.flags) throw new Error(`${where}: flags ${sol.flags} != ${record.flags}`);
  if (sol.stepping !== ((record.slideStep >> 3) & 0x07)) {
    throw new Error(`${where}: stepping ${sol.stepping} != ${(record.slideStep >> 3) & 0x07}`);
  }
  if (sol.rndslidedir !== IDX_TO_DIR[record.slideStep & 0x07]) {
    throw new Error(`${where}: rndslidedir ${sol.rndslidedir} != ${IDX_TO_DIR[record.slideStep & 0x07]}`);
  }
  if (sol.rndseed !== record.rndseed) throw new Error(`${where}: rndseed ${sol.rndseed} != ${record.rndseed}`);

  // A recorded solution always contains at least one move.
  if (sol.moves.length === 0) throw new Error(`${where}: decoded no moves`);

  let previousWhen = -Infinity;
  for (const move of sol.moves) {
    // Ticks advance strictly, never repeat or go backwards (decodeSolution
    // always adds a positive delta, so equal `when`s would be a bug).
    if (move.when <= previousWhen) {
      throw new Error(`${where}: when ${move.when} not after ${previousWhen}`);
    }
    previousWhen = move.when;
    // Format #4 stores a raw 9-bit direction (also used for MS mouse moves),
    // so the value can exceed the usual 4-bit bitmask; every format fits in
    // 9 bits.
    if (move.dir < 0 || move.dir > 0x1ff) throw new Error(`${where}: dir ${move.dir} out of range`);
  }

  // The first move happens at or after tick 0.
  if (sol.moves[0]!.when < 0) throw new Error(`${where}: first move at ${sol.moves[0]!.when}`);
  // The final move lands at (or within one tick of) the recorded best time —
  // the stored time is the total tick count of the playthrough.
  if (previousWhen > record.bestTime + 1) {
    throw new Error(`${where}: last move ${previousWhen} past best time ${record.bestTime}`);
  }
}

describe.each(SUPERCC_SETS)("SuperCC .tws decoder: $tws", (set) => {
  const file = parseTwsFile(readSuperCcFixture(set.tws));

  it("parses the container header", () => {
    expect(file.ruleset).toBe(set.ruleset);
    expect(file.setName).toBe(set.setName);
    expect(file.records).toHaveLength(set.solutionCount);
  });

  it("stores one solution per level, in ascending level order", () => {
    const numbers = file.records.map((r) => r.levelNumber);
    // Ascending, unique, and within the set. (Not necessarily contiguous:
    // CHIPS-Lynx has no record for the unplayable level 145.)
    for (let i = 0; i < numbers.length; i++) {
      expect(numbers[i]!).toBeGreaterThanOrEqual(1);
      expect(numbers[i]!).toBeLessThanOrEqual(set.levelCount);
      if (i > 0) expect(numbers[i]!).toBeGreaterThan(numbers[i - 1]!);
    }
  });

  it("decodes every record into a monotonic, in-range move list", () => {
    for (const record of file.records) validateRecord(record);
  });
});
