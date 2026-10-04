/**
 * Fog bitmask codec (acceptance A10).
 *
 * The client reconstructs the explored layer from an initial full mask plus
 * incremental row deltas, so encode/decode and the OR-merge must round-trip
 * exactly — a silent bug here would corrupt the whole fog layer.
 */

import { describe, expect, it } from 'vitest';
import {
  countExplored,
  decodeFogRows,
  diffFogRows,
  emptyFogRows,
  encodeFogRows,
  isExplored,
  mergeFogRows,
} from '../../src/game/view/fogCodec';
import { makeMatch, makeValidatorArena, primeVision, TEST_SEED } from '../helpers/fixtures';
import { tileOf } from '../../src/game/math';

describe('fog codec', () => {
  it('starts empty', () => {
    const rows = emptyFogRows(64, 64);
    expect(rows).toHaveLength(64);
    expect(rows.every((row) => row === '0'.repeat(16))).toBe(true);
  });

  it('round-trips a real explored mask', () => {
    const state = makeMatch(TEST_SEED);
    const { width, height } = state.terrain;
    const rows = encodeFogRows(state.vision.p1.explored, width, height);
    const decoded = decodeFogRows(rows, width, height);
    expect(Array.from(decoded)).toEqual(Array.from(state.vision.p1.explored));
  });

  it('encodes individual bits with MSB-first nibbles', () => {
    const width = 64;
    const height = 2;
    const bits = new Uint8Array(width * height);
    bits[0] = 1; // tile (0,0)
    bits[3] = 1; // tile (3,0)
    bits[4] = 1; // tile (4,0)
    const rows = encodeFogRows(bits, width, height);
    const first = rows[0] ?? '';
    expect(first.slice(0, 2)).toBe('98');
    expect(first.slice(2)).toBe('0'.repeat(14));
    expect(rows[1]?.length).toBe(16);
    expect(isExplored(rows, width, 0, 0)).toBe(true);
    expect(isExplored(rows, width, 3, 0)).toBe(true);
    expect(isExplored(rows, width, 4, 0)).toBe(true);
    expect(isExplored(rows, width, 1, 0)).toBe(false);
    expect(countExplored(rows, width, height)).toBe(3);
  });

  it('merges incremental deltas back to the exact full encoding', () => {
    const width = 64;
    const height = 64;
    const before = emptyFogRows(width, height);
    const afterBits = new Uint8Array(width * height);
    for (let i = 0; i < 500; i += 7) afterBits[i] = 1;
    const after = encodeFogRows(afterBits, width, height);

    const delta = diffFogRows(before, after);
    expect(delta.rows.length).toBeGreaterThan(0);

    const merged = mergeFogRows(before, delta);
    expect(merged).toEqual(after);
    expect(Array.from(decodeFogRows(merged, width, height))).toEqual(Array.from(afterBits));
  });

  it('produces an empty delta when nothing changed', () => {
    const rows = emptyFogRows(64, 64);
    expect(diffFogRows(rows, rows).rows).toEqual([]);
  });

  it('OR-merging is monotonic and idempotent', () => {
    const width = 64;
    const height = 64;
    const rows = emptyFogRows(width, height);
    const delta = { rows: [{ i: 4, bits: `f${'0'.repeat(15)}` }] };
    const once = mergeFogRows(rows, delta);
    const twice = mergeFogRows(once, delta);
    expect(twice).toEqual(once);
    expect(isExplored(once, width, 0, 4)).toBe(true);
    expect(isExplored(once, width, 3, 4)).toBe(true);
    expect(isExplored(once, width, 4, 4)).toBe(false);
  });

  it('reflects newly explored tiles after vision updates', () => {
    const arena = makeValidatorArena();
    const { width, height } = arena.state.terrain;
    const before = encodeFogRows(arena.state.vision.p1.explored, width, height);

    // A crystal the player can now see becomes explored.
    arena.p1Soldier.x = 12.5;
    arena.p1Soldier.y = 12.5;
    primeVision(arena.state);
    const after = encodeFogRows(arena.state.vision.p1.explored, width, height);

    const delta = diffFogRows(before, after);
    expect(delta.rows.length).toBeGreaterThan(0);
    expect(mergeFogRows(before, delta)).toEqual(after);
    expect(countExplored(after, width, height)).toBeGreaterThan(countExplored(before, width, height));
    // Explored is monotonically growing.
    expect(isExplored(after, width, tileOf(arena.p1Base.x), tileOf(arena.p1Base.y))).toBe(true);
  });

  it('rejects malformed rows instead of producing a wrong mask', () => {
    expect(() => decodeFogRows(['00'], 64, 1)).toThrow();
    expect(() => decodeFogRows([], 64, 1)).toThrow();
  });
});
