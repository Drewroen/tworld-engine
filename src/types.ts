// Plain data interfaces ported from the original Tile World (Chip's Challenge)
// C source. Source: state.h:146-201, defs.h:187-201.

// state.h:146
export interface MapTile {
  id: number;
  state: number;
}

// state.h:147
export interface MapCell {
  top: MapTile;
  bot: MapTile;
}

// state.h:150
export interface XYConn {
  from: number;
  to: number;
}

// state.h:152-160
export interface Creature {
  pos: number;
  id: number;
  dir: number;
  moving: number;
  frame: number;
  hidden: boolean;
  state: number;
  tdir: number;
}

// defs.h:187 — deliberately reduced subset of the full C `gamesetup`,
// containing only the fields the simulation actually needs.
export interface GameSetup {
  number: number;
  time: number;
  leveldata: Uint8Array;
  name: string;
  passwd: string;
  author: string;
}

// state.h:mm — `typedef struct action { unsigned int when:23, dir:9; } action;`
export interface Action {
  when: number;
  dir: number;
}
