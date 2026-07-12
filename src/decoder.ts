// Port of the MS .dat level-data decoder from encoding.c:28-309
// (`fileids[]` table and `expandmsdatlevel`).

import { CXGRID, CYGRID, Tile, crtile, NORTH, WEST, SOUTH, EAST } from "./constants";
import { GameState, SF_BADTILES } from "./state";

// encoding.c:28-141 — translation table for the codes used by the data file
// to define the initial state of a level.
export const fileids: number[] = [
  /* 00 empty space		*/ Tile.Empty,
  /* 01 wall			*/ Tile.Wall,
  /* 02 chip			*/ Tile.ICChip,
  /* 03 water			*/ Tile.Water,
  /* 04 fire			*/ Tile.Fire,
  /* 05 invisible wall, perm.	*/ Tile.HiddenWall_Perm,
  /* 06 blocked north		*/ Tile.Wall_North,
  /* 07 blocked west		*/ Tile.Wall_West,
  /* 08 blocked south		*/ Tile.Wall_South,
  /* 09 blocked east		*/ Tile.Wall_East,
  /* 0A block			*/ Tile.Block_Static,
  /* 0B dirt			*/ Tile.Dirt,
  /* 0C ice			*/ Tile.Ice,
  /* 0D force south		*/ Tile.Slide_South,
  /* 0E cloning block N		*/ crtile(Tile.Block, NORTH),
  /* 0F cloning block W		*/ crtile(Tile.Block, WEST),
  /* 10 cloning block S		*/ crtile(Tile.Block, SOUTH),
  /* 11 cloning block E		*/ crtile(Tile.Block, EAST),
  /* 12 force north		*/ Tile.Slide_North,
  /* 13 force east		*/ Tile.Slide_East,
  /* 14 force west		*/ Tile.Slide_West,
  /* 15 exit			*/ Tile.Exit,
  /* 16 blue door			*/ Tile.Door_Blue,
  /* 17 red door			*/ Tile.Door_Red,
  /* 18 green door		*/ Tile.Door_Green,
  /* 19 yellow door		*/ Tile.Door_Yellow,
  /* 1A SE ice slide		*/ Tile.IceWall_Southeast,
  /* 1B SW ice slide		*/ Tile.IceWall_Southwest,
  /* 1C NW ice slide		*/ Tile.IceWall_Northwest,
  /* 1D NE ice slide		*/ Tile.IceWall_Northeast,
  /* 1E blue block, tile		*/ Tile.BlueWall_Fake,
  /* 1F blue block, wall		*/ Tile.BlueWall_Real,
  /* 20 not used			*/ Tile.Overlay_Buffer,
  /* 21 thief			*/ Tile.Burglar,
  /* 22 socket			*/ Tile.Socket,
  /* 23 green button		*/ Tile.Button_Green,
  /* 24 red button		*/ Tile.Button_Red,
  /* 25 switch block, closed	*/ Tile.SwitchWall_Closed,
  /* 26 switch block, open	*/ Tile.SwitchWall_Open,
  /* 27 brown button		*/ Tile.Button_Brown,
  /* 28 blue button		*/ Tile.Button_Blue,
  /* 29 teleport			*/ Tile.Teleport,
  /* 2A bomb			*/ Tile.Bomb,
  /* 2B trap			*/ Tile.Beartrap,
  /* 2C invisible wall, temp.	*/ Tile.HiddenWall_Temp,
  /* 2D gravel			*/ Tile.Gravel,
  /* 2E pass once			*/ Tile.PopupWall,
  /* 2F hint			*/ Tile.HintButton,
  /* 30 blocked SE		*/ Tile.Wall_Southeast,
  /* 31 cloning machine		*/ Tile.CloneMachine,
  /* 32 force all directions	*/ Tile.Slide_Random,
  /* 33 drowning Chip		*/ Tile.Drowned_Chip,
  /* 34 burned Chip		*/ Tile.Burned_Chip,
  /* 35 burned Chip		*/ Tile.Bombed_Chip,
  /* 36 not used			*/ Tile.HiddenWall_Perm,
  /* 37 not used			*/ Tile.HiddenWall_Perm,
  /* 38 not used			*/ Tile.HiddenWall_Perm,
  /* 39 Chip in exit		*/ Tile.Exited_Chip,
  /* 3A exit - end game		*/ Tile.Exit_Extra_1,
  /* 3B exit - end game		*/ Tile.Exit_Extra_2,
  /* 3C Chip swimming N		*/ crtile(Tile.Swimming_Chip, NORTH),
  /* 3D Chip swimming W		*/ crtile(Tile.Swimming_Chip, WEST),
  /* 3E Chip swimming S		*/ crtile(Tile.Swimming_Chip, SOUTH),
  /* 3F Chip swimming E		*/ crtile(Tile.Swimming_Chip, EAST),
  /* 40 Bug N			*/ crtile(Tile.Bug, NORTH),
  /* 41 Bug W			*/ crtile(Tile.Bug, WEST),
  /* 42 Bug S			*/ crtile(Tile.Bug, SOUTH),
  /* 43 Bug E			*/ crtile(Tile.Bug, EAST),
  /* 44 Fireball N		*/ crtile(Tile.Fireball, NORTH),
  /* 45 Fireball W		*/ crtile(Tile.Fireball, WEST),
  /* 46 Fireball S		*/ crtile(Tile.Fireball, SOUTH),
  /* 47 Fireball E		*/ crtile(Tile.Fireball, EAST),
  /* 48 Pink ball N		*/ crtile(Tile.Ball, NORTH),
  /* 49 Pink ball W		*/ crtile(Tile.Ball, WEST),
  /* 4A Pink ball S		*/ crtile(Tile.Ball, SOUTH),
  /* 4B Pink ball E		*/ crtile(Tile.Ball, EAST),
  /* 4C Tank N			*/ crtile(Tile.Tank, NORTH),
  /* 4D Tank W			*/ crtile(Tile.Tank, WEST),
  /* 4E Tank S			*/ crtile(Tile.Tank, SOUTH),
  /* 4F Tank E			*/ crtile(Tile.Tank, EAST),
  /* 50 Glider N			*/ crtile(Tile.Glider, NORTH),
  /* 51 Glider W			*/ crtile(Tile.Glider, WEST),
  /* 52 Glider S			*/ crtile(Tile.Glider, SOUTH),
  /* 53 Glider E			*/ crtile(Tile.Glider, EAST),
  /* 54 Teeth N			*/ crtile(Tile.Teeth, NORTH),
  /* 55 Teeth W			*/ crtile(Tile.Teeth, WEST),
  /* 56 Teeth S			*/ crtile(Tile.Teeth, SOUTH),
  /* 57 Teeth E			*/ crtile(Tile.Teeth, EAST),
  /* 58 Walker N			*/ crtile(Tile.Walker, NORTH),
  /* 59 Walker W			*/ crtile(Tile.Walker, WEST),
  /* 5A Walker S			*/ crtile(Tile.Walker, SOUTH),
  /* 5B Walker E			*/ crtile(Tile.Walker, EAST),
  /* 5C Blob N			*/ crtile(Tile.Blob, NORTH),
  /* 5D Blob W			*/ crtile(Tile.Blob, WEST),
  /* 5E Blob S			*/ crtile(Tile.Blob, SOUTH),
  /* 5F Blob E			*/ crtile(Tile.Blob, EAST),
  /* 60 Paramecium N		*/ crtile(Tile.Paramecium, NORTH),
  /* 61 Paramecium W		*/ crtile(Tile.Paramecium, WEST),
  /* 62 Paramecium S		*/ crtile(Tile.Paramecium, SOUTH),
  /* 63 Paramecium E		*/ crtile(Tile.Paramecium, EAST),
  /* 64 Blue key			*/ Tile.Key_Blue,
  /* 65 Red key			*/ Tile.Key_Red,
  /* 66 Green key			*/ Tile.Key_Green,
  /* 67 Yellow key		*/ Tile.Key_Yellow,
  /* 68 Flippers			*/ Tile.Boots_Water,
  /* 69 Fire boots		*/ Tile.Boots_Fire,
  /* 6A Ice skates		*/ Tile.Boots_Ice,
  /* 6B Suction boots		*/ Tile.Boots_Slide,
  /* 6C Chip N			*/ crtile(Tile.Chip, NORTH),
  /* 6D Chip W			*/ crtile(Tile.Chip, WEST),
  /* 6E Chip S			*/ crtile(Tile.Chip, SOUTH),
  /* 6F Chip E			*/ crtile(Tile.Chip, EAST),
];

// encoding.c:18 — read a 16-bit value, stored little-endian.
export function readWord(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

// encoding.c:23 — read an x-y coordinate pair. An invalid x value always
// produces an invalid (out-of-bounds) coordinate.
export function readPos(data: Uint8Array, xOff: number, yOff: number): number {
  const x = data[xOff]!;
  const y = data[yOff]!;
  return x < CXGRID ? x + CYGRID * y : CXGRID * CYGRID;
}

const GRIDSIZE = CXGRID * CYGRID;

function translateId(rawId: number, state: GameState): number {
  if (rawId >= fileids.length) {
    state.statusflags |= SF_BADTILES;
    return Tile.Wall;
  }
  return fileids[rawId]!;
}

// Expand one RLE-encoded map layer starting at data[offset], length `size`
// bytes, writing translated tile ids into `layer` ("top" or "bot") of
// state.map. Mirrors the identical loops at encoding.c:176-192 and
// encoding.c:203-219.
function expandLayer(data: Uint8Array, offset: number, size: number, state: GameState, layer: "top" | "bot"): void {
  let pos = 0;
  let n = 0;
  while (n < size && pos < GRIDSIZE) {
    let count: number;
    let rawId: number;
    if (data[offset + n] === 0xff) {
      n++;
      count = data[offset + n]!;
      n++;
      rawId = data[offset + n]!;
    } else {
      count = 1;
      rawId = data[offset + n]!;
    }
    n++;
    const id = translateId(rawId, state);
    while (count-- > 0 && pos < GRIDSIZE) {
      state.map[pos]![layer].id = id;
      pos++;
    }
  }
}

// encoding.c:146-309 — expandmsdatlevel, ported faithfully.
export function expandLevelData(state: GameState): boolean {
  for (const cell of state.map) {
    cell.top.id = 0;
    cell.top.state = 0;
    cell.bot.id = 0;
    cell.bot.state = 0;
  }
  state.trapcount = 0;
  state.clonercount = 0;
  state.crlistcount = 0;
  state.hinttext = "";

  const setup = state.game;
  if (!setup) return false;
  const data = setup.leveldata;
  const levelsize = data.length;
  if (levelsize < 10) return false;

  const dataend = levelsize;

  if (readWord(data, 0) === 0) return false;
  state.chipsneeded = readWord(data, 4);

  if (readWord(data, 6) > 1) return false;

  let size = readWord(data, 8);
  let offset = 10;
  if (offset + size + 2 > dataend) return false;

  expandLayer(data, offset, size, state, "top");
  offset += size + 2;
  size = readWord(data, offset - 2);
  if (offset + size > dataend) return false;

  expandLayer(data, offset, size, state, "bot");
  offset += size;

  // Metadata section size field (unused beyond consistency; not enforced).
  size = readWord(data, offset);
  offset += 2;

  while (offset + 2 < dataend) {
    const fieldId = data[offset]!;
    let length = data[offset + 1]!;
    offset += 2;
    if (offset + length > dataend) length = dataend - offset;

    switch (fieldId) {
      case 2:
        if (length >= 2) state.chipsneeded = readWord(data, offset);
        break;
      case 4: {
        const count = Math.floor(length / 10);
        state.trapcount = count;
        for (let i = 0; i < count; i++) {
          const base = offset + i * 10;
          state.traps[i]!.from = readPos(data, base, base + 2);
          state.traps[i]!.to = readPos(data, base + 4, base + 6);
        }
        break;
      }
      case 5: {
        const count = Math.floor(length / 8);
        state.clonercount = count;
        for (let i = 0; i < count; i++) {
          const base = offset + i * 8;
          state.cloners[i]!.from = readPos(data, base, base + 2);
          state.cloners[i]!.to = readPos(data, base + 4, base + 6);
        }
        break;
      }
      case 7: {
        let s = "";
        for (let i = 0; i < length; i++) {
          s += String.fromCharCode(data[offset + i]!);
        }
        state.hinttext = s;
        break;
      }
      case 10: {
        const count = Math.floor(length / 2);
        state.crlistcount = count;
        for (let i = 0; i < count; i++) {
          const base = offset + i * 2;
          state.crlist[i] = readPos(data, base, base + 1);
        }
        break;
      }
      default:
        break;
    }

    offset += length;
  }

  return true;
}
