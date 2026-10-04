/**
 * Fog codec — the wire format of the explored layer (docs/SPEC.md §7.3).
 *
 * The explored mask only ever grows, so the server sends:
 *   - the full mask once, in `init`;
 *   - then `{rows: [{i, bits}]}` deltas containing only the changed rows.
 * Each row is a hex bitmask: 4 tiles per hex char, MSB first, so a 64-tile row
 * is 16 characters.
 *
 * Every function here is pure and covered by tests (acceptance A10) because a
 * codec bug would silently corrupt the client's fog.
 */

import {
  decodeBitRows,
  diffBitRows,
  emptyBitRows,
  encodeBitRows,
  mergeBitRows,
} from '../map/terrain';

export interface FogDelta {
  rows: { i: number; bits: string }[];
}

export const HEX_CHARS_PER_ROW = (width: number): number => Math.ceil(width / 4);

export function encodeFogRows(explored: Uint8Array, width: number, height: number): string[] {
  return encodeBitRows(explored, width, height);
}

export function decodeFogRows(rows: string[], width: number, height: number): Uint8Array {
  return decodeBitRows(rows, width, height);
}

export function emptyFogRows(width: number, height: number): string[] {
  return emptyBitRows(width, height);
}

export function diffFogRows(previous: string[], next: string[]): FogDelta {
  return { rows: diffBitRows(previous, next) };
}

/** Client-side (and test) merge of a delta into the locally held mask. */
export function mergeFogRows(rows: string[], delta: FogDelta): string[] {
  return mergeBitRows(rows, delta.rows);
}

export function isExplored(
  rows: string[],
  width: number,
  x: number,
  y: number,
): boolean {
  const row = rows[y];
  if (row === undefined) return false;
  const charIndex = Math.floor(x / 4);
  const nibble = parseInt(row[charIndex] ?? '0', 16);
  if (Number.isNaN(nibble)) return false;
  const bitIndex = x % 4;
  return (nibble & (1 << (3 - bitIndex))) !== 0;
}

export function countExplored(rows: string[], width: number, height: number): number {
  let total = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isExplored(rows, width, x, y)) total += 1;
    }
  }
  return total;
}
