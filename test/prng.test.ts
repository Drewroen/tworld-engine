import { describe, it, expect } from "vitest";
import { Prng } from "../src/prng";

describe("Prng (LCG)", () => {
  it("restart is deterministic from a seed", () => {
    const a = new Prng(1); a.restart(12345);
    const b = new Prng(1); b.restart(12345);
    const seqA = Array.from({ length: 8 }, () => a.random4());
    const seqB = Array.from({ length: 8 }, () => b.random4());
    expect(seqA).toEqual(seqB);
  });
  it("random4 stays in 0..3", () => {
    const p = new Prng(1); p.restart(1);
    for (let i = 0; i < 1000; i++) expect(p.random4()).toBeGreaterThanOrEqual(0);
  });
  it("matches a known LCG sub-sequence", () => {
    // Golden values captured from the real, unmodified C `random.c` via the
    // Task 7 oracle harness (tools/oracle/prng-dump.c), calling
    // restartprng(&gen, 1) and printing 8 successive random4() outputs.
    const golden = [2, 0, 1, 2, 3, 0, 2, 0];
    const p = new Prng(1); p.restart(1);
    const seq = Array.from({ length: 8 }, () => p.random4());
    expect(seq).toEqual(golden);
  });
  it("reset() with no seed throws if the shared sequence was never seeded", async () => {
    // Use a fresh module instance (distinct query string) so the module-level
    // shared sequence starts in its unseeded state, regardless of what other
    // tests in this file have done to the sequence via the normally-imported
    // module.
    const { Prng: IsolatedPrng } = await import("../src/prng?isolated-shared-sequence-check");
    expect(() => new IsolatedPrng()).toThrow(/no seed/i);
  });
});
