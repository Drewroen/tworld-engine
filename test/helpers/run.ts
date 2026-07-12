// Parses a *.fixture file (the plain "key=value" format consumed by
// tools/oracle/gen-fixtures.sh — see that script and .superpowers/sdd/
// task-7-report.md for the authoritative schema) and replays it through the
// TypeScript Game/LynxLogic engine, producing the same per-tick digest
// array shape that tools/oracle/harness.c's stdout (parsed as JSON-lines)
// provides. Used by test/lynx.diff.test.ts to differentially compare the
// TS port against the C oracle.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NIL, Ruleset } from "../../src/constants";
import { splitDatFile } from "../../src/datfile";
import { Game } from "../../src/game";
import { dumpDigest, type TickDigest } from "./digest";

interface ParsedFixture {
  dat: string;
  level: number;
  ruleset: string;
  rndseed: number;
  rndslidedir: number;
  stepping: number;
  maxTicks: number;
  moves: Array<{ when: number; dir: number }>;
}

// Mirrors gen-fixtures.sh's own parsing: plain "key=value" lines, blank
// lines and "#"-prefixed comments ignored.
function parseFixture(text: string): ParsedFixture {
  const values: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    values[key] = value;
  }

  const moves = (values.moves ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const [when, dir] = token.split(":");
      return { when: Number(when), dir: Number(dir) };
    });

  return {
    dat: values.dat ?? "",
    level: Number(values.level ?? "0"),
    ruleset: values.ruleset ?? "lynx",
    rndseed: Number(values.rndseed ?? "0"),
    rndslidedir: Number(values.rndslidedir ?? "0"),
    stepping: Number(values.stepping ?? "0"),
    maxTicks: Number(values.maxTicks ?? "0"),
    moves,
  };
}

// Runs a fixture's script through the TS engine and returns one TickDigest
// per tick, stopping early once a nonzero result is seen (matching the
// oracle harness's own early-stop behavior — see harness.c's tick loop),
// including that final tick's digest.
export function runScript(fixturePath: URL | string): TickDigest[] {
  const fsPath = typeof fixturePath === "string" ? fixturePath : fileURLToPath(fixturePath);
  const fixture = parseFixture(readFileSync(fsPath, "utf8"));

  if (fixture.ruleset !== "lynx" && fixture.ruleset !== "ms") {
    throw new Error(`runScript: unsupported ruleset "${fixture.ruleset}"`);
  }
  const ruleset = fixture.ruleset === "ms" ? Ruleset.MS : Ruleset.Lynx;

  // dat is resolved relative to tworld/data/, i.e. from
  // tworld-engine/test/fixtures/*.fixture the path is
  // ../../../tworld/data/<dat> (matching gen-fixtures.sh's DATA_DIR).
  const datDir = resolve(dirname(fsPath), "../../../tworld/data");
  const datBytes = new Uint8Array(readFileSync(join(datDir, fixture.dat)));
  const { levels } = splitDatFile(datBytes);
  const level = levels[fixture.level];
  if (!level) {
    throw new Error(`runScript: level ${fixture.level} not found in ${fixture.dat}`);
  }

  const game = new Game(level, ruleset, fixture.rndseed);
  // Note: these two assignments are inert in practice (matching the real C
  // harness's own behavior) — LynxLogic.initGame(), already invoked inside
  // the Game constructor, unconditionally overwrites
  // state.initrndslidedir/state.stepping with its lastRndSlideDir/
  // lastStepping instance defaults (NORTH/0) at the end of initgame()
  // (lxlogic.c:1916-1917 does the same from its lastrndslidedir/laststepping
  // module statics). Those defaults are what get latched in at tick 0 via
  // initialHousekeeping(). Set here anyway, before the first doTurn call, to
  // faithfully mirror the point in program order where the C harness sets
  // them from its CLI args (also before logic->initgame()'s overwrite).
  game.state.initrndslidedir = fixture.rndslidedir;
  game.state.stepping = fixture.stepping;

  const digests: TickDigest[] = [];
  for (let tick = 0; tick < fixture.maxTicks; tick++) {
    const when = game.state.currenttime + 1;
    const move = fixture.moves.find((m) => m.when === when);
    const result = game.doTurn(move ? move.dir : NIL);
    digests.push(dumpDigest(game, result));
    if (result !== 0) break;
  }
  return digests;
}
