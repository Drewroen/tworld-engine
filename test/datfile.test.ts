import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { splitDatFile } from "../src/datfile";
import { Ruleset } from "../src/constants";

const dat = new Uint8Array(readFileSync(new URL("../../tworld/data/intro.dat", import.meta.url)));

describe("splitDatFile", () => {
  it("parses the intro set header and levels", () => {
    const { ruleset, levels } = splitDatFile(dat);
    expect(ruleset).toBe(Ruleset.MS);      // intro.dat ruleset word = 0x0002
    expect(levels.length).toBe(9);
    expect(levels[0].number).toBe(1);
    expect(levels[0].leveldata.length).toBeGreaterThan(0);
  });
});
