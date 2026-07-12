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
//   This field is declared now but not yet maintained — that is the job of
//   the creature-list layer (newcreature/removecreature) in a later
//   sub-step.

import {
  CXGRID,
  CYGRID,
  NORTH,
  WEST,
  SOUTH,
  EAST,
  Ruleset,
  Tile,
  right,
  SND_SKATING_FORWARD,
  SND_SKATING_TURN,
  SND_FIREWALKING,
  SND_WATERWALKING,
  SND_ICEWALKING,
  SND_SLIDEWALKING,
  SND_SLIDING,
  SND_BLOCK_MOVING,
} from "../constants";
import { GameState } from "../state";
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
   * Lifecycle (RulesetLogic). Full implementations land in a later
   * sub-step (housekeeping + lifecycle layer); these are stubs so the
   * class satisfies the interface and the file type-checks.
   */

  initGame(): boolean {
    throw new Error("LynxLogic.initGame: not yet implemented");
  }

  advanceGame(): number {
    throw new Error("LynxLogic.advanceGame: not yet implemented");
  }

  endGame(): boolean {
    throw new Error("LynxLogic.endGame: not yet implemented");
  }
}
