# tworld-engine

A TypeScript port of the [Tile World](https://github.com/eyecreate/tworld) Chip's
Challenge game logic — the Lynx and MS ruleset simulations, level decoding, and
solution (`.tws`) replay decoding. The port is verified bit-exact against a
compiled C oracle built from the original Tile World source, via per-tick
differential tests covering ice, force floors, blocks, monsters, teleports,
traps, and clone machines in both rulesets.

This package is a headless simulation engine only. It has no renderer, no
audio, and no wall clock: it owns its own tick counter and produces the same
sequence of states for the same inputs and seed every time. Drawing tiles,
playing sounds, and driving a real-time loop are the host application's job.

## Install

```sh
npm install tworld-engine
```

## Quickstart

```ts
import { Game, splitDatFile, Ruleset, NORTH } from "tworld-engine";

// The engine's only inputs are raw .dat file bytes and a chosen ruleset —
// there is no separate level-parsing step to run first.
const { levels } = splitDatFile(datBytes);

const game = new Game(levels[0], Ruleset.Lynx);

let result = 0;
while (result === 0) {
  result = game.doTurn(NORTH); // or any other direction bitmask, or NIL for no input
}
// result: +1 win, -1 loss.

// Read game.state for anything a host UI needs to render or play sounds for:
game.state.creatures;     // creature positions, directions, ids
game.state.keys;          // key counts by color
game.state.boots;         // boots held
game.state.xviewpos;      // viewport position (fixed-point), for scrolling
game.state.yviewpos;
game.state.soundeffects;  // bitmask of sound effects to play this tick
```

`Game` also exposes `secondsPlayed()`, `getSoundEffects()`, and
`getCreatures()` as convenience accessors over the same state.

## Replaying a solution

To deterministically replay a recorded `.tws` solution instead of driving the
game from live input, decode it and hand it to the game before ticking:

```ts
import { decodeSolution } from "tworld-engine";

const sol = decodeSolution(solutionBytes); // one level's solution record
game.prepareReplay(sol);

let result = 0;
while (result === 0) {
  result = game.doTurn(0); // input during replay comes from the recorded moves
}
```

`prepareReplay` seeds the engine's PRNG and initial random-slide direction
from the solution record, so the resulting tick sequence exactly reproduces
the original recorded playthrough.

## What this package does not do

- No rendering: tile/creature drawing, animation, and the viewport camera are
  a host UI's responsibility. The engine only exposes `xviewpos`/`yviewpos`
  and per-tile map state for a host to draw from.
- No audio: the engine only sets bits in `soundeffects`; playing sounds is up
  to the host.
- No wall-clock timing: `doTurn` advances the engine's internal tick counter
  by exactly one tick per call. Pacing calls at 20 ticks/second (or however
  fast a replay should run) is the caller's job.

## API

- `splitDatFile(bytes)` — splits a multi-level `.dat` file into its ruleset
  and an array of `GameSetup` level records.
- `expandLevelData(state)` — expands a level's RLE-encoded map data onto a
  `GameState`; called internally by `Game`, exposed for advanced use.
- `Game` — the game driver: construct with a `GameSetup`, a `Ruleset`, and an
  optional seed; drive with `doTurn(cmd)`; inspect via `.state`.
- `decodeSolution(bytes)` — decodes a `.tws` per-level solution record into a
  `SolutionInfo` (moves, seed, stepping, etc.) for use with
  `Game.prepareReplay`.
- `Ruleset`, `Tile`, direction constants (`NIL`, `NORTH`, `WEST`, `SOUTH`,
  `EAST`), command constants (`CmdNorth`, etc.), and sound-effect bit
  constants (`SND_*`) for interpreting `state.soundeffects`.
- Types: `GameState`, `GameSetup`, `Creature`, `Action`, `MapCell`,
  `MapTile`.
