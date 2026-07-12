// Round-trips hand-built byte patterns (constructed by hand from the
// bit-layout rules documented in solution.c:56-116) through decodeSolution,
// one case per move-stream format (#1 1-byte, #1 2-byte, #2, #3, #4), plus
// the per-level header fields (flags, rndslidedir/stepping, rndseed).

import { describe, expect, it } from "vitest";
import { decodeSolution } from "../src/solution";

// Builds a minimal 20-byte per-level header (offset/level/password fields
// are irrelevant to decodeSolution and left zeroed) followed by the given
// move-stream bytes.
function record(header: { flags?: number; slideStep?: number; rndseed?: number }, moveBytes: number[]): Uint8Array {
  const bytes = new Uint8Array(20 + moveBytes.length);
  bytes[10] = header.flags ?? 0;
  bytes[11] = header.slideStep ?? 0;
  const seed = header.rndseed ?? 0;
  bytes[12] = seed & 0xff;
  bytes[13] = (seed >> 8) & 0xff;
  bytes[14] = (seed >> 16) & 0xff;
  bytes[15] = (seed >> 24) & 0xff;
  bytes.set(moveBytes, 20);
  return bytes;
}

describe("decodeSolution", () => {
  it("decodes the per-level header fields", () => {
    // byte11 = rndslidedir index 2 (SOUTH) | stepping 5 << 3 = 2 | 40 = 42
    const bytes = record({ flags: 5, slideStep: 42, rndseed: 0x12345678 }, []);
    const sol = decodeSolution(bytes);
    expect(sol.flags).toBe(5);
    expect(sol.rndslidedir).toBe(4); // SOUTH
    expect(sol.stepping).toBe(5);
    expect(sol.rndseed).toBe(0x12345678);
    expect(sol.moves).toEqual([]);
  });

  it("decodes format #1 (1-byte and 2-byte forms)", () => {
    // Move 1 (first move, not decremented): format #1 1-byte.
    // N=01, D=3 (EAST, idx3), T=3 -> byte = 1 | (3<<2) | (3<<5) = 0x6D.
    // Expected: when = -1 + 3 + 1 = 3, dir = EAST = 8.
    //
    // Move 2: format #1 1-byte. N=01, D=0 (NORTH, idx0), T=2 (stored delta,
    // representing an actual gap of 3 ticks) -> byte = 1 | (0<<2) | (2<<5) = 0x41.
    // Expected: when = 3 + 2 + 1 = 6, dir = NORTH = 1.
    //
    // Move 3: format #1 2-byte form. N=10, D=2 (SOUTH, idx2), T=300 (11 bits:
    // low 3 bits in byte0 bits5-7, remaining 8 bits in byte1).
    // T=300 -> T&7=4, T>>3=37. byte0 = 2 | (2<<2) | (4<<5) = 0x8A, byte1 = 37 = 0x25.
    // Expected: when = 6 + 300 + 1 = 307, dir = SOUTH = 4.
    const bytes = record({}, [0x6d, 0x41, 0x8a, 0x25]);
    const sol = decodeSolution(bytes);
    expect(sol.moves).toEqual([
      { when: 3, dir: 8 },
      { when: 6, dir: 1 },
      { when: 307, dir: 4 },
    ]);
  });

  it("decodes format #2 (4-byte, orthogonal-only, 27-bit delta)", () => {
    // First move: D=1 (WEST, idx1 -> 2), T=100000 (27 bits, split as
    // T&7 in byte0 bits5-7, then (T>>3) across bytes1-3 little-endian).
    // T=100000 -> T&7=0, T>>3=12500 -> byte1=212 (0xD4), byte2=48 (0x30), byte3=0.
    // byte0 = 3 | (1<<2) | (0<<4) | (0<<5) = 0x07.
    // Expected: when = -1 + 100000 + 1 = 100000, dir = WEST = 2.
    const bytes = record({}, [0x07, 0xd4, 0x30, 0x00]);
    const sol = decodeSolution(bytes);
    expect(sol.moves).toEqual([{ when: 100000, dir: 2 }]);
  });

  it("decodes format #3 (1-byte, three packed moves, implicit delta of 4)", () => {
    // byte = F<<6 | E<<4 | D<<2 | 00, with D=3 (EAST), E=0 (NORTH), F=1 (WEST).
    // byte = (1<<6) | (0<<4) | (3<<2) | 0 = 64 + 12 = 76 = 0x4C.
    // Expected (starting when=-1, each move steps +4): when=3/7/11.
    const bytes = record({}, [0x4c]);
    const sol = decodeSolution(bytes);
    expect(sol.moves).toEqual([
      { when: 3, dir: 8 }, // EAST
      { when: 7, dir: 1 }, // NORTH
      { when: 11, dir: 2 }, // WEST
    ]);
  });

  it("decodes format #4 (variable 2-5 bytes, raw 9-bit direction)", () => {
    // 2-byte form (NN=00): first move, raw dir=300 (9 bits: 3 low bits in
    // byte0 bits5-7, 6 high bits in byte1 bits0-5), T field = 3 (2 bits,
    // byte1 bits6-7).
    // dir&7=4, dir>>3=37. byte0 = 3 | (0<<2)[NN] | (1<<4)[marker] | (4<<5) = 0x93.
    // byte1 = 37 | (3<<6) = 0xE5.
    // Expected: when = -1 + 3 + 1 = 3, dir = 300 (raw, untranslated).
    const bytes = record({}, [0x93, 0xe5]);
    const sol = decodeSolution(bytes);
    expect(sol.moves).toEqual([{ when: 3, dir: 300 }]);
  });
});
