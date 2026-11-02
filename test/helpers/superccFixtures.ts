// Shared fixture table for the SuperCC-derived solution-replay tests.
//
// The .tws solution files and their matching .DAT level sets are vendored
// verbatim from SicklySilverMoon/SuperCC's testData (testData/tws and
// testData/sets) at commit 3e92380, where they are used by
// src/test/java/emulator/SuperCCTest.java to prove that every public solution
// in each set can be replayed to a win. See test/fixtures/supercc/README.md.

import { readFileSync } from "node:fs";
import { Ruleset } from "../../src/constants";

export interface SuperCcSet {
  /** .tws solution file name under test/fixtures/supercc/. */
  tws: string;
  /** Matching .DAT level set file name under test/fixtures/supercc/. */
  dat: string;
  ruleset: Ruleset;
  /** Level-set name recorded inside the .tws header. */
  setName: string;
  /** Number of levels in the .DAT file. */
  levelCount: number;
  /** Number of solution records stored in the .tws file. */
  solutionCount: number;
}

export const SUPERCC_SETS: readonly SuperCcSet[] = [
  {
    tws: "public_CCLP1-lynx.dac.tws",
    dat: "CCLP1-Lynx.DAT",
    ruleset: Ruleset.Lynx,
    setName: "public_CCLP1-lynx.dac",
    levelCount: 149,
    solutionCount: 149,
  },
  {
    tws: "public_CCLP1.dac.tws",
    dat: "CCLP1.DAT",
    ruleset: Ruleset.MS,
    setName: "public_CCLP1.dac",
    levelCount: 149,
    solutionCount: 149,
  },
  {
    tws: "public_CCLP2.dac.tws",
    dat: "CCLP2.DAT",
    ruleset: Ruleset.MS,
    setName: "public_CCLP2.dac",
    levelCount: 149,
    solutionCount: 149,
  },
  {
    tws: "public_CCLP3-lynx.dac.tws",
    dat: "CCLP3-Lynx.DAT",
    ruleset: Ruleset.Lynx,
    setName: "public_CCLP3-lynx.dac",
    levelCount: 149,
    solutionCount: 149,
  },
  {
    tws: "public_CCLP3.dac.tws",
    dat: "CCLP3.DAT",
    ruleset: Ruleset.MS,
    setName: "public_CCLP3.dac",
    levelCount: 149,
    solutionCount: 149,
  },
  {
    tws: "public_CCLP4-lynx.dac.tws",
    dat: "CCLP4-Lynx.DAT",
    ruleset: Ruleset.Lynx,
    setName: "public_CCLP4-lynx.dac",
    levelCount: 149,
    solutionCount: 149,
  },
  {
    tws: "public_CCLP4.dac.tws",
    dat: "CCLP4.DAT",
    ruleset: Ruleset.MS,
    setName: "public_CCLP4.dac",
    levelCount: 149,
    solutionCount: 149,
  },
  {
    tws: "public_CCLXP2.dac.tws",
    dat: "CCLXP2.DAT",
    ruleset: Ruleset.Lynx,
    setName: "public_CCLXP2.dac",
    levelCount: 149,
    solutionCount: 149,
  },
  {
    tws: "public_CHIPS-lynx.dac.tws",
    dat: "CHIPS-Lynx.DAT",
    ruleset: Ruleset.Lynx,
    setName: "public_CHIPS-lynx.dac",
    levelCount: 149,
    // CHIPS level 145 ("Thanks to...") is not playable under the Lynx
    // ruleset, so the set records no solution for it — hence 148, not 149.
    solutionCount: 148,
  },
  {
    tws: "public_CHIPS.dac.tws",
    dat: "CHIPS.DAT",
    ruleset: Ruleset.MS,
    setName: "public_CHIPS.dac",
    levelCount: 149,
    solutionCount: 149,
  },
];

export function readSuperCcFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../fixtures/supercc/${name}`, import.meta.url)));
}
