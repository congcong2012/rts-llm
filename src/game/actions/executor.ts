/**
 * ActionExecutor — the ONLY place where a validated action mutates the state.
 *
 * Nothing else in the codebase may translate a player's intent into state
 * changes, so "who changed what" is always answerable (docs/SPEC.md §4.2).
 * The executor assumes validation already passed but still guards every lookup,
 * because a state can change between validation and application (an LLM answer
 * can arrive 60 ticks after the request it was derived from).
 */

import type { Action, PlayerId, Unit } from '../../shared/types';
import type { GameState } from '../state/GameState';
import { BUILDING_STATS, UNIT_STATS } from '../config/constants';
import { makeBuilding } from '../entities/factory';
import { tileOf } from '../math';
import { addEntity, allocId, getBuilding, getCrystal, getUnit } from '../state/GameState';
import { assignTask, clearOrder, clearPath } from '../state/unitOps';
import { nearestCrystal } from '../systems/economy';
import { ensurePath } from '../systems/movement';

export function executeAction(state: GameState, owner: PlayerId, action: Action): boolean {
  try {
    switch (action.type) {
      case 'noop':
        return true;

      case 'train':
        return executeTrain(state, owner, action.buildingId, action.unitType);

      case 'build':
        return executeBuild(state, owner, action.unitIds, action.x, action.y);

      case 'move':
        return executeMove(state, owner, action.unitIds, action.x, action.y);

      case 'attack':
        return executeAttack(state, owner, action.unitIds, action.targetId);

      case 'gather':
        return executeGather(state, owner, action.unitIds, action.targetId);

      case 'hold':
        return executeHold(state, owner, action.unitIds);
    }
  } catch {
    return false;
  }
}

function executeTrain(
  state: GameState,
  owner: PlayerId,
  buildingId: string,
  unitType: Unit['kind'],
): boolean {
  const building = getBuilding(state, buildingId);
  if (building === undefined || building.owner !== owner) return false;
  const cost = UNIT_STATS[unitType].cost;
  if (state.players[owner].resources.crystal < cost) return false;

  state.players[owner].resources.crystal -= cost;
  building.queue.push(unitType);
  building.state = 'training';
  building.queueProgress = 0;
  return true;
}

function executeBuild(
  state: GameState,
  owner: PlayerId,
  unitIds: string[],
  tileX: number,
  tileY: number,
): boolean {
  const cost = BUILDING_STATS.barracks.cost;
  if (state.players[owner].resources.crystal < cost) return false;

  const builderId = unitIds[0];
  const builder = getUnit(state, builderId);
  if (builder === undefined || builder.owner !== owner) return false;

  state.players[owner].resources.crystal -= cost;
  const building = makeBuilding({
    id: allocId(state, 'b'),
    kind: 'barracks',
    owner,
    tileX,
    tileY,
    underConstruction: true,
  });
  addEntity(state, building);

  // The first listed worker becomes the builder and walks to the site; any
  // further ids stay idle (they were only offered as candidates).
  assignTask(builder, 'building', { type: 'build', buildingId: building.id });
  ensurePath(state, builder, tileX, tileY);
  return true;
}

function executeMove(
  state: GameState,
  owner: PlayerId,
  unitIds: string[],
  tileX: number,
  tileY: number,
): boolean {
  let moved = false;
  for (const id of unitIds) {
    const unit = getUnit(state, id);
    if (unit === undefined || unit.owner !== owner) continue;
    assignTask(unit, 'moving', { type: 'move', x: tileX, y: tileY });
    if (ensurePath(state, unit, tileX, tileY)) {
      moved = true;
    } else {
      // Unreachable tile: keep the unit responsive instead of stuck "moving".
      clearOrder(unit);
    }
  }
  return moved;
}

function executeAttack(
  state: GameState,
  owner: PlayerId,
  unitIds: string[],
  targetId: string,
): boolean {
  let ordered = false;
  for (const id of unitIds) {
    const unit = getUnit(state, id);
    if (unit === undefined || unit.owner !== owner) continue;
    if (!UNIT_STATS[unit.kind].canInitiateAttack) continue;
    assignTask(unit, 'attacking', { type: 'attack', targetId });
    ordered = true;
  }
  return ordered;
}

function executeGather(
  state: GameState,
  owner: PlayerId,
  unitIds: string[],
  targetId: string | undefined,
): boolean {
  let ordered = false;
  for (const id of unitIds) {
    const unit = getUnit(state, id);
    if (unit === undefined || unit.owner !== owner) continue;
    if (!UNIT_STATS[unit.kind].canGather) continue;

    let nodeId = targetId;
    if (nodeId !== undefined) {
      const node = getCrystal(state, nodeId);
      if (node === undefined || node.amount <= 0) nodeId = undefined;
    }
    if (nodeId === undefined) {
      const nearest = nearestCrystal(state, unit);
      if (nearest === undefined) continue;
      nodeId = nearest.id;
    }
    assignTask(unit, 'gathering', { type: 'gather', nodeId });
    ordered = true;
  }
  return ordered;
}

function executeHold(state: GameState, owner: PlayerId, unitIds: string[]): boolean {
  let ordered = false;
  for (const id of unitIds) {
    const unit = getUnit(state, id);
    if (unit === undefined || unit.owner !== owner) continue;
    clearPath(unit);
    unit.task = null;
    unit.state = 'holding';
    ordered = true;
  }
  return ordered;
}

export { tileOf };
