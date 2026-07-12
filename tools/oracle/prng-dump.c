/* Throwaway diagnostic: dumps the first several random4() values from the
 * real C Prng after restartprng(seed=1). Used to backfill golden values in
 * test/prng.test.ts (Task 7).
 *
 * Not wired into the Makefile's default `harness` target. Compile standalone:
 *   cc -I../../../tworld -o prng-dump prng-dump.c ../../../tworld/random.c
 * Run from tools/oracle/.
 */
#include "random.h"
#include <stdio.h>
int main(void) {
    prng gen;
    restartprng(&gen, 1);
    for (int i = 0; i < 8; i++) {
        printf("%d\n", random4(&gen));
    }
    return 0;
}
