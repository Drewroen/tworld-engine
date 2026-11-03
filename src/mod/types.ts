// Public modding API types.
//
// Mods are ordinary ES modules built by the host application. The engine
// exposes a small set of deterministic extension points; each one wraps a
// slice of the vanilla MS/Lynx logic. A handler can observe, mutate, extend,
// or replace the default behavior by calling (or not calling) `next()`.

import type { Ruleset } from "../constants";
import type { GameState } from "../state";
import type { Creature } from "../types";

/** Version of the hook contract exposed by this engine. */
export const MOD_API_VERSION = 1;

export type RulesetName = "ms" | "lynx";

/** A value or list of values, used by hook selectors. */
export type OneOrMany<T> = T | readonly T[];

/** Limit a hook to a subset of engine operations. */
export interface HookSelector {
  /** Only run under these rulesets. */
  ruleset?: OneOrMany<RulesetName>;
  /** Only run for this actor kind. */
  who?: OneOrMany<"chip" | "block" | "creature">;
  /** Only run when the acting creature has one of these ids. */
  creature?: OneOrMany<number>;
  /** Only run for these destination floor/object tile ids. */
  tile?: OneOrMany<number>;
}

/** Helpers available to every hook. */
export interface ModApi {
  /** Set a standard sound-effect bit for this tick. */
  addSound(sfx: number): void;
  /** Read a named integer counter (mod items, custom keys, etc.). */
  getCounter(name: string): number;
  /** Write a named integer counter. */
  setCounter(name: string, value: number): void;
  /** Add to a named counter and return the new value. */
  modifyCounter(name: string, delta: number): number;
  /** Read persistent per-game mod state. */
  getModState<T = unknown>(key: string): T | undefined;
  /** Write persistent per-game mod state. */
  setModState(key: string, value: unknown): void;
}

/** Fields shared by every hook context. */
export interface BaseHookContext {
  state: GameState;
  ruleset: Ruleset;
  api: ModApi;
  /** Engine tick at the time the hook runs. */
  time: number;
  /** Actor kind, when the hook is about an actor. */
  who?: "chip" | "block" | "creature";
  /** Acting creature, when the hook is about one. */
  creature?: Creature;
  /**
   * Tile id selectors match against this. For movement hooks this is the
   * destination floor tile; for item/hazard hooks it is the item/hazard.
   */
  tileId?: number;
}

export interface GameHookContext extends BaseHookContext {
  /** Result of the tick, available to `game.afterTick`. */
  result?: number;
}

export interface MoveCanMakeContext extends BaseHookContext {
  creature: Creature;
  dir: number;
  flags: number;
  from: number;
  /** Destination cell index, or -1 if off-map. */
  to: number;
  /** Destination floor tile id (Tile.Nothing when off-map). */
  floor: number;
}

export interface MoveEndContext extends BaseHookContext {
  creature: Creature;
  dir: number;
  /** Position whose tile effects were just applied. */
  pos: number;
  /** Whether the creature still exists after the default behavior. */
  survived: boolean;
}

export interface ItemCollectContext extends BaseHookContext {
  who: "chip";
  pos: number;
  /** Item tile id that was collected. */
  item: number;
  /** Mutable map tile at `pos` (top layer). */
  tile: { id: number; state: number };
}

export interface HazardEnterContext extends BaseHookContext {
  who: "chip" | "block" | "creature";
  pos: number;
  /** Hazard tile id that was entered. */
  hazard: number;
  /** Mutable map tile at `pos` (top layer). */
  tile: { id: number; state: number };
}

/**
 * Middleware handler. Call `next()` to run the default behavior; return its
 * result, wrap it, or skip `next()` to replace the behavior entirely.
 */
export type HookHandler<C, R> = (ctx: C, next: () => R) => R;

export interface HookDefinition<C, R> {
  /** Optional selector; when omitted the hook runs for every occurrence. */
  when?: HookSelector;
  /** Lower runs first. Ties are broken by mod order, then declaration order. */
  priority?: number;
  handler: HookHandler<C, R>;
}

export interface ModHooks {
  "game.init"?: HookDefinition<GameHookContext, void>;
  "game.beforeTick"?: HookDefinition<GameHookContext, void>;
  "game.afterTick"?: HookDefinition<GameHookContext, number>;
  "move.canMake"?: HookDefinition<MoveCanMakeContext, boolean>;
  "move.end"?: HookDefinition<MoveEndContext, boolean>;
  "item.collect"?: HookDefinition<ItemCollectContext, void>;
  "hazard.enter"?: HookDefinition<HazardEnterContext, boolean>;
}

export type HookName = keyof ModHooks;

export interface Mod {
  /** Stable, globally unique id, e.g. "example.charged-fireboots". */
  id: string;
  name?: string;
  version?: string;
  /** Hook API version this mod was written against. */
  apiVersion?: number;
  /** Which rulesets this mod supports. Omitted = both. */
  rulesets?: OneOrMany<RulesetName>;
  hooks?: ModHooks;
}

/** Identity helper that gives mod authors completion and type checking. */
export function defineMod(mod: Mod): Mod {
  return { apiVersion: MOD_API_VERSION, ...mod };
}
