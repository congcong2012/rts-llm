/**
 * Fog of war / vision (acceptance A8).
 *
 * Pins the three-state matrix from docs/SPEC.md §10.2 plus the combat-exposure
 * rule and the intel memory that lets the LLM attack a base it once saw.
 */

import { describe, expect, it } from 'vitest';
import { COMBAT_EXPOSURE_TICKS } from '../../src/game/config/constants';
import { stepTick, stepTicks } from '../../src/game/GameLoop';
import { tileOf } from '../../src/game/math';
import type { GameState } from '../../src/game/state/GameState';
import { getBuilding, removeEntity } from '../../src/game/state/GameState';
import {
  ghostBuildings,
  isEntityVisible,
  isSightingFresh,
  isTileExplored,
  knownCrystals,
  tick as visionTick,
  visibleEnemyUnits,
} from '../../src/game/systems/vision';
import { countExplored, encodeFogRows } from '../../src/game/view/fogCodec';
import {
  makeMatch,
  makeValidatorArena,
  placeBarracks,
  primeVision,
  TEST_SEED,
} from '../helpers/fixtures';

const exploredCount = (state: GameState, player: 'p1' | 'p2'): number =>
  countExplored(
    encodeFogRows(state.vision[player].explored, state.terrain.width, state.terrain.height),
    state.terrain.width,
    state.terrain.height,
  );

/** Park a p1 soldier right next to the enemy base so it becomes visible. */
function scoutEnemyBase(state: GameState, soldierId: string): void {
  const scout = state.index.get(soldierId);
  if (scout === undefined) throw new Error('scout missing');
  scout.x = 15.5;
  scout.y = 16.5;
  visionTick(state);
}

describe('three-state visibility', () => {
  it('own entities are always visible to their owner', () => {
    const arena = makeValidatorArena();
    expect(isEntityVisible(arena.state, 'p1', arena.p1Base)).toBe(true);
    expect(isEntityVisible(arena.state, 'p1', arena.p1Worker)).toBe(true);
    expect(isEntityVisible(arena.state, 'p2', arena.p2Base)).toBe(true);
  });

  it('sees an enemy inside a vision radius and nothing beyond it', () => {
    const arena = makeValidatorArena();
    expect(arena.state.vision.p1.visibleEntityIds.has(arena.nearEnemy.id)).toBe(true);
    expect(arena.state.vision.p1.visibleEntityIds.has(arena.farEnemy.id)).toBe(false);
    expect(visibleEnemyUnits(arena.state, 'p1').map((unit) => unit.id)).toEqual([arena.nearEnemy.id]);
  });

  it('leaves tiles outside every vision radius unexplored', () => {
    const arena = makeValidatorArena();
    expect(isTileExplored(arena.state.vision.p1, arena.state.terrain.width, 0, 19)).toBe(false);
  });

  it('keeps explored tiles explored once the observer walks away', () => {
    const state = makeMatch(TEST_SEED);
    const worker = state.units.find((unit) => unit.owner === 'p1' && unit.kind === 'worker');
    expect(worker).toBeDefined();
    if (worker === undefined) return;

    const before = exploredCount(state, 'p1');
    expect(before).toBeGreaterThan(0);

    worker.x = 60.5;
    worker.y = 60.5;
    visionTick(state);
    expect(exploredCount(state, 'p1')).toBeGreaterThanOrEqual(before);
  });

  it('explored memory only ever grows over a long run', () => {
    const state = makeMatch(TEST_SEED);
    let previous = exploredCount(state, 'p1');
    for (let i = 0; i < 30; i += 1) {
      stepTicks(state, 20);
      const current = exploredCount(state, 'p1');
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe('ghosts (remembered enemy buildings)', () => {
  it('records an enemy building while visible, then keeps it as a ghost', () => {
    const arena = makeValidatorArena();
    scoutEnemyBase(arena.state, arena.p1Soldier.id);

    expect(arena.state.vision.p1.visibleEntityIds.has(arena.p2Base.id)).toBe(true);
    expect(arena.state.intel.p1.lastKnownEnemyBase).toEqual({
      x: 17,
      y: 17,
      tick: arena.state.tick,
    });

    arena.p1Soldier.x = 4.5;
    arena.p1Soldier.y = 2.5;
    visionTick(arena.state);

    expect(arena.state.vision.p1.visibleEntityIds.has(arena.p2Base.id)).toBe(false);
    const ghosts = ghostBuildings(arena.state, 'p1');
    expect(ghosts.map((ghost) => ghost.id)).toContain(arena.p2Base.id);
    expect(ghosts.every((ghost) => ghost.kind === 'base' || ghost.kind === 'barracks')).toBe(true);
  });

  it('never creates a ghost for an enemy unit', () => {
    const arena = makeValidatorArena();
    scoutEnemyBase(arena.state, arena.p1Soldier.id);
    expect(arena.state.vision.p1.visibleEntityIds.has(arena.farEnemy.id)).toBe(true);

    arena.p1Soldier.x = 4.5;
    arena.p1Soldier.y = 2.5;
    visionTick(arena.state);

    expect(arena.state.vision.p1.visibleEntityIds.has(arena.farEnemy.id)).toBe(false);
    const ghostIds = ghostBuildings(arena.state, 'p1').map((ghost) => ghost.id);
    expect(ghostIds).not.toContain(arena.farEnemy.id);
  });

  it('drops the ghost when the building dies while observed', () => {
    const arena = makeValidatorArena();
    const barracks = placeBarracks(arena.state, 'p2', 16, 16);
    scoutEnemyBase(arena.state, arena.p1Soldier.id);
    expect(arena.state.intel.p1.buildings.has(barracks.id)).toBe(true);

    removeEntity(arena.state, barracks.id);
    expect(getBuilding(arena.state, barracks.id)).toBeUndefined();
    expect(arena.state.intel.p1.buildings.has(barracks.id)).toBe(false);
  });
});

describe('intel memory', () => {
  it('remembers the last enemy sighting and expires it after 15 seconds', () => {
    const arena = makeValidatorArena();
    expect(isSightingFresh(arena.state, 'p1')).toBe(true);
    expect(arena.state.intel.p1.lastKnownEnemySighting).not.toBeNull();

    arena.state.tick += 200;
    expect(isSightingFresh(arena.state, 'p1')).toBe(false);
  });

  it('knows crystal nodes it has explored, even out of sight', () => {
    const state = makeMatch(TEST_SEED);
    const known = knownCrystals(state, 'p1');
    expect(known.length).toBeGreaterThan(0);
    for (const node of known) {
      expect(
        isTileExplored(state.vision.p1, state.terrain.width, tileOf(node.x), tileOf(node.y)),
      ).toBe(true);
    }
  });
});

describe('combat exposure', () => {
  it('keeps two units that traded blows mutually visible for 30 ticks', () => {
    const arena = makeValidatorArena();
    const attacker = arena.p1Soldier;
    const victim = arena.farEnemy;
    expect(arena.state.vision.p1.visibleEntityIds.has(victim.id)).toBe(false);

    victim.combatExposure = arena.state.tick;
    victim.attackedBy = attacker.id;
    visionTick(arena.state);
    expect(arena.state.vision.p1.visibleEntityIds.has(victim.id)).toBe(true);

    arena.state.tick += COMBAT_EXPOSURE_TICKS + 1;
    visionTick(arena.state);
    expect(arena.state.vision.p1.visibleEntityIds.has(victim.id)).toBe(false);
  });

  it('a real fight keeps the enemy visible', () => {
    const arena = makeValidatorArena();
    arena.p1Soldier.x = 16.5;
    arena.p1Soldier.y = 17.5; // right next to the enemy soldier
    // Restore the p1 soldier's own health so it survives the exchange.
    primeVision(arena.state);

    stepTick(arena.state);
    expect(arena.state.vision.p1.visibleEntityIds.has(arena.farEnemy.id)).toBe(true);
  });
});
