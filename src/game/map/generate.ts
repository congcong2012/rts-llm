/**
 * Deterministic map generation (docs/SPEC.md §3.5).
 *
 * Everything derives from one seed, so `seed -> identical map`. The generator
 * validates its own output (bases connected, enough reachable crystal) and
 * retries with a derived seed when a layout would be unplayable; the very last
 * resort drops the rocks entirely, which is always connected.
 */

import type { PlayerId, Terrain, Vec2 } from '../../shared/types';
import { PLAYERS } from '../../shared/types';
import {
  BASE_ANCHORS,
  BASE_CLEAR_RADIUS,
  CRYSTAL_CLUSTER_DIST_MAX,
  CRYSTAL_CLUSTER_DIST_MIN,
  CRYSTAL_CLUSTER_SIZE_MAX,
  CRYSTAL_CLUSTER_SIZE_MIN,
  CRYSTAL_CLUSTERS_PER_BASE,
  MAP_H,
  MAP_W,
  NEUTRAL_CRYSTAL_CLUSTERS,
  ROCK_CLUSTER_SIZE_MAX,
  ROCK_CLUSTER_SIZE_MIN,
  ROCK_CLUSTERS_MAX,
  ROCK_CLUSTERS_MIN,
  ROCK_MIN_DISTANCE_FROM_BASE,
} from '../config/constants';
import { distance } from '../math';
import { createRng } from '../rng';
import type { Rng } from '../../shared/types';
import { distanceTo } from '../math';
import { FOUR_OFFSETS } from './grid';
import { floodFill } from './pathfinding';
import { clearRect, createTerrain, idx, inBounds, isWalkable, setBlocked } from './terrain';

export interface CrystalSpawn {
  x: number;
  y: number;
}

export interface GeneratedMap {
  seed: number;
  terrain: Terrain;
  crystals: CrystalSpawn[];
  spawns: Record<PlayerId, Vec2>;
}

const MAX_ATTEMPTS = 10;
/** Minimum reachable crystal nodes for the map to be considered playable. */
const MIN_REACHABLE_CRYSTALS = 6;

function clearBaseAreas(terrain: Terrain): void {
  for (const player of PLAYERS) {
    const anchor = BASE_ANCHORS[player];
    clearRect(terrain, anchor.x, anchor.y, BASE_CLEAR_RADIUS);
  }
}

function insideBaseClearArea(x: number, y: number): boolean {
  for (const player of PLAYERS) {
    const anchor = BASE_ANCHORS[player];
    if (Math.abs(x - anchor.x) <= BASE_CLEAR_RADIUS && Math.abs(y - anchor.y) <= BASE_CLEAR_RADIUS) {
      return true;
    }
  }
  return false;
}

function farEnoughFromBases(x: number, y: number): boolean {
  for (const player of PLAYERS) {
    const anchor = BASE_ANCHORS[player];
    if (distance(x, y, anchor.x, anchor.y) <= ROCK_MIN_DISTANCE_FROM_BASE) return false;
  }
  return true;
}

function placeRocks(terrain: Terrain, rng: Rng): void {
  const clusterCount = rng.int(ROCK_CLUSTERS_MIN, ROCK_CLUSTERS_MAX);
  for (let i = 0; i < clusterCount; i += 1) {
    let start: Vec2 | null = null;
    for (let attempt = 0; attempt < 60 && start === null; attempt += 1) {
      const x = rng.int(1, terrain.width - 2);
      const y = rng.int(1, terrain.height - 2);
      if (insideBaseClearArea(x, y)) continue;
      if (!farEnoughFromBases(x, y)) continue;
      if (!isWalkable(terrain, x, y)) continue;
      start = { x, y };
    }
    if (start === null) continue;

    const size = rng.int(ROCK_CLUSTER_SIZE_MIN, ROCK_CLUSTER_SIZE_MAX);
    let cx = start.x;
    let cy = start.y;
    for (let cell = 0; cell < size; cell += 1) {
      if (insideBaseClearArea(cx, cy) || !farEnoughFromBases(cx, cy)) break;
      setBlocked(terrain, cx, cy, true);
      const offset = rng.pick(FOUR_OFFSETS);
      const nx = cx + offset.dx;
      const ny = cy + offset.dy;
      if (!inBounds(terrain, nx, ny)) break;
      cx = nx;
      cy = ny;
    }
  }
}

function placeCrystals(terrain: Terrain, rng: Rng): CrystalSpawn[] {
  const taken = new Set<number>();
  const result: CrystalSpawn[] = [];

  const addCluster = (cx: number, cy: number, size: number): void => {
    for (let i = 0; i < size; i += 1) {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const x = cx + rng.int(-2, 2);
        const y = cy + rng.int(-2, 2);
        if (!inBounds(terrain, x, y)) continue;
        if (!isWalkable(terrain, x, y)) continue;
        const key = idx(terrain, x, y);
        if (taken.has(key)) continue;
        // Never cover a base anchor itself.
        if (PLAYERS.some((p) => BASE_ANCHORS[p].x === x && BASE_ANCHORS[p].y === y)) continue;
        taken.add(key);
        result.push({ x, y });
        break;
      }
    }
  };

  for (const player of PLAYERS) {
    const anchor = BASE_ANCHORS[player];
    for (let cluster = 0; cluster < CRYSTAL_CLUSTERS_PER_BASE; cluster += 1) {
      const angle = rng.range(0, Math.PI * 2);
      const dist = rng.range(CRYSTAL_CLUSTER_DIST_MIN, CRYSTAL_CLUSTER_DIST_MAX);
      const cx = Math.round(anchor.x + Math.cos(angle) * dist);
      const cy = Math.round(anchor.y + Math.sin(angle) * dist);
      const size = rng.int(CRYSTAL_CLUSTER_SIZE_MIN, CRYSTAL_CLUSTER_SIZE_MAX);
      addCluster(
        Math.min(Math.max(cx, 1), terrain.width - 2),
        Math.min(Math.max(cy, 1), terrain.height - 2),
        size,
      );
    }
  }

  const midX = Math.floor(terrain.width / 2);
  const midY = Math.floor(terrain.height / 2);
  for (let cluster = 0; cluster < NEUTRAL_CRYSTAL_CLUSTERS; cluster += 1) {
    const cx = Math.min(Math.max(midX + rng.int(-10, 10), 1), terrain.width - 2);
    const cy = Math.min(Math.max(midY + rng.int(-10, 10), 1), terrain.height - 2);
    addCluster(cx, cy, rng.int(CRYSTAL_CLUSTER_SIZE_MIN, CRYSTAL_CLUSTER_SIZE_MAX));
  }

  return result;
}

function isPlayable(terrain: Terrain, crystals: CrystalSpawn[]): boolean {
  const p1 = BASE_ANCHORS.p1;
  const p2 = BASE_ANCHORS.p2;
  if (!isWalkable(terrain, p1.x, p1.y) || !isWalkable(terrain, p2.x, p2.y)) return false;
  const visited = floodFill(terrain, p1.x, p1.y);
  if (visited[idx(terrain, p2.x, p2.y)] !== 1) return false;
  let reachable = 0;
  for (const node of crystals) {
    if (visited[idx(terrain, node.x, node.y)] === 1) reachable += 1;
  }
  return reachable >= MIN_REACHABLE_CRYSTALS;
}

/**
 * Generate a map. Same seed always yields the same terrain and crystal layout.
 */
export function generateMap(
  seed: number,
  options?: { width?: number; height?: number },
): GeneratedMap {
  const width = options?.width ?? MAP_W;
  const height = options?.height ?? MAP_H;
  const spawns: Record<PlayerId, Vec2> = {
    p1: { ...BASE_ANCHORS.p1 },
    p2: { ...BASE_ANCHORS.p2 },
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // Derived seed keeps retries deterministic and reproducible.
    const attemptSeed = (seed + attempt * 0x9e3779b1) >>> 0;
    const rng = createRng(attemptSeed);
    const terrain = createTerrain(width, height);
    clearBaseAreas(terrain);
    placeRocks(terrain, rng);
    const crystals = placeCrystals(terrain, rng);
    if (isPlayable(terrain, crystals)) {
      return { seed, terrain, crystals, spawns };
    }
  }

  // Last resort: a rock-free map is always connected.
  const rng = createRng(seed >>> 0);
  const terrain = createTerrain(width, height);
  clearBaseAreas(terrain);
  const crystals = placeCrystals(terrain, rng);
  return { seed, terrain, crystals, spawns };
}

/** Shortest distance from a tile to the nearest base anchor (debug helper). */
export function distanceToNearestBase(x: number, y: number): number {
  return Math.min(
    distanceTo({ x, y }, BASE_ANCHORS.p1),
    distanceTo({ x, y }, BASE_ANCHORS.p2),
  );
}

export { setBlocked };
