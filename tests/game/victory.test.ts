/** Victory conditions (docs/SPEC.md §3.4): only the base decides the match. */

import { describe, expect, it } from 'vitest';
import { createGame, stepTick, stepTicks } from '../../src/game/GameLoop';
import { removeEntity } from '../../src/game/state/GameState';
import { tick as victoryTick } from '../../src/game/systems/victory';
import { makeValidatorArena } from '../helpers/fixtures';

describe('victory', () => {
  it('declares p1 the winner when the p2 base is destroyed', () => {
    const arena = makeValidatorArena();
    removeEntity(arena.state, arena.p2Base.id);
    victoryTick(arena.state);

    expect(arena.state.status).toBe('gameover');
    expect(arena.state.winner).toBe('p1');
    expect(arena.state.endTick).toBe(arena.state.tick);
  });

  it('declares p2 the winner when the p1 base is destroyed', () => {
    const arena = makeValidatorArena();
    removeEntity(arena.state, arena.p1Base.id);
    victoryTick(arena.state);
    expect(arena.state.winner).toBe('p2');
  });

  it('is a draw when both bases fall on the same tick', () => {
    const arena = makeValidatorArena();
    removeEntity(arena.state, arena.p1Base.id);
    removeEntity(arena.state, arena.p2Base.id);
    victoryTick(arena.state);
    expect(arena.state.status).toBe('gameover');
    expect(arena.state.winner).toBeNull();
  });

  it('does not end the match when units or barracks are lost', () => {
    const arena = makeValidatorArena();
    removeEntity(arena.state, arena.p1Worker.id);
    removeEntity(arena.state, arena.p1Soldier.id);
    removeEntity(arena.state, arena.nearEnemy.id);
    victoryTick(arena.state);
    expect(arena.state.status).toBe('running');
    expect(arena.state.winner).toBeNull();
  });

  it('freezes the simulation once the match is over', () => {
    const arena = makeValidatorArena();
    removeEntity(arena.state, arena.p2Base.id);
    victoryTick(arena.state);
    const tick = arena.state.tick;
    const result = stepTick(arena.state);
    expect(result.tick).toBe(tick);
    expect(result.accepted).toBe(0);
  });

  it('ends on the tick limit with a deterministic winner', () => {
    const state = createGame({ seed: 7, config: { maxTicks: 50 } });
    stepTicks(state, 60);
    expect(state.status).toBe('gameover');
    expect(state.endTick).toBe(50);
    expect(state.tick).toBe(50);
    expect(state.events.some((event) => event.type === 'gameover')).toBe(true);
  });
});
