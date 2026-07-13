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
  CmdAbsMouseMoveFirst,
  CmdAbsMouseMoveLast,
  CmdMouseMoveFirst,
  CmdMouseMoveLast,
  CmdMoveNop,
  CXGRID,
  CYGRID,
  diridx,
  EAST,
  isdoor,
  isfloor,
  left,
  MOUSERANGE,
  MOUSERANGEMIN,
  NIL,
  NORTH,
  Ruleset,
  SND_BOMB_EXPLODES,
  SND_BOOTS_STOLEN,
  SND_BUTTON_PUSHED,
  SND_CANT_MOVE,
  SND_CHIP_LOSES,
  SND_CHIP_WINS,
  SND_DOOR_OPENED,
  SND_IC_COLLECTED,
  SND_ITEM_COLLECTED,
  SND_SOCKET_OPENED,
  SND_TELEPORTING,
  SND_TIME_LOW,
  SND_TIME_OUT,
  SND_WATER_SPLASH,
  SOUTH,
  TICKS_PER_SECOND,
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
import { GameState, SF_BADTILES, SF_NOANIMATION, SF_SHOWHINT } from "../state";
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
   * How everyone selects their move. (mslogic.c:992-1443)
   */

  /* hasgoal()/cancelgoal() macros (mslogic.c:91-93): the goal position is
   * "unset" when negative.
   */
  private hasGoal(): boolean {
    return this.state.msstate.goalpos >= 0;
  }

  private cancelGoal(): void {
    this.state.msstate.goalpos = -1;
  }

  /* The central function determining whether a creature is permitted to
   * move in a given direction. See the design notes accompanying this
   * dispatch for a summary of the several documented historical quirks
   * preserved verbatim below (the reveal-and-deny HiddenWall_Temp/
   * BlueWall_Real pattern, the two "totally backwards" block-pushing
   * checks, and the turning-tank cloning patch). (mslogic.c:992-1107)
   */
  private canMakeMove(cr: Creature, dir: number, flags: number): boolean {
    let y = Math.floor(cr.pos / CXGRID);
    let x = cr.pos % CXGRID;
    y += dir === NORTH ? -1 : dir === SOUTH ? 1 : 0;
    x += dir === WEST ? -1 : dir === EAST ? 1 : 0;
    if (y < 0 || y >= CYGRID || x < 0 || x >= CXGRID) return false;
    const to = y * CXGRID + x;

    if (!(flags & CMM_NOLEAVECHECK)) {
      switch (this.state.cellAt(cr.pos).bot.id) {
        case Tile.Wall_North:
          if (dir === NORTH) return false;
          break;
        case Tile.Wall_West:
          if (dir === WEST) return false;
          break;
        case Tile.Wall_South:
          if (dir === SOUTH) return false;
          break;
        case Tile.Wall_East:
          if (dir === EAST) return false;
          break;
        case Tile.Wall_Southeast:
          if (dir & (SOUTH | EAST)) return false;
          break;
        case Tile.Beartrap:
          if (!(cr.state & CS_RELEASED)) return false;
          break;
      }
    }

    let floor: number;
    let id: number;

    if (cr.id === Tile.Chip) {
      floor = this.floorAt(to);
      if (!(movelaws[floor]!.chip & dir)) return false;
      if (floor === Tile.Socket && this.state.chipsneeded > 0) return false;
      if (isdoor(floor) && !this.getPossession(floor)) return false;
      if (iscreature(this.state.cellAt(to).top.id)) {
        id = creatureid(this.state.cellAt(to).top.id);
        if (id === Tile.Chip || id === Tile.Swimming_Chip || id === Tile.Block)
          return false;
      }
      if (floor === Tile.HiddenWall_Temp || floor === Tile.BlueWall_Real) {
        if (!(flags & CMM_NOEXPOSEWALLS)) this.getFloorAt(to).id = Tile.Wall;
        return false;
      }
      if (floor === Tile.Block_Static) {
        if (!this.pushBlock(to, dir, flags)) return false;
        else if (flags & CMM_NOPUSHING) return false;
        if (this.state.cellAt(to).bot.id === Tile.CloneMachine)
          return false; /* totally backwards: need to check this first */
        if (flags & CMM_TELEPORTPUSH && this.floorAt(to) === Tile.Block_Static)
          /* totally backwards: remove "&& cellat(to)->bot.id == Empty)" */
          return true;
        return this.canMakeMove(cr, dir, flags | CMM_NOPUSHING);
      }
    } else if (cr.id === Tile.Block) {
      floor = this.state.cellAt(to).top.id;
      if (iscreature(floor)) {
        id = creatureid(floor);
        return id === Tile.Chip || id === Tile.Swimming_Chip;
      }
      if (!(movelaws[floor]!.block & dir)) return false;
    } else {
      floor = this.state.cellAt(to).top.id;
      if (iscreature(floor)) {
        id = creatureid(floor);
        if (id === Tile.Chip || id === Tile.Swimming_Chip) {
          floor = this.state.cellAt(to).bot.id;
          if (iscreature(floor)) {
            id = creatureid(floor);
            return id === Tile.Chip || id === Tile.Swimming_Chip;
          }
        }
      }
      if (iscreature(floor)) {
        /* turning tank cloning patch */
        const F = this.lookupCreature(to, false);
        if (!(flags & CMM_CLONECANTBLOCK)) return false; /* not cloning */
        if (
          (F === null || !(F.state & CS_TURNING)) &&
          floor === crtile(cr.id, cr.dir)
        )
          return true;
        /* must check "floor", so same-dir non-creature tank will clone */
        if (F === null) return false;
        if (F.dir === cr.dir) return true;
        return false;
      }
      if (!(movelaws[floor]!.creature & dir)) return false;
      if (floor === Tile.Fire && (cr.id === Tile.Bug || cr.id === Tile.Walker))
        if (!(flags & CMM_NOFIRECHECK)) return false;
    }

    if (this.state.cellAt(to).bot.id === Tile.CloneMachine) return false;

    return true;
  }

  /* This function embodies the movement behavior of all the creatures.
   * Given a creature, this function enumerates its desired direction of
   * movement and selects the first one that is permitted. Note that
   * calling this function also updates the current controller direction.
   *
   * Judgment call on the dead `if (FALSE && ...)` sub-block below (the
   * "stalled tank" (0,0)-move-success hack): the C source's `FALSE &&`
   * short-circuits before ever evaluating the rest of the condition,
   * making the whole `if` body permanently unreachable — this is
   * documented, deliberately-inert code left in place by the original
   * author (see the "Actually, successful (0,0) moves don't kill Chip"
   * comment immediately after it, which explains why it was disabled).
   * It is transcribed here as a literal `if (false && ...)` block (rather
   * than omitted) so a reader diffing against mslogic.c line-for-line can
   * still find it in the same relative position; TypeScript's own
   * short-circuit evaluation makes it exactly as dead as the C version.
   * (mslogic.c:1119-1282)
   */
  private chooseCreatureMove(cr: Creature): void {
    const choices: number[] = [NIL, NIL, NIL, NIL];
    let dir: number;
    let pdir: number;
    let floor: number;
    let y: number;
    let x: number;
    let m: number;
    let n: number;

    cr.tdir = NIL;

    if (cr.hidden) return;
    if (cr.id === Tile.Block) return;
    if (this.state.currenttime & 2) return;
    if (cr.id === Tile.Teeth || cr.id === Tile.Blob) {
      if ((this.state.currenttime + this.state.stepping) & 4) return;
    }
    if (cr.state & CS_TURNING) {
      cr.state &= ~(CS_TURNING | CS_HASMOVED);
      this.updateCreature(cr);
    }
    if (cr.state & CS_HASMOVED) {
      /* should be a stalled tank */
      let sfloor = this.state.cellAt(cr.pos).top.id; /* stacked tank patch */
      const id = creatureid(sfloor);
      if (iscreature(sfloor) && (id === Tile.Chip || id === Tile.Swimming_Chip))
        sfloor = this.state.cellAt(cr.pos).bot.id;
      if (!iscreature(sfloor) && movelaws[sfloor]!.creature)
        cr.hidden = true; /* hack with (0,0) movement success */
      /* maybe should check if (0,0) move goes on sliplist, but that's UB */
      if (
        false &&
        cr.hidden &&
        (id === Tile.Chip || id === Tile.Swimming_Chip) &&
        sfloor !== Tile.Fire &&
        sfloor !== Tile.Water &&
        sfloor !== Tile.Bomb
      ) {
        this.state.msstate.chipstatus = ChipStatus.CHIP_COLLIDED;
        this.state.cellAt(cr.pos).bot.id = this.state.cellAt(cr.pos).top.id;
        this.state.cellAt(cr.pos).top.id = Tile.Tank + diridx(cr.dir);
      } /* Actually, successful (0,0) moves don't kill Chip */
    }
    if (cr.state & CS_HASMOVED) {
      this.state.msstate.controllerdir = NIL;
      return;
    }
    if (cr.state & (CS_SLIP | CS_SLIDE)) return;

    floor = this.floorAt(cr.pos);

    pdir = dir = cr.dir;

    if (floor === Tile.CloneMachine || floor === Tile.Beartrap) {
      switch (cr.id) {
        case Tile.Tank:
        case Tile.Ball:
        case Tile.Glider:
        case Tile.Fireball:
        case Tile.Walker:
          choices[0] = dir;
          break;
        case Tile.Blob:
          choices[0] = dir;
          choices[1] = left(dir);
          choices[2] = back(dir);
          choices[3] = right(dir);
          this.state.mainprng.randomP4(choices);
          break;
        case Tile.Bug:
        case Tile.Paramecium:
        case Tile.Teeth:
          choices[0] = this.state.msstate.controllerdir;
          cr.tdir = this.state.msstate.controllerdir;
          return;
        default:
          console.warn(
            `Non-creature ${cr.id.toString(16).toUpperCase()} trying to move`,
          );
          break;
      }
    } else {
      switch (cr.id) {
        case Tile.Tank:
          choices[0] = dir;
          break;
        case Tile.Ball:
          choices[0] = dir;
          choices[1] = back(dir);
          break;
        case Tile.Glider:
          choices[0] = dir;
          choices[1] = left(dir);
          choices[2] = right(dir);
          choices[3] = back(dir);
          break;
        case Tile.Fireball:
          choices[0] = dir;
          choices[1] = right(dir);
          choices[2] = left(dir);
          choices[3] = back(dir);
          break;
        case Tile.Walker: {
          choices[0] = dir;
          choices[1] = left(dir);
          choices[2] = back(dir);
          choices[3] = right(dir);
          const sub = [choices[1]!, choices[2]!, choices[3]!];
          this.state.mainprng.randomP3(sub);
          choices[1] = sub[0]!;
          choices[2] = sub[1]!;
          choices[3] = sub[2]!;
          break;
        }
        case Tile.Blob:
          choices[0] = dir;
          choices[1] = left(dir);
          choices[2] = back(dir);
          choices[3] = right(dir);
          this.state.mainprng.randomP4(choices);
          break;
        case Tile.Bug:
          choices[0] = left(dir);
          choices[1] = dir;
          choices[2] = right(dir);
          choices[3] = back(dir);
          break;
        case Tile.Paramecium:
          choices[0] = right(dir);
          choices[1] = dir;
          choices[2] = left(dir);
          choices[3] = back(dir);
          break;
        case Tile.Teeth: {
          y = Math.floor(this.chipPos() / CXGRID) - Math.floor(cr.pos / CXGRID);
          x = (this.chipPos() % CXGRID) - (cr.pos % CXGRID);
          n = y < 0 ? NORTH : y > 0 ? SOUTH : NIL;
          if (y < 0) y = -y;
          m = x < 0 ? WEST : x > 0 ? EAST : NIL;
          if (x < 0) x = -x;
          if (x > y) {
            choices[0] = m;
            choices[1] = n;
          } else {
            choices[0] = n;
            choices[1] = m;
          }
          pdir = choices[2] = choices[0]!;
          break;
        }
        default:
          console.warn(
            `Non-creature ${cr.id.toString(16).toUpperCase()} trying to move`,
          );
          break;
      }
    }

    for (n = 0; n < 4 && choices[n] !== NIL; ++n) {
      cr.tdir = choices[n]!;
      this.state.msstate.controllerdir = cr.tdir;
      if (this.canMakeMove(cr, choices[n]!, 0)) return;
    }

    if (cr.id === Tile.Tank) {
      if (
        cr.state & CS_RELEASED ||
        floor !== Tile.Beartrap /*&& floor != CloneMachine*/
      )
        /* (c) bug: tank clones should stall */
        cr.state |= CS_HASMOVED;
      cr.tdir = NIL; /* handle stacked tanks */
    }

    if (cr.id !== Tile.Tank)
      /* handle stacked tanks */
      cr.tdir = pdir;
  }

  /* Select a direction for Chip to move towards the goal position.
   * (mslogic.c:1286-1318)
   */
  private chipMoveToGoalPos(): number {
    if (!this.hasGoal()) return NIL;
    const cr = this.getChip();
    if (this.state.msstate.goalpos === cr.pos) {
      this.cancelGoal();
      return NIL;
    }

    let y =
      Math.floor(this.state.msstate.goalpos / CXGRID) -
      Math.floor(cr.pos / CXGRID);
    let x = (this.state.msstate.goalpos % CXGRID) - (cr.pos % CXGRID);
    let d1 = y < 0 ? NORTH : y > 0 ? SOUTH : NIL;
    if (y < 0) y = -y;
    let d2 = x < 0 ? WEST : x > 0 ? EAST : NIL;
    if (x < 0) x = -x;
    if (x > y) {
      const dir = d1;
      d1 = d2;
      d2 = dir;
    }

    let dir: number;
    if (d1 !== NIL && d2 !== NIL) dir = this.canMakeMove(cr, d1, 0) ? d1 : d2;
    else dir = d2 === NIL ? d1 : d2;

    return dir;
  }

  /* Translate a map position into a packed location relative to Chip.
   * (mslogic.c:1322-1330)
   */
  private makeMouseRelative(absPos: number): number {
    const x = (absPos % CXGRID) - (this.chipPos() % CXGRID);
    const y =
      Math.floor(absPos / CXGRID) - Math.floor(this.chipPos() / CXGRID);
    return (y - MOUSERANGEMIN) * MOUSERANGE + (x - MOUSERANGEMIN);
  }

  /* Unpack a Chip-relative map location. (mslogic.c:1334-1340) */
  private makeMouseAbsolute(relPos: number): number {
    const x = (relPos % MOUSERANGE) + MOUSERANGEMIN;
    const y = Math.floor(relPos / MOUSERANGE) + MOUSERANGEMIN;
    return this.chipPos() + y * CXGRID + x;
  }

  /* Determine the direction of Chip's next move. If discard is true, then
   * Chip is not currently permitted to select a direction of movement,
   * and the player's input should not be retained. (mslogic.c:1346-1390)
   */
  private chooseChipMove(cr: Creature, discard: boolean): void {
    cr.tdir = NIL;

    if (cr.hidden) return;

    if (!(this.state.currenttime & 3)) cr.state &= ~CS_HASMOVED;
    if (cr.state & CS_HASMOVED) {
      if (this.state.currentinput !== NIL && this.hasGoal()) {
        this.cancelGoal();
        this.state.lastmove = CmdMoveNop;
      }
      return;
    }

    let dir = this.state.currentinput;
    this.state.currentinput = NIL;
    if (discard || ((cr.state & CS_SLIDE) !== 0 && dir === cr.dir)) {
      if (this.state.currenttime && !(this.state.currenttime & 1))
        this.cancelGoal();
      return;
    }

    if (dir >= CmdAbsMouseMoveFirst && dir <= CmdAbsMouseMoveLast) {
      this.state.msstate.goalpos = dir - CmdAbsMouseMoveFirst;
      this.state.lastmove =
        CmdMouseMoveFirst + this.makeMouseRelative(this.state.msstate.goalpos);
      dir = NIL;
    } else if (dir >= CmdMouseMoveFirst && dir <= CmdMouseMoveLast) {
      this.state.lastmove = dir;
      this.state.msstate.goalpos = this.makeMouseAbsolute(
        dir - CmdMouseMoveFirst,
      );
      dir = NIL;
    } else {
      if (dir & (NORTH | SOUTH) && dir & (EAST | WEST)) {
        dir &= NORTH | SOUTH;
      }
      this.state.lastmove = dir;
    }

    if (dir === NIL && this.hasGoal() && (this.state.currenttime & 3) === 2)
      dir = this.chipMoveToGoalPos();

    cr.tdir = dir;
  }

  /* Teleport the given creature instantaneously from the teleport tile at
   * start to another teleport tile (if possible). (mslogic.c:1395-1430)
   */
  private teleportCreature(cr: Creature, start: number): number {
    const origdir = cr.dir; /* tank push IB onto blue button via teleporter */
    if (cr.dir === NIL) {
      console.warn(
        `${this.state.currenttime}: directionless creature ` +
          `${cr.id.toString(16).toUpperCase()} on teleport at ` +
          `(${cr.pos % CXGRID} ${Math.floor(cr.pos / CXGRID)})`,
      );
      return NIL;
    }

    const origpos = cr.pos;
    let dest = start;

    for (;;) {
      --dest;
      if (dest < 0) dest += CXGRID * CYGRID;
      if (dest === start) break;
      const tile = this.state.cellAt(dest).top;
      if (tile.id !== Tile.Teleport || tile.state & FS_BROKEN) continue;
      cr.pos = dest;
      const f = this.canMakeMove(
        cr,
        cr.dir,
        CMM_NOLEAVECHECK |
          CMM_NOEXPOSEWALLS |
          CMM_NODEFERBUTTONS |
          CMM_NOFIRECHECK |
          CMM_TELEPORTPUSH,
      );
      cr.dir = origdir; /* tank push IB onto blue button via teleporter */
      cr.pos = origpos;
      if (f) break;
    }

    return dest;
  }

  /* Determine the move(s) a creature will make on the current tick.
   * (mslogic.c:1434-1443)
   */
  private chooseMove(cr: Creature): void {
    if (cr.id === Tile.Chip) {
      this.chooseChipMove(cr, Boolean(cr.state & CS_SLIP));
    } else {
      if (cr.state & CS_SLIP) cr.tdir = NIL;
      else this.chooseCreatureMove(cr);
    }
  }

  /* addsoundeffect() macro (mslogic.c, via gen.h) — sets the given sound
   * effect's bit in the game state's sound-effects bitmask. Mirrors
   * lynx.ts's own addSoundEffect() helper.
   */
  private addSoundEffect(sfx: number): void {
    this.state.soundeffects |= 1 << sfx;
  }

  /*
   * Buttons, clone machines, and bear traps. (mslogic.c:1447-1553)
   */

  /* Activate the clone machine wired to the given button, if any.
   * (mslogic.c:1447-1478)
   */
  private activateCloner(buttonPos: number): void {
    const pos = this.clonerFromButton(buttonPos);
    if (pos < 0 || pos >= CXGRID * CYGRID) return;
    const tileId = this.state.cellAt(pos).top.id;
    if (!iscreature(tileId) || creatureid(tileId) === Tile.Chip) return;
    if (creatureid(tileId) === Tile.Block) {
      const cr = this.lookupBlock(pos);
      if (cr.dir !== NIL) this.advanceCreature(cr, cr.dir);
    } else {
      if (this.state.cellAt(pos).bot.state & FS_CLONING) return;
      const dummy: Creature = {
        id: creatureid(tileId),
        pos,
        dir: creaturedirid(tileId),
        tdir: NIL,
        state: 0,
        frame: 0,
        hidden: false,
        moving: 0,
      };
      if (!this.canMakeMove(dummy, dummy.dir, CMM_CLONECANTBLOCK)) return;
      const cr = this.awakenCreature(pos);
      if (!cr) return;
      cr.state |= CS_CLONING;
      if (this.state.cellAt(pos).bot.id === Tile.CloneMachine)
        this.state.cellAt(pos).bot.state |= FS_CLONING;
    }
  }

  /* Open a bear trap. Any creature already in the trap is released.
   * (mslogic.c:1482-1504)
   */
  private springTrap(buttonPos: number): void {
    const pos = this.trapFromButton(buttonPos);
    if (pos < 0) return;
    if (pos >= CXGRID * CYGRID) {
      console.warn(
        `Off-map trap opening attempted: (${pos % CXGRID} ${Math.floor(pos / CXGRID)})`,
      );
      return;
    }
    const id = this.state.cellAt(pos).top.id;
    if (id === Tile.Block_Static || this.state.cellAt(pos).bot.state & FS_HASMUTANT) {
      const cr = this.lookupBlock(pos);
      if (cr) cr.state |= CS_RELEASED;
    } else if (iscreature(id)) {
      const cr = this.lookupCreature(pos, true);
      if (cr) cr.state |= CS_RELEASED;
    }
  }

  /* Mark all buttons everywhere as having been handled. (mslogic.c:1508-1515) */
  private resetButtons(): void {
    for (let pos = 0; pos < CXGRID * CYGRID; ++pos) {
      const cell = this.state.cellAt(pos);
      cell.top.state &= ~FS_BUTTONDOWN;
      cell.bot.state &= ~FS_BUTTONDOWN;
    }
  }

  /* Apply the effects of all deferred button presses, if any.
   * (mslogic.c:1519-1553)
   */
  private handleButtons(): void {
    for (let pos = 0; pos < CXGRID * CYGRID; ++pos) {
      const cell = this.state.cellAt(pos);
      let id: number;
      if (cell.top.state & FS_BUTTONDOWN) {
        cell.top.state &= ~FS_BUTTONDOWN;
        id = cell.top.id;
      } else if (cell.bot.state & FS_BUTTONDOWN) {
        cell.bot.state &= ~FS_BUTTONDOWN;
        id = cell.bot.id;
      } else {
        continue;
      }
      switch (id) {
        case Tile.Button_Blue:
          this.addSoundEffect(SND_BUTTON_PUSHED);
          this.turnTanks(null);
          break;
        case Tile.Button_Green:
          this.toggleWalls();
          break;
        case Tile.Button_Red:
          this.activateCloner(pos);
          this.addSoundEffect(SND_BUTTON_PUSHED);
          break;
        case Tile.Button_Brown:
          this.springTrap(pos);
          this.addSoundEffect(SND_BUTTON_PUSHED);
          break;
        default:
          console.warn(`Fooey! Tile ${id.toString(16).toUpperCase()} is not a button!`);
          break;
      }
    }
  }

  /*
   * When something actually moves. (mslogic.c:1555-1891)
   */

  /* Initiate a move by the given creature in the given direction. Return
   * FALSE if the creature cannot initiate the indicated move (side effects
   * may still occur). The `_assert(dir != NIL)` is omitted per the
   * established no-op-assertion convention (the caller — advanceCreature()
   * — already returns early on dir===NIL before ever reaching this
   * function). (mslogic.c:1563-1589)
   */
  private startMovement(cr: Creature, dir: number): boolean {
    const odir = cr.dir; /* b2 fix with convergence glitch */

    const floor = this.state.cellAt(cr.pos).bot.id;
    if (!this.canMakeMove(cr, dir, 0)) {
      if (
        cr.id === Tile.Chip ||
        (floor !== Tile.Beartrap && floor !== Tile.CloneMachine && !(cr.state & CS_SLIP))
      ) {
        if (cr.id !== Tile.Chip || odir !== NIL) cr.dir = dir; /* b2 fix */
        this.updateCreature(cr);
      }
      return false;
    }

    if (floor === Tile.Beartrap) {
      if (cr.state & CS_MUTANT) this.state.cellAt(cr.pos).bot.state &= ~FS_HASMUTANT;
    }
    cr.state &= ~CS_RELEASED;

    cr.dir = dir;

    return true;
  }

  /* Complete the movement of the given creature. Most side effects
   * produced by moving onto a tile occur at this point. This function is
   * also the only place where a creature can be added to the slip list.
   *
   * Judgment call on the "Convergence Patch" `if (TRUE || newpos != i)`
   * below: mirroring the established convention for the dead
   * `if (FALSE && ...)` block in chooseCreatureMove() (see that method's
   * design note), this is transcribed as a literal `if (true || ...)`
   * rather than simplified to an unconditional block — the point of the
   * literal transcription is to preserve, in the same relative position, a
   * visible marker of the fact that the `newpos !== i` half of the
   * condition is dead code the original author left in deliberately,
   * along with the "no idea, but Icysanity lvl 1 requires newpos=i to
   * work" comment that documents why. The large block of old, commented-
   * out code inside this branch (`cr->dir = NORTH; cellat(newpos)->top.id
   * = crtile(Chip, NORTH);`) is pure history/documentation in the C
   * source and is omitted here rather than reproduced as a TS comment.
   * (mslogic.c:1596-1866)
   */
  private endMovement(cr: Creature, dir: number): void {
    const delta = [0, -CXGRID, -1, 0, +CXGRID, 0, 0, 0, +1];
    let dead = false;

    const oldPos = cr.pos;
    let newPos = cr.pos + delta[dir]!;

    const cell = this.state.cellAt(newPos);
    let tile = cell.top;
    let floor = tile.id;
    const crid = creatureid(this.state.cellAt(oldPos).top.id); /* Non-existence patch */
    let blockCloning = false; /* Squish patch */

    if (cr.id === Tile.Chip) {
      switch (floor) {
        case Tile.Empty:
          this.popTile(newPos);
          break;
        case Tile.Water:
          if (!this.getPossession(Tile.Boots_Water))
            this.state.msstate.chipstatus = ChipStatus.CHIP_DROWNED;
          break;
        case Tile.Fire:
          if (!this.getPossession(Tile.Boots_Fire))
            this.state.msstate.chipstatus = ChipStatus.CHIP_BURNED;
          break;
        case Tile.Dirt:
          this.popTile(newPos);
          break;
        case Tile.BlueWall_Fake:
          this.popTile(newPos);
          break;
        case Tile.PopupWall:
          tile.id = Tile.Wall;
          break;
        case Tile.Door_Red:
        case Tile.Door_Blue:
        case Tile.Door_Yellow:
        case Tile.Door_Green:
          if (floor !== Tile.Door_Green)
            this.setPossession(floor, this.getPossession(floor) - 1);
          this.popTile(newPos);
          this.addSoundEffect(SND_DOOR_OPENED);
          break;
        case Tile.Boots_Ice:
        case Tile.Boots_Slide:
        case Tile.Boots_Fire:
        case Tile.Boots_Water:
        case Tile.Key_Red:
        case Tile.Key_Blue:
        case Tile.Key_Yellow:
        case Tile.Key_Green:
          if (iscreature(cell.bot.id)) this.state.msstate.chipstatus = ChipStatus.CHIP_COLLIDED;
          this.setPossession(floor, this.getPossession(floor) + 1);
          this.popTile(newPos);
          this.addSoundEffect(SND_ITEM_COLLECTED);
          break;
        case Tile.Burglar:
          this.state.boots[0] = 0;
          this.state.boots[1] = 0;
          this.state.boots[2] = 0;
          this.state.boots[3] = 0;
          this.addSoundEffect(SND_BOOTS_STOLEN);
          break;
        case Tile.ICChip:
          if (this.state.chipsneeded) --this.state.chipsneeded;
          this.popTile(newPos);
          this.addSoundEffect(SND_IC_COLLECTED);
          break;
        case Tile.Socket:
          this.popTile(newPos);
          this.addSoundEffect(SND_SOCKET_OPENED);
          break;
        case Tile.Bomb:
          this.state.msstate.chipstatus = ChipStatus.CHIP_BOMBED;
          this.addSoundEffect(SND_BOMB_EXPLODES);
          break;
        default:
          if (iscreature(floor)) this.state.msstate.chipstatus = ChipStatus.CHIP_COLLIDED;
          break;
      }
    } else if (cr.id === Tile.Block) {
      switch (floor) {
        case Tile.Empty:
          this.popTile(newPos);
          break;
        case Tile.Water:
          tile.id = Tile.Dirt;
          dead = true;
          this.addSoundEffect(SND_WATER_SPLASH);
          break;
        case Tile.Bomb:
          tile.id = Tile.Empty;
          dead = true;
          this.addSoundEffect(SND_BOMB_EXPLODES);
          break;
        case Tile.Teleport:
          if (!(tile.state & FS_BROKEN)) newPos = this.teleportCreature(cr, newPos);
          break;
      }
      const id = this.state.cellAt(oldPos).top.id;
      if (iscreature(id) && creatureid(id) === Tile.Chip) cr.state |= CS_MUTANT;
    } else {
      if (iscreature(cell.top.id)) {
        tile = cell.bot;
        floor = cell.bot.id;
      }
      switch (floor) {
        case Tile.Water:
          if (crid !== Tile.Glider) /* use crid with Non-existence patch */ dead = true;
          break;
        case Tile.Fire:
          if (crid !== Tile.Fireball) /* use crid with Non-existence patch */ dead = true;
          break;
        case Tile.Bomb:
          cell.top.id = Tile.Empty;
          dead = true;
          this.addSoundEffect(SND_BOMB_EXPLODES);
          break;
        case Tile.Teleport:
          if (!(tile.state & FS_BROKEN)) newPos = this.teleportCreature(cr, newPos);
          break;
      }
    }

    if (this.state.cellAt(oldPos).bot.id !== Tile.CloneMachine || cr.id === Tile.Chip)
      this.popTile(oldPos);
    if (dead) {
      this.removeCreature(cr);
      if (this.state.cellAt(oldPos).bot.id === Tile.CloneMachine)
        this.state.cellAt(oldPos).bot.state &= ~FS_CLONING;
      return;
    }

    if (cr.id === Tile.Chip && floor === Tile.Teleport && !(tile.state & FS_BROKEN)) {
      const i = newPos;
      newPos = this.teleportCreature(cr, newPos);
      if (true || newPos !== i) {
        /* Convergence Patch: no idea, but Icysanity lvl 1 requires
         * newpos=i to work. */
        this.addSoundEffect(SND_TELEPORTING);
        if (this.floorAt(newPos) === Tile.Block_Static) {
          if (this.state.msstate.lastslipdir === NIL) {
            /* these seem cosmetic/superfluous with new patch:
             * cr.dir = NORTH; cellat(newpos).top.id = crtile(Chip, NORTH); */
            cr.dir = NIL; /* Convergence Patch */
          } else {
            /* seems ok still, with new Convergence logic */
            cr.dir = this.state.msstate.lastslipdir;
          }
        }
      }
    }

    cr.pos = newPos;
    this.addCreatureToMap(cr);
    cr.pos = oldPos;

    tile = cell.bot;
    switch (floor) {
      case Tile.Button_Blue:
        if (cr.state & CS_DEFERPUSH) tile.state |= FS_BUTTONDOWN;
        else this.turnTanks(cr);
        this.addSoundEffect(SND_BUTTON_PUSHED);
        break;
      case Tile.Button_Green:
        if (cr.state & CS_DEFERPUSH) tile.state |= FS_BUTTONDOWN;
        else this.toggleWalls();
        break;
      case Tile.Button_Red:
        cr.moving = 1; /* Hack with SGG */
        if (cr.state & CS_DEFERPUSH) tile.state |= FS_BUTTONDOWN;
        else this.activateCloner(newPos);
        this.addSoundEffect(SND_BUTTON_PUSHED);
        cr.moving = 0; /* Hack with SGG */
        break;
      case Tile.Button_Brown:
        if (cr.state & CS_DEFERPUSH) tile.state |= FS_BUTTONDOWN;
        else this.springTrap(newPos);
        this.addSoundEffect(SND_BUTTON_PUSHED);
        break;
    }
    cr.pos = newPos;

    if (
      this.state.cellAt(oldPos).bot.id === Tile.CloneMachine &&
      cr.id === Tile.Block &&
      this.state.cellAt(oldPos).top.id !== Tile.Block_Static
    )
      blockCloning = true; /* Squish patch */

    if (this.state.cellAt(oldPos).bot.id === Tile.CloneMachine)
      this.state.cellAt(oldPos).bot.state &= ~FS_CLONING;

    if (floor === Tile.Beartrap) {
      if (this.isTrapOpen(newPos, oldPos)) cr.state |= CS_RELEASED;
    } else if (this.state.cellAt(newPos).bot.id === Tile.Beartrap) {
      for (let i = 0; i < this.state.trapcount; ++i) {
        const trap = this.state.traps[i];
        if (trap && trap.to === newPos) {
          cr.state |= CS_RELEASED;
          break;
        }
      }
    }

    if (cr.id === Tile.Chip) {
      if (this.state.msstate.goalpos === cr.pos) this.cancelGoal();
      if (
        this.state.msstate.chipstatus !== ChipStatus.CHIP_OKAY &&
        this.state.msstate.chipstatus !== ChipStatus.CHIP_SQUISHED
      )
        return; /* CHIP_SQUISHED added with Squish patch */
      if (cell.bot.id === Tile.Exit) {
        this.state.msstate.completed = 1;
        return;
      }
    } else {
      if (iscreature(cell.bot.id)) {
        if (
          creatureid(cell.bot.id) === Tile.Chip ||
          creatureid(cell.bot.id) === Tile.Swimming_Chip
        ) {
          if (cr.id !== Tile.Block || !blockCloning) /* Squish patch */
            this.state.msstate.chipstatus = ChipStatus.CHIP_COLLIDED;
          else this.state.msstate.chipstatus = ChipStatus.CHIP_SQUISHED; /* Squish patch */
          return;
        }
      }
    }

    const wasSlipping = cr.state & (CS_SLIP | CS_SLIDE);

    if (floor === Tile.Teleport) {
      this.startFloorMovement(cr, floor, NIL); /* NIL for tank reversal patch */
    } else if (isice(floor) && (cr.id !== Tile.Chip || !this.getPossession(Tile.Boots_Ice))) {
      this.startFloorMovement(cr, floor, NIL); /* NIL for tank reversal patch */
    } else if (
      isslide(floor) &&
      (cr.id !== Tile.Chip || !this.getPossession(Tile.Boots_Slide))
    ) {
      this.startFloorMovement(cr, floor, NIL); /* NIL for tank reversal patch */
    } else if (floor === Tile.Beartrap && cr.id === Tile.Block && wasSlipping) {
      this.startFloorMovement(cr, floor, NIL); /* NIL for tank reversal patch */
      if (cr.state & CS_MUTANT) cell.bot.state |= FS_HASMUTANT;
    } else {
      /* changes for MSCC-style sliplist */
      cr.state &= ~(CS_SLIP | CS_SLIDE);
      if (wasSlipping && cr.id !== Tile.Chip) {
        this.slipperCount--;
        this.removeFromSlipList(cr);
      }
    }
    if (!wasSlipping && cr.state & (CS_SLIP | CS_SLIDE) && cr.id !== Tile.Chip)
      this.state.msstate.controllerdir = this.getSlipDir(cr);
  }

  /* Move the given creature in the given direction. (mslogic.c:1870-1891) */
  private advanceCreature(cr: Creature, dir: number): number {
    if (dir === NIL) return 1;

    if (cr.id === Tile.Chip) this.state.msstate.chipwait = 0;

    if (!this.startMovement(cr, dir)) {
      if (cr.id === Tile.Chip) {
        this.addSoundEffect(SND_CANT_MOVE);
        this.resetButtons();
        this.cancelGoal();
      }
      return 0;
    }

    this.endMovement(cr, dir);
    if (cr.id === Tile.Chip) this.handleButtons();

    return 1;
  }

  /* Determine whether the game has ended, one way or the other. Returns
   * -1 if Chip has lost, +1 if Chip has won, 0 otherwise. Note the Squish
   * patch exception: a Chip who is merely CHIP_SQUISHED (but not yet
   * finalized as CHIP_SQUISHED_DEATH) is not treated as a loss here.
   * (mslogic.c:1895-1905)
   */
  private checkForEnding(): number {
    if (
      this.state.msstate.chipstatus !== ChipStatus.CHIP_OKAY &&
      this.state.msstate.chipstatus !== ChipStatus.CHIP_SQUISHED
    ) {
      this.addSoundEffect(SND_CHIP_LOSES); /* Squish patch */
      return -1;
    }
    if (this.state.msstate.completed) {
      this.addSoundEffect(SND_CHIP_WINS);
      return 1;
    }
    return 0;
  }

  /*
   * Automatic activities.
   */

  /* Execute all forced moves for Chip on the slip list. (Note the use of
   * the savedcount variable, which is how slide delay is implemented.)
   * Split from the non-Chip half below; see design notes accompanying
   * this dispatch. (mslogic.c:1911-1958)
   */
  private floorMovementsOfChip(): void {
    for (let n = 0; n < this.slips.length; ++n) {
      const slip = this.slips[n];
      if (!slip) continue;
      const cr = slip.cr;
      if (!(slip.cr.state & (CS_SLIP | CS_SLIDE))) continue;
      let slipdir = slip.dir;
      if (slipdir === NIL && cr.id === Tile.Chip) {
        /* Convergence Patch */
        this.state.cellAt(cr.pos).top.id = crtile(Tile.Chip, NORTH);
      }
      if (slipdir === NIL) continue;
      if (cr.id !== Tile.Chip) continue; /* new, non-Chip ignored */
      this.state.msstate.lastslipdir = slipdir;
      let ac = this.advanceCreature(cr, slipdir); /* useful to have ac */
      if (ac) {
        cr.state &= ~CS_HASMOVED;
      } else {
        const floor = this.state.cellAt(cr.pos).bot.id;
        if (isslide(floor)) {
          cr.state &= ~CS_HASMOVED;
        } else if (isice(floor)) {
          slipdir = this.icewallturn(floor, back(slipdir));
          this.state.msstate.lastslipdir = slipdir;
          ac = this.advanceCreature(cr, slipdir); /* again useful with ac */
          if (ac) cr.state &= ~CS_HASMOVED;
        } else if (floor === Tile.Teleport || floor === Tile.Block_Static) {
          slipdir = back(slipdir);
          this.state.msstate.lastslipdir = slipdir;
          if (this.advanceCreature(cr, slipdir)) cr.state &= ~CS_HASMOVED;
        }
        if (cr.state & (CS_SLIP | CS_SLIDE)) {
          this.endFloorMovement(cr);
          this.startFloorMovement(
            cr,
            this.state.cellAt(cr.pos).bot.id,
            NIL,
          ); /* 3rd argument with tank reversal patch */
        }
      }
      if (this.checkForEnding()) return;
    }
  }

  /* Execute all forced moves for blocks and monsters on the slip list.
   * Split from the Chip-only half above. The `n`/`advance` loop mirrors
   * the C source's `for (n = 0; n < slipcount;)` with no auto-increment
   * clause: every path through the loop body explicitly decides whether
   * to advance `n`. (mslogic.c:1960-2013)
   */
  private floorMovementsOfBlocksAndMonsters(): void {
    let advance = 0;

    for (let n = 0; n < this.slips.length; ) {
      const oldMsccSlippers = this.slipperCount;
      const slip = this.slips[n];
      if (!slip) {
        n++;
        continue;
      }
      const cr = slip.cr;
      if (cr.id === Tile.Chip) {
        /* new splitting */
        n++;
        continue;
      }
      if (advance) {
        advance--;
        n++;
        continue;
      }
      if (!(slip.cr.state & (CS_SLIP | CS_SLIDE))) {
        n++;
        continue;
      }
      let slipdir = slip.dir;
      const origdir = slipdir; /* tank reversal patch */
      if (slipdir === NIL) {
        n++;
        continue;
      }
      cr.frame = cr.dir; /* Tank Top Glitch */
      let ac = this.advanceCreature(cr, slipdir); /* useful to have ac */
      if (!ac) {
        const floor = this.state.cellAt(cr.pos).bot.id;
        if (isice(floor)) {
          slipdir = this.icewallturn(floor, back(slipdir));
          ac = this.advanceCreature(cr, slipdir); /* again useful with ac */
        }
        if (cr.state & (CS_SLIP | CS_SLIDE)) {
          this.endFloorMovement(cr);
          this.slipperCount--; /* new MSCC accounting */
          this.startFloorMovement(
            cr,
            this.state.cellAt(cr.pos).bot.id,
            ac ? NIL : origdir,
          ); /* 3rd argument with tank reversal patch */
        }
      }
      if (cr.state & CS_SLIP && ac) cr.state |= CS_SLIDE; /* Tank Top Glitch */
      cr.frame = 0; /* Tank Top Glitch */
      if (this.checkForEnding()) return;
      if (this.slipperCount === oldMsccSlippers) advance++;
    }
  }

  /* Orchestrates the two slip-list-processing halves above, plus the
   * Squish patch's final death-finalization step. (mslogic.c:2015-2024)
   */
  private floorMovements(): void {
    this.floorMovementsOfChip();
    this.updateSlipList(); /* remove deadwood */
    /* TSG stuff, not yet included */
    if (!this.checkForEnding())
      /* Squish patch (maybe was oversight?) */
      this.floorMovementsOfBlocksAndMonsters();
    if (
      !this.state.msstate.completed &&
      this.state.msstate.chipstatus === ChipStatus.CHIP_SQUISHED
    )
      this.state.msstate.chipstatus = ChipStatus.CHIP_SQUISHED_DEATH;
  }

  /* Finalize clone creation for the tick: clear the transient
   * "still cloning" marker on any creature that has it set. The actual
   * cloning/spawning already happened earlier via awakenCreature()/
   * activateCloner(). (mslogic.c:2027-2033)
   */
  private createClones(): void {
    for (const cr of this.state.creatures) {
      if (cr.state & CS_CLONING) cr.state &= ~CS_CLONING;
    }
  }

  /*
   * The functions provided by the gamelogic struct. (mslogic.c:2139-2416)
   */

  /* SF_SHOWHINT flag accessors, mirroring lynx.ts's own showHint()/
   * hideHint() helpers (lxlogic.c:109-110 equivalent).
   */
  private showHint(): void {
    this.state.statusflags |= SF_SHOWHINT;
  }

  private hideHint(): void {
    this.state.statusflags &= ~SF_SHOWHINT;
  }

  /* Actions and checks that occur at the start of a tick. The
   * `#ifndef NDEBUG` block (debug commands, cheat-code handling,
   * verifymap()/dumpmap()) is intentionally excluded from this port, per
   * the convention established for every prior layer. (mslogic.c:2139-2221,
   * minus the NDEBUG block)
   */
  private initialHousekeeping(): void {
    if (this.state.currenttime === 0) {
      this.lastStepping = this.state.stepping;
    }

    if (!(this.state.currenttime & 3)) {
      for (let n = 1; n < this.state.creatures.length; ++n) {
        const cr = this.state.creatures[n]!;
        if (cr.state & CS_TURNING) {
          cr.state &= ~(CS_TURNING | CS_HASMOVED);
          this.updateCreature(cr);
        }
      }
      ++this.state.msstate.chipwait;
      if (this.state.msstate.chipwait > 3) {
        this.state.msstate.chipwait = 3;
        const chip = this.getChip();
        if (chip.dir !== NIL) /* Convergence Glitch patch (a) */
          chip.dir = SOUTH;
        this.updateCreature(chip);
      }
    }
  }

  /* Actions and checks that occur at the end of a tick. A genuine no-op
   * in the C source; kept as an empty method for structural parity with
   * advanceGame()'s call site, matching the established convention from
   * Lynx's equivalent no-op. (mslogic.c:2225-2227)
   */
  private finalHousekeeping(): void {
    return;
  }

  /* Update the display-position fields ahead of rendering. Simpler than
   * Lynx's equivalent prepareDisplay(): MS has no moving-based sub-tile
   * animation adjustment here, just the static position-plus-offset
   * computation. (mslogic.c:2229-2240)
   */
  private prepareDisplay(): void {
    const pos = this.chipPos();
    if (this.state.cellAt(pos).bot.id === Tile.HintButton) this.showHint();
    else this.hideHint();

    this.state.xviewpos =
      (pos % CXGRID) * 8 + this.state.msstate.xviewoffset * 8;
    /* CYGRID here (not CXGRID) matches mslogic.c:2239 literally; the two
     * constants happen to have the same value (32), so this is harmless,
     * but it is transcribed exactly as written rather than "fixed". */
    this.state.yviewpos =
      Math.floor(pos / CYGRID) * 8 + this.state.msstate.yviewoffset * 8;
  }

  /* Initialize the gamestate structure to the state at the beginning of
   * the level. (mslogic.c:2252-2338)
   */
  initGame(): boolean {
    this.state.statusflags &= ~SF_BADTILES;
    this.state.statusflags |= SF_NOANIMATION;

    for (let pos = 0; pos < CXGRID * CYGRID; ++pos) {
      const cell = this.state.cellAt(pos);
      if (
        isfloor(cell.top.id) ||
        creatureid(cell.top.id) === Tile.Chip ||
        creatureid(cell.top.id) === Tile.Block
      ) {
        if (
          cell.bot.id === Tile.Teleport ||
          cell.bot.id === Tile.SwitchWall_Open ||
          cell.bot.id === Tile.SwitchWall_Closed
        ) {
          cell.bot.state |= FS_BROKEN;
        }
      }
    }

    const chip = this.allocateCreature();
    chip.pos = 0;
    chip.id = Tile.Chip;
    chip.dir = SOUTH;
    this.addToCreatureList(chip);

    for (let n = 0; n < this.state.crlistcount; ++n) {
      const pos = this.state.crlist[n]!;
      if (pos < 0 || pos >= CXGRID * CYGRID) {
        console.warn(
          `invalid creature location (${pos % CXGRID} ${Math.floor(pos / CXGRID)})`,
        );
        continue;
      }
      const cell = this.state.cellAt(pos);
      if (!iscreature(cell.top.id)) {
        console.warn(
          `no creature at location (${pos % CXGRID} ${Math.floor(pos / CXGRID)})`,
        );
        continue;
      }
      if (
        creatureid(cell.top.id) !== Tile.Block &&
        cell.bot.id !== Tile.CloneMachine
      ) {
        const cr = this.allocateCreature();
        cr.pos = pos;
        cr.id = creatureid(cell.top.id);
        cr.dir = creaturedirid(cell.top.id);
        this.addToCreatureList(cr);
        if (iscreature(cell.bot.id) && creatureid(cell.bot.id) === Tile.Chip) {
          chip.pos = pos;
          chip.dir = creaturedirid(cell.bot.id);
        }
      }
      cell.top.state |= FS_MARKER;
    }
    for (let pos = 0; pos < CXGRID * CYGRID; ++pos) {
      const cell = this.state.cellAt(pos);
      if (cell.top.state & FS_MARKER) {
        cell.top.state &= ~FS_MARKER;
      } else if (
        iscreature(cell.top.id) &&
        creatureid(cell.top.id) === Tile.Chip
      ) {
        chip.pos = pos;
        chip.dir = creaturedirid(cell.top.id);
      }
    }

    /* mslogic.c:2313-2314 (`dummycrlist.id = 0; state->creatures =
     * &dummycrlist;`) is deliberately NOT ported here. In the original C
     * program this line is a harmless compatibility no-op: MS's real
     * active-creature bookkeeping lives in its own private module-static
     * `creatures[]` array (never `gamestate.creatures`), so overwriting
     * `state->creatures` with a dummy single-element list only guards
     * against generic/display code elsewhere that assumes Lynx's
     * convention that `gamestate.creatures` IS the real list. But THIS
     * port's layer-1 design decision mapped MS's active-creature list
     * directly onto `GameState.creatures` — `this.state.creatures` IS the
     * real, actively-used list this very function just built up via
     * addToCreatureList(). Porting the line literally would destroy that
     * list, replacing it with a dummy single entry: catastrophic here,
     * even though it's inert in the original C. So this line is skipped
     * outright, per this dispatch's required deviation. */
    this.state.initrndslidedir = NORTH;

    this.state.keys[0] = 0;
    this.state.keys[1] = 0;
    this.state.keys[2] = 0;
    this.state.keys[3] = 0;
    this.state.boots[0] = 0;
    this.state.boots[1] = 0;
    this.state.boots[2] = 0;
    this.state.boots[3] = 0;

    for (let n = 0; n < this.state.trapcount; ++n) {
      const trap = this.state.traps[n]!;
      if (
        trap.to === this.chipPos() ||
        this.state.cellAt(trap.to).top.id === Tile.Block_Static ||
        this.isTrapButtonDown(trap.from)
      ) {
        this.springTrap(trap.from);
      }
    }

    this.state.msstate.chipwait = 0;
    this.state.msstate.completed = 0;
    this.state.msstate.chipstatus = ChipStatus.CHIP_OKAY;
    this.state.msstate.controllerdir = NIL;
    this.state.msstate.lastslipdir = NIL;
    this.state.stepping = this.lastStepping;
    this.cancelGoal();
    this.state.msstate.xviewoffset = 0;
    this.state.msstate.yviewoffset = 0;

    this.prepareDisplay();
    return true;
  }

  /* Advance the game state by one tick. The C source's `goto done;` early
   * exits are restructured as a labeled block with `break done` — every
   * such exit still falls through to the shared `finalHousekeeping()`/
   * `prepareDisplay()` epilogue before returning `r`, mirroring the C
   * control flow exactly. The lone exception is the CHIP_OUTOFTIME
   * timeout check below, which in the C source is a bare `return -1;`
   * (not a `goto done;`) — an inconsistency in the original source that
   * is preserved here rather than "fixed": that one early return skips
   * the epilogue entirely. (mslogic.c:2342-2405)
   */
  advanceGame(): number {
    let r = 0;

    this.state.timeoffset = -1;
    this.initialHousekeeping();

    this.slipperCount = this.slips.length;
    if (this.getChip().state & (CS_SLIP | CS_SLIDE)) /* new accounting */
      this.slipperCount--;

    done: {
      if (this.state.currenttime && !(this.state.currenttime & 1)) {
        this.state.msstate.controllerdir = NIL;
        for (let n = 0; n < this.state.creatures.length; ++n) {
          const cr = this.state.creatures[n]!;
          if (
            !cr.hidden &&
            cr.id !== Tile.Chip &&
            !(this.state.currenttime & 3) &&
            this.state.msstate.chipstatus === ChipStatus.CHIP_SQUISHED &&
            !this.state.msstate.completed
          )
            this.state.msstate.chipstatus = ChipStatus.CHIP_SQUISHED_DEATH; /* Squish patch */
          if (cr.hidden || cr.state & CS_CLONING || cr.id === Tile.Chip)
            continue;
          this.chooseMove(cr);
          if (cr.tdir !== NIL) this.advanceCreature(cr, cr.tdir);
        }
        r = this.checkForEnding();
        if (r) break done;
      }

      if (this.state.currenttime && !(this.state.currenttime & 1)) {
        this.floorMovements();
        r = this.checkForEnding();
        if (r) break done;
      }
      this.updateSlipList();

      this.state.timeoffset = 0;
      if (this.state.timelimit) {
        if (this.state.currenttime >= this.state.timelimit) {
          this.state.msstate.chipstatus = ChipStatus.CHIP_OUTOFTIME;
          this.addSoundEffect(SND_TIME_OUT);
          return -1; /* bare `return -1;` in the C source — bypasses the
                      * finalHousekeeping()/prepareDisplay() epilogue below,
                      * unlike every other early exit in this function. */
        } else if (
          this.state.timelimit - this.state.currenttime <=
            15 * TICKS_PER_SECOND &&
          this.state.currenttime % TICKS_PER_SECOND === 0
        ) {
          this.addSoundEffect(SND_TIME_LOW);
        }
      }

      const chip = this.getChip();
      this.chooseMove(chip);
      if (chip.tdir !== NIL) {
        this.advanceCreature(chip, chip.tdir); /* Squish patch, TW checked this?! */
        r = this.checkForEnding(); /* TW checks advanceCreature() status */
        if (r) break done; /* guess it's a remnant of Chip starting on exit? */
        chip.state |= CS_HASMOVED;
      }
      this.updateSlipList();
      this.createClones();
    }

    this.finalHousekeeping();
    this.prepareDisplay();
    return r;
  }

  /* Clean up after the game is done. The C source's resetcreaturepool()/
   * resetcreaturelist()/resetblocklist()/resetsliplist() calls reset the
   * C-only pool arena and per-game arrays for reuse by the next game. This
   * port has no pool arena (JS garbage-collects), and each MsLogic
   * instance is constructed fresh per Game (the current Game/RulesetLogic
   * architecture never reuses an instance across games — see lynx.ts's
   * equivalent endGame(), which is also a bare `return true`). So there is
   * no strict need to clear anything here. `this.blocks`/`this.slips` are
   * cleared anyway for safety/consistency, since doing so costs nothing
   * and matches the C source's intent even though the exact mechanism
   * differs; `this.state.creatures` is deliberately left untouched, since
   * (per the design note in initGame() above) it IS the real, live
   * creature list in this port, not a C-only arena to reset.
   * (mslogic.c:2409-2416)
   */
  endGame(): boolean {
    this.resetBlockList();
    this.resetSlipList();
    return true;
  }
}
