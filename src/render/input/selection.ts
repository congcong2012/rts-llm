/**
 * Selection & hit testing (docs/ROADMAP.md 阶段 2 任务 7).
 *
 * Hard rule: only entities the human is *allowed to see* can be selected. The
 * client enforces this on top of the server filter, because a stale snapshot can
 * leave an enemy on screen for a few frames after it walked into the fog — and
 * ordering an attack on a ghost would be a (rejected, but noisy) illegal order.
 *
 * Everything here is pure: the caller passes the currently rendered entity list
 * (already interpolated) plus a screen/world rectangle.
 */

import type { SampledEntity } from '../interp';
import { KIND_SOLDIER, KIND_WORKER, OWNER_HUMAN } from '../state/WorldModel';

/** Radius (in tiles) used to turn a click into a selection candidate. */
export const PICK_RADIUS_TILES = 0.55;
/** Above this many units a box-select is capped, mirroring the human budget. */
export const MAX_SELECTION = 24;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function rectFromPoints(ax: number, ay: number, bx: number, by: number): Rect {
  return {
    x0: Math.min(ax, bx),
    y0: Math.min(ay, by),
    x1: Math.max(ax, bx),
    y1: Math.max(ay, by),
  };
}

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
}

export function rectAreaTiles(rect: Rect): number {
  return Math.max(1, Math.round((rect.x1 - rect.x0) * (rect.y1 - rect.y0)));
}

/** A selectable entity must be an own, currently drawn unit. */
export function isSelectable(entity: SampledEntity): boolean {
  if (entity.o !== OWNER_HUMAN) return false;
  if (entity.k !== KIND_WORKER && entity.k !== KIND_SOLDIER) return false;
  return entity.alpha > 0.35;
}

/**
 * Nearest own unit within `PICK_RADIUS_TILES` of (x, y), in tile units.
 *
 * Ties are broken by the smallest id so the same click always picks the same
 * unit — deterministic selection makes the acceptance walkthrough repeatable.
 */
export function pickUnit(
  entities: readonly SampledEntity[],
  x: number,
  y: number,
  radiusTiles = PICK_RADIUS_TILES,
): string | null {
  let best: { id: string; distSq: number } | null = null;
  const radiusSq = radiusTiles * radiusTiles;

  for (const entity of entities) {
    if (!isSelectable(entity)) continue;
    const dx = entity.x - x;
    const dy = entity.y - y;
    const distSq = dx * dx + dy * dy;
    if (distSq > radiusSq) continue;
    if (best === null || distSq < best.distSq || (distSq === best.distSq && entity.id < best.id)) {
      best = { id: entity.id, distSq };
    }
  }
  return best?.id ?? null;
}

/** Every own unit whose centre lies inside the drag rectangle. */
export function pickUnitsInRect(
  entities: readonly SampledEntity[],
  rect: Rect,
  limit = MAX_SELECTION,
): string[] {
  const found: string[] = [];
  for (const entity of entities) {
    if (!isSelectable(entity)) continue;
    if (!rectContains(rect, entity.x, entity.y)) continue;
    found.push(entity.id);
  }
  found.sort();
  return found.slice(0, limit);
}

/**
 * Additive selection (shift-click / shift-drag): union of the previous set and
 * the new hits, preserving a stable order and respecting `MAX_SELECTION`.
 */
export function toggleSelection(current: readonly string[], hits: readonly string[]): string[] {
  const merged = new Set(current);
  let removed = 0;
  for (const id of hits) {
    if (merged.has(id)) {
      merged.delete(id);
      removed += 1;
    }
  }
  if (removed === 0) for (const id of hits) merged.add(id);

  return [...merged].sort().slice(0, MAX_SELECTION);
}

/** Count the selected units by kind, for the HUD readout. */
export function summarizeSelection(
  entities: readonly SampledEntity[],
  selected: ReadonlySet<string>,
): { workers: number; soldiers: number; total: number } {
  let workers = 0;
  let soldiers = 0;
  for (const entity of entities) {
    if (!selected.has(entity.id)) continue;
    if (entity.k === KIND_WORKER) workers += 1;
    else if (entity.k === KIND_SOLDIER) soldiers += 1;
  }
  return { workers, soldiers, total: workers + soldiers };
}

/** Cached view of the sampled entities, filtered down to the selectable ones. */
export function selectableIds(entities: readonly SampledEntity[]): string[] {
  return entities.filter(isSelectable).map((entity) => entity.id);
}
