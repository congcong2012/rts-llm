/**
 * Economy: the gather -> carry -> deposit loop (acceptance A6) plus node
 * depletion and carry-capacity guarantees.
 */

import { describe, expect, it } from 'vitest';
import { CARRY_CAPACITY, START_CRYSTAL } from '../../src/game/config/constants';
import { enqueueCommand, stepTick, stepTicks } from '../../src/game/GameLoop';
import { ownedUnits } from '../../src/game/state/GameState';
import { makeArena, makeMatch, placeBase, placeCrystal, placeUnit, primeVision, TEST_SEED } from '../helpers/fixtures';

const gatherAll = (state: ReturnType<typeof makeMatch>): void => {
  for (const player of ['p1', 'p2'] as const) {
    for (const worker of ownedUnits(state, player)) {
      enqueueCommand(state, player, { type: 'gather', unitIds: [worker.id] }, 'system');
    }
  }
};

describe('gather cycle', () => {
  it('A6: after 600 ticks of gathering the player has more crystal than at the start', () => {
    const state = makeMatch(TEST_SEED);
    expect(Math.round(state.players.p1.resources.crystal)).toBe(START_CRYSTAL);

    gatherAll(state);
    stepTicks(state, 600);

    expect(Math.round(state.players.p1.resources.crystal)).toBeGreaterThan(START_CRYSTAL);
    expect(state.players.p1.stats.harvested).toBeGreaterThan(0);
  });

  it('deposits carried crystal at the base and keeps mining', () => {
    const state = makeMatch(TEST_SEED);
    const worker = ownedUnits(state, 'p1')[0];
    expect(worker).toBeDefined();
    if (worker === undefined) return;

    const start = state.players.p1.resources.crystal;
    enqueueCommand(state, 'p1', { type: 'gather', unitIds: [worker.id] }, 'system');

    let sawCarry = false;
    for (let i = 0; i < 400; i += 1) {
      stepTick(state);
      if (worker.carry > 0) sawCarry = true;
    }

    expect(sawCarry).toBe(true);
    expect(state.players.p1.resources.crystal).toBeGreaterThan(start);
  });

  it('never carries more than CARRY_CAPACITY', () => {
    const state = makeMatch(TEST_SEED);
    const worker = ownedUnits(state, 'p1')[0];
    if (worker === undefined) return;
    enqueueCommand(state, 'p1', { type: 'gather', unitIds: [worker.id] }, 'system');
    for (let i = 0; i < 500; i += 1) {
      stepTick(state);
      expect(worker.carry).toBeLessThanOrEqual(CARRY_CAPACITY + 1e-9);
    }
  });

  it('removes a depleted node and lets the worker go idle', () => {
    const state = makeArena();
    placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18); // keep the match alive for multi-tick tests
    const worker = placeUnit(state, 'p1', 'worker', 3, 2);
    const node = placeCrystal(state, 3, 3, 5); // adjacent: distance 1.0
    primeVision(state);

    enqueueCommand(state, 'p1', { type: 'gather', unitIds: [worker.id] }, 'system');
    stepTicks(state, 60);

    expect(state.index.has(node.id)).toBe(false);
    expect(state.crystals).toHaveLength(0);
    expect(worker.state).toBe('idle');
    // The 5 harvested crystal reached the base before the node vanished.
    expect(Math.round(state.players.p1.resources.crystal)).toBe(505);
  });

  it('re-targets another node when its assigned one is mined out', () => {
    const state = makeArena();
    placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18); // keep the match alive for multi-tick tests
    const worker = placeUnit(state, 'p1', 'worker', 3, 2);
    placeCrystal(state, 3, 3, 2);
    const spare = placeCrystal(state, 5, 5, 500);
    primeVision(state);

    enqueueCommand(state, 'p1', { type: 'gather', unitIds: [worker.id] }, 'system');
    stepTicks(state, 200);

    expect(state.index.has(spare.id)).toBe(true);
    expect(worker.state === 'gathering' || worker.state === 'moving').toBe(true);
  });
});
