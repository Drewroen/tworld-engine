import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { splitDatFile } from "../src/datfile";
import { GameState } from "../src/state";
import { expandLevelData } from "../src/decoder";
import { Tile } from "../src/constants";

const dat = readFileSync(new URL("../../tworld/data/intro.dat", import.meta.url));

describe("expandLevelData", () => {
  it("decodes intro level 1 into a 32x32 map with Chip present", () => {
    const { ruleset, levels } = splitDatFile(new Uint8Array(dat));
    const s = new GameState();
    s.game = levels[0];
    expect(expandLevelData(s)).toBe(true);
    // Chip tile appears somewhere in the top layer
    const hasChip = s.map.some(c => (c.top.id & ~3) === Tile.Chip);
    expect(hasChip).toBe(true);
    expect(s.chipsneeded).toBeGreaterThanOrEqual(0);
  });
});
