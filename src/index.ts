// Public API surface for tworld-engine.
//
// This package's job is to run the deterministic Tile World / Chip's
// Challenge game simulation (Lynx and MS rulesets) given raw .dat level
// bytes and an input stream. Rendering, sound playback, and wall-clock
// timing are the host application's responsibility; this engine only
// exposes the state a host needs to draw a frame and play sounds
// (creature positions, keys/boots, xviewpos/yviewpos, soundeffects bits).

export { Game } from "./game";
export { splitDatFile } from "./datfile";
export { expandLevelData } from "./decoder";
export { decodeSolution } from "./solution";
export type { SolutionInfo } from "./solution";

export {
  Ruleset,
  Tile,
  NIL,
  NORTH,
  WEST,
  SOUTH,
  EAST,
  CmdNone,
  CmdNorth,
  CmdWest,
  CmdSouth,
  CmdEast,
  CmdKeyMoveFirst,
  CmdKeyMoveLast,
  CmdMoveNop,
  CmdMoveFirst,
  CmdMoveLast,
  SND_CHIP_LOSES,
  SND_CHIP_WINS,
  SND_TIME_OUT,
  SND_TIME_LOW,
  SND_DEREZZ,
  SND_CANT_MOVE,
  SND_IC_COLLECTED,
  SND_ITEM_COLLECTED,
  SND_BOOTS_STOLEN,
  SND_TELEPORTING,
  SND_DOOR_OPENED,
  SND_SOCKET_OPENED,
  SND_BUTTON_PUSHED,
  SND_TILE_EMPTIED,
  SND_WALL_CREATED,
  SND_TRAP_ENTERED,
  SND_BOMB_EXPLODES,
  SND_WATER_SPLASH,
  SND_BLOCK_MOVING,
  SND_SKATING_FORWARD,
  SND_SKATING_TURN,
  SND_SLIDING,
  SND_SLIDEWALKING,
  SND_ICEWALKING,
  SND_WATERWALKING,
  SND_FIREWALKING,
  SND_COUNT,
} from "./constants";

// GameState is only ever constructed by Game internally; consumers read
// it via `game.state` for rendering/UI purposes, so only the type (not
// the constructor) is exposed.
export type { GameState } from "./state";
export { SF_NOSAVING, SF_INVALID, SF_BADTILES, SF_SHOWHINT, SF_NOANIMATION, SF_SHUTTERED } from "./state";

export type { GameSetup, Creature, Action, MapCell, MapTile } from "./types";
