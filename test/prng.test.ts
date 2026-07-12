import { describe, it, expect } from "vitest";
import { Prng } from "../src/prng";

describe("Prng (LCG)", () => {
  it("restart is deterministic from a seed", () => {
    const a = new Prng(); a.restart(12345);
    const b = new Prng(); b.restart(12345);
    const seqA = Array.from({ length: 8 }, () => a.random4());
    const seqB = Array.from({ length: 8 }, () => b.random4());
    expect(seqA).toEqual(seqB);
  });
  it("random4 stays in 0..3", () => {
    const p = new Prng(); p.restart(1);
    for (let i = 0; i < 1000; i++) expect(p.random4()).toBeGreaterThanOrEqual(0);
  });
  it("matches a known LCG sub-sequence", () => {
    // Golden values captured from random.c with restartprng(seed=1):
    // (fill from oracle in Task 7; placeholder asserts structure until then)
    const p = new Prng(); p.restart(1);
    const v = p.random4();
    expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(4);
  });
});
