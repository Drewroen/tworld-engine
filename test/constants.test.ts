import { describe, it, expect } from "vitest";
import { Tile, NORTH, WEST, SOUTH, EAST, left, right, back, diridx, idxdir,
         crtile, creatureid, creaturedirid, iscreature, isfloor, isanimation } from "../src/constants";

describe("directions", () => {
  it("rotates left/right/back like the C macros", () => {
    expect(left(NORTH)).toBe(WEST);
    expect(right(NORTH)).toBe(EAST);
    expect(back(NORTH)).toBe(SOUTH);
    expect(left(EAST)).toBe(NORTH);
    expect(right(WEST)).toBe(NORTH);
  });
  it("diridx/idxdir round-trip", () => {
    for (const d of [NORTH, WEST, SOUTH, EAST]) expect(idxdir(diridx(d))).toBe(d);
    expect(diridx(NORTH)).toBe(0); expect(diridx(WEST)).toBe(1);
    expect(diridx(SOUTH)).toBe(2); expect(diridx(EAST)).toBe(3);
  });
});
describe("tile taxonomy", () => {
  it("packs/unpacks creature tiles", () => {
    const t = crtile(Tile.Glider, EAST);
    expect(creatureid(t)).toBe(Tile.Glider);
    expect(creaturedirid(t)).toBe(EAST);
    expect(iscreature(t)).toBe(true);
    expect(isfloor(Tile.Water)).toBe(true);
    expect(isanimation(Tile.Water_Splash)).toBe(true);
  });
});
