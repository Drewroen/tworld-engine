// Game logic engine interface, ported from the `gamelogic` vtable.
// Source: tworld/logic.h:20-28.
//
// The original C struct bundles a ruleset id, a pointer to the current
// gamestate, and four function pointers (initgame/advancegame/endgame/
// shutdown) that all take the gamelogic* as their first argument (a
// C idiom for a "this" pointer). In TypeScript this collapses naturally
// into an interface implemented by a class that holds the GameState as
// an instance field bound once at construction time; there is no need
// for a shutdown() method since there is no manual memory to release.

export interface RulesetLogic {
  readonly ruleset: number;
  /** Prepare to play a game. Returns true on success (mirrors C's int-as-bool). */
  initGame(): boolean;
  /** Advance the game one tick. Returns +1 on win, -1 on loss, 0 if still in progress. */
  advanceGame(): number;
  /** Clean up after the game is done. Returns true on success. */
  endGame(): boolean;
}
