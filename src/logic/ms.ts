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

import {
  back,
  CXGRID,
  CYGRID,
  EAST,
  NIL,
  NORTH,
  Ruleset,
  SOUTH,
  WEST,
  crtile,
  creatureid,
  creaturedirid,
  iskey,
  isboots,
  isice,
  isslide,
  iscreature,
  right,
  Tile,
} from "../constants";
import { GameState } from "../state";
import type { Creature, MapTile } from "../types";
import type { RulesetLogic } from "./ruleset";

/* Floor state flags. MS-specific — do not confuse with Lynx's own FS_*
 * constants, which use the same names for entirely different bit meanings.
 * (mslogic.c:385-389)
 */
const FS_BUTTONDOWN = 0x01; /* button press is deferred */
const FS_CLONING = 0x02; /* clone machine is activated */
const FS_BROKEN = 0x04; /* teleport/toggle wall doesn't work */
const FS_HASMUTANT = 0x08; /* beartrap contains mutant block */
const FS_MARKER = 0x10; /* marker used during initialization */

/* Creature state flags. MS-specific — do not confuse with Lynx's own CS_*
 * constants, which use the same names for entirely different bit meanings.
 * (mslogic.c:550-557)
 */
const CS_RELEASED = 0x01; /* can leave a beartrap */
const CS_CLONING = 0x02; /* cannot move this tick */
const CS_HASMOVED = 0x04; /* already used current move */
const CS_TURNING = 0x08; /* is turning around */
const CS_SLIP = 0x10; /* is on the slip list */
const CS_SLIDE = 0x20; /* is on the slip list but can move */
const CS_DEFERPUSH = 0x40; /* button pushes will be delayed */
const CS_MUTANT = 0x80; /* block is mutant, looks like Chip */

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

/*
 * The laws of movement across the various floors. (mslogic.c:770-922)
 *
 * Chip, blocks, and other creatures all have slightly different rules
 * about what sort of tiles they are permitted to move into. The
 * following lookup table encapsulates these rules. Note that these
 * rules are only the first check; a creature may be occasionally
 * permitted a particular type of move but still prevented in a specific
 * situation.
 *
 * Note this table's SHAPE is meaningfully different from Lynx's own
 * movelaws table (see lynx.ts): MS's table has no separate IN/OUT bit
 * positions, just a single directional bitmask per field, used for both
 * entering and leaving a tile in all cases.
 */
const NWSE = NORTH | WEST | SOUTH | EAST;

interface MoveLaw {
  chip: number;
  block: number;
  creature: number;
}

/* Indexed by floor tile ID (0x00-0x3F). Transcribed directly from
 * mslogic.c:786-922, entry by entry, in the same order; comments name
 * the tile at that index (matching the `Tile` enum in ../constants), but
 * it is the array *position* that mslogic.c relies on, not the comment.
 */
const movelaws: readonly MoveLaw[] = [
  { chip: 0, block: 0, creature: 0 }, // Nothing
  { chip: NWSE, block: NWSE, creature: NWSE }, // Empty
  { chip: NWSE, block: NWSE, creature: NWSE }, // Slide_North
  { chip: NWSE, block: NWSE, creature: NWSE }, // Slide_West
  { chip: NWSE, block: NWSE, creature: NWSE }, // Slide_South
  { chip: NWSE, block: NWSE, creature: NWSE }, // Slide_East
  { chip: NWSE, block: NWSE, creature: 0 }, // Slide_Random
  { chip: NWSE, block: NWSE, creature: NWSE }, // Ice
  { chip: SOUTH | EAST, block: SOUTH | EAST, creature: SOUTH | EAST }, // IceWall_Northwest
  { chip: SOUTH | WEST, block: SOUTH | WEST, creature: SOUTH | WEST }, // IceWall_Northeast
  { chip: NORTH | EAST, block: NORTH | EAST, creature: NORTH | EAST }, // IceWall_Southwest
  { chip: NORTH | WEST, block: NORTH | WEST, creature: NORTH | WEST }, // IceWall_Southeast
  { chip: NWSE, block: NWSE, creature: 0 }, // Gravel
  { chip: NWSE, block: 0, creature: 0 }, // Dirt
  { chip: NWSE, block: NWSE, creature: NWSE }, // Water
  { chip: NWSE, block: NWSE, creature: NWSE }, // Fire
  { chip: NWSE, block: NWSE, creature: NWSE }, // Bomb
  { chip: NWSE, block: NWSE, creature: NWSE }, // Beartrap
  { chip: NWSE, block: 0, creature: 0 }, // Burglar
  { chip: NWSE, block: NWSE, creature: NWSE }, // HintButton
  { chip: NWSE, block: NWSE, creature: NWSE }, // Button_Blue
  { chip: NWSE, block: NWSE, creature: NWSE }, // Button_Green
  { chip: NWSE, block: NWSE, creature: NWSE }, // Button_Red
  { chip: NWSE, block: NWSE, creature: NWSE }, // Button_Brown
  { chip: NWSE, block: NWSE, creature: NWSE }, // Teleport
  { chip: 0, block: 0, creature: 0 }, // Wall
  {
    chip: NORTH | WEST | EAST,
    block: NORTH | WEST | EAST,
    creature: NORTH | WEST | EAST,
  }, // Wall_North
  {
    chip: NORTH | WEST | SOUTH,
    block: NORTH | WEST | SOUTH,
    creature: NORTH | WEST | SOUTH,
  }, // Wall_West
  {
    chip: WEST | SOUTH | EAST,
    block: WEST | SOUTH | EAST,
    creature: WEST | SOUTH | EAST,
  }, // Wall_South
  {
    chip: NORTH | SOUTH | EAST,
    block: NORTH | SOUTH | EAST,
    creature: NORTH | SOUTH | EAST,
  }, // Wall_East
  { chip: SOUTH | EAST, block: SOUTH | EAST, creature: SOUTH | EAST }, // Wall_Southeast
  { chip: 0, block: 0, creature: 0 }, // HiddenWall_Perm
  { chip: NWSE, block: 0, creature: 0 }, // HiddenWall_Temp
  { chip: NWSE, block: 0, creature: 0 }, // BlueWall_Real
  { chip: NWSE, block: 0, creature: 0 }, // BlueWall_Fake
  { chip: NWSE, block: NWSE, creature: NWSE }, // SwitchWall_Open
  { chip: 0, block: 0, creature: 0 }, // SwitchWall_Closed
  { chip: NWSE, block: 0, creature: 0 }, // PopupWall
  { chip: 0, block: 0, creature: 0 }, // CloneMachine
  { chip: NWSE, block: 0, creature: 0 }, // Door_Red
  { chip: NWSE, block: 0, creature: 0 }, // Door_Blue
  { chip: NWSE, block: 0, creature: 0 }, // Door_Yellow
  { chip: NWSE, block: 0, creature: 0 }, // Door_Green
  { chip: NWSE, block: 0, creature: 0 }, // Socket
  { chip: NWSE, block: NWSE, creature: 0 }, // Exit
  { chip: NWSE, block: 0, creature: 0 }, // ICChip
  { chip: NWSE, block: NWSE, creature: NWSE }, // Key_Red
  { chip: NWSE, block: NWSE, creature: NWSE }, // Key_Blue
  { chip: NWSE, block: NWSE, creature: NWSE }, // Key_Yellow
  { chip: NWSE, block: NWSE, creature: NWSE }, // Key_Green
  { chip: NWSE, block: NWSE, creature: 0 }, // Boots_Ice
  { chip: NWSE, block: NWSE, creature: 0 }, // Boots_Slide
  { chip: NWSE, block: NWSE, creature: 0 }, // Boots_Fire
  { chip: NWSE, block: NWSE, creature: 0 }, // Boots_Water
  { chip: NWSE, block: 0, creature: 0 }, // Block_Static
  { chip: 0, block: 0, creature: 0 }, // Drowned_Chip
  { chip: 0, block: 0, creature: 0 }, // Burned_Chip
  { chip: 0, block: 0, creature: 0 }, // Bombed_Chip
  { chip: 0, block: 0, creature: 0 }, // Exited_Chip
  { chip: 0, block: 0, creature: 0 }, // Exit_Extra_1
  { chip: 0, block: 0, creature: 0 }, // Exit_Extra_2
  { chip: 0, block: 0, creature: 0 }, // Overlay_Buffer
  { chip: 0, block: 0, creature: 0 }, // Floor_Reserved2
  { chip: 0, block: 0, creature: 0 }, // Floor_Reserved1
];

/* Flags for canmakemove(). MS-specific — do not confuse with Lynx's own
 * CMM_* constants, which use the same names for entirely different flag
 * meanings. Including CMM_NOLEAVECHECK in a call to canmakemove()
 * indicates that the tile the creature is moving out of is automatically
 * presumed to permit such movement. CMM_NOEXPOSEWALLS causes blue and
 * hidden walls to remain unexposed. CMM_CLONECANTBLOCK means that the
 * creature will not be prevented from moving by an identical creature
 * standing in the way. CMM_NOPUSHING prevents Chip from pushing blocks
 * inside this function. CMM_TELEPORTPUSH indicates to the block-pushing
 * logic that Chip is teleporting. This prevents a stack of two blocks
 * from being treated as a single block, and allows Chip to push a
 * slipping block away from him. CMM_NOFIRECHECK causes bugs and walkers
 * to not avoid fire. Finally, CMM_NODEFERBUTTONS causes buttons pressed
 * by pushed blocks to take effect immediately. (mslogic.c:924-944)
 */
const CMM_NOLEAVECHECK = 0x0001;
const CMM_NOEXPOSEWALLS = 0x0002;
const CMM_CLONECANTBLOCK = 0x0004;
const CMM_NOPUSHING = 0x0008;
const CMM_TELEPORTPUSH = 0x0010;
const CMM_NOFIRECHECK = 0x0020;
const CMM_NODEFERBUTTONS = 0x0040;

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
   * Simple floor functions. (mslogic.c:379-542)
   */

  /* Translate a slide floor into the direction it points in. In the case
   * of a random slide floor, a new direction is selected. Note: this uses
   * the MAIN prng's random4() directly, unlike Lynx's random-slide
   * handling (lastRndSlideDir + right() rotation). (mslogic.c:394-408)
   */
  private getSlideDir(floor: number): number {
    switch (floor) {
      case Tile.Slide_North:
        return NORTH;
      case Tile.Slide_West:
        return WEST;
      case Tile.Slide_South:
        return SOUTH;
      case Tile.Slide_East:
        return EAST;
      case Tile.Slide_Random:
        return 1 << this.state.mainprng.random4();
      default:
        return NIL;
    }
  }

  /* Alter a creature's direction if they are at an ice wall. Pure
   * function — unlike Lynx's applyIceWallTurn, this does not mutate
   * anything; the caller is responsible for applying the result.
   * (mslogic.c:412-424)
   */
  private icewallturn(floor: number, dir: number): number {
    switch (floor) {
      case Tile.IceWall_Northeast:
        return dir === SOUTH ? EAST : dir === WEST ? NORTH : dir;
      case Tile.IceWall_Southwest:
        return dir === NORTH ? WEST : dir === EAST ? SOUTH : dir;
      case Tile.IceWall_Northwest:
        return dir === SOUTH ? WEST : dir === EAST ? NORTH : dir;
      case Tile.IceWall_Southeast:
        return dir === NORTH ? EAST : dir === WEST ? SOUTH : dir;
      default:
        return dir;
    }
  }

  /* Find the location of a bear trap from one of its buttons.
   * (mslogic.c:428-437)
   */
  private trapFromButton(pos: number): number {
    for (let i = 0; i < this.state.trapcount; ++i) {
      const trap = this.state.traps[i];
      if (trap && trap.from === pos) return trap.to;
    }
    return -1;
  }

  /* Find the location of a clone machine from one of its buttons.
   * (mslogic.c:441-450)
   */
  private clonerFromButton(pos: number): number {
    for (let i = 0; i < this.state.clonercount; ++i) {
      const cloner = this.state.cloners[i];
      if (cloner && cloner.from === pos) return cloner.to;
    }
    return -1;
  }

  /* Return the floor tile found at the given location. (mslogic.c:454-465) */
  private floorAt(pos: number): number {
    const cell = this.state.cellAt(pos);
    if (
      !iskey(cell.top.id) &&
      !isboots(cell.top.id) &&
      !iscreature(cell.top.id)
    )
      return cell.top.id;
    if (
      !iskey(cell.bot.id) &&
      !isboots(cell.bot.id) &&
      !iscreature(cell.bot.id)
    )
      return cell.bot.id;
    return Tile.Empty;
  }

  /* Return a reference to the tile that forms the floor at the given
   * location, so the caller can mutate it in place (mirroring the C
   * maptile* pointer). Note the final fallback replicates the C source's
   * `/* ? *\/`-flagged quirk: it returns the bottom tile reference (not a
   * synthesized Empty tile), even though the equivalent branch in
   * floorAt() returns the Empty constant. (mslogic.c:470-481)
   */
  private getFloorAt(pos: number): MapTile {
    const cell = this.state.cellAt(pos);
    if (
      !iskey(cell.top.id) &&
      !isboots(cell.top.id) &&
      !iscreature(cell.top.id)
    )
      return cell.top;
    if (
      !iskey(cell.bot.id) &&
      !isboots(cell.bot.id) &&
      !iscreature(cell.bot.id)
    )
      return cell.bot;
    return cell.bot; /* ? */
  }

  /* Return TRUE if the brown button at the given location is currently
   * held down. (mslogic.c:486-488)
   */
  private isTrapButtonDown(pos: number): boolean {
    return (
      pos >= 0 &&
      pos < CXGRID * CYGRID &&
      this.state.cellAt(pos).top.id !== Tile.Button_Brown
    );
  }

  /* Place a new tile at the given location, causing the current upper
   * tile to become the lower tile. (mslogic.c:493-499)
   */
  private pushTile(pos: number, tile: MapTile): void {
    const cell = this.state.cellAt(pos);
    cell.bot = cell.top;
    cell.top = tile;
  }

  /* Remove the upper tile from the given location, causing the current
   * lower tile to become uppermost. Returns a snapshot copy of the tile
   * that was removed. (mslogic.c:504-514)
   */
  private popTile(pos: number): MapTile {
    const cell = this.state.cellAt(pos);
    const tile: MapTile = { id: cell.top.id, state: cell.top.state };
    cell.top = cell.bot;
    cell.bot = { id: Tile.Empty, state: 0 };
    return tile;
  }

  /* Return TRUE if a bear trap is currently passable. (mslogic.c:518-527) */
  private isTrapOpen(pos: number, skipPos: number): boolean {
    for (let i = 0; i < this.state.trapcount; ++i) {
      const trap = this.state.traps[i];
      if (
        trap &&
        trap.to === pos &&
        trap.from !== skipPos &&
        this.isTrapButtonDown(trap.from)
      )
        return true;
    }
    return false;
  }

  /* Flip-flop the state of any toggle walls. (mslogic.c:531-542) */
  private toggleWalls(): void {
    for (let pos = 0; pos < CXGRID * CYGRID; ++pos) {
      const cell = this.state.cellAt(pos);
      if (
        (cell.top.id === Tile.SwitchWall_Open ||
          cell.top.id === Tile.SwitchWall_Closed) &&
        !(cell.top.state & FS_BROKEN)
      )
        cell.top.id ^= Tile.SwitchWall_Open ^ Tile.SwitchWall_Closed;
      if (
        (cell.bot.id === Tile.SwitchWall_Open ||
          cell.bot.id === Tile.SwitchWall_Closed) &&
        !(cell.bot.state & FS_BROKEN)
      )
        cell.bot.id ^= Tile.SwitchWall_Open ^ Tile.SwitchWall_Closed;
    }
  }

  /*
   * Functions that manage the list of entities. (mslogic.c:544-710)
   */

  /* Return the creature located at pos. Ignores Chip unless includeChip
   * is true. Return null if no such creature is present. (mslogic.c:562-575)
   */
  private lookupCreature(pos: number, includeChip: boolean): Creature | null {
    for (const cr of this.state.creatures) {
      if (cr.hidden) continue;
      if (cr.pos === pos && (cr.id !== Tile.Chip || includeChip)) return cr;
    }
    return null;
  }

  /* Return the block located at pos. If the block in question is not
   * currently "active", it is automatically added to the block list.
   *
   * Judgment call: the C source's `_assert(!"lookupblock() called on
   * blockless location")` is a debug-only assertion that fires only when
   * called on a location with no block/Block_Static tile at all. Per the
   * no-op-assertion convention established for Lynx, this is transcribed
   * as a thrown Error instead (rather than a silent no-op) since silently
   * falling through would leave `cr.dir` at its allocateCreature() default
   * of NIL with no diagnostic, masking a genuine caller bug during
   * development. (mslogic.c:580-602)
   */
  private lookupBlock(pos: number): Creature {
    for (const block of this.blocks) {
      if (block.pos === pos && !block.hidden) return block;
    }

    const cr = this.allocateCreature();
    cr.id = Tile.Block;
    cr.pos = pos;
    const id = this.state.cellAt(pos).top.id;
    if (id === Tile.Block_Static) {
      cr.dir = NIL;
    } else if (creatureid(id) === Tile.Block) {
      cr.dir = creaturedirid(id);
    } else {
      throw new Error("lookupBlock() called on blockless location");
    }

    return this.addToBlockList(cr);
  }

  /* Update the given creature's tile on the map to reflect its current
   * state. (mslogic.c:607-641)
   */
  private updateCreature(cr: Creature): void {
    if (cr.hidden) return;
    const cell = this.state.cellAt(cr.pos);
    const tile = cell.top;
    let id = cr.id;
    if (id === Tile.Block) {
      tile.id = Tile.Block_Static;
      if (cr.state & CS_MUTANT) tile.id = crtile(Tile.Chip, NORTH);
      return;
    } else if (id === Tile.Chip) {
      if (this.state.msstate.chipstatus) {
        switch (this.state.msstate.chipstatus) {
          case ChipStatus.CHIP_BURNED:
            tile.id = Tile.Burned_Chip;
            return;
          case ChipStatus.CHIP_DROWNED:
            tile.id = Tile.Drowned_Chip;
            return;
        }
      } else if (cell.bot.id === Tile.Water) {
        id = Tile.Swimming_Chip;
      }
    }

    let dir = cr.dir;
    if (cr.state & CS_TURNING) dir = right(dir);

    tile.id = crtile(id, dir);
    tile.state = 0;
  }

  /* Add the given creature's tile to the map. (mslogic.c:645-652) */
  private addCreatureToMap(cr: Creature): void {
    if (cr.hidden) return;
    this.pushTile(cr.pos, { id: Tile.Empty, state: 0 });
    this.updateCreature(cr);
  }

  /* Enervate an inert creature. (mslogic.c:656-668) */
  private awakenCreature(pos: number): Creature | null {
    const tileId = this.state.cellAt(pos).top.id;
    if (!iscreature(tileId) || creatureid(tileId) === Tile.Chip) return null;
    const cr = this.allocateCreature();
    cr.id = creatureid(tileId);
    cr.dir = creaturedirid(tileId);
    cr.pos = pos;
    return cr.id === Tile.Block
      ? this.addToBlockList(cr)
      : this.addToCreatureList(cr);
  }

  /* Mark a creature as dead. (mslogic.c:672-679) */
  private removeCreature(cr: Creature): void {
    cr.state &= ~(CS_SLIP | CS_SLIDE);
    if (cr.id === Tile.Chip) {
      if (this.state.msstate.chipstatus === ChipStatus.CHIP_OKAY)
        this.state.msstate.chipstatus = ChipStatus.CHIP_NOTOKAY;
    } else {
      cr.hidden = true;
    }
  }

  /* Turn around any and all tanks. (A tank that is halfway through the
   * process of moving at the time is given special treatment.) The
   * "Tank Top Glitch" and "Spontaneous Generation" handling below are
   * real, historically-observed original-game quirks being deliberately
   * preserved, not bugs. (mslogic.c:684-710)
   */
  private turnTanks(inMidMove: Creature | null): void {
    for (const cr of this.state.creatures) {
      if (cr.hidden || cr.id !== Tile.Tank) continue;
      cr.dir = back(cr.dir);
      if (
        cr.state & CS_SLIP &&
        !(cr.state & CS_SLIDE) &&
        cr.frame !== 0 &&
        cr.moving === 0
      )
        cr.dir = back(cr.frame); /* Tank Top Glitch */
      if (!(cr.state & CS_TURNING)) cr.state |= CS_TURNING | CS_HASMOVED;
      if (cr === inMidMove) continue;
      if (creatureid(this.state.cellAt(cr.pos).top.id) === Tile.Tank) {
        this.updateCreature(cr);
      } else if (cr.moving !== 0) {
        /* handle Spontaneous Generation */
        if (cr.state & CS_TURNING) {
          /* always TRUE? */
          cr.state &= ~CS_TURNING;
          this.updateCreature(cr);
          cr.state |= CS_TURNING;
        }
        cr.dir = back(cr.dir); /* OK with SGG, bad for stacked tanks */
      }
    }
  }

  /*
   * Maintaining the slip list. (mslogic.c:712-768)
   */

  /* Add the given creature to the slip list if it is not already on it
   * (assuming that the given floor is a kind that causes slipping).
   *
   * Judgment call on the "Convergence Patch"/"tank reversal patch" chain
   * below: this is transcribed exactly as the C source's if/else-if chain,
   * including the two dead-give-away comments ("tank reversal patch",
   * "new with Convergence Patch") that document real historical bugfixes
   * to the original game, not simplifications available to this port.
   * icewallturn()/getSlideDir() are pure functions here (see their design
   * notes above), so their return values are used directly rather than
   * expecting them to mutate `cr` in place. (mslogic.c:719-751)
   */
  private startFloorMovement(cr: Creature, floor: number, fdir: number): void {
    let dir = fdir; /* fdir used with tank reversal when stuck on teleporter */

    cr.state &= ~(CS_SLIP | CS_SLIDE);

    if (isice(floor)) {
      if (fdir === NIL) {
        /* tank reversal patch */
        dir = this.icewallturn(floor, cr.dir);
      }
    } else if (isslide(floor)) {
      dir = this.getSlideDir(floor);
    } else if (floor === Tile.Teleport) {
      if (fdir === NIL) dir = cr.dir; /* tank reversal patch */
    } else if (floor === Tile.Beartrap && cr.id === Tile.Block) {
      dir = cr.dir;
    } else if (cr.id !== Tile.Chip) {
      /* new with Convergence Patch */
      return;
    } else {
      dir = cr.dir; /* new with Convergence Patch */
    }

    if (cr.id === Tile.Chip) {
      /* changed with Convergence Patch */
      /* cr->state |= isslide(floor) ? CS_SLIDE : CS_SLIP; */
      cr.state |= isice(floor) || (floor === Tile.Teleport && dir !== NIL) ? CS_SLIP : CS_SLIDE;
      this.prependToSlipList(cr, dir);
      cr.dir = dir;
      this.updateCreature(cr);
    } else {
      cr.state |= CS_SLIP;
      cr.frame = 0; /* safety with Tank Top Glitch */
      this.appendToSlipList(cr, dir);
    }
  }

  /* Remove the given creature from the slip list. (mslogic.c:755-758) */
  private endFloorMovement(cr: Creature): void {
    cr.state &= ~(CS_SLIP | CS_SLIDE);
    this.removeFromSlipList(cr);
  }

  /* Clean out deadwood entries in the slip list. Walks `this.slips`
   * backward because endFloorMovement()/removeFromSlipList() mutates the
   * array by removing entries; a forward walk would skip entries after a
   * removal shifts the remaining ones down. (mslogic.c:762-768)
   */
  private updateSlipList(): void {
    for (let n = this.slips.length - 1; n >= 0; --n) {
      const slip = this.slips[n];
      if (slip && !(slip.cr.state & (CS_SLIP | CS_SLIDE))) {
        this.endFloorMovement(slip.cr);
      }
    }
  }

  /* Move a block at the given position forward in the given direction.
   * Returns FALSE (0) if the block cannot be pushed. (mslogic.c:949-986)
   */
  private pushBlock(pos: number, dir: number, flags: number): number {
    const cr = this.lookupBlock(pos);
    if (!cr) {
      console.warn(
        `${this.state.currenttime}: attempt to push disembodied block!`,
      );
      return 0;
    }
    const slipping = cr.state & (CS_SLIP | CS_SLIDE); /* accounting */
    if (cr.state & (CS_SLIP | CS_SLIDE)) {
      const slipdir = this.getSlipDir(cr);
      if (dir === slipdir || dir === back(slipdir)) {
        if (!(flags & CMM_TELEPORTPUSH)) {
          return 0;
        }
      }
    }

    if (
      !(flags & CMM_TELEPORTPUSH) &&
      this.state.cellAt(pos).bot.id === Tile.Block_Static
    )
      this.state.cellAt(pos).bot.id = Tile.Empty;
    if (!(flags & CMM_NODEFERBUTTONS)) cr.state |= CS_DEFERPUSH;
    const r = this.advanceCreature(cr, dir);
    if (!(flags & CMM_NODEFERBUTTONS)) cr.state &= ~CS_DEFERPUSH;
    if (!r) {
      cr.state &= ~(CS_SLIP | CS_SLIDE);
      if (slipping) {
        /* new MSCC-like accounting */
        this.slipperCount--;
        this.removeFromSlipList(cr);
      }
    }
    return r;
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
