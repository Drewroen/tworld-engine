// Deterministic pseudorandom number generator, ported from the original
// Tile World (Chip's Challenge) C source. Source: random.c:1-124.
//
// Determinism is the entire point of this port: solution replay depends on
// bit-exact reproduction of this LCG, so the exact arithmetic below matters
// more than idiomatic style.

// random.c:15 — `static unsigned long lastvalue = 0x80000000UL;` — the
// module-level "shared sequence" value chained across all shared-mode
// generators. Kept out-of-range (> 0x7FFFFFFF) initially, mirroring the C
// sentinel that random.c:52-53 uses to detect "never seeded"; exposed via
// resetSharedSequence() so tests can isolate the shared sequence instead of
// relying on wall-clock seeding (which this port deliberately omits).
let lastValue = 0x80000000;

// random.c:17-20
// static unsigned long nextvalue(unsigned long value)
// {
//     return ((value * 1103515245UL) + 12345UL) & 0x7FFFFFFFUL;
// }
function nextValue(value: number): number {
  return ((Math.imul(value, 1103515245) >>> 0) + 12345) & 0x7fffffff;
}

/** Reset the module-level shared sequence (random.c:15's `lastvalue`). Exposed for test isolation. */
export function resetSharedSequence(seed: number): void {
  lastValue = seed & 0x7fffffff;
}

export class Prng {
  // random.c:9-13 — struct prng { initial; value; shared; }
  initial = 0;
  value = 0;
  shared = true;

  constructor(seed?: number) {
    this.reset(seed);
  }

  // random.c:44-50
  // void resetprng(prng *gen)
  // {
  //     if (lastvalue > 0x7FFFFFFFUL)
  //         lastvalue = nextvalue(nextvalue(nextvalue(nextvalue(time(NULL)))));
  //     gen->value = gen->initial = lastvalue;
  //     gen->shared = TRUE;
  // }
  //
  // This port omits time()-based seeding: determinism requires an explicitly
  // injected seed. If no seed is supplied and the shared sequence has never
  // been seeded, the shared sequence is seeded with 0 (deterministic
  // fallback in place of time(NULL)).
  reset(seed?: number): void {
    if (seed !== undefined) {
      lastValue = seed & 0x7fffffff;
    } else if (lastValue > 0x7fffffff) {
      lastValue = nextValue(nextValue(nextValue(nextValue(0))));
    }
    this.value = this.initial = lastValue;
    this.shared = true;
  }

  // random.c:52-56
  // void restartprng(prng *gen, unsigned long seed)
  // {
  //     gen->value = gen->initial = seed & 0x7FFFFFFFUL;
  //     gen->shared = FALSE;
  // }
  restart(seed: number): void {
    this.value = this.initial = seed & 0x7fffffff;
    this.shared = false;
  }

  getInitialSeed(): number {
    return this.initial;
  }

  // random.c:32-38
  // static void nextrandom(prng *gen)
  // {
  //     if (gen->shared)
  //         gen->value = lastvalue = nextvalue(lastvalue);
  //     else
  //         gen->value = nextvalue(gen->value);
  // }
  private nextRandom(): void {
    if (this.shared) {
      lastValue = nextValue(lastValue);
      this.value = lastValue;
    } else {
      this.value = nextValue(this.value);
    }
  }

  // random.c:60-64
  // int random4(prng *gen)
  // {
  //     nextrandom(gen);
  //     return gen->value >> 29;
  // }
  random4(): number {
    this.nextRandom();
    return this.value >> 29;
  }

  // random.c:66-73
  // int randomof3(prng *gen, int a, int b, int c)
  // {
  //     int n;
  //     nextrandom(gen);
  //     n = (int)((3.0 * (gen->value & 0x3FFFFFFFUL)) / (double)0x40000000UL);
  //     return n < 2 ? n < 1 ? a : b : c;
  // }
  randomOf3(a: number, b: number, c: number): number {
    this.nextRandom();
    const n = Math.floor((3.0 * (this.value & 0x3fffffff)) / 0x40000000);
    return n < 2 ? (n < 1 ? a : b) : c;
  }

  // random.c:75-83
  // void randomp3(prng *gen, int *array)
  // {
  //     int n, t;
  //     nextrandom(gen);
  //     n = gen->value >> 30;
  //     t = array[n];  array[n] = array[1];  array[1] = t;
  //     n = (int)((3.0 * (gen->value & 0x3FFFFFFFUL)) / (double)0x40000000UL);
  //     t = array[n];  array[n] = array[2];  array[2] = t;
  // }
  randomP3(array: number[]): void {
    this.nextRandom();
    let n = this.value >> 30;
    let t = array[n]!;
    array[n] = array[1]!;
    array[1] = t;
    n = Math.floor((3.0 * (this.value & 0x3fffffff)) / 0x40000000);
    t = array[n]!;
    array[n] = array[2]!;
    array[2] = t;
  }

  // random.c:85-96
  // void randomp4(prng *gen, int *array)
  // {
  //     int n, t;
  //     nextrandom(gen);
  //     n = gen->value >> 30;
  //     t = array[n];  array[n] = array[1];  array[1] = t;
  //     n = (int)((3.0 * (gen->value & 0x0FFFFFFFUL)) / (double)0x10000000UL);
  //     t = array[n];  array[n] = array[2];  array[2] = t;
  //     n = (gen->value >> 28) & 3;
  //     t = array[n];  array[n] = array[3];  array[3] = t;
  // }
  randomP4(array: number[]): void {
    this.nextRandom();
    let n = this.value >> 30;
    let t = array[n]!;
    array[n] = array[1]!;
    array[1] = t;
    n = Math.floor((3.0 * (this.value & 0x0fffffff)) / 0x10000000);
    t = array[n]!;
    array[n] = array[2]!;
    array[2] = t;
    n = (this.value >> 28) & 3;
    t = array[n]!;
    array[n] = array[3]!;
    array[3] = t;
  }
}
