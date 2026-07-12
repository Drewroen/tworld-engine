import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { splitDatFile } from "../src/datfile";
import { Ruleset } from "../src/constants";

const dat = new Uint8Array(readFileSync(new URL("../../tworld/data/intro.dat", import.meta.url)));

describe("splitDatFile", () => {
  it("parses the intro set header and levels", () => {
    const { ruleset, levels } = splitDatFile(dat);
    expect(ruleset).toBe(Ruleset.MS);      // intro.dat ruleset word = 0x0002
    expect(levels.length).toBe(9);
    expect(levels[0].number).toBe(1);
    expect(levels[0].leveldata.length).toBeGreaterThan(0);
  });

  it("stops the metadata field walk with exactly 2 trailing bytes, matching series.c's `data + 2 < dataend`", () => {
    // Level blob: 10-byte header (number=1, time=0, 4 unused bytes, upperSize=0),
    // lowerSize=0, metadata size field=0 (unused), then a valid name field
    // (fieldId=3, length=2, "AB") followed by exactly 2 trailing bytes that
    // look like a spurious {fieldId:3, length:0} record. If the loop were to
    // enter on exactly 2 remaining bytes (the pre-fix bug), it would
    // misinterpret this padding and reset name to "".
    const level = new Uint8Array([
      0x01, 0x00, // number = 1
      0x00, 0x00, // time = 0
      0x00, 0x00, 0x00, 0x00, // unused
      0x00, 0x00, // upperSize = 0
      0x00, 0x00, // lowerSize = 0
      0x00, 0x00, // metadata size (unused)
      0x03, 0x02, 0x41, 0x42, // fieldId=3 (name), length=2, "AB"
      0x03, 0x00, // trailing padding: looks like {fieldId:3, length:0}
    ]);

    const header = new Uint8Array([
      0xac, 0xaa, // signature
      0x02, 0x00, // ruleset word = MS
      0x01, 0x00, // level count = 1
      level.length, 0x00, // level size
    ]);

    const bytes = new Uint8Array(header.length + level.length);
    bytes.set(header, 0);
    bytes.set(level, header.length);

    const { levels } = splitDatFile(bytes);
    expect(levels[0].name).toBe("AB");
  });
});
