/**
 * Terrain layer: a row-major walkability grid.
 *
 * Out-of-bounds is treated as blocked, so callers never need a separate bounds
 * check before a walkability test.
 */

import type { Terrain } from '../../shared/types';

export function createTerrain(width: number, height: number): Terrain {
  return { width, height, blocked: new Uint8Array(width * height) };
}

export function idx(terrain: Terrain, x: number, y: number): number {
  return y * terrain.width + x;
}

export function inBounds(terrain: Terrain, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < terrain.width && y < terrain.height;
}

export function isBlocked(terrain: Terrain, x: number, y: number): boolean {
  if (!inBounds(terrain, x, y)) return true;
  return terrain.blocked[idx(terrain, x, y)] === 1;
}

export function isWalkable(terrain: Terrain, x: number, y: number): boolean {
  return !isBlocked(terrain, x, y);
}

export function setBlocked(terrain: Terrain, x: number, y: number, blocked: boolean): void {
  if (!inBounds(terrain, x, y)) return;
  terrain.blocked[idx(terrain, x, y)] = blocked ? 1 : 0;
}

export function clearRect(terrain: Terrain, cx: number, cy: number, radius: number): void {
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      setBlocked(terrain, x, y, false);
    }
  }
}

export function countBlocked(terrain: Terrain): number {
  let total = 0;
  for (let i = 0; i < terrain.blocked.length; i += 1) total += terrain.blocked[i] === 1 ? 1 : 0;
  return total;
}

/** Serialise the blocked layer as one hex bitmask string per row. */
export function encodeBlockedRows(terrain: Terrain): string[] {
  return encodeBitRows(terrain.blocked, terrain.width, terrain.height);
}

/** Generic row-bitmask encoder: 4 tiles per hex char, MSB first. */
export function encodeBitRows(bits: Uint8Array, width: number, height: number): string[] {
  const charsPerRow = Math.ceil(width / 4);
  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    const chars = new Array<string>(charsPerRow).fill('0');
    for (let x = 0; x < width; x += 1) {
      if (bits[y * width + x] !== 1) continue;
      const charIndex = Math.floor(x / 4);
      const bitIndex = x % 4;
      const current = parseInt(chars[charIndex] ?? '0', 16);
      const next = current | (1 << (3 - bitIndex));
      chars[charIndex] = next.toString(16);
    }
    rows.push(chars.join(''));
  }
  return rows;
}

/** Inverse of {@link encodeBitRows}. Throws on malformed input. */
export function decodeBitRows(rows: string[], width: number, height: number): Uint8Array {
  const bits = new Uint8Array(width * height);
  const charsPerRow = Math.ceil(width / 4);
  for (let y = 0; y < height; y += 1) {
    const row = rows[y];
    if (row === undefined) throw new Error(`decodeBitRows: missing row ${y}`);
    if (row.length !== charsPerRow) {
      throw new Error(`decodeBitRows: row ${y} has ${row.length} chars, expected ${charsPerRow}`);
    }
    for (let x = 0; x < width; x += 1) {
      const charIndex = Math.floor(x / 4);
      const nibble = parseInt(row[charIndex] ?? '0', 16);
      if (Number.isNaN(nibble)) throw new Error(`decodeBitRows: bad hex in row ${y}`);
      const bitIndex = x % 4;
      if ((nibble & (1 << (3 - bitIndex))) !== 0) bits[y * width + x] = 1;
    }
  }
  return bits;
}

/** Rows whose bitmask differs between two encodes. */
export function diffBitRows(previous: string[], next: string[]): { i: number; bits: string }[] {
  const changes: { i: number; bits: string }[] = [];
  for (let i = 0; i < next.length; i += 1) {
    const before = previous[i];
    const after = next[i];
    if (after === undefined) continue;
    if (before === after) continue;
    changes.push({ i, bits: after });
  }
  return changes;
}

/** Apply a delta by OR-ing the received bits into the current rows. */
export function mergeBitRows(
  rows: string[],
  changes: { i: number; bits: string }[],
): string[] {
  const merged = [...rows];
  for (const change of changes) {
    const current = merged[change.i];
    if (current === undefined) {
      merged[change.i] = change.bits;
      continue;
    }
    let out = '';
    for (let c = 0; c < Math.max(current.length, change.bits.length); c += 1) {
      const a = parseInt(current[c] ?? '0', 16);
      const b = parseInt(change.bits[c] ?? '0', 16);
      out += ((a | b) & 0xf).toString(16);
    }
    merged[change.i] = out;
  }
  return merged;
}

export function emptyBitRows(width: number, height: number): string[] {
  return new Array<string>(height).fill('0'.repeat(Math.ceil(width / 4)));
}
