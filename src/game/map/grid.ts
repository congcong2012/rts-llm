/** Grid traversal helpers: neighbourhoods and deterministic tile search. */

import type { Terrain, Vec2 } from '../../shared/types';
import { inBounds, isWalkable } from './terrain';

export interface Neighbor {
  x: number;
  y: number;
  cost: number;
}

const SQRT2 = Math.SQRT2;

/** 8-neighbour offsets, fixed order so pathfinding is deterministic. */
const OFFSETS_8: readonly { dx: number; dy: number; cost: number }[] = [
  { dx: 1, dy: 0, cost: 1 },
  { dx: -1, dy: 0, cost: 1 },
  { dx: 0, dy: 1, cost: 1 },
  { dx: 0, dy: -1, cost: 1 },
  { dx: 1, dy: 1, cost: SQRT2 },
  { dx: 1, dy: -1, cost: SQRT2 },
  { dx: -1, dy: 1, cost: SQRT2 },
  { dx: -1, dy: -1, cost: SQRT2 },
];

export const FOUR_OFFSETS: readonly { dx: number; dy: number }[] = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
];

/**
 * Walkable 8-neighbours of a tile.
 *
 * Diagonal steps are only produced when both orthogonal tiles are walkable, so
 * units never cut through the corner of a rock.
 */
export function neighbors8(terrain: Terrain, x: number, y: number): Neighbor[] {
  const result: Neighbor[] = [];
  for (const offset of OFFSETS_8) {
    const nx = x + offset.dx;
    const ny = y + offset.dy;
    if (!isWalkable(terrain, nx, ny)) continue;
    if (offset.dx !== 0 && offset.dy !== 0) {
      if (!isWalkable(terrain, x + offset.dx, y) || !isWalkable(terrain, x, y + offset.dy)) continue;
    }
    result.push({ x: nx, y: ny, cost: offset.cost });
  }
  return result;
}

export function manhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

export function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/**
 * Deterministic expanding-ring search for the first tile satisfying
 * `predicate`. Used for unit spawn points and building placement.
 */
export function findFreeTileNear(
  terrain: Terrain,
  origin: Vec2,
  predicate: (x: number, y: number) => boolean,
  radius: number,
): Vec2 | null {
  for (let r = 0; r <= radius; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        // Only the ring at distance r, so the closest tiles are examined first.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = origin.x + dx;
        const y = origin.y + dy;
        if (!inBounds(terrain, x, y)) continue;
        if (predicate(x, y)) return { x, y };
      }
    }
  }
  return null;
}
