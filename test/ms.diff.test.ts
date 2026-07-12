// Differential verification: replays every test/fixtures/ms-*.fixture
// script through the TypeScript MS engine and asserts its per-tick digest
// is bit-exactly identical to the golden digest recorded from the real C
// oracle (tools/oracle/harness, see test/fixtures/*.digest.json).
//
// Mirrors test/lynx.diff.test.ts exactly (see that file for the fixture
// file-format note). One MS-specific wrinkle: mslogic.c's creature list is
// a private, unexported module-static with no accessor, so the oracle
// harness always emits "creatures":[] for MS digests; MsLogic likewise
// doesn't implement the optional activeCreatures() method, so
// Game.getCreatures() falls back to [] on the TS side too (see
// src/game.ts's getCreatures doc comment). This is a genuine,
// already-analyzed architectural limitation of the original C mslogic.c,
// not a gap for this port to paper over — the fidelity signal here comes
// from chipsNeeded/keys/boots/xview/yview/statusflags/soundeffects/
// mainprng instead of creature positions.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runScript } from "./helpers/run";
import type { TickDigest } from "./helpers/digest";

const fixturesDir = new URL("./fixtures/", import.meta.url);
const fixtureNames = readdirSync(fixturesDir)
  .filter((f) => f.startsWith("ms-") && f.endsWith(".fixture"))
  .sort();

function readGolden(name: string): TickDigest[] {
  const path = new URL(name.replace(/\.fixture$/, ".digest.json"), fixturesDir);
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TickDigest);
}

describe.each(fixtureNames)("MS differential: %s", (name) => {
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
