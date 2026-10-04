/**
 * Map generation (acceptance A5): every seed must produce a *playable* map —
 * both bases connected and enough reachable crystal for an economy.
 */

import { describe, expect, it } from 'vitest';
import { BASE_ANCHORS, BASE_CLEAR_RADIUS } from '../../src/game/config/constants';
import { generateMap } from '../../src/game/map/generate';
import { floodFill } from '../../src/game/map/pathfinding';
import { idx, isWalkable } from '../../src/game/map/terrain';

describe('generateMap', () => {
  it('produces a connected, playable map for 100 different seeds', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const map = generateMap(seed);
      const terrain = map.terrain;

      expect(isWalkable(terrain, BASE_ANCHORS.p1.x, BASE_ANCHORS.p1.y), `p1 base blocked (seed ${seed})`).toBe(true);
      expect(isWalkable(terrain, BASE_ANCHORS.p2.x, BASE_ANCHORS.p2.y), `p2 base blocked (seed ${seed})`).toBe(true);

      const visited = floodFill(terrain, BASE_ANCHORS.p1.x, BASE_ANCHORS.p1.y);
      expect(
        visited[idx(terrain, BASE_ANCHORS.p2.x, BASE_ANCHORS.p2.y)],
        `p2 base unreachable (seed ${seed})`,
      ).toBe(1);

      const reachableCrystals = map.crystals.filter(
        (node) => visited[idx(terrain, node.x, node.y)] === 1,
      );
      expect(reachableCrystals.length, `too few reachable crystals (seed ${seed})`).toBeGreaterThanOrEqual(6);
      expect(map.crystals.length, `no crystals at all (seed ${seed})`).toBeGreaterThan(0);
    }
  });

  it('is deterministic: the same seed yields an identical map', () => {
    const a = generateMap(4242);
    const b = generateMap(4242);
    expect(Array.from(b.terrain.blocked)).toEqual(Array.from(a.terrain.blocked));
    expect(b.crystals).toEqual(a.crystals);
    expect(b.spawns).toEqual(a.spawns);
  });

  it('produces different terrain for different seeds', () => {
    const a = generateMap(1);
    const b = generateMap(2);
    const sameTerrain =
      Array.from(a.terrain.blocked).join('') === Array.from(b.terrain.blocked).join('');
    const sameCrystals = JSON.stringify(a.crystals) === JSON.stringify(b.crystals);
    expect(sameTerrain && sameCrystals).toBe(false);
  });

  it('keeps a clear 5x5 area around both bases', () => {
    for (let seed = 0; seed < 25; seed += 1) {
      const { terrain } = generateMap(seed);
      for (const anchor of [BASE_ANCHORS.p1, BASE_ANCHORS.p2]) {
        for (let dy = -BASE_CLEAR_RADIUS; dy <= BASE_CLEAR_RADIUS; dy += 1) {
          for (let dx = -BASE_CLEAR_RADIUS; dx <= BASE_CLEAR_RADIUS; dx += 1) {
            expect(
              isWalkable(terrain, anchor.x + dx, anchor.y + dy),
              `blocked clear area at ${anchor.x + dx},${anchor.y + dy} (seed ${seed})`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('never places a crystal on top of a base anchor', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const map = generateMap(seed);
      for (const node of map.crystals) {
        const onBase = [BASE_ANCHORS.p1, BASE_ANCHORS.p2].some(
          (anchor) => anchor.x === node.x && anchor.y === node.y,
        );
        expect(onBase, `crystal on base anchor (seed ${seed})`).toBe(false);
      }
    }
  });
});
