/** Combat: simultaneous damage, cooldowns, pursuit, death and retaliation. */

import { describe, expect, it } from 'vitest';
import { UNIT_STATS } from '../../src/game/config/constants';
import { enqueueCommand, stepTick, stepTicks } from '../../src/game/GameLoop';
import type { GameState } from '../../src/game/state/GameState';
import type { Unit } from '../../src/shared/types';
import {
  makeArena,
  makeValidatorArena,
  placeBase,
  placeCrystal,
  placeUnit,
  primeVision,
} from '../helpers/fixtures';

interface Duel {
  state: GameState;
  attacker: Unit;
  defender: Unit;
}

/** Two soldiers facing each other on a clean field, `gap` tiles apart. */
function makeDuel(gap = 1): Duel {
  const state = makeArena();
  placeBase(state, 'p1', 0, 0);
  placeBase(state, 'p2', 19, 19);
  const attacker = placeUnit(state, 'p1', 'soldier', 4, 8);
  const defender = placeUnit(state, 'p2', 'soldier', 4 + gap, 8);
  primeVision(state);
  return { state, attacker, defender };
}

describe('combat resolution', () => {
  it('applies damage simultaneously to both sides of a duel', () => {
    const { state, attacker, defender } = makeDuel(1);
    const beforeA = attacker.hp;
    const beforeB = defender.hp;

    stepTick(state);

    expect(defender.hp).toBe(beforeB - UNIT_STATS.soldier.attack);
    expect(attacker.hp).toBe(beforeA - UNIT_STATS.soldier.attack);
  });

  it('gates further hits behind the attack cooldown', () => {
    const { state, attacker, defender } = makeDuel(1);
    stepTick(state);
    const afterFirst = defender.hp;
    expect(attacker.cooldown).toBe(UNIT_STATS.soldier.cooldownTicks);

    stepTick(state);
    expect(defender.hp).toBe(afterFirst); // still cooling down

    stepTicks(state, UNIT_STATS.soldier.cooldownTicks - 1);
    expect(defender.hp).toBeLessThan(afterFirst);
  });

  it('never damages a target that is out of range and unordered', () => {
    const { state, attacker, defender } = makeDuel(6);
    stepTick(state);
    expect(defender.hp).toBe(defender.maxHp);
    expect(attacker.hp).toBe(attacker.maxHp);
  });

  it('pursues an ordered target until it is in range', () => {
    const { state, attacker, defender } = makeDuel(6);
    const before = Math.hypot(defender.x - attacker.x, defender.y - attacker.y);

    enqueueCommand(state, 'p1', { type: 'attack', unitIds: [attacker.id], targetId: defender.id }, 'system');
    stepTicks(state, 40);

    const after = Math.hypot(defender.x - attacker.x, defender.y - attacker.y);
    expect(after).toBeLessThan(before);
    expect(defender.hp).toBeLessThan(defender.maxHp);
  });

  it('removes a dead unit and credits the kill', () => {
    const { state, defender } = makeDuel(1);
    defender.hp = 5;
    const result = stepTick(state);

    expect(state.index.has(defender.id)).toBe(false);
    expect(state.units.some((unit) => unit.id === defender.id)).toBe(false);
    expect(state.players.p1.stats.killed).toBe(1);
    expect(state.players.p2.stats.lost).toBe(1);
    expect(result.events.some((event) => event.type === 'death')).toBe(true);
  });

  it('lets both units die on the same tick when the damage is mutual', () => {
    const { state, attacker, defender } = makeDuel(1);
    attacker.hp = 5;
    defender.hp = 5;
    stepTick(state);

    expect(state.index.has(attacker.id)).toBe(false);
    expect(state.index.has(defender.id)).toBe(false);
  });

  it('shoots instead of walking when an enemy is already in range', () => {
    const arena = makeValidatorArena();
    const soldier = arena.p1Soldier;
    const startX = soldier.x;
    const startY = soldier.y;

    stepTicks(arena.state, 10);

    expect(soldier.x).toBe(startX);
    expect(soldier.y).toBe(startY);
    expect(arena.nearEnemy.hp).toBeLessThan(arena.nearEnemy.maxHp);
  });
});

describe('retaliation', () => {
  it('a gathering worker abandons its order and fights back when attacked', () => {
    const state = makeArena();
    placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18); // keeps the match alive across ticks
    const worker = placeUnit(state, 'p1', 'worker', 4, 2);
    const raider = placeUnit(state, 'p2', 'soldier', 5, 2);
    placeCrystal(state, 9, 2, 500);
    primeVision(state);

    enqueueCommand(state, 'p1', { type: 'gather', unitIds: [worker.id] }, 'system');
    stepTick(state);

    expect(worker.state).toBe('gathering'); // busy, so it does NOT auto-engage
    expect(worker.hp).toBe(worker.maxHp - UNIT_STATS.soldier.attack);
    expect(raider.hp).toBe(raider.maxHp);

    stepTick(state);
    expect(worker.state).toBe('attacking');
    expect(raider.hp).toBe(raider.maxHp - UNIT_STATS.worker.attack);
  });
});
