/**
 * Match bootstrap: build the map and place the starting bases, workers and
 * crystal nodes. Split out of GameLoop so the container module stays free of
 * generation concerns.
 */

import type { GameConfig, Vec2 } from '../../shared/types';
import type { GameState } from '../state/GameState';
import { PLAYERS } from '../../shared/types';
import { START_CRYSTAL, START_WORKERS, BASE_ANCHORS, MAP_H, MAP_W, DEFAULT_CONFIG } from '../config/constants';
import { makeBuilding, makeCrystal, makeUnit } from '../entities/factory';
import { findFreeTileNear } from '../map/grid';
import { generateMap } from '../map/generate';
import { addEntity, allocId, createEmptyState, isTileFree } from '../state/GameState';

export interface MatchOptions {
  seed?: number;
  gameId?: string;
  config?: Partial<GameConfig>;
}

export const DEFAULT_SEED = 12345;

export function createMatch(options: MatchOptions = {}): GameState {
  const seed = (options.seed ?? DEFAULT_SEED) >>> 0;
  const config: GameConfig = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
  const map = generateMap(seed, { width: config.width ?? MAP_W, height: config.height ?? MAP_H });

  const state = createEmptyState({
    gameId: options.gameId ?? `g-${seed.toString(16)}`,
    seed,
    terrain: map.terrain,
    config,
    startCrystal: START_CRYSTAL,
  });

  for (const node of map.crystals) {
    addEntity(state, makeCrystal({ id: allocId(state, 'r'), tileX: node.x, tileY: node.y }));
  }

  // Tiles already used for this player's spawn, so workers do not stack up.
  const taken = new Set<string>();

  for (const player of PLAYERS) {
    const anchor: Vec2 = map.spawns[player] ?? { ...BASE_ANCHORS[player] };
    addEntity(
      state,
      makeBuilding({
        id: allocId(state, 'b'),
        kind: 'base',
        owner: player,
        tileX: anchor.x,
        tileY: anchor.y,
      }),
    );

    for (let i = 0; i < START_WORKERS; i += 1) {
      const tile = findFreeTileNear(
        state.terrain,
        anchor,
        (x, y) => isTileFree(state, x, y) && !taken.has(`${x},${y}`),
        5,
      );
      if (tile === null) break;
      taken.add(`${tile.x},${tile.y}`);
      addEntity(
        state,
        makeUnit({
          id: allocId(state, 'u'),
          kind: 'worker',
          owner: player,
          x: tile.x + 0.5,
          y: tile.y + 0.5,
        }),
      );
    }
  }

  return state;
}
