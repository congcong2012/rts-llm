/**
 * Movement: path following only.
 *
 * This module owns *how* a unit walks; *where it decides to go* is up to the
 * economy / production / combat systems, which all call `ensurePath`. Units do
 * not collide with each other (docs/SPEC.md §1.2), so only terrain matters.
 */

import type { Unit } from '../../shared/types';
import type { GameState } from '../state/GameState';
import { ARRIVE_EPSILON, UNIT_STATS, MOVE_ARRIVE_EPSILON } from '../config/constants';
import { distance, tileOf } from '../math';
import { findPath } from '../map/pathfinding';
import { clearPath as clearUnitPath } from '../state/unitOps';

export { clearUnitPath as clearPath };

/**
 * Make sure `unit` is walking towards tile (tx,ty).
 *
 * Cheap to call every tick: if the unit is already heading to the same tile the
 * existing path is kept, so A* is only recomputed when the destination changes.
 *
 * @returns false when the destination is unreachable / blocked.
 */
export function ensurePath(state: GameState, unit: Unit, tx: number, ty: number): boolean {
  const dest = unit.destTile;
  if (unit.path !== null && dest !== null && dest.x === tx && dest.y === ty) return true;

  const path = findPath(state.terrain, tileOf(unit.x), tileOf(unit.y), tx, ty);
  if (path === null) {
    clearUnitPath(unit);
    return false;
  }
  unit.path = path;
  unit.pathIndex = 0;
  unit.destTile = { x: tx, y: ty };
  return true;
}

/** True when the unit stands close enough to the centre of tile (tx,ty). */
export function isAtTile(unit: Unit, tx: number, ty: number): boolean {
  return distance(unit.x, unit.y, tx + 0.5, ty + 0.5) <= MOVE_ARRIVE_EPSILON;
}

function stepAlongPath(state: GameState, unit: Unit): void {
  const path = unit.path;
  if (path === null) return;
  const speed = UNIT_STATS[unit.kind].speed;

  let guard = 0;
  while (unit.path !== null && unit.pathIndex < unit.path.length && guard < path.length + 1) {
    guard += 1;
    const node = unit.path[unit.pathIndex];
    if (node === undefined) {
      clearUnitPath(unit);
      return;
    }
    const tx = node.x + 0.5;
    const ty = node.y + 0.5;
    const remaining = distance(unit.x, unit.y, tx, ty);

    if (remaining <= ARRIVE_EPSILON) {
      // Already standing on this node — consume it and look at the next one.
      unit.x = tx;
      unit.y = ty;
      unit.pathIndex += 1;
      continue;
    }

    if (remaining <= speed) {
      unit.x = tx;
      unit.y = ty;
      unit.pathIndex += 1;
      break;
    }

    unit.x += ((tx - unit.x) / remaining) * speed;
    unit.y += ((ty - unit.y) / remaining) * speed;
    break;
  }

  if (unit.path !== null && unit.pathIndex >= unit.path.length) {
    const finished = unit.task !== null && unit.task.type === 'move';
    clearUnitPath(unit);
    if (finished) {
      unit.state = 'idle';
      unit.task = null;
      state.events.push({ type: 'arrive', tick: state.tick, entityId: unit.id, owner: unit.owner });
    }
  }
}

export function tick(state: GameState): void {
  for (const unit of state.units) {
    if (unit.path === null) continue;
    stepAlongPath(state, unit);
  }
}
