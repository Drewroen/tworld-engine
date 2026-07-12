// The game logic for the Lynx ruleset, ported from tworld/lxlogic.c.
//
// This is layer 1 of an ordered, multi-dispatch port of a ~2045-line C file.
// This layer covers lxlogic.c:1-336 — includes/enums/macros, the delta[]
// movement-offset table, all module-global statics, the accessor macros,
// the lynx_prng() 8-bit PRNG, floor-state flags/macros, getslidedir(),
// applyicewallturn(), trapfrombutton(), clonerfrombutton(), and
// resetfloorsounds(). Later sub-steps add the creature-list, movement, and
// lifecycle layers on top of this skeleton.
//
// Design notes on statics-to-instance-field conversion (read this before
// extending the file in a later sub-step):
//
// - `state` (lxlogic.c:81, a module-global gamestate* rebound via the
//   `setstate(logic)` macro at the top of every C entry point) becomes the
//   `private state: GameState` field below, bound once at construction. No
//   setstate()-equivalent method is needed since the state never changes
//   after construction.
//
// - `pedanticmode` (lxlogic.c:54, logic.h:39) is a genuinely global,
//   program-wide fidelity toggle in the original — not per-game state — so
//   it stays a module-level `let` here (see `pedanticMode` below), not an
//   instance field.
//
// - `lastrndslidedir` (lxlogic.c:68) and `laststepping` (lxlogic.c:72) are
//   per-game-in-progress values in spirit (they influence how a single
//   game's randomness/animation phase evolves tick to tick). To keep
//   multiple simultaneous LynxLogic instances from cross-talking, they are
//   instance fields here (`lastRndSlideDir`, `lastStepping`), not module
//   globals, even though the C original used module statics for them.
//
// - `creaturearray` (lxlogic.c:76, the backing memory for the creature
//   list): `GameState.creatures` (see src/state.ts) already *is* this flat
//   array in the TS port, so no separate field is declared for it here.
//   What the C code additionally tracks is `crend` — a pointer to the
//   current logical end of the list, used for reverse iteration. Since
//   `GameState.lxstate.crend` is typed `Creature | null` (mirroring the C
//   pointer, see src/state.ts:40), a later sub-step doing index-based
//   splicing on `this.state.creatures` will also want an index form of
//   "the end". The chosen convention (to be honored by sub-steps 3-6):
//   `crEndIndex` is an index into `this.state.creatures`, one past the
//   last logically-active creature (i.e. creatures at index >= crEndIndex
//   are "hidden"/free slots available for reuse by newcreature()).
//   Reverse iteration should walk `for (let i = crEndIndex - 1; i >= 0; i--)`.
//
// - `crEndIndex` is now maintained (as of the creature-list layer,
//   newCreature/removeCreature/removeAnimation). `this.state.creatures` is a
//   plain growable array, not a fixed preallocated buffer with a Nothing-id
//   sentinel like the C original, so "growing the list" in `newCreature()`
//   just pushes/writes a fresh Creature object at index `crEndIndex` when no
//   hidden slot exists to reuse and increments `crEndIndex`. The two C
//   capacity checks (`MAX_CREATURES`, and pedantic-mode's `PMAX_CREATURES`)
//   are still enforced against `crEndIndex` before growing.

import {
  CXGRID,
  CYGRID,
  NORTH,
  WEST,
  SOUTH,
  EAST,
  NIL,
  Ruleset,
  Tile,
  left,
  right,
  back,
  isanimation,
  isice,
  isslide,
  isdoor,
  isfloor,
  iscreature,
  ismsspecial,
  crtile,
  creatureid,
  creaturedirid,
  directionalcmd,
  SND_SKATING_FORWARD,
  SND_SKATING_TURN,
  SND_FIREWALKING,
  SND_WATERWALKING,
  SND_ICEWALKING,
  SND_SLIDEWALKING,
  SND_SLIDING,
  SND_BLOCK_MOVING,
  SND_WATER_SPLASH,
  SND_BOMB_EXPLODES,
  SND_CHIP_LOSES,
  SND_CANT_MOVE,
  SND_TELEPORTING,
  SND_TILE_EMPTIED,
  SND_WALL_CREATED,
  SND_DOOR_OPENED,
  SND_ITEM_COLLECTED,
  SND_BOOTS_STOLEN,
  SND_IC_COLLECTED,
  SND_SOCKET_OPENED,
  SND_CHIP_WINS,
  SND_TRAP_ENTERED,
  SND_BUTTON_PUSHED,
} from "../constants";
import { GameState, SF_BADTILES, SF_INVALID, SF_SHOWHINT } from "../state";
import type { Creature } from "../types";
import type { RulesetLogic } from "./ruleset";

/* A number well above the maximum number of creatures that could possibly
 * exist simultaneously. (lxlogic.c:18)
 */
export const MAX_CREATURES = 2 * CXGRID * CYGRID;

/* The maximum number of creatures on the original Atari Lynx version.
 * (lxlogic.c:22)
 */
export const PMAX_CREATURES = 128;

/* Temporary "holding" values used in place of a direction. (lxlogic.c:26-27) */
export const WALKER_TURN = NORTH | SOUTH | EAST;
export const BLOB_TURN = NORTH | SOUTH | WEST;

/* TRUE if dir is a diagonal move. (lxlogic.c:31) */
export const isDiagonal = (dir: number): boolean =>
  (dir & (NORTH | SOUTH)) !== 0 && (dir & (EAST | WEST)) !== 0;

/* A list of ways for Chip to lose. (lxlogic.c:45-49) */
export enum ChipStatus {
  CHIP_OKAY = 0,
  CHIP_DROWNED,
  CHIP_BURNED,
  CHIP_BOMBED,
  CHIP_OUTOFTIME,
  CHIP_COLLIDED,
  CHIP_NOTOKAY,
}

/* Pedantic mode flag. (lxlogic.c:54, logic.h:39)
 * A genuine program-wide toggle, not per-game state — see the design note
 * above. Later sub-steps should read/write this as `pedanticMode`.
 */
export let pedanticMode = false;

/* Used to calculate movement offsets. (lxlogic.c:63) */
export const delta: readonly number[] = [
  0, -CXGRID, -1, 0, +CXGRID, 0, 0, 0, +1,
];

/* Floor state flags. (lxlogic.c:203-206) */
const FS_CLAIMED = 0x40;
const FS_ANIMATED = 0x20;
const FS_BEARTRAP = 0x01;
const FS_TELEPORT = 0x02;

/* Creature state flags. (lxlogic.c:342-348) */
const CS_FDIRMASK = 0x0f;
const CS_SLIDETOKEN = 0x10;
const CS_REVERSE = 0x20;
const CS_PUSHED = 0x40;
const CS_TELEPORTED = 0x80;

/*
 * The laws of movement across the various floors. (lxlogic.c:498-671)
 *
 * Chip, blocks, and other creatures all have slightly different rules
 * about what sort of tiles they are permitted to move into and out of.
 * The following lookup table encapsulates these rules. Note that these
 * rules are only the first check; a creature may be generally permitted
 * a particular type of move but still prevented in a specific situation.
 */

const DIR_IN = (dir: number): number => dir;
const DIR_OUT = (dir: number): number => dir << 4;

const NORTH_IN = DIR_IN(NORTH);
const WEST_IN = DIR_IN(WEST);
const SOUTH_IN = DIR_IN(SOUTH);
const EAST_IN = DIR_IN(EAST);
const NORTH_OUT = DIR_OUT(NORTH);
const WEST_OUT = DIR_OUT(WEST);
const SOUTH_OUT = DIR_OUT(SOUTH);
const EAST_OUT = DIR_OUT(EAST);
const ALL_IN = NORTH_IN | WEST_IN | SOUTH_IN | EAST_IN;
const ALL_OUT = NORTH_OUT | WEST_OUT | SOUTH_OUT | EAST_OUT;
const ALL_IN_OUT = ALL_IN | ALL_OUT;

interface MoveLaw {
  chip: number;
  block: number;
  creature: number;
}

/* Indexed by floor tile ID (0x00-0x3F). Transcribed directly from
 * lxlogic.c:524-671, entry by entry, in the same order; comments name
 * the tile at that index (matching the `Tile` enum in ../constants), but
 * it is the array *position* that lxlogic.c relies on, not the comment.
 */
const movelaws: readonly MoveLaw[] = [
  { chip: 0, block: 0, creature: 0 }, // Nothing
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Empty
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Slide_North
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Slide_West
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Slide_South
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Slide_East
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Slide_Random
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Ice
  {
    // IceWall_Northwest
    chip: NORTH_OUT | WEST_OUT | SOUTH_IN | EAST_IN,
    block: NORTH_OUT | WEST_OUT | SOUTH_IN | EAST_IN,
    creature: NORTH_OUT | WEST_OUT | SOUTH_IN | EAST_IN,
  },
  {
    // IceWall_Northeast
    chip: NORTH_OUT | EAST_OUT | SOUTH_IN | WEST_IN,
    block: NORTH_OUT | EAST_OUT | SOUTH_IN | WEST_IN,
    creature: NORTH_OUT | EAST_OUT | SOUTH_IN | WEST_IN,
  },
  {
    // IceWall_Southwest
    chip: SOUTH_OUT | WEST_OUT | NORTH_IN | EAST_IN,
    block: SOUTH_OUT | WEST_OUT | NORTH_IN | EAST_IN,
    creature: SOUTH_OUT | WEST_OUT | NORTH_IN | EAST_IN,
  },
  {
    // IceWall_Southeast
    chip: SOUTH_OUT | EAST_OUT | NORTH_IN | WEST_IN,
    block: SOUTH_OUT | EAST_OUT | NORTH_IN | WEST_IN,
    creature: SOUTH_OUT | EAST_OUT | NORTH_IN | WEST_IN,
  },
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_OUT }, // Gravel
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Dirt
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Water
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Fire
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Bomb
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Beartrap
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Burglar
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // HintButton
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Button_Blue
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Button_Green
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Button_Red
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Button_Brown
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Teleport
  { chip: ALL_OUT, block: ALL_OUT, creature: ALL_OUT }, // Wall
  {
    // Wall_North
    chip: NORTH_IN | WEST_IN | EAST_IN | WEST_OUT | SOUTH_OUT | EAST_OUT,
    block: NORTH_IN | WEST_IN | EAST_IN | WEST_OUT | SOUTH_OUT | EAST_OUT,
    creature: NORTH_IN | WEST_IN | EAST_IN | WEST_OUT | SOUTH_OUT | EAST_OUT,
  },
  {
    // Wall_West
    chip: NORTH_IN | WEST_IN | SOUTH_IN | NORTH_OUT | SOUTH_OUT | EAST_OUT,
    block: NORTH_IN | WEST_IN | SOUTH_IN | NORTH_OUT | SOUTH_OUT | EAST_OUT,
    creature: NORTH_IN | WEST_IN | SOUTH_IN | NORTH_OUT | SOUTH_OUT | EAST_OUT,
  },
  {
    // Wall_South
    chip: WEST_IN | SOUTH_IN | EAST_IN | NORTH_OUT | WEST_OUT | EAST_OUT,
    block: WEST_IN | SOUTH_IN | EAST_IN | NORTH_OUT | WEST_OUT | EAST_OUT,
    creature: WEST_IN | SOUTH_IN | EAST_IN | NORTH_OUT | WEST_OUT | EAST_OUT,
  },
  {
    // Wall_East
    chip: NORTH_IN | SOUTH_IN | EAST_IN | NORTH_OUT | WEST_OUT | SOUTH_OUT,
    block: NORTH_IN | SOUTH_IN | EAST_IN | NORTH_OUT | WEST_OUT | SOUTH_OUT,
    creature: NORTH_IN | SOUTH_IN | EAST_IN | NORTH_OUT | WEST_OUT | SOUTH_OUT,
  },
  {
    // Wall_Southeast
    chip: SOUTH_IN | EAST_IN | NORTH_OUT | WEST_OUT,
    block: SOUTH_IN | EAST_IN | NORTH_OUT | WEST_OUT,
    creature: SOUTH_IN | EAST_IN | NORTH_OUT | WEST_OUT,
  },
  { chip: ALL_OUT, block: ALL_OUT, creature: ALL_OUT }, // HiddenWall_Perm
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // HiddenWall_Temp
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // BlueWall_Real
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // BlueWall_Fake
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // SwitchWall_Open
  { chip: ALL_OUT, block: ALL_OUT, creature: ALL_OUT }, // SwitchWall_Closed
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // PopupWall
  { chip: ALL_OUT, block: ALL_OUT, creature: ALL_OUT }, // CloneMachine
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Door_Red
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Door_Blue
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Door_Yellow
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Door_Green
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Socket
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Exit
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // ICChip
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Key_Red
  { chip: ALL_IN_OUT, block: ALL_IN_OUT, creature: ALL_IN_OUT }, // Key_Blue
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Key_Yellow
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Key_Green
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Boots_Slide
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Boots_Ice
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Boots_Water
  { chip: ALL_IN_OUT, block: ALL_OUT, creature: ALL_OUT }, // Boots_Fire
  { chip: 0, block: 0, creature: 0 }, // Block_Static
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

/* canmakemove() flag bits. (lxlogic.c:684-688) */
const CMM_RELEASING = 0x0001;
const CMM_CLEARANIMATIONS = 0x0002;
const CMM_STARTMOVEMENT = 0x0004;
const CMM_PUSHBLOCKS = 0x0008;
const CMM_PUSHBLOCKSNOW = 0x0010;

export class LynxLogic implements RulesetLogic {
  readonly ruleset = Ruleset.Lynx;

  private state: GameState;

  /* The direction used the last time something stepped onto a random
   * slide floor. (lxlogic.c:68 — instance field here; see design note above.)
   */
  private lastRndSlideDir = NORTH;

  /* The most recently used stepping phase value. (lxlogic.c:72 — instance
   * field here; see design note above.)
   */
  private lastStepping = 0;

  /* Index into this.state.creatures marking the logical end of the active
   * creature list (one past the last active creature). See the design
   * note above on creature-list end-tracking. Not yet maintained by this
   * layer — a later sub-step (creature-list layer) owns it.
   */
  private crEndIndex = 0;

  constructor(state: GameState) {
    this.state = state;
  }

  /* Returns the live, active portion of the creature list (indices
   * [0, crEndIndex)), equivalent to walking the C creaturelist() macro's
   * array up to its Nothing-id (0) sentinel. Exposed for test/diagnostic
   * code (e.g. the oracle differential digest dumper) that needs to mirror
   * exactly what the C harness's printDigest() walks; not used by the
   * engine's own logic, which always goes through crEndIndex directly.
   */
  activeCreatures(): Creature[] {
    return this.state.creatures.slice(0, this.crEndIndex);
  }

  /*
   * Simple field accessors. (lxlogic.c:90-146)
   *
   * Most single-field C accessor macros (completed()/togglestate()/
   * couldntmove()/chippushing()/chipstuck()/mapbreached()/chiptopos()/
   * chiptocr()/putwall()/prngvalue1()/prngvalue2()/xviewoffset()/
   * yviewoffset()/creaturelistend()/timelimit()/currenttime()/lastmove()/
   * stepping()/rndslidedir()/xviewpos()/yviewpos()/chipsneeded(), etc.)
   * are not given wrapper methods here — later sub-steps should read/write
   * the underlying fields directly, e.g. `this.state.lxstate.completed`,
   * `this.state.lxstate.prng1`, `this.state.timelimit`. Only accessors
   * with real logic, or that take a parameter, get methods below.
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

  private chipIsAlive(): boolean {
    return this.getChip().id === Tile.Chip;
  }

  private floorAt(pos: number): number {
    return this.state.cellAt(pos).top.id;
  }

  private addSoundEffect(sfx: number): void {
    this.state.soundeffects |= 1 << sfx;
  }

  private stopSoundEffect(sfx: number): void {
    this.state.soundeffects &= ~(1 << sfx);
  }

  /*
   * Floor-state flag accessors. (lxlogic.c:210-219)
   */

  private claimLocation(pos: number): void {
    this.state.cellAt(pos).top.state |= FS_CLAIMED;
  }

  private removeClaim(pos: number): void {
    this.state.cellAt(pos).top.state &= ~FS_CLAIMED;
  }

  private isLocationClaimed(pos: number): boolean {
    return (this.state.cellAt(pos).top.state & FS_CLAIMED) !== 0;
  }

  private markAnimated(pos: number): void {
    this.state.cellAt(pos).top.state |= FS_ANIMATED;
  }

  private clearAnimated(pos: number): void {
    this.state.cellAt(pos).top.state &= ~FS_ANIMATED;
  }

  private isMarkedAnimated(pos: number): boolean {
    return (this.state.cellAt(pos).top.state & FS_ANIMATED) !== 0;
  }

  private markBeartrap(pos: number): void {
    this.state.cellAt(pos).top.state |= FS_BEARTRAP;
  }

  private isMarkedBeartrap(pos: number): boolean {
    return (this.state.cellAt(pos).top.state & FS_BEARTRAP) !== 0;
  }

  private markTeleport(pos: number): void {
    this.state.cellAt(pos).top.state |= FS_TELEPORT;
  }

  private isMarkedTeleport(pos: number): boolean {
    return (this.state.cellAt(pos).top.state & FS_TELEPORT) !== 0;
  }

  /* possession(obj)/_possession(obj) — resolves a tile/object id to the
   * player's inventory slot for it (keys/boots), as an lvalue in C.
   * Ported as a get/set pair over the resolved slot. (lxlogic.c:148-180)
   */
  private possessionSlot(obj: number): { arr: number[]; idx: number } {
    switch (obj) {
      case Tile.Key_Red:
      case Tile.Door_Red:
        return { arr: this.state.keys, idx: 0 };
      case Tile.Key_Blue:
      case Tile.Door_Blue:
        return { arr: this.state.keys, idx: 1 };
      case Tile.Key_Yellow:
      case Tile.Door_Yellow:
        return { arr: this.state.keys, idx: 2 };
      case Tile.Key_Green:
      case Tile.Door_Green:
        return { arr: this.state.keys, idx: 3 };
      case Tile.Boots_Ice:
      case Tile.Ice:
      case Tile.IceWall_Northwest:
      case Tile.IceWall_Northeast:
      case Tile.IceWall_Southwest:
      case Tile.IceWall_Southeast:
        return { arr: this.state.boots, idx: 0 };
      case Tile.Boots_Slide:
      case Tile.Slide_North:
      case Tile.Slide_West:
      case Tile.Slide_South:
      case Tile.Slide_East:
      case Tile.Slide_Random:
        return { arr: this.state.boots, idx: 1 };
      case Tile.Boots_Fire:
      case Tile.Fire:
        return { arr: this.state.boots, idx: 2 };
      case Tile.Boots_Water:
      case Tile.Water:
        return { arr: this.state.boots, idx: 3 };
      default:
        throw new Error(`possession() called with an invalid object ${obj}`);
    }
  }

  private getPossession(obj: number): number {
    const { arr, idx } = this.possessionSlot(obj);
    return arr[idx] ?? 0;
  }

  private setPossession(obj: number, value: number): void {
    const { arr, idx } = this.possessionSlot(obj);
    arr[idx] = value;
  }

  /* The pseudorandom number generator, used by walkers and blobs. This
   * exactly matches the PRNG used in the original Lynx game.
   * (lxlogic.c:185-195) — bit-level fidelity required; see the byte
   * wraparound masking after every arithmetic step below.
   */
  private lynxPrng(): number {
    const ls = this.state.lxstate;
    let n = ((ls.prng1 >> 2) - ls.prng1) & 0xff;
    if (!(ls.prng1 & 0x02)) {
      n = (n - 1) & 0xff;
    }
    ls.prng1 = ((ls.prng1 >> 1) | (ls.prng2 & 0x80)) & 0xff;
    ls.prng2 = ((ls.prng2 << 1) | (n & 0x01)) & 0xff;
    return (ls.prng1 ^ ls.prng2) & 0xff;
  }

  /* Translate a slide floor into the direction it points in. In the case
   * of a random slide floor, if advance is true a new direction shall be
   * selected; otherwise the current direction is used. (lxlogic.c:225-240)
   */
  private getSlideDir(floor: number, advance: boolean): number {
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
        if (advance) {
          this.lastRndSlideDir = right(this.lastRndSlideDir);
        }
        return this.lastRndSlideDir;
      default:
        throw new Error(`getSlideDir() called with an invalid floor ${floor}`);
    }
  }

  /* Alter a creature's direction if they are at an ice wall.
   * (lxlogic.c:244-265)
   */
  private applyIceWallTurn(cr: Creature): void {
    const floor = this.floorAt(cr.pos);
    let dir = cr.dir;
    switch (floor) {
      case Tile.IceWall_Northeast:
        dir = dir === SOUTH ? EAST : dir === WEST ? NORTH : dir;
        break;
      case Tile.IceWall_Southwest:
        dir = dir === NORTH ? WEST : dir === EAST ? SOUTH : dir;
        break;
      case Tile.IceWall_Northwest:
        dir = dir === SOUTH ? WEST : dir === EAST ? NORTH : dir;
        break;
      case Tile.IceWall_Southeast:
        dir = dir === NORTH ? EAST : dir === WEST ? SOUTH : dir;
        break;
      default:
        break;
    }
    cr.dir = dir;
  }

  /* Find the location of a beartrap from one of its buttons.
   * (lxlogic.c:269-293)
   */
  private trapFromButton(pos: number): number {
    if (pedanticMode) {
      let i = pos;
      for (;;) {
        ++i;
        if (i === CXGRID * CYGRID) {
          i = 0;
        }
        if (i === pos) {
          break;
        }
        if (this.floorAt(i) === Tile.Beartrap) {
          return i;
        }
        if (this.isMarkedBeartrap(i)) {
          return -1;
        }
      }
    } else {
      const traps = this.state.traps;
      const n = this.state.trapcount;
      for (let i = 0; i < n; i++) {
        const xy = traps[i];
        if (xy && xy.from === pos) {
          return xy.to;
        }
      }
    }
    return -1;
  }

  /* Find the location of a clone machine from one of its buttons.
   * (lxlogic.c:297-319)
   */
  private clonerFromButton(pos: number): number {
    if (pedanticMode) {
      let i = pos;
      for (;;) {
        ++i;
        if (i === CXGRID * CYGRID) {
          i = 0;
        }
        if (i === pos) {
          break;
        }
        if (this.floorAt(i) === Tile.CloneMachine) {
          return i;
        }
      }
    } else {
      const cloners = this.state.cloners;
      const n = this.state.clonercount;
      for (let i = 0; i < n; i++) {
        const xy = cloners[i];
        if (xy && xy.from === pos) {
          return xy.to;
        }
      }
    }
    return -1;
  }

  /* Quell any continuous sound effects coming from what Chip is standing
   * on. If includePushing is true, also quell the sound of any blocks
   * being pushed. (lxlogic.c:325-336)
   */
  private resetFloorSounds(includePushing: boolean): void {
    this.stopSoundEffect(SND_SKATING_FORWARD);
    this.stopSoundEffect(SND_SKATING_TURN);
    this.stopSoundEffect(SND_FIREWALKING);
    this.stopSoundEffect(SND_WATERWALKING);
    this.stopSoundEffect(SND_ICEWALKING);
    this.stopSoundEffect(SND_SLIDEWALKING);
    this.stopSoundEffect(SND_SLIDING);
    if (includePushing) {
      this.stopSoundEffect(SND_BLOCK_MOVING);
    }
  }

  /*
   * Functions that manage the list of entities. (lxlogic.c:337-496)
   */

  /* getfdir(cr)/setfdir(cr, d) — temp storage for forced moves, packed
   * into the low nibble of cr.state. (lxlogic.c:350-352)
   */
  private getFDir(cr: Creature): number {
    return cr.state & CS_FDIRMASK;
  }

  private setFDir(cr: Creature, d: number): void {
    cr.state = (cr.state & ~CS_FDIRMASK) | (d & CS_FDIRMASK);
  }

  /* Return the creature located at pos. Ignores Chip unless includeChip
   * is true. (lxlogic.c:354-369)
   */
  private lookupCreature(pos: number, includeChip: boolean): Creature | null {
    const start = includeChip ? 0 : 1;
    for (let i = start; i < this.crEndIndex; i++) {
      const cr = this.state.creatures[i];
      if (cr && cr.pos === pos && !cr.hidden && !isanimation(cr.id)) {
        return cr;
      }
    }
    return null;
  }

  /* Return a fresh creature. (lxlogic.c:373-392)
   *
   * Design note: unlike the C version's fixed-size preallocated array with
   * a Nothing-id sentinel, `this.state.creatures` is a plain growable
   * array. `crEndIndex` is the authoritative logical count; slots at or
   * beyond it are ignored. When no hidden slot is available for reuse and
   * the array itself hasn't grown that far yet, a new Creature is pushed
   * onto the array before being claimed.
   */
  private newCreature(): Creature | null {
    for (let i = 1; i < this.crEndIndex; i++) {
      const cr = this.state.creatures[i];
      if (cr && cr.hidden) {
        return cr;
      }
    }
    if (this.crEndIndex >= MAX_CREATURES) {
      console.warn("Ran out of room in the creatures array!");
      return null;
    }
    if (pedanticMode && this.crEndIndex >= PMAX_CREATURES) {
      return null;
    }

    let cr = this.state.creatures[this.crEndIndex];
    if (!cr) {
      cr = {
        pos: 0,
        id: Tile.Nothing,
        dir: 0,
        moving: 0,
        frame: 0,
        hidden: false,
        state: 0,
        tdir: 0,
      };
      this.state.creatures[this.crEndIndex] = cr;
    }
    cr.hidden = true;
    this.crEndIndex++;
    return cr;
  }

  /* Flag all tanks to turn around. (lxlogic.c:396-409) */
  private turnTanks(): void {
    for (let i = 0; i < this.crEndIndex; i++) {
      const cr = this.state.creatures[i];
      if (!cr) continue;
      if (cr.hidden) continue;
      if (cr.id !== Tile.Tank) continue;
      const floor = this.floorAt(cr.pos);
      if (floor === Tile.CloneMachine || isice(floor)) continue;
      cr.state ^= CS_REVERSE;
    }
  }

  /* Start an animation sequence at the spot (formerly) occupied by the
   * given creature. The creature's slot in the creature list is reused
   * by the animation sequence. (lxlogic.c:415-432)
   */
  private removeCreature(cr: Creature, animationId: number): void {
    if (cr.id !== Tile.Chip) {
      this.removeClaim(cr.pos);
    }
    if (cr.state & CS_PUSHED) {
      this.stopSoundEffect(SND_BLOCK_MOVING);
    }
    cr.id = animationId;
    cr.frame = (this.state.currenttime + this.state.stepping) & 1 ? 12 : 11;
    --cr.frame;
    cr.hidden = false;
    cr.state = 0;
    cr.tdir = NIL;
    if (cr.moving === 8) {
      cr.pos -= delta[cr.dir] ?? 0;
      cr.moving = 0;
    }
    this.markAnimated(cr.pos);
  }

  /* End the given animation sequence (thus removing the final vestige of
   * an ex-creature). (lxlogic.c:437-445)
   */
  private removeAnimation(cr: Creature): void {
    cr.hidden = true;
    this.clearAnimated(cr.pos);
    if (cr === this.state.creatures[this.crEndIndex - 1]) {
      cr.id = Tile.Nothing;
      --this.crEndIndex;
    }
  }

  /* Abort the animation sequence occuring at the given location.
   * (lxlogic.c:449-460)
   */
  private stopAnimationAt(pos: number): boolean {
    for (let i = 0; i < this.crEndIndex; i++) {
      const anim = this.state.creatures[i];
      if (anim && !anim.hidden && anim.pos === pos && isanimation(anim.id)) {
        this.removeAnimation(anim);
        return true;
      }
    }
    return false;
  }

  /* What happens when Chip dies. reason indicates the cause of death.
   * also is either null or points to a creature that dies with Chip.
   * (lxlogic.c:465-496)
   */
  private removeChip(reason: ChipStatus, also: Creature | null): void {
    const chip = this.getChip();

    switch (reason) {
      case ChipStatus.CHIP_DROWNED:
        this.addSoundEffect(SND_WATER_SPLASH);
        this.removeCreature(chip, Tile.Water_Splash);
        break;
      case ChipStatus.CHIP_BOMBED:
        this.addSoundEffect(SND_BOMB_EXPLODES);
        this.removeCreature(chip, Tile.Bomb_Explosion);
        break;
      case ChipStatus.CHIP_OUTOFTIME:
        this.removeCreature(chip, Tile.Entity_Explosion);
        break;
      case ChipStatus.CHIP_BURNED:
        this.addSoundEffect(SND_CHIP_LOSES);
        this.removeCreature(chip, Tile.Entity_Explosion);
        break;
      case ChipStatus.CHIP_COLLIDED:
        this.addSoundEffect(SND_CHIP_LOSES);
        this.removeCreature(chip, Tile.Entity_Explosion);
        if (also && also !== chip) {
          this.removeCreature(also, Tile.Entity_Explosion);
        }
        break;
      default:
        break;
    }

    this.resetFloorSounds(false);
    this.startEndGameTimer();
    this.state.timeoffset = 1;
  }

  /* startendgametimer() macro. (lxlogic.c, see logic.h) */
  private startEndGameTimer(): void {
    this.state.lxstate.endgametimer = 12 + 1;
  }

  /*
   * The movement-decision layer. (lxlogic.c:498-1061)
   */

  /* Return TRUE if the given block is allowed to be moved in the given
   * direction. If flags includes CMM_PUSHBLOCKSNOW, then the indicated
   * movement of the block will be initiated. (lxlogic.c:694-718)
   */
  private canPushBlock(block: Creature, dir: number, flags: number): boolean {
    if (!this.canMakeMove(block, dir, flags)) {
      if (!block.moving && (flags & (CMM_PUSHBLOCKS | CMM_PUSHBLOCKSNOW))) {
        block.dir = dir;
        if (pedanticMode) {
          block.tdir = dir;
        }
      }
      return false;
    }
    if (flags & (CMM_PUSHBLOCKS | CMM_PUSHBLOCKSNOW)) {
      block.dir = dir;
      block.tdir = dir;
      block.state |= CS_PUSHED;
      if (flags & CMM_PUSHBLOCKSNOW) {
        this.advanceCreature(block, false);
      }
    }

    return true;
  }

  /* Return TRUE if the given creature is allowed to attempt to move in
   * the given direction. Side effects can and will occur from calling
   * this function, as indicated by flags. (lxlogic.c:724-818)
   */
  private canMakeMove(cr: Creature, dir: number, flags: number): boolean {
    let floor = this.floorAt(cr.pos);
    switch (floor) {
      case Tile.Wall_North:
        if (dir & NORTH) return false;
        break;
      case Tile.Wall_West:
        if (dir & WEST) return false;
        break;
      case Tile.Wall_South:
        if (dir & SOUTH) return false;
        break;
      case Tile.Wall_East:
        if (dir & EAST) return false;
        break;
      case Tile.Wall_Southeast:
        if (dir & (SOUTH | EAST)) return false;
        break;
      case Tile.IceWall_Northwest:
        if (dir & (SOUTH | EAST)) return false;
        break;
      case Tile.IceWall_Northeast:
        if (dir & (SOUTH | WEST)) return false;
        break;
      case Tile.IceWall_Southwest:
        if (dir & (NORTH | EAST)) return false;
        break;
      case Tile.IceWall_Southeast:
        if (dir & (NORTH | WEST)) return false;
        break;
      case Tile.Beartrap:
      case Tile.CloneMachine:
        if (!(flags & CMM_RELEASING)) return false;
        break;
      default:
        break;
    }

    if (
      isslide(floor) &&
      (cr.id !== Tile.Chip || this.getPossession(Tile.Boots_Slide) === 0) &&
      this.getSlideDir(floor, false) === back(dir)
    ) {
      return false;
    }

    let y = Math.floor(cr.pos / CXGRID);
    let x = cr.pos % CXGRID;
    y += dir === NORTH ? -1 : dir === SOUTH ? 1 : 0;
    x += dir === WEST ? -1 : dir === EAST ? 1 : 0;
    const to = y * CXGRID + x;

    if (x < 0 || x >= CXGRID) return false;
    if (y < 0 || y >= CYGRID) {
      if (pedanticMode) {
        if (flags & CMM_STARTMOVEMENT) {
          this.state.lxstate.mapbreached = 1;
          console.warn(`map breach in pedantic mode at (${x} ${y})`);
        }
      }
      return false;
    }

    floor = this.floorAt(to);
    if (floor === Tile.SwitchWall_Open || floor === Tile.SwitchWall_Closed) {
      floor ^= this.state.lxstate.togglestate;
    }

    if (cr.id === Tile.Chip) {
      const law = movelaws[floor];
      if (!law || !(law.chip & dir)) return false;
      if (floor === Tile.Socket && this.state.chipsneeded > 0) return false;
      if (isdoor(floor) && this.getPossession(floor) === 0) return false;
      if (this.isMarkedAnimated(to)) return false;
      const other = this.lookupCreature(to, false);
      if (other && other.id === Tile.Block) {
        if (!this.canPushBlock(other, dir, flags & ~CMM_RELEASING)) return false;
      }
      if (floor === Tile.HiddenWall_Temp || floor === Tile.BlueWall_Real) {
        if (flags & CMM_STARTMOVEMENT) {
          this.state.cellAt(to).top.id = Tile.Wall;
        }
        return false;
      }
    } else if (cr.id === Tile.Block) {
      if (cr.moving > 0) return false;
      const law = movelaws[floor];
      if (!law || !(law.block & dir)) return false;
      if (this.isLocationClaimed(to)) return false;
      if (flags & CMM_CLEARANIMATIONS) {
        if (this.isMarkedAnimated(to)) this.stopAnimationAt(to);
      }
    } else {
      const law = movelaws[floor];
      if (!law || !(law.creature & dir)) return false;
      if (this.isLocationClaimed(to)) return false;
      if (floor === Tile.Fire && cr.id !== Tile.Fireball) return false;
      if (flags & CMM_CLEARANIMATIONS) {
        if (this.isMarkedAnimated(to)) this.stopAnimationAt(to);
      }
    }

    return true;
  }

  /* This function embodies the movement behavior of all the creatures.
   * Given a creature, this function enumerates its desired direction of
   * movement and selects the first one that is permitted.
   * (lxlogic.c:828-932)
   */
  private chooseCreatureMove(cr: Creature): void {
    const choices: number[] = [NIL, NIL, NIL, NIL];
    let pdir = NIL;

    if (isanimation(cr.id)) return;

    cr.tdir = NIL;
    if (cr.id === Tile.Block) return;
    if (this.getFDir(cr) !== NIL) return;
    const floor = this.floorAt(cr.pos);
    if (floor === Tile.CloneMachine || floor === Tile.Beartrap) {
      cr.tdir = cr.dir;
      return;
    }

    const dir = cr.dir;

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
      case Tile.Walker:
        choices[0] = dir;
        choices[1] = WALKER_TURN;
        break;
      case Tile.Blob:
        choices[0] = BLOB_TURN;
        break;
      case Tile.Teeth: {
        if ((this.state.currenttime + this.state.stepping) & 4) return;
        let y = Math.floor(this.chipPos() / CXGRID) - Math.floor(cr.pos / CXGRID);
        let x = (this.chipPos() % CXGRID) - (cr.pos % CXGRID);
        const n0 = y < 0 ? NORTH : y > 0 ? SOUTH : NIL;
        if (y < 0) y = -y;
        const m0 = x < 0 ? WEST : x > 0 ? EAST : NIL;
        if (x < 0) x = -x;
        if (x > y) {
          choices[0] = m0;
          choices[1] = n0;
        } else {
          choices[0] = n0;
          choices[1] = m0;
        }
        pdir = choices[0]!;
        break;
      }
      default:
        break;
    }

    for (let n = 0; n < 4 && choices[n] !== NIL; ++n) {
      if (choices[n] === WALKER_TURN) {
        let m = this.lynxPrng() & 3;
        choices[n] = cr.dir;
        while (m--) {
          choices[n] = right(choices[n]!);
        }
      } else if (choices[n] === BLOB_TURN) {
        const cw = [NORTH, EAST, SOUTH, WEST];
        choices[n] = cw[this.state.mainprng.random4()]!;
      }
      cr.tdir = choices[n]!;
      if (this.canMakeMove(cr, choices[n]!, CMM_CLEARANIMATIONS)) return;
    }

    if (pdir !== NIL) cr.tdir = pdir;
  }

  /* Determine the direction of Chip's next move. If discard is true,
   * then Chip is not currently permitted to select a direction of
   * movement, and the player's input should not be retained.
   * (lxlogic.c:938-981)
   */
  private chooseChipMove(cr: Creature, discard: boolean): void {
    this.state.lxstate.pushing = 0;

    let dir = this.state.currentinput;
    this.state.currentinput = NIL;

    if (!directionalcmd(dir)) dir = NIL;

    if (dir === NIL || discard || this.state.lxstate.stuck) {
      cr.tdir = NIL;
      return;
    }

    this.state.lastmove = dir;
    cr.tdir = dir;

    if (cr.tdir !== NIL) dir = cr.tdir;
    else if (this.getFDir(cr) !== NIL) dir = this.getFDir(cr);
    else return;

    if (isDiagonal(dir)) {
      if (cr.dir & dir) {
        const f1 = this.canMakeMove(cr, cr.dir, CMM_PUSHBLOCKS);
        const f2 = this.canMakeMove(cr, cr.dir ^ dir, CMM_PUSHBLOCKS);
        dir = !f1 && f2 ? dir ^ cr.dir : cr.dir;
      } else {
        if (this.canMakeMove(cr, dir & (EAST | WEST), CMM_PUSHBLOCKS)) {
          dir &= EAST | WEST;
        } else {
          dir &= NORTH | SOUTH;
        }
      }
      cr.tdir = dir;
    } else {
      this.canMakeMove(cr, dir, CMM_PUSHBLOCKS);
    }
  }

  /* This function determines if the given creature is currently being
   * forced to move. (Ice, slide floors, and teleports are the three
   * possible causes of this. Bear traps and clone machines also cause
   * forced movement, but these are handled outside of the normal
   * movement sequence.) If so, the direction is stored in the
   * creature's fdir field, and true is returned unless the creature can
   * override the forced move. (lxlogic.c:991-1023)
   */
  private getForcedMove(cr: Creature): boolean {
    this.setFDir(cr, NIL);

    const floor = this.floorAt(cr.pos);

    if (this.state.currenttime === 0) return false;

    if (isice(floor)) {
      if (cr.id === Tile.Chip && this.getPossession(Tile.Boots_Ice) !== 0) return false;
      if (cr.id === Tile.Chip && this.state.lxstate.stuck) return false;
      if (cr.dir === NIL) return false;
      this.setFDir(cr, cr.dir);
      return true;
    } else if (isslide(floor)) {
      if (cr.id === Tile.Chip && this.getPossession(Tile.Boots_Slide) !== 0) return false;
      this.setFDir(cr, this.getSlideDir(floor, true));
      return !(cr.state & CS_SLIDETOKEN);
    } else if (cr.state & CS_TELEPORTED) {
      cr.state &= ~CS_TELEPORTED;
      this.setFDir(cr, cr.dir);
      return true;
    }

    return false;
  }

  /* Return the move a creature will make on the current tick.
   * (lxlogic.c:1027-1041)
   */
  private chooseMove(cr: Creature): boolean {
    if (cr.id === Tile.Chip) {
      this.chooseChipMove(cr, this.getForcedMove(cr));
      if (cr.tdir === NIL && this.getFDir(cr) === NIL) {
        this.resetFloorSounds(false);
      }
    } else {
      if (this.getForcedMove(cr)) {
        cr.tdir = NIL;
      } else if (cr.id !== Tile.Block) {
        this.chooseCreatureMove(cr);
      }
    }

    return cr.tdir !== NIL || this.getFDir(cr) !== NIL;
  }

  /* Update the location that Chip is currently moving into (and reset
   * the pointer to the creature that Chip is colliding with).
   * (lxlogic.c:1046-1061)
   */
  private checkMovingTo(): void {
    const cr = this.getChip();
    const dir = cr.tdir;
    if (dir === NIL || isDiagonal(dir)) {
      this.state.lxstate.chiptopos = -1;
      this.state.lxstate.chiptocr = null;
      return;
    }

    this.state.lxstate.chiptopos = cr.pos + (delta[dir] ?? 0);
    this.state.lxstate.chiptocr = null;
  }

  /*
   * The movement-execution layer. (lxlogic.c:1070-1521)
   */

  /* Move a creature standing on a teleport tile to the next teleport tile
   * (searching backwards through the map, with wraparound). Returns TRUE
   * if the creature was successfully moved. (lxlogic.c:1070-1109)
   */
  private teleportCreature(cr: Creature): boolean {
    const origpos = cr.pos;
    let pos = origpos;

    for (;;) {
      --pos;
      if (pos < 0) {
        pos += CXGRID * CYGRID;
      }
      if (this.floorAt(pos) === Tile.Teleport) {
        if (cr.id !== Tile.Chip) {
          this.removeClaim(cr.pos);
        }
        cr.pos = pos;
        if (!this.isLocationClaimed(pos) && this.canMakeMove(cr, cr.dir, 0)) {
          break;
        }
        if (pos === origpos) {
          if (cr.id === Tile.Chip) {
            this.state.lxstate.stuck = 1;
          } else {
            this.claimLocation(cr.pos);
          }
          return false;
        }
      } else if (this.isMarkedTeleport(pos)) {
        this.state.cellAt(pos).top.id = Tile.Teleport;
        if (pos === this.chipPos()) {
          this.getChip().hidden = true;
        }
      }
    }

    if (cr.id === Tile.Chip) {
      this.addSoundEffect(SND_TELEPORTING);
    } else {
      this.claimLocation(cr.pos);
    }
    cr.state |= CS_TELEPORTED;
    return true;
  }

  /* Release a creature currently inside a clone machine. If the creature
   * successfully exits, a new clone is created to replace it.
   * (lxlogic.c:1114-1144)
   */
  private activateCloner(pos: number): boolean {
    if (pos < 0) return false;
    if (pos >= CXGRID * CYGRID) {
      console.warn(
        `Off-map cloning attempted: (${pos % CXGRID} ${Math.floor(pos / CXGRID)})`,
      );
      return false;
    }
    if (this.floorAt(pos) !== Tile.CloneMachine) {
      console.warn(
        `Red button not connected to a clone machine at (${pos % CXGRID} ${Math.floor(pos / CXGRID)})`,
      );
      return false;
    }
    const cr = this.lookupCreature(pos, true);
    if (!cr) return false;
    const clone = this.newCreature();
    if (!clone) {
      return this.advanceCreature(cr, true) !== 0;
    }

    // *clone = *cr; — copy every field of the Creature struct.
    clone.pos = cr.pos;
    clone.id = cr.id;
    clone.dir = cr.dir;
    clone.moving = cr.moving;
    clone.frame = cr.frame;
    clone.hidden = cr.hidden;
    clone.state = cr.state;
    clone.tdir = cr.tdir;

    if (this.advanceCreature(cr, true) <= 0) {
      clone.hidden = true;
      return false;
    }
    return true;
  }

  /* Release any creature on a beartrap at the given location.
   * (lxlogic.c:1148-1167)
   */
  private springTrap(pos: number): void {
    if (pos < 0) return;
    if (pos >= CXGRID * CYGRID) {
      console.warn(
        `Off-map trap opening attempted: (${pos % CXGRID} ${Math.floor(pos / CXGRID)})`,
      );
      return;
    }
    if (!this.isMarkedBeartrap(pos)) {
      console.warn(
        `Brown button not connected to a beartrap at (${pos % CXGRID} ${Math.floor(pos / CXGRID)})`,
      );
      return;
    }
    const cr = this.lookupCreature(pos, true);
    if (cr && cr.dir !== NIL) {
      this.advanceCreature(cr, true);
    }
  }

  /* Initiate a move by the given creature. The direction of movement is
   * given by the tdir field, or the fdir field if tdir is NIL. releasing
   * must be true if the creature is moving out of a bear trap or clone
   * machine. +1 is returned if the creature succeeded in moving, 0 is
   * returned if the move could not be initiated, and -1 is returned if
   * the creature was killed in the attempt. (lxlogic.c:1180-1269)
   */
  private startMovement(cr: Creature, releasing: boolean): number {
    let dir: number;
    if (cr.tdir !== NIL) {
      dir = cr.tdir;
    } else if (this.getFDir(cr) !== NIL) {
      dir = this.getFDir(cr);
    } else {
      return 0;
    }

    cr.dir = dir;
    const floorfrom = this.floorAt(cr.pos);

    if (cr.id === Tile.Chip) {
      if (this.getPossession(Tile.Boots_Slide) === 0) {
        if (isslide(floorfrom) && cr.tdir === NIL) {
          cr.state |= CS_SLIDETOKEN;
        } else if (!isice(floorfrom) || this.getPossession(Tile.Boots_Ice) !== 0) {
          cr.state &= ~CS_SLIDETOKEN;
        }
      }
    }

    if (
      !this.canMakeMove(
        cr,
        dir,
        CMM_PUSHBLOCKSNOW |
          CMM_CLEARANIMATIONS |
          CMM_STARTMOVEMENT |
          (releasing ? CMM_RELEASING : 0),
      )
    ) {
      if (cr.id === Tile.Chip) {
        if (!this.state.lxstate.couldntmove) {
          this.state.lxstate.couldntmove = 1;
          this.addSoundEffect(SND_CANT_MOVE);
        }
        this.state.lxstate.pushing = 1;
      }
      if (isice(floorfrom) && (cr.id !== Tile.Chip || this.getPossession(Tile.Boots_Ice) === 0)) {
        cr.dir = back(dir);
        this.applyIceWallTurn(cr);
      }
      return 0;
    }

    if (this.state.lxstate.mapbreached && this.chipIsAlive()) {
      this.removeChip(ChipStatus.CHIP_COLLIDED, cr);
      return -1;
    }

    if (cr.id !== Tile.Chip) {
      this.removeClaim(cr.pos);
      if (cr.id !== Tile.Block && cr.pos === this.state.lxstate.chiptopos) {
        this.state.lxstate.chiptocr = cr;
      }
    } else if (this.state.lxstate.chiptocr && !this.state.lxstate.chiptocr.hidden) {
      this.state.lxstate.chiptocr.moving = 8;
      this.removeChip(ChipStatus.CHIP_COLLIDED, this.state.lxstate.chiptocr);
      return -1;
    }

    cr.pos += delta[dir] ?? 0;
    if (cr.id !== Tile.Chip) {
      this.claimLocation(cr.pos);
    }

    cr.moving += 8;

    if (cr.id !== Tile.Chip && cr.pos === this.chipPos() && !this.getChip().hidden) {
      this.removeChip(ChipStatus.CHIP_COLLIDED, cr);
      return -1;
    }
    if (cr.id === Tile.Chip) {
      this.state.lxstate.couldntmove = 0;
      const other = this.lookupCreature(cr.pos, false);
      if (other) {
        this.removeChip(ChipStatus.CHIP_COLLIDED, other);
        return -1;
      }
    }

    if (cr.state & CS_PUSHED) {
      this.state.lxstate.pushing = 1;
      this.addSoundEffect(SND_BLOCK_MOVING);
    }

    return +1;
  }

  /* Continue the given creature's move. (lxlogic.c:1273-1294) */
  private continueMovement(cr: Creature): boolean {
    if (isanimation(cr.id)) return true;

    if (cr.id === Tile.Chip && this.state.lxstate.stuck) return true;

    let speed = cr.id === Tile.Blob ? 1 : 2;
    const floor = this.floorAt(cr.pos);
    if (isslide(floor) && (cr.id !== Tile.Chip || this.getPossession(Tile.Boots_Slide) === 0)) {
      speed *= 2;
    } else if (isice(floor) && (cr.id !== Tile.Chip || this.getPossession(Tile.Boots_Ice) === 0)) {
      speed *= 2;
    }
    cr.moving -= speed;
    cr.frame = (cr.moving / 2) | 0;
    return cr.moving > 0;
  }

  /* Complete the movement of the given creature. Most side effects
   * produced by moving onto a tile occur at this point. False is
   * returned if the creature is removed by the time the function
   * returns. If stationary is true, we are in pedantic mode and handling
   * creatures starting on top of something. (lxlogic.c:1302-1473)
   */
  private endMovement(cr: Creature, stationary: boolean): boolean {
    let survived = true;

    if (isanimation(cr.id)) return true;

    const floor = this.floorAt(cr.pos);

    if (cr.id === Tile.Chip && this.state.lxstate.putwall !== -1) return true;

    if (cr.id === Tile.Chip && this.getPossession(Tile.Boots_Ice) === 0) {
      this.applyIceWallTurn(cr);
    }
    if (cr.id !== Tile.Chip && !stationary) {
      this.applyIceWallTurn(cr);
    }

    if (cr.id === Tile.Chip) {
      switch (floor) {
        case Tile.Water:
          if (this.getPossession(Tile.Boots_Water) === 0) {
            this.removeChip(ChipStatus.CHIP_DROWNED, null);
            survived = false;
          }
          break;
        case Tile.Fire:
          if (stationary) break;
          if (this.getPossession(Tile.Boots_Fire) === 0) {
            this.removeChip(ChipStatus.CHIP_BURNED, null);
            survived = false;
          }
          break;
        case Tile.Dirt:
        case Tile.BlueWall_Fake:
          this.state.cellAt(cr.pos).top.id = Tile.Empty;
          this.addSoundEffect(SND_TILE_EMPTIED);
          break;
        case Tile.PopupWall:
          this.state.cellAt(cr.pos).top.id = Tile.Wall;
          this.addSoundEffect(SND_WALL_CREATED);
          break;
        case Tile.Door_Red:
        case Tile.Door_Blue:
        case Tile.Door_Yellow:
        case Tile.Door_Green:
          if (floor !== Tile.Door_Green) {
            this.setPossession(floor, this.getPossession(floor) - 1);
          }
          this.state.cellAt(cr.pos).top.id = Tile.Empty;
          this.addSoundEffect(SND_DOOR_OPENED);
          break;
        case Tile.Key_Red:
        case Tile.Key_Blue:
        case Tile.Key_Yellow:
        case Tile.Key_Green:
          if (this.getPossession(floor) === 255) {
            this.setPossession(floor, -1);
          }
        // Intentional fall-through (matches lxlogic.c:1364).
        case Tile.Boots_Ice:
        case Tile.Boots_Slide:
        case Tile.Boots_Fire:
        case Tile.Boots_Water:
          this.setPossession(floor, this.getPossession(floor) + 1);
          this.state.cellAt(cr.pos).top.id = Tile.Empty;
          this.addSoundEffect(SND_ITEM_COLLECTED);
          break;
        case Tile.Burglar:
          this.setPossession(Tile.Boots_Ice, 0);
          this.setPossession(Tile.Boots_Slide, 0);
          this.setPossession(Tile.Boots_Fire, 0);
          this.setPossession(Tile.Boots_Water, 0);
          this.addSoundEffect(SND_BOOTS_STOLEN);
          break;
        case Tile.ICChip:
          if (stationary) break;
          if (this.state.chipsneeded) {
            --this.state.chipsneeded;
          }
          this.state.cellAt(cr.pos).top.id = Tile.Empty;
          this.addSoundEffect(SND_IC_COLLECTED);
          break;
        case Tile.Socket:
          this.state.cellAt(cr.pos).top.id = Tile.Empty;
          this.addSoundEffect(SND_SOCKET_OPENED);
          break;
        case Tile.Exit:
          cr.hidden = true;
          this.state.lxstate.completed = 1;
          this.addSoundEffect(SND_CHIP_WINS);
          break;
        default:
          break;
      }
    } else if (cr.id === Tile.Block) {
      switch (floor) {
        case Tile.Water:
          this.state.cellAt(cr.pos).top.id = Tile.Dirt;
          this.addSoundEffect(SND_WATER_SPLASH);
          this.removeCreature(cr, Tile.Water_Splash);
          survived = false;
          break;
        case Tile.Key_Blue:
          this.state.cellAt(cr.pos).top.id = Tile.Empty;
          break;
        default:
          break;
      }
    } else {
      switch (floor) {
        case Tile.Water:
          if (cr.id !== Tile.Glider) {
            this.addSoundEffect(SND_WATER_SPLASH);
            this.removeCreature(cr, Tile.Water_Splash);
            survived = false;
          }
          break;
        case Tile.Key_Blue:
          this.state.cellAt(cr.pos).top.id = Tile.Empty;
          break;
        default:
          break;
      }
    }

    if (!survived) return false;

    switch (floor) {
      case Tile.Bomb:
        if (stationary) break;
        this.state.cellAt(cr.pos).top.id = Tile.Empty;
        if (cr.id === Tile.Chip) {
          this.removeChip(ChipStatus.CHIP_BOMBED, null);
        } else {
          this.addSoundEffect(SND_BOMB_EXPLODES);
          this.removeCreature(cr, Tile.Bomb_Explosion);
        }
        survived = false;
        break;
      case Tile.Beartrap:
        if (stationary) break;
        this.addSoundEffect(SND_TRAP_ENTERED);
        break;
      case Tile.Button_Blue:
        if (stationary) break;
        this.turnTanks();
        this.addSoundEffect(SND_BUTTON_PUSHED);
        break;
      case Tile.Button_Green:
        if (stationary) break;
        this.state.lxstate.togglestate ^= Tile.SwitchWall_Open ^ Tile.SwitchWall_Closed;
        this.addSoundEffect(SND_BUTTON_PUSHED);
        break;
      case Tile.Button_Red:
        if (stationary) break;
        if (this.activateCloner(this.clonerFromButton(cr.pos))) {
          this.addSoundEffect(SND_BUTTON_PUSHED);
        }
        break;
      case Tile.Button_Brown:
        if (stationary) break;
        this.addSoundEffect(SND_BUTTON_PUSHED);
        break;
      case Tile.Socket:
      // Intentional fall-through (matches lxlogic.c:1465).
      case Tile.Dirt:
      case Tile.BlueWall_Fake:
        this.state.cellAt(cr.pos).top.id = Tile.Empty; // No sound effect
        break;
      default:
        break;
    }

    return survived;
  }

  /* Advance the movement of the given creature. If the creature is not
   * currently moving but should be, movement is initiated. If the
   * creature completes their movement, any and all appropriate side
   * effects are applied. If releasing is true, the movement is occurring
   * out-of-turn, as with movement across an open beartrap or an
   * activated clone machine. The return value is +1 if the creature
   * successfully moved (or successfully remained stationary), 0 if the
   * creature tried to move and failed, or -1 if the creature was killed
   * and exists no longer. (lxlogic.c:1485-1521)
   */
  private advanceCreature(cr: Creature, releasing: boolean): number {
    let tdir = NIL;

    if (cr.moving <= 0 && !isanimation(cr.id)) {
      if (releasing) {
        tdir = cr.tdir;
        cr.tdir = cr.dir;
      } else if (cr.tdir === NIL && this.getFDir(cr) === NIL) {
        if (pedanticMode && !this.endMovement(cr, true)) {
          return -1;
        }
        return +1;
      }

      const f = this.startMovement(cr, releasing);
      if (f > 0) {
        cr.hidden = false;
      }
      if (pedanticMode && f === 0 && !this.endMovement(cr, true)) {
        return -1;
      }
      if (f < 0) {
        return f;
      }
      if (f === 0) {
        if (releasing) {
          cr.tdir = tdir;
        }
        return 0;
      }
      cr.tdir = NIL;
    }

    if (!this.continueMovement(cr)) {
      if (!this.endMovement(cr, false)) {
        return -1;
      }
    }

    return +1;
  }

  /*
   * The housekeeping + lifecycle layer. (lxlogic.c:1612-2014)
   */

  /* SF_SHOWHINT flag accessors. (lxlogic.c:109-110) */
  private showHint(): void {
    this.state.statusflags |= SF_SHOWHINT;
  }

  private hideHint(): void {
    this.state.statusflags &= ~SF_SHOWHINT;
  }

  /* SF_INVALID flag accessors. (lxlogic.c:111-112) */
  private markInvalid(): void {
    this.state.statusflags |= SF_INVALID;
  }

  private isMarkedInvalid(): boolean {
    return (this.state.statusflags & SF_INVALID) !== 0;
  }

  /* Actions and checks that occur at the start of every tick.
   * (lxlogic.c:1612-1701 — minus the #ifndef NDEBUG debug/cheat blocks,
   * which are intentionally excluded from this port.)
   */
  private initialHousekeeping(): void {
    if (this.state.currenttime === 0) {
      this.lastRndSlideDir = this.state.initrndslidedir;
      this.lastStepping = this.state.stepping;
    }

    const chip = this.getChip();
    if (chip.id === Tile.Pushing_Chip) {
      chip.id = Tile.Chip;
    }

    if (!this.state.lxstate.endgametimer) {
      if (this.state.lxstate.completed) {
        this.startEndGameTimer();
        this.state.timeoffset = 1;
      } else if (this.state.timelimit && this.state.currenttime >= this.state.timelimit) {
        this.removeChip(ChipStatus.CHIP_OUTOFTIME, null);
      }
    }

    for (let i = 0; i < this.crEndIndex; i++) {
      const cr = this.state.creatures[i];
      if (!cr) continue;
      if (cr !== chip && cr.hidden) continue;
      if (cr.state & CS_REVERSE) {
        cr.state &= ~CS_REVERSE;
        if (cr.moving <= 0) {
          cr.dir = back(cr.dir);
        }
      }
    }
    for (let i = 0; i < this.crEndIndex; i++) {
      const cr = this.state.creatures[i];
      if (!cr) continue;
      if (cr.state & CS_PUSHED) {
        if (cr.hidden || cr.moving <= 0) {
          this.stopSoundEffect(SND_BLOCK_MOVING);
          cr.state &= ~CS_PUSHED;
        }
      }
    }

    if (this.state.lxstate.togglestate) {
      for (let pos = 0; pos < CXGRID * CYGRID; pos++) {
        const id = this.floorAt(pos);
        if (id === Tile.SwitchWall_Open || id === Tile.SwitchWall_Closed) {
          this.state.cellAt(pos).top.id ^= this.state.lxstate.togglestate;
        }
      }
      this.state.lxstate.togglestate = 0;
    }

    this.state.lxstate.chiptopos = -1;
    this.state.lxstate.chiptocr = null;
  }

  /* Actions and checks that occur at the end of every tick.
   * (lxlogic.c:1703-1708 — a no-op in the original; kept as a real method
   * for structural parity with advanceGame()'s call sequence.)
   */
  private finalHousekeeping(): void {
    return;
  }

  /* Set the state fields specifically used to produce the output.
   * (lxlogic.c:1710-1761)
   */
  private prepareDisplay(): void {
    const chip = this.getChip();
    const floor = this.floorAt(chip.pos);

    this.state.xviewpos = (chip.pos % CXGRID) * 8 + this.state.lxstate.xviewoffset * 8;
    this.state.yviewpos =
      Math.floor(chip.pos / CXGRID) * 8 + this.state.lxstate.yviewoffset * 8;
    if (chip.moving) {
      switch (chip.dir) {
        case NORTH:
          this.state.yviewpos += chip.moving;
          break;
        case WEST:
          this.state.xviewpos += chip.moving;
          break;
        case SOUTH:
          this.state.yviewpos -= chip.moving;
          break;
        case EAST:
          this.state.xviewpos -= chip.moving;
          break;
        default:
          break;
      }
    }

    if (!chip.hidden) {
      if (floor === Tile.HintButton && chip.moving <= 0) {
        this.showHint();
      } else {
        this.hideHint();
      }
      if (chip.id === Tile.Chip && this.state.lxstate.pushing) {
        chip.id = Tile.Pushing_Chip;
      }
      if (chip.moving) {
        this.resetFloorSounds(false);
        if (floor === Tile.Fire && this.getPossession(Tile.Boots_Fire)) {
          this.addSoundEffect(SND_FIREWALKING);
        } else if (floor === Tile.Water && this.getPossession(Tile.Boots_Water)) {
          this.addSoundEffect(SND_WATERWALKING);
        } else if (isice(floor)) {
          if (this.getPossession(Tile.Boots_Ice)) {
            this.addSoundEffect(SND_ICEWALKING);
          } else if (floor === Tile.Ice) {
            this.addSoundEffect(SND_SKATING_FORWARD);
          } else {
            this.addSoundEffect(SND_SKATING_TURN);
          }
        } else if (isslide(floor)) {
          if (this.getPossession(Tile.Boots_Slide)) {
            this.addSoundEffect(SND_SLIDEWALKING);
          } else {
            this.addSoundEffect(SND_SLIDING);
          }
        }
      }
      if (this.state.lxstate.stuck && isice(floor)) {
        this.addSoundEffect(SND_SKATING_FORWARD);
      }
    }
  }

  /*
   * The functions provided by the RulesetLogic interface.
   */

  /* Initialize the gamestate structure to the state at the beginning of
   * the level, using the data in the associated GameSetup. The level map
   * is decoded and assembled, the list of creatures is drawn up, and other
   * miscellaneous initializations are performed. (lxlogic.c:1772-1924)
   */
  initGame(): boolean {
    if (pedanticMode && this.state.statusflags & SF_BADTILES) {
      this.markInvalid();
    }

    this.state.creatures = [];
    this.crEndIndex = 0;
    let chipIndex = -1;

    for (let pos = 0; pos < CXGRID * CYGRID; pos++) {
      const cell = this.state.cellAt(pos);

      if (cell.top.id === Tile.Block_Static) {
        cell.top.id = crtile(Tile.Block, NORTH);
      }
      if (cell.bot.id === Tile.Block_Static) {
        cell.bot.id = crtile(Tile.Block, NORTH);
      }
      if (ismsspecial(cell.top.id) && cell.top.id !== Tile.Exited_Chip) {
        cell.top.id = Tile.Wall;
        if (pedanticMode) this.markInvalid();
      }
      if (ismsspecial(cell.bot.id) && cell.bot.id !== Tile.Exited_Chip) {
        cell.bot.id = Tile.Wall;
        if (pedanticMode) this.markInvalid();
      }
      if (cell.bot.id !== Tile.Empty) {
        if (!isfloor(cell.bot.id) || isfloor(cell.top.id)) {
          console.warn(
            `invalid "buried" tile at (${pos % CXGRID} ${Math.floor(pos / CXGRID)})`,
          );
          this.markInvalid();
        }
      }

      if (iscreature(cell.top.id)) {
        const cr: Creature = {
          pos,
          id: creatureid(cell.top.id),
          dir: creaturedirid(cell.top.id),
          moving: 0,
          hidden: false,
          state: 0,
          tdir: NIL,
          frame: 0,
        };
        if (pedanticMode && cr.id === Tile.Block && isice(cell.bot.id)) {
          cr.dir = NIL;
        }
        if (cr.id === Tile.Chip) {
          if (chipIndex >= 0) {
            console.warn("multiple Chips on the map!");
            this.markInvalid();
          }
          chipIndex = this.state.creatures.length;
          cr.dir = SOUTH;
          cr.state = 0;
        } else {
          cr.state = 0;
          this.claimLocation(pos);
        }
        this.setFDir(cr, NIL);
        cr.tdir = NIL;
        cr.frame = 0;
        this.state.creatures.push(cr);
        this.crEndIndex++;

        cell.top.id = cell.bot.id;
        cell.bot.id = Tile.Empty;
      }

      if (pedanticMode && (cell.top.id === Tile.Wall_North || cell.top.id === Tile.Wall_West)) {
        this.markInvalid();
      }
      if (cell.top.id === Tile.Beartrap) this.markBeartrap(pos);
      if (cell.top.id === Tile.Teleport) this.markTeleport(pos);
    }

    if (chipIndex < 0) {
      console.warn("Chip isn't on the map!");
      this.markInvalid();
      chipIndex = this.state.creatures.length;
      this.state.creatures.push({
        pos: 0,
        id: Tile.Nothing,
        dir: NIL,
        moving: 0,
        hidden: true,
        state: 0,
        tdir: NIL,
        frame: 0,
      });
      this.crEndIndex++;
    }

    if (chipIndex !== 0) {
      const tmp = this.state.creatures[0]!;
      this.state.creatures[0] = this.state.creatures[chipIndex]!;
      this.state.creatures[chipIndex] = tmp;
    }

    // Validate beartrap wirings. (lxlogic.c:1870-1882)
    for (let i = 0; i < this.state.trapcount; i++) {
      const xy = this.state.traps[i];
      if (!xy) continue;
      if (xy.from >= CXGRID * CYGRID || xy.to >= CXGRID * CYGRID) {
        console.warn("ignoring off-map beartrap wiring");
        xy.from = -1;
      } else if (this.floorAt(xy.from) !== Tile.Button_Brown) {
        console.warn(
          `invalid beartrap wiring: no button at (${xy.from % CXGRID} ${Math.floor(xy.to / CXGRID)})`,
        );
      } else if (this.floorAt(xy.to) !== Tile.Beartrap) {
        console.warn(
          `disabling miswired beartrap button at (${xy.to % CXGRID} ${Math.floor(xy.to / CXGRID)})`,
        );
        xy.from = -1;
      }
    }
    // Validate cloner wirings. (lxlogic.c:1883-1895)
    for (let i = 0; i < this.state.clonercount; i++) {
      const xy = this.state.cloners[i];
      if (!xy) continue;
      if (xy.from >= CXGRID * CYGRID || xy.to >= CXGRID * CYGRID) {
        console.warn("ignoring off-map cloner wiring");
        xy.from = -1;
      } else if (this.floorAt(xy.from) !== Tile.Button_Red) {
        console.warn(
          `invalid cloner wiring: no button at (${xy.from % CXGRID} ${Math.floor(xy.to / CXGRID)})`,
        );
      } else if (this.floorAt(xy.to) !== Tile.CloneMachine) {
        console.warn(
          `disabling miswired cloner button at (${xy.to % CXGRID} ${Math.floor(xy.to / CXGRID)})`,
        );
        xy.from = -1;
      }
    }

    this.state.keys[0] = this.state.keys[1] = this.state.keys[2] = this.state.keys[3] = 0;
    this.state.boots[0] = this.state.boots[1] = this.state.boots[2] = this.state.boots[3] = 0;

    this.state.lxstate.endgametimer = 0;
    this.state.lxstate.togglestate = 0;
    this.state.lxstate.couldntmove = 0;
    this.state.lxstate.pushing = 0;
    this.state.lxstate.stuck = pedanticMode ? (isice(this.floorAt(this.chipPos())) ? 1 : 0) : 0;
    this.state.lxstate.mapbreached = 0;
    this.state.lxstate.completed = 0;
    this.state.lxstate.chiptopos = -1;
    this.state.lxstate.chiptocr = null;
    this.state.lxstate.putwall = -1;
    this.state.lxstate.prng1 = 0;
    this.state.lxstate.prng2 = 0;
    this.state.initrndslidedir = this.lastRndSlideDir;
    this.state.stepping = this.lastStepping;
    this.state.lxstate.xviewoffset = 0;
    this.state.lxstate.yviewoffset = 0;

    this.prepareDisplay();
    this.state.soundeffects = 0;
    return !this.isMarkedInvalid();
  }

  /* Advance the game state by one tick. (lxlogic.c:1928-2006) */
  advanceGame(): number {
    this.initialHousekeeping();

    const chip = this.getChip();

    for (let i = this.crEndIndex - 1; i >= 0; i--) {
      const cr = this.state.creatures[i];
      if (!cr) continue;
      if (cr !== chip && cr.hidden) continue;
      if (isanimation(cr.id)) {
        --cr.frame;
        if (cr.frame < 0) {
          this.removeAnimation(cr);
        }
        continue;
      }
      if (cr === chip && this.state.lxstate.endgametimer) continue;
      if (cr.moving <= 0) {
        this.chooseMove(cr);
      }
    }

    if (this.getFDir(chip) === NIL && chip.tdir === NIL) {
      this.state.lxstate.couldntmove = 0;
    } else {
      this.checkMovingTo();
    }

    for (let i = this.crEndIndex - 1; i >= 0; i--) {
      const cr = this.state.creatures[i];
      if (!cr) continue;
      if (cr === chip && this.state.lxstate.completed) continue;
      if (cr !== chip && cr.hidden) continue;
      if (this.advanceCreature(cr, false) < 0) continue;
      cr.tdir = NIL;
      this.setFDir(cr, NIL);
      if (pedanticMode && this.floorAt(cr.pos) === Tile.PopupWall) {
        if (cr !== chip) {
          this.state.lxstate.putwall = this.chipPos();
        }
      }
      if (this.floorAt(cr.pos) === Tile.Button_Brown && cr.moving <= 0) {
        this.springTrap(this.trapFromButton(cr.pos));
      }
    }

    for (let i = this.crEndIndex - 1; i >= 0; i--) {
      const cr = this.state.creatures[i];
      if (!cr) continue;
      if (cr.hidden) continue;
      if (cr.moving) continue;
      if (this.floorAt(cr.pos) === Tile.Teleport) {
        this.teleportCreature(cr);
      }
    }

    if (this.state.lxstate.putwall !== -1) {
      if (!this.getChip().hidden) {
        if (this.floorAt(this.chipPos()) === Tile.Beartrap) {
          this.springTrap(this.chipPos());
        }
        this.state.cellAt(this.state.lxstate.putwall).top.id = Tile.Wall;
      }
      this.state.lxstate.putwall = -1;
    }

    this.finalHousekeeping();
    this.prepareDisplay();

    if (this.state.lxstate.endgametimer) {
      --this.state.timeoffset;
      --this.state.lxstate.endgametimer;
      if (this.state.lxstate.endgametimer === 0) {
        this.resetFloorSounds(true);
        return this.state.lxstate.completed ? 1 : -1;
      }
    }

    return 0;
  }

  /* Free resources associated with the current game state. Does nothing
   * in this port (no per-game resources are separately allocated).
   * (lxlogic.c:2010-2014)
   */
  endGame(): boolean {
    return true;
  }
}
