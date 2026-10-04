/** A* pathfinding: shortest paths, obstacle avoidance, no corner cutting. */

import { describe, expect, it } from 'vitest';
import { createTerrain, setBlocked } from '../../src/game/map/terrain';
import { findPath, isReachable } from '../../src/game/map/pathfinding';

const key = (p: { x: number; y: number }): string => `${p.x},${p.y}`;

describe('findPath', () => {
  it('returns an empty path when start equals target', () => {
    const terrain = createTerrain(10, 10);
    expect(findPath(terrain, 3, 3, 3, 3)).toEqual([]);
  });

  it('walks a straight line across open ground', () => {
    const terrain = createTerrain(10, 10);
    const path = findPath(terrain, 0, 0, 5, 0);
    expect(path).not.toBeNull();
    expect(path?.length).toBe(5);
    expect(path?.map(key)).toEqual(['1,0', '2,0', '3,0', '4,0', '5,0']);
  });

  it('routes around a wall', () => {
    const terrain = createTerrain(12, 12);
    // Vertical wall at x=5 with a gap only at y=10.
    for (let y = 0; y < 10; y += 1) setBlocked(terrain, 5, y, true);
    const path = findPath(terrain, 2, 2, 9, 2);
    expect(path).not.toBeNull();
    expect(path?.length).toBeGreaterThan(7); // strictly longer than the direct line
    expect(path?.every((p) => terrain.blocked[p.y * terrain.width + p.x] === 0)).toBe(true);
    expect(path?.some((p) => p.y >= 10)).toBe(true); // it used the gap
  });

  it('returns null when the target is walled off', () => {
    const terrain = createTerrain(8, 8);
    for (const [x, y] of [
      [3, 2],
      [3, 3],
      [3, 4],
      [2, 3],
      [4, 3],
    ] as const) {
      setBlocked(terrain, x, y, true);
    }
    expect(findPath(terrain, 0, 0, 3, 3)).toBeNull();
  });

  it('returns null for a blocked or out-of-bounds target', () => {
    const terrain = createTerrain(8, 8);
    setBlocked(terrain, 5, 5, true);
    expect(findPath(terrain, 0, 0, 5, 5)).toBeNull();
    expect(findPath(terrain, 0, 0, 20, 20)).toBeNull();
    expect(findPath(terrain, -1, 0, 2, 2)).toBeNull();
  });

  it('never cuts a corner between two blocked tiles', () => {
    const terrain = createTerrain(6, 6);
    setBlocked(terrain, 1, 0, true);
    const path = findPath(terrain, 0, 0, 1, 1);
    expect(path).not.toBeNull();
    // (0,0) -> (1,1) diagonally would cut the blocked (1,0).
    expect(path?.map(key)).toEqual(['0,1', '1,1']);
  });

  it('produces only orthogonal-or-diagonal single steps', () => {
    const terrain = createTerrain(20, 20);
    for (let i = 0; i < 20; i += 3) setBlocked(terrain, i, 7, true);
    const path = findPath(terrain, 1, 1, 18, 18);
    expect(path).not.toBeNull();
    let previous = { x: 1, y: 1 };
    for (const step of path ?? []) {
      const dx = Math.abs(step.x - previous.x);
      const dy = Math.abs(step.y - previous.y);
      expect(Math.max(dx, dy)).toBe(1);
      expect(dx + dy).toBeGreaterThan(0);
      previous = step;
    }
    expect(previous).toEqual({ x: 18, y: 18 });
  });
});

describe('isReachable', () => {
  it('agrees with findPath on an open map', () => {
    const terrain = createTerrain(10, 10);
    expect(isReachable(terrain, 0, 0, 9, 9)).toBe(true);
  });

  it('reports false across a sealed wall', () => {
    const terrain = createTerrain(10, 10);
    for (let y = 0; y < 10; y += 1) setBlocked(terrain, 4, y, true);
    expect(isReachable(terrain, 0, 0, 9, 0)).toBe(false);
  });
});
