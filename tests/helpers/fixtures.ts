/**
 * Shared test fixtures.
 *
 * Two flavours of state are used across the suite:
 *  - `makeMatch()` builds a real, fully generated match (used for anything that
 *    depends on map generation, fog, determinism or long runs);
 *  - `makeArena()` builds a tiny hand-placed 20x20 field with no rocks, so unit
 *    and building tests can assert exact numbers.
 */

import type { Building, BuildingKind, GameConfig, PlayerId, Unit, UnitKind } from '../../src/shared/types';
import { makeBuilding, makeCrystal, makeUnit } from '../../src/game/entities/factory';
import { createGame } from '../../src/game/GameLoop';
import { setBlocked, createTerrain } from '../../src/game/map/terrain';
import type { GameState } from '../../src/game/state/GameState';
import {
  addEntity,
  allocId,
  createEmptyState,
  findBaseOf,
} from '../../src/game/state/GameState';
import { tick as visionTick } from '../../src/game/systems/vision';

export const TEST_SEED = 12345;

/** A complete, generated match. Vision is primed by `createGame`. */
export function makeMatch(seed = TEST_SEED, config?: Partial<GameConfig>): GameState {
  return createGame(config === undefined ? { seed } : { seed, config });
}

export interface ArenaOptions {
  width?: number;
  height?: number;
  seed?: number;
  crystal?: number;
  config?: Partial<GameConfig>;
}

/**
 * A bare 20x20 field with no rocks and **no bases**.
 *
 * IMPORTANT: the victory rule is "a player with no base is defeated", so a hand
 * built state must give *both* players a base before it can be stepped more than
 * once — otherwise the match ends on the first tick. Every multi-tick test below
 * therefore places a p1 base and a p2 base.
 */
export function makeArena(options: ArenaOptions = {}): GameState {
  const terrain = createTerrain(options.width ?? 20, options.height ?? 20);
  return createEmptyState({
    gameId: 'arena',
    seed: options.seed ?? 1,
    terrain,
    startCrystal: options.crystal ?? 500,
    ...(options.config === undefined ? {} : { config: options.config }),
  });
}

export function placeBase(state: GameState, owner: PlayerId, tileX: number, tileY: number): Building {
  const building = makeBuilding({
    id: allocId(state, 'b'),
    kind: 'base',
    owner,
    tileX,
    tileY,
  });
  addEntity(state, building);
  return building;
}

export function placeBarracks(
  state: GameState,
  owner: PlayerId,
  tileX: number,
  tileY: number,
): Building {
  const building = makeBuilding({
    id: allocId(state, 'b'),
    kind: 'barracks',
    owner,
    tileX,
    tileY,
  });
  addEntity(state, building);
  return building;
}

export function placeUnit(
  state: GameState,
  owner: PlayerId,
  kind: UnitKind,
  tileX: number,
  tileY: number,
): Unit {
  const unit = makeUnit({
    id: allocId(state, 'u'),
    kind,
    owner,
    x: tileX + 0.5,
    y: tileY + 0.5,
  });
  addEntity(state, unit);
  return unit;
}

export function placeCrystal(
  state: GameState,
  tileX: number,
  tileY: number,
  amount?: number,
) {
  const node = makeCrystal({
    id: allocId(state, 'r'),
    tileX,
    tileY,
    ...(amount === undefined ? {} : { amount }),
  });
  addEntity(state, node);
  return node;
}

export function blockTile(state: GameState, tileX: number, tileY: number): void {
  setBlocked(state.terrain, tileX, tileY, true);
}

/** Recompute fog / visibility. Required after hand-placing entities. */
export function primeVision(state: GameState): void {
  visionTick(state);
}

export interface ArenaSetup {
  state: GameState;
  p1Base: Building;
  p2Base: Building;
  p1Worker: Unit;
  p1Soldier: Unit;
  p2Soldier: Unit;
  farEnemy: Unit;
  nearEnemy: Unit;
  crystal: { id: string; x: number; y: number; amount: number };
  depleted: { id: string };
  rock: { x: number; y: number };
  free: { x: number; y: number };
}

/**
 * A rich, deterministic arena used by the validator table:
 *
 *   (2,2)   p1 base b1        (3,2) p1 worker      (4,2) p1 soldier
 *   (6,2)   crystal r1        (7,2) depleted r2
 *   (5,3)   p2 soldier NEAR (visible to p1)
 *   (17,17) p2 base           (16,17) p2 soldier FAR (out of p1 vision)
 *   (9,9)   rock
 */
export function makeValidatorArena(): ArenaSetup {
  const state = makeArena();
  const p1Base = placeBase(state, 'p1', 2, 2);
  const p2Base = placeBase(state, 'p2', 17, 17);
  const p1Worker = placeUnit(state, 'p1', 'worker', 3, 2);
  const p1Soldier = placeUnit(state, 'p1', 'soldier', 4, 2);
  const p2Soldier = placeUnit(state, 'p2', 'soldier', 16, 17);
  const nearEnemy = placeUnit(state, 'p2', 'soldier', 5, 3);
  const crystal = placeCrystal(state, 6, 2, 500);
  const depleted = placeCrystal(state, 7, 2, 0);
  blockTile(state, 9, 9);
  primeVision(state);

  return {
    state,
    p1Base,
    p2Base,
    p1Worker,
    p1Soldier,
    p2Soldier,
    farEnemy: p2Soldier,
    nearEnemy,
    crystal: { id: crystal.id, x: 6, y: 2, amount: 500 },
    depleted: { id: depleted.id },
    rock: { x: 9, y: 9 },
    free: { x: 7, y: 4 },
  };
}

/** Convenience: the crystal resource of a player, rounded. */
export function crystalOf(state: GameState, player: PlayerId): number {
  return Math.round(state.players[player].resources.crystal);
}

export function baseOf(state: GameState, player: PlayerId): Building | undefined {
  return findBaseOf(state, player);
}

export function kindLabel(kind: BuildingKind | UnitKind): string {
  return kind;
}
