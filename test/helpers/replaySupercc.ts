// Shared driver for the SuperCC solution-replay tests.
//
// Each test/supercc/*.test.ts file replays one level set's worth of recorded
// solutions through the full engine. Splitting the sweep across one file per
// set lets Vitest run them in parallel worker threads (a single-file sweep of
// all ~1,489 solutions takes ~30s; split across the pool it finishes in a few).
//
// For every recorded playthrough the driver decodes the solution, loads it into
// a fresh Game via prepareReplay, and ticks the engine (input comes from the
// recorded moves) until the game ends. Every solution must end in a win.

import { describe, expect, it } from "vitest";
import { NIL } from "../../src/constants";
import { splitDatFile } from "../../src/datfile";
import { Game } from "../../src/game";
import { decodeSolution } from "../../src/solution";
import { SUPERCC_SETS, readSuperCcFixture, type SuperCcSet } from "./superccFixtures";
import { parseTwsFile } from "./twsFile";

// A winning replay finishes within a handful of ticks of the recorded best
// time (the final move + the exit animation). Allow generous slack so the test
// is about "does it win", not about exact tick counts, while still bounding the
// loop for a diverging replay.
const TICK_SLACK = 100;

function replaySet(set: SuperCcSet): void {
  const solutionFile = parseTwsFile(readSuperCcFixture(set.tws));
  const { levels, ruleset } = splitDatFile(readSuperCcFixture(set.dat));
  expect(ruleset).toBe(set.ruleset);
  expect(levels).toHaveLength(set.levelCount);

  for (const record of solutionFile.records) {
    const level = levels[record.levelNumber - 1];
    expect(level, `level ${record.levelNumber} present in ${set.dat}`).toBeDefined();
    expect(level!.passwd, `level ${record.levelNumber} password`).toBe(record.password);

    const sol = decodeSolution(record.recordBytes);
    const game = new Game(level!, solutionFile.ruleset);
    game.prepareReplay(sol);

    let result = 0;
    let ticks = 0;
    const cap = record.bestTime + TICK_SLACK;
    while (result === 0 && ticks < cap) {
      result = game.doTurn(NIL);
      ticks++;
    }

    expect(result, `level ${record.levelNumber} (best time ${record.bestTime}, ${ticks} ticks)`).toBe(1);
    expect(ticks, `level ${record.levelNumber} finished within the slack window`).toBeLessThanOrEqual(cap);
  }
}

// Registers the replay test for the given .tws file. Called from each thin
// test/supercc/*.test.ts file so Vitest can parallelize the per-set sweeps.
export function defineReplayTest(twsName: string): void {
  const set = SUPERCC_SETS.find((s) => s.tws === twsName);
  if (!set) throw new Error(`defineReplayTest: unknown fixture ${twsName}`);
  describe(`SuperCC solution replay: ${set.tws}`, () => {
    it(`replays all ${set.solutionCount} recorded solutions to a win`, () => replaySet(set));
  });
}
