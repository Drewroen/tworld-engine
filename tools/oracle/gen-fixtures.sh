#!/usr/bin/env bash
# gen-fixtures.sh: Runs tools/oracle/harness over every fixture definition
# in test/fixtures/*.fixture and writes the resulting per-tick JSON-lines
# digest to a sibling test/fixtures/<name>.digest.json file.
#
# Fixture file format (test/fixtures/*.fixture): plain "key=value" lines,
# blank lines and "#"-prefixed comments ignored. Recognized keys:
#
#   dat         - .dat filename, resolved relative to tworld/data/
#   level       - level index within the .dat file (0-based)
#   ruleset     - "ms" or "lynx"
#   rndseed     - seed passed to restartprng()
#   rndslidedir - initial random-slide direction (0/1/2/4/8)
#   stepping    - initial timer stepping offset (0-7)
#   maxTicks    - number of ticks to simulate
#   moves       - space-separated "when:dir" pairs
#                 (dir: 0=NIL 1=NORTH 2=WEST 4=SOUTH 8=EAST)
#
# The generated *.digest.json file is JSON-lines: one JSON object per tick,
# in the schema documented atop harness.c. This is the format Tasks 10/12
# should read to build TypeScript-side differential ("does the TS engine
# produce byte-identical digests?") tests.
#
# Usage: ./gen-fixtures.sh   (run from tools/oracle/, or anywhere -- paths
# below are resolved relative to this script's own location)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORACLE_DIR="$SCRIPT_DIR"
FIXTURES_DIR="$SCRIPT_DIR/../../test/fixtures"
DATA_DIR="$SCRIPT_DIR/../../../tworld/data"
HARNESS="$ORACLE_DIR/harness"

if [ ! -x "$HARNESS" ]; then
    echo "building harness..."
    make -C "$ORACLE_DIR"
fi

shopt -s nullglob
fixtures=("$FIXTURES_DIR"/*.fixture)
if [ ${#fixtures[@]} -eq 0 ]; then
    echo "no *.fixture files found in $FIXTURES_DIR"
    exit 1
fi

for fixture in "${fixtures[@]}"; do
    name="$(basename "$fixture" .fixture)"
    echo "generating $name.digest.json from $(basename "$fixture")"

    dat="" level="" ruleset="" rndseed="" rndslidedir="" stepping="" maxTicks="" moves=""
    while IFS='=' read -r key value; do
        case "$key" in
            \#*|"") continue ;;
        esac
        case "$key" in
            dat) dat="$value" ;;
            level) level="$value" ;;
            ruleset) ruleset="$value" ;;
            rndseed) rndseed="$value" ;;
            rndslidedir) rndslidedir="$value" ;;
            stepping) stepping="$value" ;;
            maxTicks) maxTicks="$value" ;;
            moves) moves="$value" ;;
        esac
    done < "$fixture"

    datpath="$DATA_DIR/$dat"
    outfile="$FIXTURES_DIR/$name.digest.json"

    # shellcheck disable=SC2086 -- $moves is intentionally word-split into
    # separate "when:dir" positional args.
    "$HARNESS" "$datpath" "$level" "$ruleset" "$rndseed" "$rndslidedir" \
        "$stepping" "$maxTicks" $moves > "$outfile"
done

echo "done."
