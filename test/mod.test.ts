// Tests for the hook spine. These use a minimal hand-built level so the
// behavior under test is isolated: Chip starts at (1,1), and the tile at
// (2,1) is whatever the test needs.

import { describe, expect, it } from "vitest";
import { Ruleset, Tile, EAST, NIL } from "../src/constants";
import { Game } from "../src/game";
import { ChipStatus } from "../src/logic/ms";
import { defineMod } from "../src/mod";
import type { GameSetup } from "../src/types";

const GRID = 32;
const at = (x: number, y: number): number => y * GRID + x;

function rle(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    let run = 1;
    while (i + run < data.length && data[i + run] === data[i] && run < 255) {
      run++;
    }
    if (run >= 3) {
      out.push(0xff, run, data[i]!);
    } else {
      for (let n = 0; n < run; n++) out.push(data[i]!);
    }
    i += run;
  }
  return Uint8Array.from(out);
}

/**
 * Build a minimal level blob. Raw ids use the standard fileids table:
 *   0x00 Empty, 0x02 ICChip, 0x04 Fire, 0x15 Exit, 0x69 Boots_Fire,
 *   0x6e Chip facing SOUTH.
 */
function makeLevel(options: {
  top?: readonly [number, number][];
  bot?: readonly [number, number][];
  chips?: number;
  time?: number;
}): GameSetup {
  const top = new Uint8Array(GRID * GRID);
  const bot = new Uint8Array(GRID * GRID);
  for (const [pos, id] of options.top ?? []) top[pos] = id;
  for (const [pos, id] of options.bot ?? []) bot[pos] = id;

  const topRle = rle(top);
  const botRle = rle(bot);
  const data = new Uint8Array(10 + topRle.length + 2 + botRle.length + 2);
  const view = new DataView(data.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, options.time ?? 100, true);
  view.setUint16(4, options.chips ?? 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, topRle.length, true);
  data.set(topRle, 10);

  let offset = 10 + topRle.length;
  view.setUint16(offset, botRle.length, true);
  offset += 2;
  data.set(botRle, offset);
  offset += botRle.length;
  view.setUint16(offset, 0, true);

  return {
    number: 1,
    time: options.time ?? 100,
    leveldata: data,
    name: "mod-test",
    passwd: "",
    author: "",
  };
}

function chipLevel(targetRawId: number, chips = 0): GameSetup {
  return makeLevel({
    top: [
      [at(1, 1), 0x6e], // Chip facing SOUTH
      [at(2, 1), targetRawId],
    ],
    chips,
  });
}

describe("mod hooks", () => {
  it("runs lifecycle hooks in order", () => {
    const mod = defineMod({
      id: "test.lifecycle",
      hooks: {
        "game.init": {
          handler: (ctx, next) => {
            ctx.api.setModState("init", true);
            next();
          },
        },
        "game.beforeTick": {
          handler: (ctx, next) => {
            ctx.api.modifyCounter("before", 1);
            next();
          },
        },
        "game.afterTick": {
          handler: (ctx, next) => {
            ctx.api.modifyCounter("after", 1);
            return next();
          },
        },
      },
    });

    const game = new Game(chipLevel(0x00), Ruleset.MS, 0, { mods: [mod] });
    expect(game.state.mod.init).toBe(true);

    expect(game.doTurn(NIL)).toBe(0);
    expect(game.state.counters.before).toBe(1);
    expect(game.state.counters.after).toBe(1);
  });

  it("lets game.afterTick override the tick result", () => {
    const mod = defineMod({
      id: "test.after-tick",
      hooks: {
        "game.afterTick": {
          handler: (_ctx, next) => {
            next();
            return 42;
          },
        },
      },
    });

    const game = new Game(chipLevel(0x00), Ruleset.MS, 0, { mods: [mod] });
    expect(game.doTurn(NIL)).toBe(42);
  });

  it("can veto a move via move.canMake", () => {
    const mod = defineMod({
      id: "test.block-move",
      hooks: {
        "move.canMake": {
          when: { who: "chip" },
          handler: (ctx, next) => {
            if (ctx.from === at(1, 1) && ctx.dir === EAST) {
              ctx.api.setModState("blocked", true);
              return false;
            }
            return next();
          },
        },
      },
    });

    const game = new Game(chipLevel(0x00), Ruleset.MS, 0, { mods: [mod] });
    game.doTurn(EAST);

    expect(game.state.mod.blocked).toBe(true);
    expect(game.state.creatures[0]!.pos).toBe(at(1, 1));
  });

  it("runs move.end after tile effects", () => {
    const mod = defineMod({
      id: "test.move-end",
      hooks: {
        "move.end": {
          when: { who: "chip" },
          handler: (ctx, next) => {
            const survived = next();
            ctx.api.modifyCounter("moveEnds", 1);
            ctx.api.setModState("lastMoveSurvived", survived);
            return survived;
          },
        },
      },
    });

    const game = new Game(chipLevel(0x00), Ruleset.MS, 0, { mods: [mod] });
    game.doTurn(EAST);

    expect(game.state.counters.moveEnds).toBe(1);
    expect(game.state.mod.lastMoveSurvived).toBe(true);
  });

  it("can extend item collection", () => {
    const mod = defineMod({
      id: "test.extend-fireboots",
      hooks: {
        "item.collect": {
          when: { tile: Tile.Boots_Fire, who: "chip" },
          handler: (ctx, next) => {
            next();
            ctx.api.setModState("firebootsExtended", true);
            ctx.api.setCounter("boot:fire:charges", 3);
          },
        },
      },
    });

    const game = new Game(chipLevel(0x69), Ruleset.MS, 0, { mods: [mod] });
    game.doTurn(EAST);

    expect(game.state.boots[2]).toBe(1);
    expect(game.state.mod.firebootsExtended).toBe(true);
    expect(game.state.counters["boot:fire:charges"]).toBe(3);
  });

  it.each([
    ["MS", Ruleset.MS],
    ["Lynx", Ruleset.Lynx],
  ])("can replace hazard behavior (%s)", (_name, ruleset) => {
    const mod = defineMod({
      id: "test.hazard-override",
      hooks: {
        "hazard.enter": {
          when: { tile: Tile.Fire, who: "chip" },
          handler: (ctx) => {
            ctx.api.setModState("savedFromFire", true);
            return true; // handled; do not run the vanilla burn check
          },
        },
      },
    });

    const game = new Game(chipLevel(0x04), ruleset, 0, { mods: [mod] });
    let result = game.doTurn(EAST);
    // Lynx animates movement across several ticks; MS resolves it in one.
    for (let i = 0; i < 12 && result === 0; i++) result = game.doTurn(NIL);

    expect(game.state.mod.savedFromFire).toBe(true);
    expect(game.state.msstate.chipstatus).toBe(ChipStatus.CHIP_OKAY);
  });
});
