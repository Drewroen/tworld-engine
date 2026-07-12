// Mirrors the per-tick JSON digest schema emitted by tools/oracle/harness.c's
// printDigest() (see the schema comment atop that file), so TS-engine and
// C-oracle digests can be deep-equal-compared directly.
//
// Field-by-field mapping (see harness.c:138-173):
//   t            -> state.currenttime (post-increment; Game.doTurn already
//                    increments before running the tick's logic)
//   result       -> the tick's advanceGame()/doTurn() return value, passed
//                    in by the caller (not read off Game itself)
//   chipsNeeded  -> state.chipsneeded
//   keys/boots   -> state.keys[0..3] / state.boots[0..3]
//   xview/yview  -> state.xviewpos / state.yviewpos
//   statusflags  -> state.statusflags
//   soundeffects -> state.soundeffects
//   mainprng     -> state.mainprng.value
//   lxprng1/2    -> state.lxstate.prng1 / state.lxstate.prng2
//   creatures    -> [pos,id,dir,moving,frame,hidden,state] per active
//                    creature, in list order; `hidden` is emitted as 0/1
//                    (an int, matching the C struct field's type), not a
//                    JSON boolean, exactly as `(int)cr->hidden` is printed
//                    by harness.c's printf.

import type { Game } from "../../src/game";

export interface TickDigest {
  t: number;
  result: number;
  chipsNeeded: number;
  keys: number[];
  boots: number[];
  xview: number;
  yview: number;
  statusflags: number;
  soundeffects: number;
  mainprng: number;
  lxprng1: number;
  lxprng2: number;
  creatures: number[][];
}

export function dumpDigest(game: Game, result: number): TickDigest {
  const state = game.state;
  const creatures = game
    .getCreatures()
    .map((cr) => [cr.pos, cr.id, cr.dir, cr.moving, cr.frame, cr.hidden ? 1 : 0, cr.state]);

  return {
    t: state.currenttime,
    result,
    chipsNeeded: state.chipsneeded,
    keys: [...state.keys],
    boots: [...state.boots],
    xview: state.xviewpos,
    yview: state.yviewpos,
    statusflags: state.statusflags,
    soundeffects: state.soundeffects,
    mainprng: state.mainprng.value,
    lxprng1: state.lxstate.prng1,
    lxprng2: state.lxstate.prng2,
    creatures,
  };
}
