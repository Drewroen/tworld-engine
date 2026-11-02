// Parses a complete Tile World solution (.tws) file — the container that holds
// the per-level solution records consumed by src/solution.ts's decodeSolution.
//
// Ported from solution.c's readsolutionheader (tw-solution.c:221-247) and
// readsolution (tw-solution.c:488-533). The on-disk layout is:
//
//   HEADER
//    0-3   signature (35 33 9B 99)
//     4    ruleset (1=Lynx, 2=MS)
//    5-6   most recently visited level number (unused here)
//     7    count of bytes in the remainder of the header
//    8-xx  header extension bytes (skipped)
//
//   followed by a sequence of per-level records. Each record is a 4-byte
//   little-endian length `size`, then `size` payload bytes:
//
//     0-1   level number
//     2-5   level password (four ASCII characters)
//     6     other flags
//     7     initial random slide direction (low 3 bits) + stepping (next 3)
//     8-11  initial random number generator seed
//    12-15  time of solution in ticks (best time)
//    16-xx  solution move stream
//
//   A `size` of 0 is padding (skip four bytes); 0xFFFFFFFF terminates the
//   file. A `size` of 6 means the level's number and password are present but
//   no solution was recorded. A record whose level number is 0 and whose
//   password is empty is the level-set-name record written by
//   writesolutionsetname (tw-solution.c:274-282); its payload from offset 16 is
//   the NUL-terminated set name.
//
// decodeSolution expects a *whole* per-level record (including the 4-byte
// length prefix), because its field offsets (flags at 10, slide/stepping at 11,
// seed at 12, move stream at 20) are relative to that full record. parseTwsFile
// therefore hands back each record's full bytes rather than just the payload.

import { Ruleset } from "../../src/constants";

export interface TwsRecord {
  levelNumber: number;
  password: string;
  /** Raw payload bytes 6-9: other flags, slide/stepping, and RNG seed. */
  flags: number;
  slideStep: number;
  rndseed: number;
  /** Time of the solution in ticks (payload bytes 12-15). */
  bestTime: number;
  /**
   * The complete record (4-byte length prefix + payload), i.e. exactly the
   * byte layout decodeSolution expects to be handed.
   */
  recordBytes: Uint8Array;
}

export interface TwsFile {
  ruleset: Ruleset;
  setName: string | null;
  records: TwsRecord[];
}

const CSSIG = 0x999b3335;

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>>
      0)
  );
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

export function parseTwsFile(bytes: Uint8Array): TwsFile {
  if (bytes.length < 8) throw new Error("parseTwsFile: file too short");
  if (readUint32LE(bytes, 0) !== CSSIG) throw new Error("parseTwsFile: bad signature");

  const rulesetByte = bytes[4]!;
  let ruleset: Ruleset;
  if (rulesetByte === Ruleset.Lynx) ruleset = Ruleset.Lynx;
  else if (rulesetByte === Ruleset.MS) ruleset = Ruleset.MS;
  else throw new Error(`parseTwsFile: unknown ruleset byte ${rulesetByte}`);

  // bytes 5-6 (most recently visited level) are not needed.
  let offset = 8 + bytes[7]!;
  if (offset > bytes.length) throw new Error("parseTwsFile: header extension past end of file");

  const records: TwsRecord[] = [];
  let setName: string | null = null;

  while (offset + 4 <= bytes.length) {
    const recordStart = offset;
    const size = readUint32LE(bytes, offset);
    if (size === 0xffffffff) break; // end-of-file marker
    if (size === 0) {
      offset += 4; // padding
      continue;
    }
    if (recordStart + 4 + size > bytes.length) {
      throw new Error("parseTwsFile: truncated per-level record");
    }
    offset = recordStart + 4 + size;
    const payload = bytes.subarray(recordStart + 4, offset);

    const levelNumber = payload[0]! | (payload[1]! << 8);
    const password = ascii(payload, 2, 6);
    if (size === 6) continue; // number + password only; no solution stored

    const emptyPassword = payload[2] === 0 && payload[3] === 0 && payload[4] === 0 && payload[5] === 0;
    if (levelNumber === 0 && emptyPassword) {
      // Level-set-name record: payload[16..] is a NUL-terminated string.
      let end = 16;
      while (end < payload.length && payload[end] !== 0) end++;
      setName = ascii(payload, 16, end);
      continue;
    }

    records.push({
      levelNumber,
      password,
      flags: payload[6]!,
      slideStep: payload[7]!,
      rndseed: readUint32LE(payload, 8),
      bestTime: readUint32LE(payload, 12),
      recordBytes: bytes.subarray(recordStart, offset),
    });
  }

  return { ruleset, setName, records };
}
