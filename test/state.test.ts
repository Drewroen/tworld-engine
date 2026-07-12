import { describe, it, expect } from "vitest";
import { GameState } from "../src/state";

describe("GameState", () => {
  it("allocates a 1024-cell two-layer map", () => {
    const s = new GameState();
    expect(s.map.length).toBe(1024);
    expect(s.map[0]).toHaveProperty("top");
    expect(s.map[0]).toHaveProperty("bot");
    expect(s.keys.length).toBe(4);
    expect(s.boots.length).toBe(4);
    expect(s.traps.length).toBe(256);
    expect(s.cloners.length).toBe(256);
  });
});
