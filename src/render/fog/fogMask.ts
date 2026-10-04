/**
 * Client-side fog bookkeeping (docs/ROADMAP.md 阶段 2 任务 6).
 *
 * The server sends the explored layer as row bitmasks:
 *   - once, in full, inside `init` (`FogInit.exploredRows`);
 *   - then only the rows that grew, as `FogDelta`.
 *
 * This module owns that local state and answers two questions:
 *   - has this tile ever been seen?  → `isExploredTile`
 *   - which rows does a delta touch? → `mergeFogDelta().changedRows`
 *
 * Everything is pure and DOM-free, so it is unit tested directly (acceptance
 * B10) — a codec bug here would silently corrupt the player's map knowledge.
 *
 * Three visibility states exist on the client, derived from two inputs:
 *   unexplored        never seen              → opaque black
 *   explored, unseen  seen before, not now    → dimmed (alpha 0.45)
 *   visible now       inside an own unit's / a visible enemy's vision radius
 *                                             → clear
 * The "visible now" set is approximated from the entity rows the server sent
 * (see {@link visibleTilesFromEntities}); it is cosmetic only and can never
 * disclose anything, because the input is already filtered server-side.
 */

import type { FogDelta, FogInit } from '../../shared/protocol';
import { HEX_CHARS_PER_ROW } from '../../game/view/fogCodec';

/** Alpha applied to a remembered (explored, not currently visible) tile. */
export const EXPLORED_ALPHA = 0.45;
/** Alpha applied to a currently visible tile. */
export const VISIBLE_ALPHA = 0.0;
/** Alpha applied to a tile that was never seen. */
export const UNEXPLORED_ALPHA = 1.0;
/** Ticks a freshly revealed tile takes to ease from opaque to its target. */
export const REVEAL_TICKS = 8;

/** Test one bit of a hex row string. Out-of-range reads return false. */
export function isRowBitSet(row: string | undefined, x: number): boolean {
  if (row === undefined) return false;
  const nibble = parseInt(row[x >> 2] ?? '0', 16);
  if (Number.isNaN(nibble)) return false;
  return (nibble & (1 << (3 - (x & 3)))) !== 0;
}

export interface FogMask {
  width: number;
  height: number;
  /** One hex bitmask string per map row; length === height; 4 tiles per char. */
  exploredRows: string[];
}

export function createFogMask(width: number, height: number): FogMask {
  const charsPerRow = HEX_CHARS_PER_ROW(width);
  return {
    width,
    height,
    exploredRows: new Array<string>(height).fill('0'.repeat(charsPerRow)),
  };
}

/**
 * Build the mask from the `init` payload.
 *
 * Everything already known at connect time is treated as *settled*: the renderer
 * must not replay 64 rows of reveal animation on join.
 */
export function initFogMask(fog: FogInit, width: number, height: number): FogMask {
  const mask = createFogMask(width, height);
  const rows = Math.min(height, fog.exploredRows.length);
  for (let y = 0; y < rows; y += 1) {
    const row = fog.exploredRows[y];
    if (row !== undefined && row.length > 0) mask.exploredRows[y] = row;
  }
  return mask;
}

export interface FogChange {
  /** Rows whose bits changed, ascending — the renderer only repaints these. */
  changedRows: number[];
  /** Tile indices that flipped unexplored → explored in this update. */
  revealedTiles: number[];
}

/**
 * Merge a delta into the mask. Mutates `mask`, returns what changed.
 *
 * Bits are only ever turned ON: the explored layer is monotonic, so a stale or
 * malformed delta can never shrink what the player already knows.
 */
export function mergeFogDelta(mask: FogMask, delta: FogDelta, nowMs: number): FogChange {
  void nowMs;
  const changedRows: number[] = [];
  const revealedTiles: number[] = [];

  for (const update of delta.rows) {
    const y = update.i;
    if (y < 0 || y >= mask.height) continue;

    const current = mask.exploredRows[y] ?? '0'.repeat(HEX_CHARS_PER_ROW(mask.width));
    if (current === update.bits) continue;

    const chars = current.split('');
    let changed = false;
    for (let x = 0; x < mask.width; x += 1) {
      if (!isRowBitSet(update.bits, x)) continue;
      if (isRowBitSet(current, x)) continue;
      const index = x >> 2;
      const nibble = parseInt(chars[index] ?? '0', 16);
      chars[index] = (nibble | (1 << (3 - (x & 3)))).toString(16);
      revealedTiles.push(y * mask.width + x);
      changed = true;
    }
    if (!changed) continue;

    mask.exploredRows[y] = chars.join('');
    changedRows.push(y);
  }

  changedRows.sort((a, b) => a - b);
  revealedTiles.sort((a, b) => a - b);
  return { changedRows, revealedTiles };
}

export function isExploredTile(mask: FogMask, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false;
  return isRowBitSet(mask.exploredRows[y], x);
}

export function countExploredTiles(mask: FogMask): number {
  let total = 0;
  for (let y = 0; y < mask.height; y += 1) {
    const row = mask.exploredRows[y];
    if (row === undefined) continue;
    for (let x = 0; x < mask.width; x += 1) if (isRowBitSet(row, x)) total += 1;
  }
  return total;
}

export interface VisionSource {
  k: number;
  o: number;
  x: number;
  y: number;
}

/**
 * Approximate "visible right now" tiles from the entity rows the server sent.
 *
 * Mirrors the simulation's `markCircle` (tile centres, circular radius) so the
 * clear region on screen matches what the player can actually observe. Returns a
 * flat mask of 0/1, one byte per tile.
 */
export function visibleTilesFromEntities(
  mask: FogMask,
  visionRadius: (owner: number, kind: number) => number,
  entities: readonly VisionSource[],
): Uint8Array {
  const visible = new Uint8Array(mask.width * mask.height);

  for (const entity of entities) {
    const radius = visionRadius(entity.o, entity.k);
    if (radius <= 0) continue;

    const cx = entity.x;
    const cy = entity.y;
    const radiusSq = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(mask.width - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(mask.height - 1, Math.ceil(cy + radius));

    for (let ty = y0; ty <= y1; ty += 1) {
      for (let tx = x0; tx <= x1; tx += 1) {
        const dx = tx + 0.5 - cx;
        const dy = ty + 0.5 - cy;
        if (dx * dx + dy * dy > radiusSq) continue;
        visible[ty * mask.width + tx] = 1;
      }
    }
  }
  return visible;
}

/**
 * One time-based step of an alpha transition.
 *
 * Returns the new alpha and whether the transition finished. Time-based (a fixed
 * alpha per millisecond) rather than a per-frame exponential lerp: the latter
 * runs at a different speed on a 30 fps machine and only ever approaches its
 * target asymptotically, which leaves a permanent faint haze along the vision
 * boundary.
 */
export function advanceAlpha(
  current: number,
  target: number,
  step: number,
  settleEpsilon = 0.004,
): { alpha: number; done: boolean } {
  const difference = target - current;
  if (Math.abs(difference) <= step || Math.abs(difference) <= settleEpsilon) {
    return { alpha: target, done: true };
  }
  return { alpha: current + Math.sign(difference) * step, done: false };
}

/** Milliseconds a tile needs to cross its full alpha range. */
export function revealSpanMs(tickRate: number): number {
  return Math.max(1, (REVEAL_TICKS * 1000) / tickRate);
}

/** Rows in which the visible mask differs between two states.
 *
 * `before === null` means "nothing was visible before" (a fresh world model), so
 * the result is every row that currently contains a lit tile.
 */
export function changedVisibleRows(
  mask: FogMask,
  before: Uint8Array | null,
  after: Uint8Array,
): number[] {
  const rows: number[] = [];
  for (let y = 0; y < mask.height; y += 1) {
    const base = y * mask.width;
    for (let x = 0; x < mask.width; x += 1) {
      const a = before === null ? 0 : (before[base + x] ?? 0);
      const b = after[base + x] ?? 0;
      if (a !== b) {
        rows.push(y);
        break;
      }
    }
  }
  return rows;
}
