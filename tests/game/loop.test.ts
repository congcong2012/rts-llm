/**
 * GameLoop: fixed-timestep behaviour, end conditions and an end-to-end match
 * driven by the rule AI (acceptance A3 — a full match must finish).
 */

import { describe, expect, it } from 'vitest';
import { createGame, enqueueCommands, stepTick, stepTicks } from '../../src/game/GameLoop';
import { hashState } from '../../src/game/rng';
import { findBaseOf } from '../../src/game/state/GameState';
import { PLAYERS } from '../../src/shared/types';
import { decide } from '../../src/llm/ruleAi';
import { makeMatch, TEST_SEED } from '../helpers/fixtures';

describe('stepTick', () => {
  it('advances exactly one tick and reports it', () => {
    const state = createGame({ seed: 1 });
    expect(state.tick).toBe(0);
    const result = stepTick(state);
    expect(result.tick).toBe(1);
    expect(state.tick).toBe(1);
    stepTick(state);
    expect(state.tick).toBe(2);
  });

  it('starts with the documented opening setup for both players', () => {
    const state = makeMatch(TEST_SEED);
    for (const player of PLAYERS) {
      expect(findBaseOf(state, player)).toBeDefined();
      expect(state.units.filter((unit) => unit.owner === player && unit.kind === 'worker')).toHaveLength(4);
      expect(state.players[player].resources.crystal).toBe(250);
    }
    // Initial vision is primed, so own bases are visible from tick 0.
    expect(state.vision.p1.visibleEntityIds.has('b1')).toBe(true);
  });

  it('runs a full rule-AI match to completion without throwing', () => {
    const state = createGame({ seed: TEST_SEED, config: { maxTicks: 9000 } });
    let rejected = 0;
    let guard = 0;
    while (state.status === 'running' && guard < 10000) {
      guard += 1;
      if (state.tick % 20 === 0) {
        for (const player of PLAYERS) {
          enqueueCommands(state, player, decide(state, player).actions, 'rule');
        }
      }
      rejected += stepTick(state).rejected.length;
    }

    expect(state.status).toBe('gameover');
    expect(state.tick).toBeLessThanOrEqual(9000);
    expect(rejected).toBe(0);
    if (state.winner !== null) {
      expect(findBaseOf(state, state.winner)).toBeDefined();
      const loser = state.winner === 'p1' ? 'p2' : 'p1';
      expect(findBaseOf(state, loser)).toBeUndefined();
    }
  });

  it('never lets a flood of malformed commands crash or corrupt the match', () => {
    const state = createGame({ seed: 3 });
    const garbage = [
      { type: 'move', unitIds: ['u1'], x: -5, y: 999 },
      { type: 'train', buildingId: 'nope', unitType: 'worker' },
      { type: 'attack', unitIds: ['u1'], targetId: 'u5' },
      { type: 'gather', unitIds: ['u2'], targetId: 'r1' },
      { type: 42 },
      null,
      'not an action',
      [],
      { type: 'build', unitIds: [], buildingType: 'base', x: 1, y: 1 },
      { type: 'move', unitIds: ['u1', 'u1'], x: 5.5, y: 5 },
    ];

    for (let i = 0; i < 200; i += 1) {
      for (const raw of garbage) {
        // Bypass typing on purpose: this simulates a malicious client.
        enqueueCommands(state, 'p2', [raw as never], 'human');
      }
      const result = stepTick(state);
      expect(result.rejected.length).toBeGreaterThan(0);
    }

    expect(state.status).toBe('running');
    expect(state.tick).toBe(200);
    expect(hashState(state)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('stops advancing after the match is decided', () => {
    const state = createGame({ seed: 4, config: { maxTicks: 10 } });
    stepTicks(state, 20);
    expect(state.status).toBe('gameover');
    expect(state.tick).toBe(10);
    stepTick(state);
    expect(state.tick).toBe(10);
  });
});
