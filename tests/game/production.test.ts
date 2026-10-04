/** Production: training queues, cost deduction, population, construction. */

import { describe, expect, it } from 'vitest';
import { BUILDING_STATS, UNIT_STATS } from '../../src/game/config/constants';
import { enqueueCommand, stepTick, stepTicks } from '../../src/game/GameLoop';
import { findBaseOf, ownedUnits } from '../../src/game/state/GameState';
import {
  makeArena,
  placeBase,
  placeBarracks,
  placeUnit,
  primeVision,
} from '../helpers/fixtures';

const baseCost = UNIT_STATS.worker.cost;

describe('training', () => {
  it('deducts the cost immediately and queues the unit', () => {
    const state = makeArena({ crystal: 500 });
    const base = placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18); // keeps the match alive across ticks
    primeVision(state);

    enqueueCommand(state, 'p1', { type: 'train', buildingId: base.id, unitType: 'worker' }, 'system');
    stepTick(state);

    expect(state.players.p1.resources.crystal).toBe(500 - baseCost);
    expect(base.queue).toEqual(['worker']);
    expect(base.state).toBe('training');
  });

  it('spawns the unit after the training time, next to the building', () => {
    const state = makeArena({ crystal: 500 });
    const base = placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18); // keeps the match alive across ticks
    primeVision(state);

    enqueueCommand(state, 'p1', { type: 'train', buildingId: base.id, unitType: 'worker' }, 'system');
    stepTicks(state, UNIT_STATS.worker.trainTicks - 1);
    expect(ownedUnits(state, 'p1')).toHaveLength(0);

    stepTick(state);
    const units = ownedUnits(state, 'p1');
    expect(units).toHaveLength(1);
    const spawned = units[0];
    expect(spawned?.kind).toBe('worker');
    expect(base.queue).toHaveLength(0);
    expect(base.state).toBe('idle');
    expect(state.players.p1.stats.trained).toBe(1);
    // Spawned on a walkable free tile adjacent to the base.
    if (spawned !== undefined) {
      expect(Math.abs(spawned.x - base.x)).toBeLessThanOrEqual(3.5);
      expect(Math.abs(spawned.y - base.y)).toBeLessThanOrEqual(3.5);
    }
  });

  it('refuses a second order while the queue is busy', () => {
    const state = makeArena({ crystal: 500 });
    const base = placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18); // keeps the match alive across ticks
    primeVision(state);

    enqueueCommand(state, 'p1', { type: 'train', buildingId: base.id, unitType: 'worker' }, 'system');
    stepTick(state);
    enqueueCommand(state, 'p1', { type: 'train', buildingId: base.id, unitType: 'worker' }, 'system');
    const result = stepTick(state);

    expect(result.accepted).toBe(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(['INVALID_STATE']);
    expect(base.queue).toHaveLength(1);
  });
});

describe('construction', () => {
  it('completes a barracks once the builder reaches the site', () => {
    const state = makeArena({ crystal: 500 });
    placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18); // keeps the match alive across ticks
    const builder = placeUnit(state, 'p1', 'worker', 3, 2);
    primeVision(state);

    enqueueCommand(
      state,
      'p1',
      { type: 'build', unitIds: [builder.id], buildingType: 'barracks', x: 6, y: 2 },
      'system',
    );
    stepTick(state);

    expect(state.players.p1.resources.crystal).toBe(500 - BUILDING_STATS.barracks.cost);
    const site = state.buildings.find((building) => building.kind === 'barracks');
    expect(site).toBeDefined();
    if (site === undefined) return;
    expect(site.state).toBe('constructing');
    expect(site.hp).toBeLessThan(site.maxHp);
    expect(builder.state).toBe('building');

    // Step until completion, watching the event stream on each tick.
    let sawBuiltEvent = false;
    for (let i = 0; i < BUILDING_STATS.barracks.buildTicks + 60; i += 1) {
      const result = stepTick(state);
      if (result.events.some((event) => event.type === 'built')) {
        sawBuiltEvent = true;
        break;
      }
    }

    expect(sawBuiltEvent).toBe(true);
    expect(site.state).toBe('idle');
    expect(site.hp).toBe(site.maxHp);
    expect(builder.state).toBe('idle');
  });

  it('pauses progress when the builder leaves the site', () => {
    const state = makeArena({ crystal: 500 });
    placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18); // keeps the match alive across ticks
    const builder = placeUnit(state, 'p1', 'worker', 3, 2);
    primeVision(state);

    enqueueCommand(
      state,
      'p1',
      { type: 'build', unitIds: [builder.id], buildingType: 'barracks', x: 6, y: 2 },
      'system',
    );
    stepTicks(state, 60);
    const site = state.buildings.find((building) => building.kind === 'barracks');
    if (site === undefined) throw new Error('site missing');
    const progress = site.buildProgress;
    expect(progress).toBeGreaterThan(0);

    // Send the builder far away: the site must stop progressing.
    enqueueCommand(state, 'p1', { type: 'move', unitIds: [builder.id], x: 18, y: 18 }, 'system');
    stepTicks(state, 30);
    expect(site.buildProgress).toBe(progress);
  });

  it('enforces the barracks limit of two per player', () => {
    const state = makeArena({ crystal: 2000 });
    placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18); // keeps the match alive across ticks
    placeBarracks(state, 'p1', 1, 5);
    placeBarracks(state, 'p1', 1, 6);
    const builder = placeUnit(state, 'p1', 'worker', 3, 2);
    primeVision(state);

    enqueueCommand(
      state,
      'p1',
      { type: 'build', unitIds: [builder.id], buildingType: 'barracks', x: 6, y: 2 },
      'system',
    );
    const result = stepTick(state);
    expect(result.rejected.map((r) => r.reason)).toEqual(['PRODUCTION_BLOCKED']);
  });
});

describe('population cap', () => {
  it('blocks training once the cap is reached', () => {
    const state = makeArena({ crystal: 500, config: { popCap: 1 } });
    const base = placeBase(state, 'p1', 2, 2);
    placeUnit(state, 'p1', 'worker', 3, 2);
    primeVision(state);

    enqueueCommand(state, 'p1', { type: 'train', buildingId: base.id, unitType: 'worker' }, 'system');
    const result = stepTick(state);
    expect(result.rejected.map((r) => r.reason)).toEqual(['POP_CAP_REACHED']);
    expect(findBaseOf(state, 'p1')).toBe(base);
  });
});
