/**
 * Fog mask tests (acceptance B7/B10).
 *
 * The client's fog is a pure data structure fed by `FogInit` + `FogDelta`, so
 * every rule from docs/SPEC.md §10 is asserted here instead of being eyeballed in
 * a browser:
 *   - explored is monotonic (never re-blacks),
 *   - deltas touch only the rows that actually changed,
 *   - every codec path round-trips against the server's encoder.
 */

import { describe, expect, it } from 'vitest';
import { encodeBitRows } from '../../src/game/map/terrain';
import { encodeFogRows, diffFogRows, emptyFogRows } from '../../src/game/view/fogCodec';
import {
  EXPLORED_ALPHA,
  REVEAL_TICKS,
  UNEXPLORED_ALPHA,
  VISIBLE_ALPHA,
  advanceAlpha,
  changedVisibleRows,
  countExploredTiles,
  createFogMask,
  initFogMask,
  isExploredTile,
  isRowBitSet,
  mergeFogDelta,
  revealSpanMs,
  visibleTilesFromEntities,
} from '../../src/render/fog/fogMask';

const W = 8;
const H = 4;

/** Build a server-side explored bitmap and encode it, like the gateway would. */
function rowsFromTiles(tiles: readonly [number, number][]): string[] {
  const bits = new Uint8Array(W * H);
  for (const [x, y] of tiles) bits[y * W + x] = 1;
  return encodeBitRows(bits, W, H);
}

describe('fogMask: construction', () => {
  it('starts fully unexplored', () => {
    const mask = createFogMask(W, H);
    expect(mask.exploredRows).toHaveLength(H);
    expect(countExploredTiles(mask)).toBe(0);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) expect(isExploredTile(mask, x, y)).toBe(false);
    }
  });

  it('adopts the rows from the init frame', () => {
    const rows = rowsFromTiles([
      [0, 0],
      [3, 1],
      [7, 3],
    ]);
    const mask = initFogMask({ exploredRows: rows }, W, H);

    expect(isExploredTile(mask, 0, 0)).toBe(true);
    expect(isExploredTile(mask, 3, 1)).toBe(true);
    expect(isExploredTile(mask, 7, 3)).toBe(true);
    expect(isExploredTile(mask, 1, 0)).toBe(false);
    expect(countExploredTiles(mask)).toBe(3);
  });

  it('ignores a short or oversized init payload instead of crashing', () => {
    const mask = initFogMask({ exploredRows: ['f', 'f'] }, W, H);
    expect(mask.exploredRows).toHaveLength(H);
    expect(countExploredTiles(mask)).toBe(8);
  });
});

describe('fogMask: bit reads', () => {
  it('reads individual bits MSB-first, matching the server encoder', () => {
    // 0b1001 => x=0 and x=3 are set within the first nibble.
    expect(isRowBitSet('9', 0)).toBe(true);
    expect(isRowBitSet('9', 1)).toBe(false);
    expect(isRowBitSet('9', 2)).toBe(false);
    expect(isRowBitSet('9', 3)).toBe(true);
  });

  it('returns false for missing rows and invalid characters', () => {
    expect(isRowBitSet(undefined, 0)).toBe(false);
    expect(isRowBitSet('', 5)).toBe(false);
    expect(isRowBitSet('zz', 0)).toBe(false);
  });
});

describe('fogMask: delta merge', () => {
  it('turns on the new bits and reports the changed rows', () => {
    const mask = createFogMask(W, H);
    const next = rowsFromTiles([
      [1, 0],
      [2, 0],
      [5, 2],
    ]);
    const delta = diffFogRows(emptyFogRows(W, H), next);
    const change = mergeFogDelta(mask, delta, 0);

    expect(change.changedRows).toEqual([0, 2]);
    expect(change.revealedTiles).toEqual([1, 2, 2 * W + 5]);
    expect(isExploredTile(mask, 1, 0)).toBe(true);
    expect(isExploredTile(mask, 5, 2)).toBe(true);
    expect(countExploredTiles(mask)).toBe(3);
  });

  it('is monotonic: a stale or partial delta never re-blacks a tile', () => {
    const mask = createFogMask(W, H);
    const full = rowsFromTiles([
      [0, 0],
      [1, 0],
      [2, 1],
    ]);
    mergeFogDelta(mask, diffFogRows(emptyFogRows(W, H), full), 0);
    expect(countExploredTiles(mask)).toBe(3);

    // A delta that adds one new tile on row 0 and does not mention row 1 at all.
    // Row 0's existing bits (x=0, x=1) must survive, and row 1 must be untouched:
    // the explored layer only ever grows, whatever the delta says.
    const change = mergeFogDelta(mask, { rows: [{ i: 0, bits: '08' }] }, 100);
    expect(change.changedRows).toEqual([0]);
    expect(isExploredTile(mask, 0, 0)).toBe(true);
    expect(isExploredTile(mask, 1, 0)).toBe(true);
    expect(isExploredTile(mask, 4, 0)).toBe(true);
    expect(isExploredTile(mask, 2, 1)).toBe(true);
    expect(countExploredTiles(mask)).toBe(4);
  });

  it('reports nothing when the delta adds no new bits', () => {
    const mask = createFogMask(W, H);
    const rows = rowsFromTiles([[4, 3]]);
    mergeFogDelta(mask, diffFogRows(emptyFogRows(W, H), rows), 0);

    const again = mergeFogDelta(mask, { rows: [{ i: 3, bits: rows[3] ?? '0' }] }, 100);
    expect(again.changedRows).toEqual([]);
    expect(again.revealedTiles).toEqual([]);
  });

  it('ignores rows outside the map', () => {
    const mask = createFogMask(W, H);
    const change = mergeFogDelta(
      mask,
      {
        rows: [
          { i: -1, bits: 'ff' },
          { i: 99, bits: 'ff' },
        ],
      },
      0,
    );
    expect(change.changedRows).toEqual([]);
    expect(countExploredTiles(mask)).toBe(0);
  });

  it('applies a multi-row delta in one pass', () => {
    const mask = createFogMask(W, H);
    const first = rowsFromTiles([[0, 0]]);
    mergeFogDelta(mask, diffFogRows(emptyFogRows(W, H), first), 0);
    const second = rowsFromTiles([
      [0, 0],
      [0, 1],
      [7, 1],
      [3, 2],
    ]);
    const change = mergeFogDelta(mask, diffFogRows(first, second), 50);

    expect(change.changedRows).toEqual([1, 2]);
    expect(countExploredTiles(mask)).toBe(4);
  });

  it('round-trips against the server-side full-mask encoder', () => {
    const mask = createFogMask(W, H);
    const bits = new Uint8Array(W * H);
    for (let i = 0; i < bits.length; i += 3) bits[i] = 1;
    const rows = encodeFogRows(bits, W, H);

    mergeFogDelta(mask, diffFogRows(emptyFogRows(W, H), rows), 0);
    expect(mask.exploredRows).toEqual(rows);
    expect(countExploredTiles(mask)).toBe(bits.reduce((sum, value) => sum + value, 0));
  });
});

describe('fogMask: visible-tile derivation', () => {
  /** Small radii keep the assertions exact on an 8x4 map. */
  const visionRadius = (owner: number, kind: number): number =>
    owner === 2 ? 0 : kind === 0 ? 2 : kind === 1 ? 2 : 3;

  it('marks a circular region around each own entity, tile-centre based', () => {
    const mask = createFogMask(W, H);
    // Vision 2, centred exactly on the centre of tile (4, 2).
    const vision2 = (owner: number): number => (owner === 2 ? 0 : 2);
    const visible = visibleTilesFromEntities(mask, vision2, [{ k: 0, o: 0, x: 4.5, y: 2.5 }]);

    // Directly under the unit is visible, orthogonally adjacent too, and a
    // diagonal neighbour (d² = 2) as well.
    expect(visible[2 * W + 4]).toBe(1);
    expect(visible[2 * W + 5]).toBe(1);
    expect(visible[1 * W + 3]).toBe(1);

    // Two tiles away orthogonally (d² = 4) is still inside; three is not.
    expect(visible[2 * W + 6]).toBe(1);
    expect(visible[2 * W + 7]).toBe(0);
    // A diagonal 2-2 step (d² = 8) is outside.
    expect(visible[0 * W + 6]).toBe(0);

    // 12 tiles: the 13-point radius-2 disc, minus the one that falls off-map
    // (y = 4 does not exist). The count also proves nothing wrapped around the
    // row stride: a wrapped write would light additional tiles.
    expect(visible.reduce((sum, value) => sum + value, 0)).toBe(12);
  });

  it('skips neutral and non-vision entities', () => {
    const mask = createFogMask(W, H);
    const visible = visibleTilesFromEntities(mask, visionRadius, [
      { k: 4, o: 2, x: 1.5, y: 1.5 }, // crystal: owner code 2 => radius 0
    ]);
    expect(visible.reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it('clips to the map instead of writing out of bounds', () => {
    const mask = createFogMask(W, H);
    const small = (owner: number, kind: number): number => (owner === 2 ? 0 : kind === 1 ? 2 : 2);
    const visible = visibleTilesFromEntities(mask, small, [{ k: 1, o: 0, x: 0.5, y: 0.5 }]);
    expect(visible).toHaveLength(W * H);
    expect(visible[0]).toBe(1);
  });

  it('reports the rows where visibility changed', () => {
    const mask = createFogMask(W, H);
    const vision2 = (owner: number): number => (owner === 2 ? 0 : 2);
    const before = visibleTilesFromEntities(mask, vision2, [{ k: 1, o: 0, x: 1.5, y: 0.5 }]);
    const after = visibleTilesFromEntities(mask, vision2, [{ k: 1, o: 0, x: 1.5, y: 3.5 }]);

    // The unit moved from the top row to the bottom row: both extremes changed.
    const rows = changedVisibleRows(mask, before, after);
    expect(rows).toContain(0);
    expect(rows).toContain(3);

    // A null `before` means "nothing was visible yet", so the result must be
    // exactly the rows that contain a visible tile now — computed independently.
    const rowsWithVisibleTiles: number[] = [];
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (after[y * W + x] === 1) {
          rowsWithVisibleTiles.push(y);
          break;
        }
      }
    }
    expect(rowsWithVisibleTiles).toEqual([1, 2, 3]);
    expect(changedVisibleRows(mask, null, after)).toEqual(rowsWithVisibleTiles);
  });
});

describe('fogMask: reveal transition is time based', () => {
  it('crosses the full range in exactly REVEAL_TICKS ticks', () => {
    const tickRate = 10;
    const spanMs = revealSpanMs(tickRate);
    expect(spanMs).toBe(800); // 8 ticks at 10 tick/s

    // Simulate 60 fps frames until the transition reports "done".
    let alpha = UNEXPLORED_ALPHA;
    let elapsed = 0;
    const frameMs = 1000 / 60;
    let frames = 0;
    for (; frames < 200; frames += 1) {
      const result = advanceAlpha(alpha, VISIBLE_ALPHA, frameMs / spanMs);
      alpha = result.alpha;
      elapsed += frameMs;
      if (result.done) break;
    }
    // Settles within one frame of the nominal 800 ms window, and EXACTLY on the
    // target (an exponential lerp would leave a permanent offset).
    expect(elapsed).toBeGreaterThan(spanMs - frameMs - 1);
    expect(elapsed).toBeLessThan(spanMs + frameMs + 1);
    expect(alpha).toBe(VISIBLE_ALPHA);
  });

  it('takes the same wall-clock time at 30 fps as at 60 fps', () => {
    const spanMs = revealSpanMs(10);
    const runToCompletion = (frameMs: number): number => {
      let alpha = UNEXPLORED_ALPHA;
      let elapsed = 0;
      for (let frame = 0; frame < 1000; frame += 1) {
        const result = advanceAlpha(alpha, EXPLORED_ALPHA, frameMs / spanMs);
        alpha = result.alpha;
        elapsed += frameMs;
        if (result.done) break;
      }
      return elapsed;
    };
    const at60 = runToCompletion(1000 / 60);
    const at30 = runToCompletion(1000 / 30);
    // Within one frame of each other: the duration is a property of the game
    // clock, not of the renderer's frame rate.
    expect(Math.abs(at60 - at30)).toBeLessThan(1000 / 30 + 1);
    expect(at30).toBeLessThan(spanMs + 1000 / 30 + 1);
  });

  it('snaps to the target once the remaining distance is negligible', () => {
    const result = advanceAlpha(0.452, 0.45, 0.0001);
    expect(result.done).toBe(true);
    expect(result.alpha).toBe(0.45);
  });

  it('moves towards the target without overshooting', () => {
    let alpha = UNEXPLORED_ALPHA;
    const step = 0.05;
    for (let i = 0; i < 100; i += 1) {
      const result = advanceAlpha(alpha, VISIBLE_ALPHA, step);
      expect(result.alpha).toBeGreaterThanOrEqual(VISIBLE_ALPHA);
      expect(result.alpha).toBeLessThanOrEqual(UNEXPLORED_ALPHA);
      alpha = result.alpha;
      if (result.done) break;
    }
    expect(alpha).toBe(VISIBLE_ALPHA);
  });

  it('also fades back in when a tile leaves vision again', () => {
    let alpha = VISIBLE_ALPHA;
    let elapsed = 0;
    const frameMs = 1000 / 60;
    const spanMs = revealSpanMs(10);
    for (let frame = 0; frame < 200; frame += 1) {
      const result = advanceAlpha(alpha, EXPLORED_ALPHA, frameMs / spanMs);
      alpha = result.alpha;
      elapsed += frameMs;
      if (result.done) break;
    }
    expect(alpha).toBe(EXPLORED_ALPHA);
    expect(elapsed).toBeLessThan(spanMs + frameMs + 1);
  });
});

describe('fogMask: alpha constants match the roadmap', () => {
  it('uses pure black for unexplored and 0.45 for remembered tiles', () => {
    expect(UNEXPLORED_ALPHA).toBe(1);
    expect(EXPLORED_ALPHA).toBe(0.45);
    expect(VISIBLE_ALPHA).toBe(0);
    expect(REVEAL_TICKS).toBe(8);
  });
});
