// Differential verification: replays every test/fixtures/lynx-*.fixture
// script through the TypeScript Lynx engine and asserts its per-tick digest
// is bit-exactly identical to the golden digest recorded from the real C
// oracle (tools/oracle/harness, see test/fixtures/*.digest.json).
//
// Note on file naming: an earlier draft of the task brief for this test
// imagined a "*.script.json" fixture format, but Task 7 (which built the
// oracle) settled on the simpler "*.fixture" key=value format actually
// documented in tools/oracle/gen-fixtures.sh and .superpowers/sdd/
// task-7-report.md. That is the real, authoritative format consumed here.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runScript } from "./helpers/run";
import type { TickDigest } from "./helpers/digest";

const fixturesDir = new URL("./fixtures/", import.meta.url);
const fixtureNames = readdirSync(fixturesDir)
  .filter((f) => f.startsWith("lynx-") && f.endsWith(".fixture"))
  .sort();

function readGolden(name: string): TickDigest[] {
  const path = new URL(name.replace(/\.fixture$/, ".digest.json"), fixturesDir);
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TickDigest);
}

describe.each(fixtureNames)("Lynx differential: %s", (name) => {
  it("matches the oracle digest tick-for-tick", () => {
    const golden = readGolden(name);
    const got = runScript(new URL(name, fixturesDir));

    // Compare tick-by-tick (rather than one blanket array-level toEqual) so
    // a mismatch's vitest failure output pinpoints the exact divergent tick
    // and field instead of dumping the whole array diff.
    expect(got.length).toBe(golden.length);
    for (let i = 0; i < golden.length; i++) {
      expect(got[i], `tick ${i}`).toEqual(golden[i]);
    }
  });
});
