/** Small order-manipulation helpers shared by movement, actions and systems. */

import type { Unit, UnitTask } from '../../shared/types';

export function clearPath(unit: Unit): void {
  unit.path = null;
  unit.pathIndex = 0;
  unit.destTile = null;
}

export function assignTask(unit: Unit, state: Unit['state'], task: UnitTask | null): void {
  clearPath(unit);
  unit.state = state;
  unit.task = task;
}

export function clearOrder(unit: Unit): void {
  clearPath(unit);
  unit.task = null;
  unit.state = 'idle';
}

/**
 * Drop any order that points at `targetId` (called when an entity dies or is
 * mined out).
 *
 * The unit state is deliberately preserved for gatherers and attackers: their
 * system re-acquires a target next tick (a worker whose node was mined out
 * keeps gathering on a neighbouring node instead of standing still forever).
 * Only builders are reset, because a construction site that vanished leaves
 * nothing to build.
 */
export function releaseReferencesTo(units: Iterable<Unit>, targetId: string): void {
  for (const unit of units) {
    const task = unit.task;
    if (task !== null) {
      const references =
        (task.type === 'gather' && task.nodeId === targetId) ||
        (task.type === 'deposit' && task.baseId === targetId) ||
        (task.type === 'attack' && task.targetId === targetId) ||
        (task.type === 'build' && task.buildingId === targetId);
      if (references) {
        clearPath(unit);
        unit.task = null;
        if (task.type === 'build') unit.state = 'idle';
      }
    }
    if (unit.attackedBy === targetId) unit.attackedBy = null;
  }
}
