import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { splitDatFile } from "../src/datfile";
import { Game } from "../src/game";
import { Ruleset, NIL } from "../src/constants";

const dat = new Uint8Array(readFileSync(new URL("../../tworld/data/intro.dat", import.meta.url)));

describe("Game (Lynx smoke)", () => {
  it("advances idle ticks deterministically", () => {
    const { levels } = splitDatFile(dat);
    const g = new Game(levels[0], Ruleset.Lynx);
    let r = 0;
    for (let i = 0; i < 50 && r === 0; i++) r = g.doTurn(NIL);
    expect(g.state.currenttime).toBeGreaterThan(0);
    expect(r).toBe(0);
  });
});
