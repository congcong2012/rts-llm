/**
 * Human-view snapshot (docs/SPEC.md §7, §10.2).
 *
 * Anti-cheat is enforced HERE, server-side: the snapshot only carries entities
 * the human is allowed to see. Enemy units outside the human's vision never
 * reach the client, and the opponent's resource count is never included, so a
 * modified client has nothing to reveal.
 *
 * Included:
 *   - every own unit / building
 *   - enemy units and buildings inside the human's current vision
 *   - crystal nodes the human has explored at least once (they never move)
 *   - enemy buildings remembered but not visible, as `ghosts`
 * Excluded:
 *   - enemy units that are not visible (no ghosts for units, by design)
 *   - the opponent's crystal count
 */

import type { Building, Entity, GameEvent, Unit } from '../../shared/types';
import type { GameState } from '../state/GameState';
import type { EntityRow, GhostRow, HumanSnapshot } from '../../shared/protocol';
import { buildingStateCode, kindCode, ownerCode, unitStateCode } from '../../shared/protocol';
import { round1, tileOf } from '../math';
import { population } from '../state/GameState';
import { ghostBuildings, knownCrystals } from '../systems/vision';
import { encodeFogRows, diffFogRows, emptyFogRows } from './fogCodec';

export interface HumanSnapshotOptions {
  /** Previously sent explored rows, used to build an incremental fog delta. */
  previousFogRows?: string[];
  /** Set to false to omit the fog delta entirely. */
  includeFog?: boolean;
}

function taskTargetId(entity: Unit | Building): string | undefined {
  if (entity.category !== 'unit' || entity.task === null) return undefined;
  switch (entity.task.type) {
    case 'gather':
      return entity.task.nodeId;
    case 'deposit':
      return entity.task.baseId;
    case 'attack':
      return entity.task.targetId;
    case 'build':
      return entity.task.buildingId;
    case 'move':
      return undefined;
  }
}

export function toEntityRow(entity: Entity): EntityRow {
  const row: EntityRow = {
    k: kindCode(entity.kind),
    o: ownerCode(entity.owner),
    id: entity.id,
    x: round1(entity.x),
    y: round1(entity.y),
    hp: Math.max(0, Math.round(entity.hp)),
    s: -1,
  };
  if (entity.category === 'unit') {
    row.s = unitStateCode(entity.state);
    row.task = taskTargetId(entity);
    row.carry = round1(entity.carry);
  } else if (entity.category === 'building') {
    row.s = buildingStateCode(entity.state);
  }
  return row;
}

export function toGhostRow(ghost: {
  id: string;
  kind: Building['kind'];
  x: number;
  y: number;
  hpPct: number;
  tick: number;
}): GhostRow {
  return {
    id: ghost.id,
    kind: ghost.kind,
    x: ghost.x,
    y: ghost.y,
    hpPct: round1(ghost.hpPct * 100) / 100,
    tick: ghost.tick,
  };
}

export function snapshotForHuman(
  state: GameState,
  options: HumanSnapshotOptions = {},
): HumanSnapshot {
  const vision = state.vision.p1;
  const entities: EntityRow[] = [];

  for (const unit of state.units) {
    if (unit.owner === 'p1' || vision.visibleEntityIds.has(unit.id)) {
      entities.push(toEntityRow(unit));
    }
  }
  for (const building of state.buildings) {
    if (building.owner === 'p1' || vision.visibleEntityIds.has(building.id)) {
      entities.push(toEntityRow(building));
    }
  }

  const crystals = knownCrystals(state, 'p1').map(toEntityRow);
  const ghosts = ghostBuildings(state, 'p1').map(toGhostRow);

  const snapshot: HumanSnapshot = {
    tick: state.tick,
    status: state.status,
    winner: state.winner,
    crystal: Math.round(state.players.p1.resources.crystal),
    pop: population(state, 'p1'),
    popCap: state.config.popCap,
    entities,
    ghosts,
    crystals,
  };

  if (options.includeFog !== false) {
    const rows = encodeFogRows(vision.explored, state.terrain.width, state.terrain.height);
    const previous = options.previousFogRows ?? emptyFogRows(state.terrain.width, state.terrain.height);
    snapshot.fog = diffFogRows(previous, rows);
  }

  return snapshot;
}

/** Explored layer as full rows — sent once, in the `init` message. */
export function fullFogRows(state: GameState): string[] {
  return encodeFogRows(state.vision.p1.explored, state.terrain.width, state.terrain.height);
}

// ── Event filtering ─────────────────────────────────────────────────────────

/**
 * Keep only events the human could have observed.
 *
 * A red unit dying behind the fog must not appear in the event stream — that
 * would leak both its existence and its death.
 */
export function isEventVisibleToHuman(state: GameState, event: GameEvent): boolean {
  if (event.type === 'gameover') return true;
  if (event.owner === 'p1') return true;
  if (event.visibleTo !== undefined && event.visibleTo.includes('p1')) return true;
  const seen = state.vision.p1.visibleEntityIds;
  if (event.entityId !== undefined && seen.has(event.entityId)) return true;
  if (event.targetId !== undefined && seen.has(event.targetId)) return true;
  // Anonymous system events carry no positional information at all.
  return (
    event.owner === undefined && event.entityId === undefined && event.targetId === undefined
  );
}

export function eventsForHuman(state: GameState, events: GameEvent[]): GameEvent[] {
  return events.filter((event) => isEventVisibleToHuman(state, event));
}

export { tileOf };
