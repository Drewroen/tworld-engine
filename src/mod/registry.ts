// Deterministic hook registry.
//
// Hooks are sorted by priority, then by mod order, then by the fixed
// HOOK_NAMES order below. That makes middleware execution reproducible for a
// given mod list, which replay verification depends on.

import { Ruleset } from "../constants";
import type { GameState } from "../state";
import {
  MOD_API_VERSION,
  type BaseHookContext,
  type HookDefinition,
  type HookHandler,
  type HookName,
  type HookSelector,
  type Mod,
  type ModApi,
  type OneOrMany,
  type RulesetName,
} from "./types";

const HOOK_NAMES: readonly HookName[] = [
  "game.init",
  "game.beforeTick",
  "game.afterTick",
  "move.canMake",
  "move.end",
  "item.collect",
  "hazard.enter",
];

interface RegisteredHook {
  name: HookName;
  selector: HookSelector | undefined;
  priority: number;
  order: number;
  modId: string;
  handler: HookHandler<any, any>;
}

function includes<T>(value: OneOrMany<T>, target: T): boolean {
  return Array.isArray(value) ? value.includes(target) : value === target;
}

function rulesetName(ruleset: Ruleset): RulesetName | null {
  if (ruleset === Ruleset.MS) return "ms";
  if (ruleset === Ruleset.Lynx) return "lynx";
  return null;
}

function modSupportsRuleset(mod: Mod, ruleset: Ruleset): boolean {
  if (mod.rulesets === undefined) return true;
  const name = rulesetName(ruleset);
  return name !== null && includes(mod.rulesets, name);
}

function selectorMatches(selector: HookSelector | undefined, ctx: BaseHookContext): boolean {
  if (!selector) return true;

  if (selector.ruleset !== undefined) {
    const name = rulesetName(ctx.ruleset);
    if (name === null || !includes(selector.ruleset, name)) return false;
  }

  if (selector.who !== undefined) {
    if (ctx.who === undefined || !includes(selector.who, ctx.who)) return false;
  }

  if (selector.creature !== undefined) {
    const id = ctx.creature?.id;
    if (id === undefined || !includes(selector.creature, id)) return false;
  }

  if (selector.tile !== undefined) {
    if (ctx.tileId === undefined || !includes(selector.tile, ctx.tileId)) return false;
  }

  return true;
}

export function createModApi(state: GameState): ModApi {
  return {
    addSound(sfx: number): void {
      state.soundeffects |= 1 << sfx;
    },
    getCounter(name: string): number {
      return state.counters[name] ?? 0;
    },
    setCounter(name: string, value: number): void {
      state.counters[name] = value;
    },
    modifyCounter(name: string, delta: number): number {
      const next = (state.counters[name] ?? 0) + delta;
      state.counters[name] = next;
      return next;
    },
    getModState<T = unknown>(key: string): T | undefined {
      return state.mod[key] as T | undefined;
    },
    setModState(key: string, value: unknown): void {
      state.mod[key] = value;
    },
  };
}

export class HookRegistry {
  readonly api: ModApi;

  private readonly hooks = new Map<HookName, RegisteredHook[]>();
  private order = 0;

  constructor(mods: readonly Mod[], ruleset: Ruleset, state: GameState) {
    this.api = createModApi(state);

    for (const mod of mods) {
      if (!modSupportsRuleset(mod, ruleset)) continue;

      if (mod.apiVersion !== undefined && mod.apiVersion > MOD_API_VERSION) {
        throw new Error(
          `Mod "${mod.id}" requires hook API version ${mod.apiVersion}, ` +
            `but this engine provides ${MOD_API_VERSION}.`,
        );
      }

      const hooks = mod.hooks as unknown as
        | Record<string, HookDefinition<BaseHookContext, unknown> | undefined>
        | undefined;
      if (!hooks) continue;

      for (const name of HOOK_NAMES) {
        const definition = hooks[name];
        if (!definition) continue;
        if (typeof definition.handler !== "function") {
          throw new Error(`Mod "${mod.id}" hook "${name}" has no handler function.`);
        }

        const list = this.hooks.get(name) ?? [];
        list.push({
          name,
          selector: definition.when,
          priority: definition.priority ?? 0,
          order: this.order++,
          modId: mod.id,
          handler: definition.handler as HookHandler<any, any>,
        });
        this.hooks.set(name, list);
      }
    }

    for (const list of this.hooks.values()) {
      list.sort((a, b) => a.priority - b.priority || a.order - b.order);
    }
  }

  /** True when at least one mod registered a handler for this hook. */
  has(name: HookName): boolean {
    return (this.hooks.get(name)?.length ?? 0) > 0;
  }

  /**
   * Run the middleware chain for `name`. If no handler matches the context
   * selectors, `next()` (the vanilla/default behavior) is called.
   */
  run<C extends BaseHookContext, R>(name: HookName, ctx: C, next: () => R): R {
    const list = this.hooks.get(name);
    if (!list || list.length === 0) return next();

    let index = -1;
    const dispatch = (i: number): R => {
      if (i <= index) {
        throw new Error(`Hook "${name}" called next() more than once.`);
      }
      index = i;

      const hook = list[i];
      if (!hook) return next();
      if (!selectorMatches(hook.selector, ctx)) return dispatch(i + 1);

      return hook.handler(ctx, () => dispatch(i + 1)) as R;
    };

    return dispatch(0);
  }
}
