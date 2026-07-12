// Port of the multi-level .dat file header/splitting logic from
// series.c:171-285 (`readseriesheader`, `readleveldata`).

import { Ruleset } from "./constants";
import type { GameSetup } from "./types";

const SIG_DATFILE = 0xaaac;
const SIG_DATFILE_MS = 0x0002;
const SIG_DATFILE_LYNX = 0x0102;

function bytesToString(data: Uint8Array, pos: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(data[pos + i] ?? 0);
  }
  return s;
}

// Port of readleveldata's field-walk (series.c:205-262). `data` is the raw,
// still RLE-encoded per-level blob; only the 10-byte header and the two map
// layers' lengths are used here to skip to the metadata field section.
function parseLevel(data: Uint8Array): GameSetup {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const number = data.length >= 2 ? view.getUint16(0, true) : 0;
  let time = 0;
  let name = "";
  let passwd = "";
  let author = "";

  if (data.length >= 10) {
    time = view.getUint16(2, true);

    const upperSize = view.getUint16(8, true);
    let pos = 10 + upperSize;

    if (pos + 2 <= data.length) {
      const lowerSize = view.getUint16(pos, true);
      pos += 2 + lowerSize;

      if (pos + 2 <= data.length) {
        // metadata section size field (unused; fields are walked to dataend)
        pos += 2;

        const dataend = data.length;
        while (pos + 2 < dataend) {
          const fieldId = data[pos] ?? 0;
          let length = data[pos + 1] ?? 0;
          pos += 2;
          if (length > dataend - pos) length = dataend - pos;

          switch (fieldId) {
            case 1:
              if (length > 1) time = view.getUint16(pos, true);
              break;
            case 3:
              name = bytesToString(data, pos, length);
              break;
            case 6: {
              let s = "";
              for (let n = 0; n < length && n < 15 && (data[pos + n] ?? 0) !== 0; n++) {
                s += String.fromCharCode((data[pos + n] ?? 0) ^ 0x99);
              }
              passwd = s;
              break;
            }
            case 9:
              author = bytesToString(data, pos, length);
              break;
            default:
              break;
          }

          pos += length;
        }
      }
    }
  }

  return { number, time, leveldata: data, name, passwd, author };
}

// Port of readseriesheader (series.c:171-203) plus a loop over
// readleveldata (series.c:205-262).
export function splitDatFile(bytes: Uint8Array): { ruleset: Ruleset; levels: GameSetup[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const signature = view.getUint16(offset, true);
  offset += 2;
  if (signature !== SIG_DATFILE) {
    throw new Error("not a valid data file");
  }

  const rulesetWord = view.getUint16(offset, true);
  offset += 2;
  let ruleset: Ruleset;
  switch (rulesetWord) {
    case SIG_DATFILE_MS:
      ruleset = Ruleset.MS;
      break;
    case SIG_DATFILE_LYNX:
      ruleset = Ruleset.Lynx;
      break;
    default:
      throw new Error("data file uses an unrecognized ruleset");
  }

  const count = view.getUint16(offset, true);
  offset += 2;

  const levels: GameSetup[] = [];
  for (let i = 0; i < count; i++) {
    const size = view.getUint16(offset, true);
    offset += 2;
    const leveldata = bytes.slice(offset, offset + size);
    offset += size;
    levels.push(parseLevel(leveldata));
  }

  return { ruleset, levels };
}
