// Decoder for the .tws solution-file per-level move stream.
// Ported from solution.c:17-116 (format description) and
// solution.c:276-356 (expandsolution).

import type { Action } from "./types";

// solution.c:122-140 — translate move directions between the 3-bit index
// representation used by the move-stream encoding and the 4-bit
// NORTH/WEST/SOUTH/EAST bitmask representation used everywhere else in this
// port. Only idxdir8 (index -> bitmask) is needed for decoding.
//
// 0 = NORTH        = 0001 = 1
// 1 = WEST         = 0010 = 2
// 2 = SOUTH        = 0100 = 4
// 3 = EAST         = 1000 = 8
// 4 = NORTH | WEST = 0011 = 3
// 5 = SOUTH | WEST = 0110 = 6
// 6 = NORTH | EAST = 1001 = 9
// 7 = SOUTH | EAST = 1100 = 12
const idxdir8: readonly number[] = [1, 2, 4, 8, 3, 6, 9, 12];

// Per-level solution record layout (solution.c:35-49):
//  0-3   offset to next solution
//  4-5   level number
//  6-9   level password
//  10    other flags
//  11    initial random slide direction (low 3 bits) + stepping (next 3 bits)
// 12-15  initial random number generator seed
// 16-19  time of solution in ticks
// 20-xx  solution bytes (the move stream)
const FLAGS_OFFSET = 10;
const SLIDEDIR_STEPPING_OFFSET = 11;
const RNDSEED_OFFSET = 12;
const MOVESTREAM_OFFSET = 20;

export interface SolutionInfo {
  moves: Action[];
  rndseed: number;
  rndslidedir: number;
  stepping: number;
  flags: number;
}

// Decode one per-level solution record's move stream (solution.c:276-356,
// expandsolution) into an array of Actions with absolute `when` values.
//
// The move stream is a sequence of variable-length (1-5 byte) values, whose
// low 2 bits of the first byte select one of four encodings:
//   00 -> format #3: one byte, three packed 2-bit-direction moves, each with
//         an implicit tick-delta of 4 (T=3, i.e. delta-1) from the previous.
//   01 -> format #1 (1-byte form): 3-bit direction index, 3-bit tick-delta
//         (minus one, except the very first move).
//   10 -> format #1 (2-byte form): 3-bit direction index, 11-bit tick-delta
//         (minus one, except the very first move).
//   11 -> disambiguated by bit 4 of the first byte:
//         bit4=0 -> format #2 (4 bytes): 2-bit orthogonal-only direction,
//                   27-bit tick-delta (minus one, except the first move).
//         bit4=1 -> format #4 (2-5 bytes): 2-bit size selector, 9-bit raw
//                   direction value (used as-is, not translated via
//                   idxdir8 — solution.c doesn't translate it either, since
//                   this format also carries MS mouse-move commands), and a
//                   2/10/18/26-bit tick-delta (minus one, except the first
//                   move) depending on the size selector.
//
// The "minus one, except the first move" rule is implemented, as in the C
// source, by initializing the running `when` total to -1 before the loop:
// every move adds (delta + 1) to the running total uniformly, which for the
// first move (starting from -1) yields exactly the stored delta value
// un-decremented.
export function decodeSolution(bytes: Uint8Array): SolutionInfo {
  const flags = bytes[FLAGS_OFFSET] ?? 0;
  const b11 = bytes[SLIDEDIR_STEPPING_OFFSET] ?? 0;
  const rndslidedir = idxdir8[b11 & 0x07]!;
  const stepping = (b11 >> 3) & 0x07;
  const rndseed =
    (((bytes[RNDSEED_OFFSET] ?? 0) |
      ((bytes[RNDSEED_OFFSET + 1] ?? 0) << 8) |
      ((bytes[RNDSEED_OFFSET + 2] ?? 0) << 16) |
      ((bytes[RNDSEED_OFFSET + 3] ?? 0) << 24)) >>>
      0);

  const moves: Action[] = [];
  let when = -1;
  let p = MOVESTREAM_OFFSET;
  while (p < bytes.length) {
    const b0 = bytes[p]!;
    switch (b0 & 0x03) {
      case 0: {
        // Format #3: three packed 2-bit-direction moves, delta=4 each.
        when += 4;
        moves.push({ when, dir: idxdir8[(b0 >> 2) & 0x03]! });
        when += 4;
        moves.push({ when, dir: idxdir8[(b0 >> 4) & 0x03]! });
        when += 4;
        moves.push({ when, dir: idxdir8[(b0 >> 6) & 0x03]! });
        p += 1;
        break;
      }
      case 1: {
        // Format #1, 1-byte form.
        const dir = idxdir8[(b0 >> 2) & 0x07]!;
        when += ((b0 >> 5) & 0x07) + 1;
        moves.push({ when, dir });
        p += 1;
        break;
      }
      case 2: {
        // Format #1, 2-byte form.
        if (p + 2 > bytes.length) throw new Error("decodeSolution: truncated solution data");
        const b1 = bytes[p + 1]!;
        const dir = idxdir8[(b0 >> 2) & 0x07]!;
        when += ((b0 >> 5) & 0x07) + (b1 << 3) + 1;
        moves.push({ when, dir });
        p += 2;
        break;
      }
      case 3: {
        if (b0 & 0x10) {
          // Format #4: 2-5 bytes, raw 9-bit direction, 2/10/18/26-bit delta.
          const n = (b0 >> 2) & 0x03;
          if (p + 2 + n > bytes.length) throw new Error("decodeSolution: truncated solution data");
          const b1 = bytes[p + 1]!;
          const dir = ((b0 >> 5) & 0x07) | ((b1 & 0x3f) << 3);
          let delta = (b1 >> 6) & 0x03;
          for (let i = n - 1; i >= 0; i--) {
            delta += (bytes[p + 2 + i]! << (2 + i * 8)) >>> 0;
          }
          when += delta + 1;
          moves.push({ when, dir });
          p += 2 + n;
        } else {
          // Format #2: 4 bytes, 2-bit orthogonal direction, 27-bit delta.
          if (p + 4 > bytes.length) throw new Error("decodeSolution: truncated solution data");
          const dir = idxdir8[(b0 >> 2) & 0x03]!;
          const delta =
            ((b0 >> 5) & 0x07) | (bytes[p + 1]! << 3) | (bytes[p + 2]! << 11) | (bytes[p + 3]! << 19);
          when += delta + 1;
          moves.push({ when, dir });
          p += 4;
        }
        break;
      }
    }
  }

  return { moves, rndseed, rndslidedir, stepping, flags };
}
