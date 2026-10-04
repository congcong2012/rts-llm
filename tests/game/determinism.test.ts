/**
 * Determinism (acceptance A4): the same seed plus the same command log must
 * produce a bit-identical match. This is what makes replays and bug reports
 * reproducible.
 */

import { describe, expect, it } from 'vitest';
import { createGame, enqueueCommands, stepTick } from '../../src/game/GameLoop';
import { hashState } from '../../src/game/rng';
import { PLAYERS } from '../../src/shared/types';
import { decide } from '../../src/llm/ruleAi';

/** Run a scripted match, returning the hash at each checkpoint tick. */
function runScripted(seed: number, checkpoints: number[], interval = 20): string[] {
  const state = createGame({ seed });
  const hashes: string[] = [];
  const maxTick = Math.max(...checkpoints);
  while (state.tick < maxTick && state.status === 'running') {
    if (state.tick % interval === 0) {
      for (const player of PLAYERS) {
        const decision = decide(state, player);
        enqueueCommands(state, player, decision.actions, 'rule');
      }
    }
    stepTick(state);
    if (checkpoints.includes(state.tick)) hashes.push(hashState(state));
  }
  return hashes;
}

describe('determinism', () => {
  it('reproduces an identical match from the same seed and commands', () => {
    const checkpoints = [100, 300, 600, 900];
    const first = runScripted(12345, checkpoints);
    const second = runScripted(12345, checkpoints);
    expect(first).toHaveLength(checkpoints.length);
    expect(second).toEqual(first);
  });

  it('produces different matches for different seeds', () => {
    const a = runScripted(11, [1]);
    const b = runScripted(12, [1]);
    expect(a[0]).not.toBe(b[0]);
  });

  it('hashes the same state identically when called repeatedly', () => {
    const state = createGame({ seed: 99 });
    const first = hashState(state);
    expect(hashState(state)).toBe(first);
    stepTick(state);
    const second = hashState(state);
    expect(second).not.toBe(first);
    expect(hashState(state)).toBe(second);
  });

  it('is unaffected by the order in which entities were registered', () => {
    const state = createGame({ seed: 5 });
    const before = hashState(state);
    // Reversing the arrays must not change the hash: it sorts by id.
    state.units.reverse();
    state.buildings.reverse();
    state.crystals.reverse();
    expect(hashState(state)).toBe(before);
  });

  it('folds rng position into the hash so PRNG divergence is detectable', () => {
    const state = createGame({ seed: 5 });
    const before = hashState(state);
    state.rng.next();
    expect(hashState(state)).not.toBe(before);
  });
});
