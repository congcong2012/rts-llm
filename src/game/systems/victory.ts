/**
 * Victory: destroying the enemy base ends the match immediately.
 *
 * Losing every unit or every barracks is deliberately *not* a defeat — only the
 * base matters (docs/SPEC.md §3.4). If both bases fall on the same tick the
 * match is a draw (`winner === null`).
 */

import type { GameState } from '../state/GameState';
import { findBaseOf } from '../state/GameState';

export function tick(state: GameState): void {
  if (state.status === 'gameover') return;

  const p1Base = findBaseOf(state, 'p1');
  const p2Base = findBaseOf(state, 'p2');
  if (p1Base !== undefined && p2Base !== undefined) return;

  state.status = 'gameover';
  state.endTick = state.tick;
  if (p1Base === undefined && p2Base !== undefined) state.winner = 'p2';
  else if (p2Base === undefined && p1Base !== undefined) state.winner = 'p1';
  else state.winner = null; // mutual destruction

  state.events.push({
    type: 'gameover',
    tick: state.tick,
    owner: state.winner ?? undefined,
  });
}

/** Quick check used by tests and the simulate script. */
export function hasEnded(state: GameState): boolean {
  return state.status === 'gameover';
}
