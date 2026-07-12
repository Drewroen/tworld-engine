// Portable driver/facade wrapping a RulesetLogic instance and its GameState.
// Ported from the relevant slices of play.c: initgamestate (play.c:113-137),
// prepareplayback (play.c:141-158), secondsplayed (play.c:162-164), and
// doturn (play.c:292-333).

import { NIL, Ruleset, SND_ONESHOT_COUNT, TICKS_PER_SECOND } from "./constants";
import { expandLevelData } from "./decoder";
import { LynxLogic } from "./logic/lynx";
import type { RulesetLogic } from "./logic/ruleset";
import { GameState } from "./state";
import type { Action, GameSetup } from "./types";

// play.c does not define a numeric CmdPreserve constant anywhere the TS port
// has ported so far (it's just an ordinary auto-incremented enum member in
// defs.h's Cmd* enum, with no special bit pattern). Any sentinel value that
// doesn't collide with real direction/mouse command values works. -1 is safe
// since all real commands are >= 0 (NIL=0, directions are small positive bit
// flags, mouse commands are computed from a 0-based range).
export const CmdPreserve = -1;

// Placeholder shape for a decoded solution, standing in for the real
// `SolutionInfo` interface that Task 13's .tws-format decoder will define.
// `prepareReplay` only needs these four fields; align this with the real
// type once Task 13 lands.
export interface ReplaySolution {
  moves: Action[];
  rndseed: number;
  rndslidedir: number;
  stepping: number;
}

// A reasonable, deterministic-but-arbitrary default seed for fresh
// (non-replay) games. The original C `resetprng()` seeds from the wall
// clock when no seed has ever been set, but this TS port's Prng class
// deliberately has no time-based fallback (determinism is a hard
// project-wide constraint, see prng.ts). Since exact original-session
// randomness only matters for replay verification (via prepareReplay,
// which always supplies an explicit recorded seed), fresh play just needs
// *some* fixed, reproducible seed. Callers who want a different one can
// pass it explicitly.
const DEFAULT_FRESH_SEED = 0;

export class Game {
  private readonly logic: RulesetLogic;
  private readonly gameState: GameState;

  constructor(game: GameSetup, ruleset: number, seed = DEFAULT_FRESH_SEED) {
    const state = new GameState();
    // A freshly constructed GameState already has a zeroed map (see
    // state.ts), so no explicit re-zeroing is needed here — unlike the C
    // original, which reuses one static `gamestate` across level loads.
    state.game = game;
    state.ruleset = ruleset;
    state.replay = -1;
    state.currenttime = -1;
    state.timeoffset = 0;
    state.currentinput = NIL;
    state.lastmove = NIL;
    state.initrndslidedir = NIL;
    state.stepping = -1;
    state.statusflags = 0;
    state.soundeffects = 0;
    state.timelimit = game.time * TICKS_PER_SECOND;
    state.moves = [];
    state.mainprng.restart(seed);

    if (!expandLevelData(state)) {
      throw new Error("Game: expandLevelData failed; invalid level data.");
    }

    if (ruleset === Ruleset.Lynx) {
      this.logic = new LynxLogic(state);
    } else if (ruleset === Ruleset.MS) {
      throw new Error("Game: MS ruleset not yet implemented (Task 11).");
    } else {
      throw new Error(`Game: unknown ruleset ${ruleset}.`);
    }

    this.gameState = state;
    if (!this.logic.initGame()) {
      throw new Error("Game: initGame failed; invalid level data.");
    }
  }

  // play.c:292-333 — doturn
  doTurn(cmd: number): number {
    const state = this.gameState;

    state.soundeffects &= ~((1 << SND_ONESHOT_COUNT) - 1);
    // The engine owns its own clock: no gettickcount() OS call, just a plain
    // tick increment.
    ++state.currenttime;

    if (state.replay < 0) {
      if (cmd !== CmdPreserve) state.currentinput = cmd;
    } else if (state.replay < state.moves.length) {
      const next = state.moves[state.replay]!;
      if (state.currenttime === next.when) {
        state.currentinput = next.dir;
        ++state.replay;
      }
    }

    const result = this.logic.advanceGame();

    if (state.replay < 0 && state.lastmove) {
      state.moves.push({ when: state.currenttime, dir: state.lastmove });
      state.lastmove = NIL;
    }

    return result;
  }

  // play.c:141-158 — prepareplayback
  prepareReplay(sol: ReplaySolution): void {
    const state = this.gameState;
    state.moves = sol.moves;
    state.mainprng.restart(sol.rndseed);
    state.initrndslidedir = sol.rndslidedir;
    state.stepping = sol.stepping;
    state.replay = 0;
  }

  // Exposes the mutable GameState for inspection. Callers should treat this
  // as read-only by convention; this getter does not structurally enforce
  // immutability.
  get state(): GameState {
    return this.gameState;
  }

  // play.c:162-164 — secondsplayed
  secondsPlayed(): number {
    return Math.floor((this.gameState.currenttime + this.gameState.timeoffset) / TICKS_PER_SECOND);
  }

  getSoundEffects(): number {
    return this.gameState.soundeffects;
  }
}
