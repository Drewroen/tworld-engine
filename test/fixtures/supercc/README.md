# SuperCC solution-set fixtures

These files are vendored verbatim from the
[SicklySilverMoon/SuperCC](https://github.com/SicklySilverMoon/SuperCC) test
data, at commit `3e92380dabbae2dcf4e86ed5dc7572695311c8d4`:

- `*.tws` — `testData/tws/` — public recorded solution sets (one per level set).
- `*.DAT` — `testData/sets/` — the matching level sets.

SuperCC uses the same pairing in
`src/test/java/emulator/SuperCCTest.java`, where each test asserts that every
recorded solution in a `.tws` file replays to a win in the corresponding `.DAT`
level set.

They are used here by:

- `test/solution.supercc.test.ts` — parses each `.tws` container and runs every
  per-level record through `decodeSolution`, checking structural invariants.
- `test/supercc/*.test.ts` — replays every recorded solution through the full
  engine and asserts each one wins.

## The `.tws` container

A `.tws` file is a header (signature `0x999B3335`, ruleset byte, and a variable
header extension) followed by a sequence of length-prefixed per-level records.
Each record carries the level number, password, RNG seed, best time, and the
move stream. The move stream uses the five variable-length encodings documented
in Tile World's `solution.c`. See `test/helpers/twsFile.ts` for the parser.

## Note on format #2

These files were written by SuperCC, whose `.tws` writer stamps the high nibble
of format #2's top time byte with `0x9` as a marker (Tile World's own writer
leaves it zero). The 27-bit format #2 delta is documented as having its top four
bits "always zero" (the timer is 23 bits), so `decodeSolution` masks that nibble
off. Without the mask, four solutions in these sets (which use format #2) decode
to garbage move times and fail to replay; with it, every solution wins. Tile
World's C reader does not mask and so cannot read SuperCC-written format #2
records at all.

## Licensing

The level sets are the community CCLP packs and the original `CHIPS.DAT`. They
are included here only as test fixtures, mirroring SuperCC's own test data. See
the SuperCC repository for their provenance and terms.
