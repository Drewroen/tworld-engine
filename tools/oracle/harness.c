/* harness.c: A headless driver for the real Tile World game logic
 * (lxlogic.c / mslogic.c), used as a bit-exactness oracle for the
 * TypeScript port.
 *
 * It reads a level directly out of a .dat file (walking just enough of the
 * file-level header itself -- see readDatLevel() below -- to avoid pulling
 * in series.c/fileio.c and their I/O abstractions), builds a gamestate by
 * hand exactly as play.c's initgamestate()/doturn() do (minus all OS/GUI
 * calls), and then drives the tick loop itself, printing one JSON digest
 * line per tick to stdout.
 *
 * Usage:
 *   ./harness <datfile> <levelIndex> <ruleset:ms|lynx> <rndseed> \
 *             <rndslidedir:0|1|2|4|8> <stepping:0-7> <maxTicks> \
 *             [when:dir ...]
 *
 * <when> is the tick number (matching state.currenttime, i.e. ticks after
 * the level starts, first tick is 0) at which to inject the directional
 * move <dir>. <dir> is one of: 0 (NIL/none), 1 (NORTH), 2 (WEST),
 * 4 (SOUTH), 8 (EAST) -- these match the NIL/NORTH/WEST/SOUTH/EAST macros
 * in gen.h directly, so no translation is needed. Ticks with no matching
 * "when:dir" entry get NIL (no input) that tick, same as a human not
 * pressing anything.
 *
 * Digest line schema (one line per tick, printed after logic->advancegame
 * runs for that tick):
 *
 *   {"t":<int>,"result":<int>,"chipsNeeded":<int>,
 *    "keys":[<int>,<int>,<int>,<int>],"boots":[<int>,<int>,<int>,<int>],
 *    "xview":<int>,"yview":<int>,"statusflags":<int>,"soundeffects":<uint>,
 *    "mainprng":<uint>,"lxprng1":<int>,"lxprng2":<int>,
 *    "creatures":[[pos,id,dir,moving,frame,hidden,state], ...]}
 *
 * NOTE on the MS "creatures" field: mslogic.c keeps its live creature list
 * in a module-static `static creature **creatures` array (see mslogic.c,
 * declared near the top of the file) that is NOT exposed through
 * `gamestate` or any exported accessor in logic.h. Since we must not modify
 * mslogic.c, the "creatures" array in MS-ruleset digests is always emitted
 * empty ("[]"). All other digest fields (chipsNeeded, keys, boots, view
 * position, statusflags, soundeffects, mainprng) are still fully populated
 * for MS and are the fidelity signal to use for the MS port's differential
 * tests.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "defs.h"
#include "err.h"
#include "state.h"
#include "encoding.h"
#include "logic.h"
#include "random.h"

#define SIG_DATFILE		0xAAAC
#define SIG_DATFILE_MS		0x0002
#define SIG_DATFILE_LYNX	0x0102

typedef struct move {
    int when;
    int dir;
} move;

static unsigned readu16(unsigned char const *p)
{
    return (unsigned)p[0] | ((unsigned)p[1] << 8);
}

/* Reads the whole file into a freshly malloc'd buffer, walks the
 * file-level header (2-byte signature, 2-byte ruleset word, 2-byte level
 * count, then per-level 2-byte size + that many bytes), and returns a
 * pointer to (and size of) the raw byte blob for the requested level
 * index. The returned blob pointer aliases into *filebufOut, which the
 * caller owns and must keep alive as long as the blob is used.
 */
static unsigned char *readDatLevel(char const *path, int levelIndex,
                                    long *blobSizeOut,
                                    unsigned char **filebufOut)
{
    FILE *fp = fopen(path, "rb");
    if (!fp) {
        fprintf(stderr, "cannot open %s\n", path);
        exit(1);
    }
    fseek(fp, 0, SEEK_END);
    long filesize = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    unsigned char *buf = malloc(filesize);
    if (!buf || fread(buf, 1, filesize, fp) != (size_t)filesize) {
        fprintf(stderr, "cannot read %s\n", path);
        exit(1);
    }
    fclose(fp);

    if (filesize < 6 || readu16(buf) != SIG_DATFILE) {
        fprintf(stderr, "%s: not a valid .dat file\n", path);
        exit(1);
    }
    unsigned rulesetword = readu16(buf + 2);
    if (rulesetword != SIG_DATFILE_MS && rulesetword != SIG_DATFILE_LYNX) {
        fprintf(stderr, "%s: unrecognized ruleset word 0x%04x\n", path, rulesetword);
        exit(1);
    }
    unsigned levelcount = readu16(buf + 4);
    if ((unsigned)levelIndex >= levelcount) {
        fprintf(stderr, "levelIndex %d out of range (file has %u levels)\n",
                levelIndex, levelcount);
        exit(1);
    }

    unsigned char *p = buf + 6;
    unsigned char *end = buf + filesize;
    for (unsigned n = 0; n < levelcount; ++n) {
        if (p + 2 > end) {
            fprintf(stderr, "%s: truncated level header\n", path);
            exit(1);
        }
        unsigned size = readu16(p);
        p += 2;
        if (p + size > end) {
            fprintf(stderr, "%s: truncated level data\n", path);
            exit(1);
        }
        if ((int)n == levelIndex) {
            *blobSizeOut = size;
            *filebufOut = buf;
            return p;
        }
        p += size;
    }

    fprintf(stderr, "levelIndex %d not found\n", levelIndex);
    exit(1);
    return NULL;
}

static void printDigest(gamestate *state, int ruleset, int result)
{
    printf("{\"t\":%d,\"result\":%d,\"chipsNeeded\":%d,"
           "\"keys\":[%d,%d,%d,%d],\"boots\":[%d,%d,%d,%d],"
           "\"xview\":%d,\"yview\":%d,\"statusflags\":%d,"
           "\"soundeffects\":%lu,\"mainprng\":%lu,"
           "\"lxprng1\":%d,\"lxprng2\":%d,\"creatures\":[",
           state->currenttime, result, state->chipsneeded,
           state->keys[0], state->keys[1], state->keys[2], state->keys[3],
           state->boots[0], state->boots[1], state->boots[2], state->boots[3],
           state->xviewpos, state->yviewpos, state->statusflags,
           state->soundeffects, state->mainprng.value,
           ruleset == Ruleset_Lynx ? (int)state->lxstate.prng1 : 0,
           ruleset == Ruleset_Lynx ? (int)state->lxstate.prng2 : 0);

    if (ruleset == Ruleset_Lynx) {
        creature *cr = state->creatures;
        int first = 1;
        if (cr) {
            for (; cr->id; ++cr) {
                if (!first)
                    printf(",");
                first = 0;
                printf("[%d,%d,%d,%d,%d,%d,%d]",
                       (int)cr->pos, (int)cr->id, (int)cr->dir,
                       (int)cr->moving, (int)cr->frame, (int)cr->hidden,
                       (int)cr->state);
            }
        }
    }
    /* MS ruleset: creature list is not exposed by mslogic.c (it lives in a
     * module-static `static creature **creatures` array), so it is left
     * empty here -- see file-header note above. */

    printf("]}\n");
}

int main(int argc, char **argv)
{
    if (argc < 8) {
        fprintf(stderr,
            "usage: %s <datfile> <levelIndex> <ms|lynx> <rndseed> "
            "<rndslidedir> <stepping> <maxTicks> [when:dir ...]\n", argv[0]);
        return 1;
    }

    char const *datfile = argv[1];
    int levelIndex = atoi(argv[2]);
    char const *rulesetName = argv[3];
    unsigned long rndseed = strtoul(argv[4], NULL, 10);
    int rndslidedir = atoi(argv[5]);
    int stepping = atoi(argv[6]);
    int maxTicks = atoi(argv[7]);

    int ruleset;
    if (strcmp(rulesetName, "ms") == 0)
        ruleset = Ruleset_MS;
    else if (strcmp(rulesetName, "lynx") == 0)
        ruleset = Ruleset_Lynx;
    else {
        fprintf(stderr, "ruleset must be \"ms\" or \"lynx\", got \"%s\"\n", rulesetName);
        return 1;
    }

    int moveCount = argc - 8;
    move *moves = malloc(sizeof(move) * (moveCount > 0 ? moveCount : 1));
    for (int i = 0; i < moveCount; ++i) {
        char const *arg = argv[8 + i];
        char const *colon = strchr(arg, ':');
        if (!colon) {
            fprintf(stderr, "bad move arg \"%s\", expected when:dir\n", arg);
            return 1;
        }
        moves[i].when = atoi(arg);
        moves[i].dir = atoi(colon + 1);
    }

    long blobSize;
    unsigned char *filebuf;
    unsigned char *blob = readDatLevel(datfile, levelIndex, &blobSize, &filebuf);

    gamesetup setup;
    memset(&setup, 0, sizeof setup);
    setup.leveldata = blob;
    setup.levelsize = blobSize;
    setup.number = blob[0] | (blob[1] << 8);
    setup.time = blob[2] | (blob[3] << 8);
    setup.besttime = TIME_NIL;

    gamestate state;
    memset(&state, 0, sizeof state);
    state.game = &setup;
    state.ruleset = ruleset;
    state.replay = -1;
    state.currenttime = -1;
    state.timeoffset = 0;
    state.currentinput = NIL;
    state.lastmove = NIL;
    state.initrndslidedir = (unsigned char)rndslidedir;
    state.stepping = (signed char)stepping;
    state.statusflags = 0;
    state.soundeffects = 0;
    state.timelimit = setup.time * TICKS_PER_SECOND;

    restartprng(&state.mainprng, rndseed);

    if (!expandleveldata(&state)) {
        fprintf(stderr, "expandleveldata failed for level %d\n", levelIndex);
        return 1;
    }

    gamelogic *logic = (ruleset == Ruleset_Lynx) ? lynxlogicstartup() : mslogicstartup();
    if (!logic) {
        fprintf(stderr, "failed to start up %s logic\n", rulesetName);
        return 1;
    }
    logic->state = &state;
    if (!logic->initgame(logic)) {
        fprintf(stderr, "initgame failed for level %d\n", levelIndex);
        return 1;
    }

    for (int tick = 0; tick < maxTicks; ++tick) {
        /* Mirrors the start of play.c's doturn(): clear the one-shot sound
         * effect bits before advancing. */
        state.soundeffects &= ~((1UL << SND_ONESHOT_COUNT) - 1);
        state.currenttime++;

        state.currentinput = NIL;
        for (int i = 0; i < moveCount; ++i) {
            if (moves[i].when == state.currenttime) {
                state.currentinput = moves[i].dir;
                break;
            }
        }

        int result = logic->advancegame(logic);
        printDigest(&state, ruleset, result);

        if (result != 0)
            break;
    }

    return 0;
}
