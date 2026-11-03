# Modding

The engine exposes a small, deterministic hook API. Mods are ordinary ES
modules: the host imports them and passes them to `Game`.

```ts
import { Game, Ruleset, defineMod, Tile, SND_FIREWALKING } from "tworld-engine";

const chargedFireboots = defineMod({
  id: "example.charged-fireboots",
  apiVersion: 1,
  rulesets: ["ms", "lynx"],

  hooks: {
    "item.collect": {
      when: { tile: Tile.Boots_Fire, who: "chip" },
      handler: (ctx, next) => {
        next(); // run the vanilla collection first
        ctx.api.setCounter("boot:fire:charges", 3);
      },
    },

    "hazard.enter": {
      when: { tile: Tile.Fire, who: "chip" },
      handler: (ctx, next) => {
        const charges = ctx.api.getCounter("boot:fire:charges");
        if (charges > 0) {
          ctx.api.setCounter("boot:fire:charges", charges - 1);
          ctx.api.addSound(SND_FIREWALKING);
          return true; // handled: do not run the vanilla burn check
        }
        return next();
      },
    },
  },
});

const game = new Game(level, Ruleset.MS, 0, { mods: [chargedFireboots] });
```

## Hook model

A hook is middleware:

```ts
handler(ctx, next) => result
```

- Call `next()` to run the vanilla/default behavior.
- Call `next()` and then do more work to **extend** it.
- Return without calling `next()` to **replace** it.
- `ctx.api` provides sounds, named counters, and persistent mod state.
- `ctx.state` is the live `GameState`; mods may inspect or mutate it.

Handlers run in a deterministic order: `priority` (lower first), then mod
order, then hook declaration order. Handlers must be synchronous.

## Available hooks

| Hook | Result | Fires when |
| --- | --- | --- |
| `game.init` | `void` | After the level has been initialized. |
| `game.beforeTick` | `void` | Before a tick is simulated. |
| `game.afterTick` | `number` | After a tick; may override the win/loss/in-progress result. |
| `move.canMake` | `boolean` | A creature/block tries to move. Veto or replace the decision. |
| `move.end` | `boolean` | Tile effects for a completed move have run; `ctx.survived` says whether the actor still exists. |
| `item.collect` | `void` | Chip collects an item (keys, boots, IC chip). |
| `hazard.enter` | `boolean` | Chip enters water/fire/bomb. Return `false` if the hazard killed Chip. |

Selectors narrow a hook:

```ts
when: {
  ruleset: ["ms", "lynx"],
  who: "chip",
  creature: Tile.Chip,
  tile: [Tile.Fire, Tile.Water],
}
```

`tile` matches the destination floor for movement hooks, and the item/hazard
for item/hazard hooks.

## Persistent state

Use `ctx.api.setCounter` / `getCounter` for named integer values such as
custom keys, charge counts, or collectibles. Use `ctx.api.getModState` /
`setModState` for arbitrary per-game data. Both live on `GameState` as plain
`counters` and `mod` objects, so hosts can serialize them.

Do not keep persistent state in module-level or closure variables: replays and
save/restore depend on all mod state being in `GameState`.

## Determinism

Hooks are part of the deterministic simulation. They must not use
`Math.random()`, `Date`, network access, or other nondeterministic sources.
If a mod needs randomness, use the engine's seeded PRNG and keep the draw count
stable. Standard replays with no mods are unaffected because the vanilla code
paths remain the default handlers.

## MS vs Lynx

Both rulesets expose the same hook names, but the default handlers differ
because the underlying engines differ. Use `ctx.ruleset` or the `ruleset`
selector when behavior should be version-specific. A mod that declares
`rulesets: ["ms"]` is skipped entirely under Lynx.

## Current scope and next steps

This first slice covers behavior hooks. Still planned:

- A tile/content registry for new item ids, file codes, and declarative
  `provides` / `requires` effects.
- More extension points (buttons, cloners, traps, creature AI, teleport,
  win/loss conditions, level loading).
- Mod-aware level compilation and asset manifests.
- Mod fingerprints in saved games and modded replays.
