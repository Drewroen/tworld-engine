// GameState struct, ported from the original Tile World (Chip's Challenge) C
// source. Source: state.h:146-286.

import { CXGRID, CYGRID, Ruleset } from "./constants";
import { Prng } from "./prng";
import type { Action, Creature, GameSetup, MapCell, XYConn } from "./types";

// state.h:270-275
export const SF_NOSAVING = 0x0001;
export const SF_INVALID = 0x0002;
export const SF_BADTILES = 0x0004;
export const SF_SHOWHINT = 0x0008;
export const SF_NOANIMATION = 0x0010;
export const SF_SHUTTERED = 0x0020;

function makeMapCell(): MapCell {
  return { top: { id: 0, state: 0 }, bot: { id: 0, state: 0 } };
}

function makeXYConn(): XYConn {
  return { from: 0, to: 0 };
}

// state.h:187-192 — struct msstate_
class MSState {
  chipwait = 0;
  chipstatus = 0;
  controllerdir = 0;
  lastslipdir = 0;
  completed = 0;
  goalpos = 0;
  xviewoffset = 0;
  yviewoffset = 0;
}

// state.h:194-206 — struct lxstate_
class LXState {
  // Pointer-like fields: -1/null mean "none", matching the C init pattern.
  chiptocr: Creature | null = null;
  crend: Creature | null = null;
  chiptopos = -1;
  putwall = -1;
  prng1 = 0;
  prng2 = 0;
  xviewoffset = 0;
  yviewoffset = 0;
  endgametimer = 0;
  togglestate = 0;
  completed = 0;
  stuck = 0;
  pushing = 0;
  couldntmove = 0;
  mapbreached = 0;
}

// state.h:232-266 — typedef struct gamestate gamestate
export class GameState {
  game: GameSetup | null = null;
  ruleset: Ruleset = Ruleset.None;
  replay = 0;
  timelimit = 0;
  currenttime = 0;
  timeoffset = 0;
  currentinput = 0;
  chipsneeded = 0;
  xviewpos = 0;
  yviewpos = 0;
  keys: number[] = [0, 0, 0, 0];
  boots: number[] = [0, 0, 0, 0];
  statusflags = 0;
  lastmove = 0;
  initrndslidedir = 0;
  stepping = 0;
  soundeffects = 0;
  moves: Action[] = [];
  // Placeholder seed; the real driver always calls .restart(realSeed) before
  // gameplay begins, so this value never affects actual play.
  mainprng: Prng = new Prng(0);
  creatures: Creature[] = [];
  trapcount = 0;
  clonercount = 0;
  crlistcount = 0;
  traps: XYConn[] = Array.from({ length: 256 }, makeXYConn);
  cloners: XYConn[] = Array.from({ length: 256 }, makeXYConn);
  crlist: number[] = new Array(256).fill(0);
  hinttext = "";
  map: MapCell[] = Array.from({ length: CXGRID * CYGRID }, makeMapCell);

  msstate = new MSState();
  lxstate = new LXState();

  cellAt(pos: number): MapCell {
    const cell = this.map[pos];
    if (!cell) throw new RangeError(`cellAt: position ${pos} out of range`);
    return cell;
  }
}
