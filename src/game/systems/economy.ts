/**
 * Economy: the worker gather cycle.
 *
 * A worker in the `gathering` state loops:
 *   walk to node -> mine (GATHER_RATE/tick) -> walk to base -> deposit -> repeat
 *
 * The phase is carried by `Unit.task` (`gather` | `deposit`) while the public
 * unit state stays `gathering`, which is what the LLM sees.
 */

import type { ResourceNode, Unit } from '../../shared/types';
import type { GameState } from '../state/GameState';
import {
  CARRY_CAPACITY,
  DEPOSIT_RANGE,
  GATHER_RANGE,
  GATHER_RATE,
} from '../config/constants';
import { distance, round3, tileOf } from '../math';
import { findBaseOf, getBuilding, getCrystal, removeEntity } from '../state/GameState';
import { assignTask, clearPath } from '../state/unitOps';
import { ensurePath } from './movement';

export function tick(state: GameState): void {
  for (const unit of state.units) {
    if (unit.kind !== 'worker') continue;
    if (unit.state !== 'gathering') continue;
    runCycle(state, unit);
  }
}

function runCycle(state: GameState, unit: Unit): void {
  const task = unit.task;
  if (task === null || (task.type !== 'gather' && task.type !== 'deposit')) {
    assignGather(state, unit);
    return;
  }
  if (task.type === 'gather') gatherStep(state, unit, task.nodeId);
  else depositStep(state, unit, task.baseId);
}

/** Closest crystal with resources left; ties break on id for determinism. */
export function nearestCrystal(state: GameState, unit: Unit): ResourceNode | undefined {
  let best: ResourceNode | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const node of state.crystals) {
    if (node.amount <= 0) continue;
    const d = distance(unit.x, unit.y, node.x, node.y);
    if (d < bestDistance || (d === bestDistance && best !== undefined && node.id < best.id)) {
      best = node;
      bestDistance = d;
    }
  }
  return best;
}

function assignGather(state: GameState, unit: Unit): void {
  const node = nearestCrystal(state, unit);
  if (node === undefined) {
    clearPath(unit);
    unit.task = null;
    unit.state = 'idle';
    return;
  }
  assignTask(unit, 'gathering', { type: 'gather', nodeId: node.id });
}

function assignDeposit(state: GameState, unit: Unit): void {
  const base = findBaseOf(state, unit.owner);
  if (base === undefined) {
    // No base left to deliver to — keep mining until the base situation is
    // resolved (a lost base ends the match anyway).
    assignGather(state, unit);
    return;
  }
  assignTask(unit, 'gathering', { type: 'deposit', baseId: base.id });
}

function gatherStep(state: GameState, unit: Unit, nodeId: string): void {
  const node = getCrystal(state, nodeId);
  if (node === undefined || node.amount <= 0) {
    assignGather(state, unit);
    return;
  }
  if (unit.carry >= CARRY_CAPACITY) {
    assignDeposit(state, unit);
    return;
  }
  if (distance(unit.x, unit.y, node.x, node.y) > GATHER_RANGE) {
    ensurePath(state, unit, tileOf(node.x), tileOf(node.y));
    return;
  }

  clearPath(unit);
  const space = CARRY_CAPACITY - unit.carry;
  const mined = Math.min(GATHER_RATE, node.amount, space);
  unit.carry = round3(unit.carry + mined);
  node.amount = round3(node.amount - mined);
  state.players[unit.owner].stats.harvested = round3(
    state.players[unit.owner].stats.harvested + mined,
  );

  if (node.amount <= 0) {
    node.amount = 0;
    state.events.push({
      type: 'harvest',
      tick: state.tick,
      entityId: unit.id,
      targetId: node.id,
      owner: unit.owner,
      x: tileOf(node.x),
      y: tileOf(node.y),
    });
    removeEntity(state, node.id);
    // removeEntity cleared our task; head home with whatever we are carrying.
    if (unit.carry > 0) assignDeposit(state, unit);
    else assignGather(state, unit);
  }
}

function depositStep(state: GameState, unit: Unit, baseId: string): void {
  const base = getBuilding(state, baseId);
  if (base === undefined || base.owner !== unit.owner) {
    assignGather(state, unit);
    return;
  }
  if (distance(unit.x, unit.y, base.x, base.y) > DEPOSIT_RANGE) {
    ensurePath(state, unit, tileOf(base.x), tileOf(base.y));
    return;
  }

  clearPath(unit);
  if (unit.carry > 0) {
    state.players[unit.owner].resources.crystal = round3(
      state.players[unit.owner].resources.crystal + unit.carry,
    );
    unit.carry = 0;
  }
  assignGather(state, unit);
}
