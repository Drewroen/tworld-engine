// Shared constants transcribed from the original Tile World (Chip's Challenge) C source.
// Sources: state.h:14-128, defs.h:70-90, defs.h:149-179.

// --- Grid / timing constants (defs.h) ---
export const CXGRID = 32;
export const CYGRID = 32;
export const TICKS_PER_SECOND = 20;
export const MAXIMUM_TICK_COUNT = 0x7fffff;

// --- Ruleset (state.h) ---
export enum Ruleset {
  None = 0,
  Lynx = 1,
  MS = 2,
}

// --- Directions (state.h / defs.h) ---
export const NIL = 0;
export const NORTH = 1;
export const WEST = 2;
export const SOUTH = 4;
export const EAST = 8;

// logic.h:14-16 bit-rotation macros over the 4-bit direction nibble.
export const left = (d: number): number => ((d << 1) | (d >> 3)) & 15;
export const back = (d: number): number => ((d << 2) | (d >> 2)) & 15;
export const right = (d: number): number => ((d << 3) | (d >> 1)) & 15;

// Direction <-> index mapping (NORTH=0, WEST=1, SOUTH=2, EAST=3).
export const diridx = (d: number): number => (0x30210 >> (d * 2)) & 3;
export const idxdir = (i: number): number => 1 << (i & 3);

// --- Tile enum (state.h:14-116) ---
export enum Tile {
  Nothing = 0x00,

  Empty = 0x01,

  Slide_North = 0x02,
  Slide_West = 0x03,
  Slide_South = 0x04,
  Slide_East = 0x05,
  Slide_Random = 0x06,
  Ice = 0x07,
  IceWall_Northwest = 0x08,
  IceWall_Northeast = 0x09,
  IceWall_Southwest = 0x0a,
  IceWall_Southeast = 0x0b,
  Gravel = 0x0c,
  Dirt = 0x0d,
  Water = 0x0e,
  Fire = 0x0f,
  Bomb = 0x10,
  Beartrap = 0x11,
  Burglar = 0x12,
  HintButton = 0x13,

  Button_Blue = 0x14,
  Button_Green = 0x15,
  Button_Red = 0x16,
  Button_Brown = 0x17,
  Teleport = 0x18,

  Wall = 0x19,
  Wall_North = 0x1a,
  Wall_West = 0x1b,
  Wall_South = 0x1c,
  Wall_East = 0x1d,
  Wall_Southeast = 0x1e,
  HiddenWall_Perm = 0x1f,
  HiddenWall_Temp = 0x20,
  BlueWall_Real = 0x21,
  BlueWall_Fake = 0x22,
  SwitchWall_Open = 0x23,
  SwitchWall_Closed = 0x24,
  PopupWall = 0x25,

  CloneMachine = 0x26,

  Door_Red = 0x27,
  Door_Blue = 0x28,
  Door_Yellow = 0x29,
  Door_Green = 0x2a,
  Socket = 0x2b,
  Exit = 0x2c,

  ICChip = 0x2d,
  Key_Red = 0x2e,
  Key_Blue = 0x2f,
  Key_Yellow = 0x30,
  Key_Green = 0x31,
  Boots_Ice = 0x32,
  Boots_Slide = 0x33,
  Boots_Fire = 0x34,
  Boots_Water = 0x35,

  Block_Static = 0x36,

  Drowned_Chip = 0x37,
  Burned_Chip = 0x38,
  Bombed_Chip = 0x39,
  Exited_Chip = 0x3a,
  Exit_Extra_1 = 0x3b,
  Exit_Extra_2 = 0x3c,

  Overlay_Buffer = 0x3d,

  Floor_Reserved2 = 0x3e,
  Floor_Reserved1 = 0x3f,

  Chip = 0x40,

  Block = 0x44,

  Tank = 0x48,
  Ball = 0x4c,
  Glider = 0x50,
  Fireball = 0x54,
  Walker = 0x58,
  Blob = 0x5c,
  Teeth = 0x60,
  Bug = 0x64,
  Paramecium = 0x68,

  Swimming_Chip = 0x6c,
  Pushing_Chip = 0x70,

  Entity_Reserved2 = 0x74,
  Entity_Reserved1 = 0x78,

  Water_Splash = 0x7c,
  Bomb_Explosion = 0x7d,
  Entity_Explosion = 0x7e,
  Animation_Reserved1 = 0x7f,
}

// --- Creature tile packing (state.h) ---
// Creature tiles encode direction in the low 2 bits via diridx/idxdir.
export const crtile = (id: number, dir: number): number => id | diridx(dir);
export const creatureid = (id: number): number => id & ~3;
export const creaturedirid = (id: number): number => idxdir(id & 3);

// --- Taxon predicates (state.h:120-128) ---
export const isslide = (f: number): boolean => f >= Tile.Slide_North && f <= Tile.Slide_Random;
export const isice = (f: number): boolean => f >= Tile.Ice && f <= Tile.IceWall_Southeast;
export const isdoor = (f: number): boolean => f >= Tile.Door_Red && f <= Tile.Door_Green;
export const iskey = (f: number): boolean => f >= Tile.Key_Red && f <= Tile.Key_Green;
export const isboots = (f: number): boolean => f >= Tile.Boots_Ice && f <= Tile.Boots_Water;
export const ismsspecial = (f: number): boolean => f >= Tile.Drowned_Chip && f <= Tile.Overlay_Buffer;
export const isfloor = (f: number): boolean => f <= Tile.Floor_Reserved1;
export const iscreature = (f: number): boolean => f >= Tile.Chip && f < Tile.Water_Splash;
export const isanimation = (f: number): boolean => f >= Tile.Water_Splash && f <= Tile.Animation_Reserved1;

// --- Sound constants (defs.h:149-179) ---
export const SND_CHIP_LOSES = 0;
export const SND_CHIP_WINS = 1;
export const SND_TIME_OUT = 2;
export const SND_TIME_LOW = 3;
export const SND_DEREZZ = 4;
export const SND_CANT_MOVE = 5;
export const SND_IC_COLLECTED = 6;
export const SND_ITEM_COLLECTED = 7;
export const SND_BOOTS_STOLEN = 8;
export const SND_TELEPORTING = 9;
export const SND_DOOR_OPENED = 10;
export const SND_SOCKET_OPENED = 11;
export const SND_BUTTON_PUSHED = 12;
export const SND_TILE_EMPTIED = 13;
export const SND_WALL_CREATED = 14;
export const SND_TRAP_ENTERED = 15;
export const SND_BOMB_EXPLODES = 16;
export const SND_WATER_SPLASH = 17;
export const SND_ONESHOT_COUNT = 18;
export const SND_BLOCK_MOVING = 18;
export const SND_SKATING_FORWARD = 19;
export const SND_SKATING_TURN = 20;
export const SND_SLIDING = 21;
export const SND_SLIDEWALKING = 22;
export const SND_ICEWALKING = 23;
export const SND_WATERWALKING = 24;
export const SND_FIREWALKING = 25;
export const SND_COUNT = 26;

// --- Command constants (defs.h:70-90) ---
export const CmdNone = NIL;
export const CmdNorth = NORTH;
export const CmdWest = WEST;
export const CmdSouth = SOUTH;
export const CmdEast = EAST;
export const CmdKeyMoveFirst = NORTH;
export const CmdKeyMoveLast = NORTH | WEST | SOUTH | EAST;

export const MOUSERANGEMIN = -9;
export const MOUSERANGEMAX = 9;
export const MOUSERANGE = 19;

export const directionalcmd = (cmd: number): boolean => ((cmd & ~CmdKeyMoveLast) === 0);
