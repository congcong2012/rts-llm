/**
 * Production: training queues and construction sites.
 *
 * - Training resources are deducted when the order is *accepted* (action layer),
 *   never here, so this system only advances progress.
 * - A construction site needs its assigned worker within BUILD_RANGE; if the
 *   worker wanders off, progress simply pauses (it is not cancelled).
 */

import type { Building, Unit } from '../../shared/types';
import type { GameState } from '../state/GameState';
import {
  BUILD_RANGE,
  FREE_TILE_SEARCH_RADIUS,
  trainTicksFor,
  UNIT_STATS,
} from '../config/constants';
import { makeUnit } from '../entities/factory';
import { distance, tileOf } from '../math';
import { findFreeTileNear } from '../map/grid';
import {
  addEntity,
  allocId,
  getUnit,
  isTileFree,
  population,
  totalEntityCount,
} from '../state/GameState';
import { clearOrder } from '../state/unitOps';
import { ensurePath, isAtTile } from './movement';

export function tick(state: GameState): void {
  for (const building of state.buildings) {
    if (building.state === 'constructing') {
      constructionStep(state, building);
      continue;
    }
    if (building.state === 'idle' && building.queue.length > 0) {
      building.state = 'training';
    }
    if (building.state === 'training') {
      trainingStep(state, building);
    }
  }
}

// ── Construction ────────────────────────────────────────────────────────────

export function findBuilder(state: GameState, buildingId: string): Unit | undefined {
  for (const unit of state.units) {
    if (unit.task !== null && unit.task.type === 'build' && unit.task.buildingId === buildingId) {
      return unit;
    }
  }
  return undefined;
}

function constructionStep(state: GameState, building: Building): void {
  const builder = findBuilder(state, building.id);
  if (builder === undefined) return; // paused — no assigned worker

  if (distance(builder.x, builder.y, building.x, building.y) > BUILD_RANGE) {
    const tileX = tileOf(building.x);
    const tileY = tileOf(building.y);
    const dest = findFreeTileNear(
      state.terrain,
      { x: tileX, y: tileY },
      (x, y) => isTileFree(state, x, y),
      3,
    );
    ensurePath(state, builder, dest?.x ?? tileX, dest?.y ?? tileY);
    return;
  }

  building.buildProgress += 1;
  const ratio = Math.min(1, building.buildProgress / Math.max(1, building.buildTotal));
  building.hp = Math.max(1, Math.round(building.maxHp * (0.1 + 0.9 * ratio)));

  if (building.buildProgress >= building.buildTotal) {
    building.state = 'idle';
    building.hp = building.maxHp;
    clearOrder(builder);
    state.events.push({
      type: 'built',
      tick: state.tick,
      entityId: builder.id,
      targetId: building.id,
      owner: building.owner,
      x: tileOf(building.x),
      y: tileOf(building.y),
    });
  }
}

// ── Training ────────────────────────────────────────────────────────────────

function trainingStep(state: GameState, building: Building): void {
  const kind = building.queue[0];
  if (kind === undefined) {
    building.state = 'idle';
    building.queueProgress = 0;
    return;
  }

  building.queueProgress += 1;
  if (building.queueProgress < trainTicksFor(kind)) return;

  const spawned = trySpawnUnit(state, building, kind);
  if (!spawned) return; // no room / caps reached — retry next tick

  building.queue.shift();
  building.queueProgress = 0;
  building.state = building.queue.length > 0 ? 'training' : 'idle';
}

/**
 * Place a finished unit next to its producer.
 *
 * @returns false when the unit cannot be placed right now (no free tile, entity
 *          hard cap or population cap); the caller keeps the item queued.
 */
export function trySpawnUnit(state: GameState, building: Building, kind: Unit['kind']): boolean {
  if (totalEntityCount(state) >= state.config.entityHardCap) return false;
  if (population(state, building.owner) >= state.config.popCap) return false;

  const tile = findFreeTileNear(
    state.terrain,
    { x: tileOf(building.x), y: tileOf(building.y) },
    (x, y) => isTileFree(state, x, y),
    FREE_TILE_SEARCH_RADIUS,
  );
  if (tile === null) return false;

  const unit = makeUnit({
    id: allocId(state, 'u'),
    kind,
    owner: building.owner,
    x: tile.x + 0.5,
    y: tile.y + 0.5,
  });
  addEntity(state, unit);
  state.players[building.owner].stats.trained += 1;
  state.events.push({
    type: 'trained',
    tick: state.tick,
    entityId: building.id,
    targetId: unit.id,
    owner: building.owner,
    x: tile.x,
    y: tile.y,
  });
  return true;
}

/** Cost of a unit kind — re-exported so the action layer has one source. */
export function unitCost(kind: Unit['kind']): number {
  return UNIT_STATS[kind].cost;
}

/** True when a building is idle and ready to accept a new training order. */
export function canAcceptTraining(building: Building): boolean {
  return building.state === 'idle' && building.queue.length === 0;
}

/** Re-export for callers that only need "is the builder on site". */
export { isAtTile, getUnit };
