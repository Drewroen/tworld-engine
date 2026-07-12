// Integration test: proves decodeSolution's SolutionInfo output and
// Game.prepareReplay interoperate correctly end-to-end.
//
// Note on reference behavior: play.c's doturn (play.c:292-333, faithfully
// ported in src/game.ts) treats replay-mode input as "sticky" — once a
// move's `when` arrives, state.currentinput is set to that move's `dir` and
// then left untouched (not reset to NIL) until the next scheduled move,
// exactly like a real held key. Fresh/interactive play (state.replay < 0),
// by contrast, is driven by whatever `cmd` doTurn is called with that tick,
// which the existing oracle fixtures (test/fixtures/*.fixture, used by
// test/helpers/run.ts) supply as one-tick-only "nudges". These two input
// models are both faithful to the original C source, but they are not
// interchangeable: reusing an existing momentary-nudge oracle fixture's
// digest as the "expected" output of a sticky-hold replay would compare
// apples to oranges (confirmed by running both side-by-side: they agree
// while the held direction from the prior move is still in progress, and
// diverge once a move that would only be a one-tick nudge under
// fresh-play semantics instead persists into a later tick under replay
// semantics). So this test instead builds its own sticky-consistent
// reference run — driving the same Game/level directly via doTurn(dir),
// holding each decoded move's direction from its `when` tick until the next
// one exactly as prepareReplay's internal replay mechanism does — and
// checks that decodeSolution + prepareReplay reproduces it tick-for-tick.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NIL, Ruleset } from "../src/constants";
import { splitDatFile } from "../src/datfile";
import { Game } from "../src/game";
import { decodeSolution } from "../src/solution";
import { dumpDigest, type TickDigest } from "./helpers/digest";
import type { Action } from "../src/types";

const datUrl = new URL("../../tworld/data/intro.dat", import.meta.url);
const TICKS = 10;

// Drives `game` for TICKS ticks, holding each move's direction sticky from
// its `when` tick onward (matching doTurn's own replay-mode semantics),
// without going through prepareReplay/state.moves at all.
function runSticky(game: Game, moves: Action[]): TickDigest[] {
  const digests: TickDigest[] = [];
  let dir = NIL;
  for (let tick = 0; tick < TICKS; tick++) {
    const when = game.state.currenttime + 1;
    const move = moves.find((m) => m.when === when);
    if (move) dir = move.dir;
    const result = game.doTurn(dir);
    digests.push(dumpDigest(game, result));
    if (result !== 0) break;
  }
  return digests;
}

// Builds a 20-byte header + move-stream bytes reproducing
// lynx-intro-1.fixture's script: rndseed=1, moves 3:EAST(8) 6:NORTH(1).
//
// Move 1 (first move, not decremented): format #1 1-byte.
// N=01, D=3 (EAST, idx3), T=3 -> byte = 1 | (3<<2) | (3<<5) = 0x6D.
// when = -1 + 3 + 1 = 3, dir = EAST = 8.
//
// Move 2: format #1 1-byte. N=01, D=0 (NORTH, idx0), T=2 (stored delta for
// an actual 3-tick gap) -> byte = 1 | (0<<2) | (2<<5) = 0x41.
// when = 3 + 2 + 1 = 6, dir = NORTH = 1.
function buildSolutionBytes(): Uint8Array {
  const bytes = new Uint8Array(20 + 2);
  // byte11: rndslidedir index 0, stepping 0 (inert for Lynx replay — see
  // test/helpers/run.ts's comment on why these two fields don't affect the
  // Lynx ruleset's simulated behavior regardless of value).
  bytes[11] = 0;
  const rndseed = 1;
  bytes[12] = rndseed & 0xff;
  bytes[13] = (rndseed >> 8) & 0xff;
  bytes[14] = (rndseed >> 16) & 0xff;
  bytes[15] = (rndseed >> 24) & 0xff;
  bytes.set([0x6d, 0x41], 20);
  return bytes;
}

describe("decodeSolution + Game.prepareReplay integration", () => {
  it("replays a decoded solution and matches a sticky-driven reference run tick-for-tick", () => {
    const sol = decodeSolution(buildSolutionBytes());

    expect(sol.moves).toEqual([
      { when: 3, dir: 8 },
      { when: 6, dir: 1 },
    ]);
    expect(sol.rndseed).toBe(1);

    const dat = new Uint8Array(readFileSync(datUrl));
    const { levels } = splitDatFile(dat);
    const level = levels[0]!;

    // Reference: drive the engine directly, holding each decoded move's
    // direction sticky (no prepareReplay/decodeSolution involved).
    const reference = new Game(level, Ruleset.Lynx, sol.rndseed);
    const referenceDigests = runSticky(reference, sol.moves);

    // Subject: decode -> prepareReplay -> doTurn, using the engine's own
    // internal replay mechanism.
    const subject = new Game(level, Ruleset.Lynx);
    subject.prepareReplay(sol);
    const subjectDigests: TickDigest[] = [];
    for (let tick = 0; tick < TICKS; tick++) {
      const result = subject.doTurn(NIL);
      subjectDigests.push(dumpDigest(subject, result));
      if (result !== 0) break;
    }

    expect(subjectDigests.length).toBe(referenceDigests.length);
    for (let i = 0; i < referenceDigests.length; i++) {
      expect(subjectDigests[i], `tick ${i}`).toEqual(referenceDigests[i]);
    }

    // A concrete, non-tautological sanity check on the outcome itself:
    // Chip should have completed the decoded EAST move by tick 6 and be
    // mid-way through a subsequent NORTH move by the final tick.
    const last = subjectDigests[subjectDigests.length - 1]!;
    expect(last.t).toBe(TICKS - 1);
    expect(last.creatures[0]![2]).toBe(1); // dir: NORTH
  });
});
