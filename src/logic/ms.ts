// The game logic for the MS ruleset, ported from tworld/mslogic.c.
//
// This is layer 1 of an ordered, multi-dispatch port of a ~2452-line C file.
// This layer covers mslogic.c:1-378 — includes/enums, the CHIP_* status
// enum (including the two Squish-patch additions), the laststepping module
// static, the accessor macros, checkpossession()/possession(), and the
// THREE list/arena subsystems: the creature-pool arena, the active-creatures
// list, the active-blocks list, and the slip list. Later sub-steps add the
// movement-decision, movement-execution, and lifecycle layers on top of this
// skeleton, culminating in initGame()/advanceGame()/endGame().
//
// Design notes on statics-to-instance-field conversion (read this before
// extending the file in a later sub-step) — mirrors the documentation
// pattern established in lynx.ts:
//
// - `state` (mslogic.c:41, a module-global gamestate* rebound via the
//   `setstate(logic)` macro at the top of every C entry point) becomes the
//   `private state: GameState` field below, bound once at construction. No
//   setstate()-equivalent method is needed since the state never changes
//   after construction.
//
// - `laststepping` (mslogic.c:36) is a per-game-in-progress value in spirit
//   (it tracks the most recently used animation stepping phase across
//   ticks). To keep multiple simultaneous MsLogic instances from
//   cross-talking, it is an instance field here (`lastStepping`), not a
//   module global, even though the C original used a module static — the
//   same reasoning already established for Lynx's `lastRndSlideDir`/
//   `lastStepping` in lynx.ts.
//
// - The creature-pool arena (mslogic.c:157-256: `crpoollump`,
//   `currentcrpoollump`, `resetcreaturepool`, `freecreaturepool`,
//   `allocatecreature`) is a pure C memory-management detail (a linked list
//   of preallocated malloc'd chunks, recycled via `resetcreaturepool` at the
//   start of each game and freed via `freecreaturepool` at shutdown). JS
//   garbage-collects, so none of the arena/pool bookkeeping is ported. Only
//   `allocateCreature()` survives, as a plain factory function returning a
//   fresh object literal with the same default field values C's
//   `allocatecreature()` sets. This mirrors how the Lynx port skipped
//   `creaturearray`'s C-only calloc/free lifecycle (see lynx.ts's design
//   notes on `creaturearray`).
//
// - The active-creatures list (mslogic.c:183-187: `creatures[]`/
//   `creaturecount`/`creaturesallocated`, plus `resetcreaturelist`/
//   `addtocreaturelist`) maps directly onto `GameState.creatures` (see
//   src/state.ts), which is already a plain growable `Creature[]` in this
//   port — no separate field is declared for it here. `resetCreatureList()`
//   truncates it; `addToCreatureList()` pushes onto it; `getChip()` reads
//   index 0 (mirroring the `getchip()` macro, mslogic.c:50, which assumes
//   `creatures[0]` is always Chip).
//
// - The active-blocks list (mslogic.c:189-193: `blocks[]`/`blockcount`/
//   `blocksallocated`) and the slip list (mslogic.c:195-199: `slips[]`/
//   `slipcount`/`slipsallocated`) are genuinely separate, MS-specific
//   concepts with no Lynx equivalent — they are subsets/side-lists of
//   pointers into the creature arena, not the master list itself. They
//   become private INSTANCE fields (`blocks`, `slips`) for the same
//   re-entrancy reasoning as `lastStepping` above: multiple simultaneous
//   MsLogic instances must not cross-talk. The C arrays' manual
//   realloc-based dynamic growth (`blocksallocated`/`slipsallocated`) is not
//   ported; plain JS arrays grow on their own. The elements of `blocks` are
//   object references into the SAME `Creature` objects that live in
//   `this.state.creatures` (mirroring the C `creature*` pointers), not
//   copies.
//
// - `msccslippers` (mslogic.c:302, a lone module-static int incremented once
//   in `appendtosliplist` for "new accounting") is per-game bookkeeping, not
//   a genuine global, so it becomes an instance field (`slipperCount`).
//
// - `activeCreatures()` (the RulesetLogic optional method added during the
//   Lynx differential-testing work, Task 10): unlike Lynx's `crEndIndex`-
//   bounded slice of a fixed-size array with hidden/animation slots
//   interspersed, `this.state.creatures` here IS already exactly the flat
//   list of currently-active creatures (mirroring the C `creatures[]`
//   active-list array one-to-one, with no free/hidden slots mixed in — see
//   the active-creatures list note above). A trivial
//   `activeCreatures(): Creature[] { return [...this.state.creatures]; }`
//   would therefore already be complete given this layer's scope, but it is
//   deliberately NOT added in this dispatch: whichever later sub-step
//   finalizes the creature-list semantics (in particular, how removed/dead
//   creatures are excised from `this.state.creatures`, since mslogic.c's
//   `removecreature`/analogous bookkeeping hasn't been ported yet) is
//   better positioned to confirm this is still accurate and add it then.

import { NIL, Ruleset, Tile } from "../constants";
import { GameState } from "../state";
import type { Creature } from "../types";
import type { RulesetLogic } from "./ruleset";

/* A list of ways for Chip to lose. (mslogic.c:23-28)
 * Includes the two Squish-patch additions (CHIP_SQUISHED/
 * CHIP_SQUISHED_DEATH) relative to Lynx's ChipStatus enum.
 */
export enum ChipStatus {
  CHIP_OKAY = 0,
  CHIP_DROWNED,
  CHIP_BURNED,
  CHIP_BOMBED,
  CHIP_OUTOFTIME,
  CHIP_COLLIDED,
  CHIP_SQUISHED,
  CHIP_SQUISHED_DEATH,
  CHIP_NOTOKAY,
}

export class MsLogic implements RulesetLogic {
  readonly ruleset = Ruleset.MS;

  private state: GameState;

  /* The most recently used stepping phase value. (mslogic.c:36 — instance
   * field here; see design note above.)
   */
  private lastStepping = 0;

  /* The list of "active" blocks: a subset of this.state.creatures holding
   * only the Block-type creatures, for push-related bookkeeping.
   * (mslogic.c:189-193 — instance field here; see design note above.)
   */
  private blocks: Creature[] = [];

  /* The list of sliding creatures (creature + direction pairs), for
   * creatures currently sliding on ice/force floors.
   * (mslogic.c:195-199 — instance field here; see design note above.)
   */
  private slips: { cr: Creature; dir: number }[] = [];

  /* "New accounting" of sliding creatures. (mslogic.c:302 — instance field
   * here; see design note above.)
   */
  private slipperCount = 0;

  constructor(state: GameState) {
    this.state = state;
  }

  /*
   * Simple field accessors. (mslogic.c:48-93)
   *
   * Most single-field C accessor macros (chipsneeded()/clonerlist()/
   * traplist()/timelimit()/timeoffset()/stepping()/currenttime()/
   * currentinput()/xviewpos()/yviewpos()/lastmove()/completed()/
   * chipstatus()/chipwait()/controllerdir()/lastslipdir()/xviewoffset()/
   * yviewoffset()/goalpos()/hasgoal()/cancelgoal(), etc.) are not given
   * wrapper methods here — later sub-steps should read/write the
   * underlying fields directly, e.g. `this.state.chipsneeded`,
   * `this.state.msstate.completed`. Only accessors with real logic, or
   * that take a parameter, get methods below.
   */

  private getChip(): Creature {
    const chip = this.state.creatures[0];
    if (!chip) {
      throw new Error("getChip: creature list has no entry at index 0");
    }
    return chip;
  }

  private chipPos(): number {
    return this.getChip().pos;
  }

  private chipDir(): number {
    return this.getChip().dir;
  }

  /* possession(obj)/checkpossession(obj) — resolves a tile/object id to the
   * player's inventory slot for it (keys/boots), as an lvalue in C.
   * Ported as a get/set pair over the resolved slot, mirroring the pattern
   * used by lynx.ts's possessionSlot()/getPossession()/setPossession().
   * Transcribed entry-by-entry from the full switch statement.
   * (mslogic.c:95-151)
   */
  private checkPossession(obj: number): { arr: number[]; idx: number } {
    switch (obj) {
      case Tile.Key_Red:
        return { arr: this.state.keys, idx: 0 };
      case Tile.Key_Blue:
        return { arr: this.state.keys, idx: 1 };
      case Tile.Key_Yellow:
        return { arr: this.state.keys, idx: 2 };
      case Tile.Key_Green:
        return { arr: this.state.keys, idx: 3 };
      case Tile.Boots_Ice:
        return { arr: this.state.boots, idx: 0 };
      case Tile.Boots_Slide:
        return { arr: this.state.boots, idx: 1 };
      case Tile.Boots_Fire:
        return { arr: this.state.boots, idx: 2 };
      case Tile.Boots_Water:
        return { arr: this.state.boots, idx: 3 };
      case Tile.Door_Red:
        return { arr: this.state.keys, idx: 0 };
      case Tile.Door_Blue:
        return { arr: this.state.keys, idx: 1 };
      case Tile.Door_Yellow:
        return { arr: this.state.keys, idx: 2 };
      case Tile.Door_Green:
        return { arr: this.state.keys, idx: 3 };
      case Tile.Ice:
        return { arr: this.state.boots, idx: 0 };
      case Tile.IceWall_Northwest:
        return { arr: this.state.boots, idx: 0 };
      case Tile.IceWall_Northeast:
        return { arr: this.state.boots, idx: 0 };
      case Tile.IceWall_Southwest:
        return { arr: this.state.boots, idx: 0 };
      case Tile.IceWall_Southeast:
        return { arr: this.state.boots, idx: 0 };
      case Tile.Slide_North:
        return { arr: this.state.boots, idx: 1 };
      case Tile.Slide_West:
        return { arr: this.state.boots, idx: 1 };
      case Tile.Slide_South:
        return { arr: this.state.boots, idx: 1 };
      case Tile.Slide_East:
        return { arr: this.state.boots, idx: 1 };
      case Tile.Slide_Random:
        return { arr: this.state.boots, idx: 1 };
      case Tile.Fire:
        return { arr: this.state.boots, idx: 2 };
      case Tile.Water:
        return { arr: this.state.boots, idx: 3 };
      default:
        throw new Error(`possession() called with an invalid object ${obj}`);
    }
  }

  private getPossession(obj: number): number {
    const { arr, idx } = this.checkPossession(obj);
    return arr[idx] ?? 0;
  }

  private setPossession(obj: number, value: number): void {
    const { arr, idx } = this.checkPossession(obj);
    arr[idx] = value;
  }

  /*
   * Memory allocation functions for the various arenas. (mslogic.c:153-377)
   *
   * See the top-of-file design note: the creature-pool arena itself
   * (crpoollump/currentcrpoollump/resetcreaturepool/freecreaturepool) is a
   * pure C memory-management detail and is not ported. Only
   * allocateCreature() survives, as a plain factory function.
   */

  /* Return a fresh creature, default-initialized to match the field values
   * C's allocatecreature() sets on a freshly claimed arena slot.
   * (mslogic.c:224-256)
   */
  private allocateCreature(): Creature {
    return {
      id: Tile.Nothing,
      pos: -1,
      dir: NIL,
      tdir: NIL,
      state: 0,
      frame: 0,
      hidden: false,
      moving: 0,
    };
  }

  /* Empty the list of active creatures. (mslogic.c:260-262) */
  private resetCreatureList(): void {
    this.state.creatures.length = 0;
  }

  /* Append the given creature to the end of the creature list.
   * (mslogic.c:266-275)
   */
  private addToCreatureList(cr: Creature): Creature {
    this.state.creatures.push(cr);
    return cr;
  }

  /* Empty the list of "active" blocks. (mslogic.c:279-281) */
  private resetBlockList(): void {
    this.blocks.length = 0;
  }

  /* Append the given block to the end of the block list.
   * (mslogic.c:285-294)
   */
  private addToBlockList(cr: Creature): Creature {
    this.blocks.push(cr);
    return cr;
  }

  /* Empty the list of sliding creatures. (mslogic.c:298-300) */
  private resetSlipList(): void {
    this.slips.length = 0;
  }

  /* Append the given creature to the end of the slip list. If the
   * creature already has an entry, its direction is updated in place
   * instead of duplicating the entry. (mslogic.c:306-327)
   */
  private appendToSlipList(cr: Creature, dir: number): Creature {
    for (let n = 0; n < this.slips.length; ++n) {
      const slip = this.slips[n];
      if (slip && slip.cr === cr) {
        slip.dir = dir;
        return cr;
      }
    }
    this.slips.push({ cr, dir });
    this.slipperCount++; /* new accounting */
    return cr;
  }

  /* Add the given creature to the start of the slip list. If the
   * creature is already at the front of the list, its direction is
   * updated in place instead of duplicating the entry. (mslogic.c:331-351)
   */
  private prependToSlipList(cr: Creature, dir: number): Creature {
    const first = this.slips[0];
    if (first && first.cr === cr) {
      first.dir = dir;
      return cr;
    }
    this.slips.unshift({ cr, dir });
    return cr;
  }

  /* Return the sliding direction of a creature on the slip list.
   * (mslogic.c:355-362)
   */
  private getSlipDir(cr: Creature): number {
    for (let n = 0; n < this.slips.length; ++n) {
      const slip = this.slips[n];
      if (slip && slip.cr === cr) {
        return slip.dir;
      }
    }
    return NIL;
  }

  /* Remove the given creature from the slip list. (mslogic.c:366-377) */
  private removeFromSlipList(cr: Creature): void {
    const n = this.slips.findIndex((slip) => slip.cr === cr);
    if (n === -1) return;
    this.slips.splice(n, 1);
  }

  /*
   * Stubs for later sub-dispatches.
   */

  /* The central creature-movement function. Not yet implemented — a later
   * sub-dispatch fills this in. (mslogic.c forward-declared at line 32)
   */
  private advanceCreature(cr: Creature, dir: number): number {
    throw new Error("MsLogic.advanceCreature: not yet implemented");
  }

  initGame(): boolean {
    throw new Error("MsLogic.initGame: not yet implemented");
  }

  advanceGame(): number {
    throw new Error("MsLogic.advanceGame: not yet implemented");
  }

  endGame(): boolean {
    throw new Error("MsLogic.endGame: not yet implemented");
  }
}
