/**
 * Compact legal action set + membership test (docs/SPEC.md §9.3).
 *
 * This is the *only* way the LLM learns what it may do. Instead of enumerating
 * every (unit × target) pair — which grows linearly with army size — each entry
 * lists the units that may act plus the set of legal targets. The LLM still
 * answers with a concrete `{type, unitIds, x, y}`, and the validator expands
 * this compact form to decide whether the answer was legal.
 */

import type {
  Action,
  BuildingKind,
  PlayerId,
  Unit,
  UnitKind,
  Vec2,
} from '../../shared/types';
import type { GameState } from '../state/GameState';
import {
  BUILDING_STATS,
  FREE_TILE_SEARCH_RADIUS,
  LEGAL_TARGET_CAP,
  LEGAL_UNIT_CAP,
  UNIT_STATS,
} from '../config/constants';
import { distance, tileOf } from '../math';
import { isWalkable } from '../map/terrain';
import { canAcceptTraining } from '../systems/production';
import {
  countBuildings,
  findBaseOf,
  isTileFree,
  ownedBuildings,
  ownedUnits,
  population,
} from '../state/GameState';
import {
  isSightingFresh,
  knownCrystals,
  visibleEnemyBuildings,
  visibleEnemyUnits,
} from '../systems/vision';

export interface TargetPoint {
  x: number;
  y: number;
  label?: string;
}

export interface LegalTrainEntry {
  buildingId: string;
  unitType: UnitKind;
}

export interface LegalBuildEntry {
  unitIds: string[];
  buildingType: BuildingKind;
  targets: TargetPoint[];
}

export interface LegalMoveEntry {
  unitIds: string[];
  targets: TargetPoint[];
}

export interface LegalAttackEntry {
  unitIds: string[];
  targets: { id: string; x: number; y: number }[];
}

export interface LegalGatherEntry {
  unitIds: string[];
  targets: { id: string }[];
}

export interface LegalActionSet {
  owner: PlayerId;
  tick: number;
  train: LegalTrainEntry[];
  build: LegalBuildEntry | null;
  move: LegalMoveEntry | null;
  attack: LegalAttackEntry | null;
  gather: LegalGatherEntry | null;
  hold: string[];
  noop: true;
}

const sortIds = (ids: string[]): string[] => [...ids].sort();

function isMovable(unit: Unit): boolean {
  // A worker that is mid-construction stays committed to the site.
  return unit.state !== 'building';
}

/** Candidate destinations. Never derived from hidden information. */
function buildMoveTargets(state: GameState, owner: PlayerId): TargetPoint[] {
  const targets: TargetPoint[] = [];
  const push = (x: number, y: number, label: string): void => {
    if (!isWalkable(state.terrain, x, y)) return;
    if (targets.some((t) => t.x === x && t.y === y)) return;
    targets.push({ x, y, label });
  };

  const base = findBaseOf(state, owner);
  if (base !== undefined) push(tileOf(base.x), tileOf(base.y), 'own_base');

  for (const barracks of ownedBuildings(state, owner)) {
    if (barracks.kind === 'barracks') push(tileOf(barracks.x), tileOf(barracks.y), 'own_barracks');
  }

  const crystals = knownCrystals(state, owner)
    .filter((node) => node.amount > 0)
    .sort((a, b) => {
      const da = base === undefined ? 0 : distance(base.x, base.y, a.x, a.y);
      const db = base === undefined ? 0 : distance(base.x, base.y, b.x, b.y);
      return da === db ? (a.id < b.id ? -1 : 1) : da - db;
    });
  crystals.slice(0, 2).forEach((node, index) => {
    push(tileOf(node.x), tileOf(node.y), index === 0 ? 'nearest_crystal' : 'crystal_2');
  });

  const intel = state.intel[owner];
  if (intel.lastKnownEnemyBase !== null) {
    push(intel.lastKnownEnemyBase.x, intel.lastKnownEnemyBase.y, 'enemy_base_last_seen');
  }
  if (isSightingFresh(state, owner) && intel.lastKnownEnemySighting !== null) {
    push(intel.lastKnownEnemySighting.x, intel.lastKnownEnemySighting.y, 'enemy_last_seen');
  }

  push(Math.floor(state.terrain.width / 2), Math.floor(state.terrain.height / 2), 'map_center');
  // Generic far quadrant (a symmetric-map anchor, not the enemy base tile).
  push(owner === 'p1' ? 48 : 16, owner === 'p1' ? 48 : 16, 'far_quadrant');

  return targets.slice(0, LEGAL_TARGET_CAP);
}

function buildBuildTargets(state: GameState, owner: PlayerId): TargetPoint[] {
  const base = findBaseOf(state, owner);
  const anchor: Vec2 =
    base !== undefined
      ? { x: tileOf(base.x), y: tileOf(base.y) }
      : { x: 0, y: 0 };
  const targets: TargetPoint[] = [];
  for (let ring = 1; ring <= FREE_TILE_SEARCH_RADIUS && targets.length < 6; ring += 1) {
    for (let dy = -ring; dy <= ring && targets.length < 6; dy += 1) {
      for (let dx = -ring; dx <= ring && targets.length < 6; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = anchor.x + dx;
        const y = anchor.y + dy;
        if (!isTileFree(state, x, y)) continue;
        targets.push({ x, y });
      }
    }
  }
  return targets.slice(0, 6);
}

export function buildLegalActions(state: GameState, owner: PlayerId): LegalActionSet {
  const units = ownedUnits(state, owner);
  const buildings = ownedBuildings(state, owner);
  const resources = state.players[owner].resources.crystal;
  const pop = population(state, owner);
  const popRoom = pop < state.config.popCap;

  // ── train ────────────────────────────────────────────────────────────────
  const train: LegalTrainEntry[] = [];
  for (const building of buildings) {
    if (!canAcceptTraining(building)) continue;
    const stats = BUILDING_STATS[building.kind];
    for (const unitType of stats.trains) {
      if (resources < UNIT_STATS[unitType].cost) continue;
      if (!popRoom) continue;
      train.push({ buildingId: building.id, unitType });
    }
  }
  train.sort((a, b) =>
    a.buildingId === b.buildingId
      ? a.unitType < b.unitType
        ? -1
        : 1
      : a.buildingId < b.buildingId
        ? -1
        : 1,
  );

  // ── build ────────────────────────────────────────────────────────────────
  let build: LegalBuildEntry | null = null;
  const builders = sortIds(
    units
      .filter(
        (unit) =>
          UNIT_STATS[unit.kind].canBuild &&
          // `gathering` is allowed: redirecting a harvester to a build site is
          // normal RTS play (the worker abandons its gather cycle).
          (unit.state === 'idle' || unit.state === 'holding' || unit.state === 'gathering'),
      )
      .map((unit) => unit.id),
  ).slice(0, LEGAL_UNIT_CAP);
  const barracksStats = BUILDING_STATS.barracks;
  const barracksLimitReached =
    barracksStats.limit > 0 && countBuildings(state, owner, 'barracks') >= barracksStats.limit;
  if (
    builders.length > 0 &&
    barracksStats.buildable &&
    !barracksLimitReached &&
    resources >= barracksStats.cost
  ) {
    const targets = buildBuildTargets(state, owner);
    if (targets.length > 0) {
      build = { unitIds: builders, buildingType: 'barracks', targets };
    }
  }

  // ── move ─────────────────────────────────────────────────────────────────
  const movers = sortIds(units.filter(isMovable).map((unit) => unit.id)).slice(0, LEGAL_UNIT_CAP);
  const moveTargets = buildMoveTargets(state, owner);
  const move: LegalMoveEntry | null =
    movers.length > 0 && moveTargets.length > 0 ? { unitIds: movers, targets: moveTargets } : null;

  // ── attack ───────────────────────────────────────────────────────────────
  const enemies = [
    ...visibleEnemyUnits(state, owner).map((unit) => ({ id: unit.id, x: tileOf(unit.x), y: tileOf(unit.y) })),
    ...visibleEnemyBuildings(state, owner).map((building) => ({
      id: building.id,
      x: tileOf(building.x),
      y: tileOf(building.y),
    })),
  ];
  const attackers = sortIds(
    units.filter((unit) => UNIT_STATS[unit.kind].canInitiateAttack).map((unit) => unit.id),
  ).slice(0, LEGAL_UNIT_CAP);
  const attack: LegalAttackEntry | null =
    attackers.length > 0 && enemies.length > 0
      ? { unitIds: attackers, targets: enemies.slice(0, 20) }
      : null;

  // ── gather ───────────────────────────────────────────────────────────────
  const gatherers = sortIds(
    units.filter((unit) => UNIT_STATS[unit.kind].canGather).map((unit) => unit.id),
  ).slice(0, LEGAL_UNIT_CAP);
  const crystalTargets = knownCrystals(state, owner)
    .filter((node) => node.amount > 0)
    .map((node) => ({ id: node.id }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const gather: LegalGatherEntry | null =
    gatherers.length > 0 && crystalTargets.length > 0
      ? { unitIds: gatherers, targets: crystalTargets.slice(0, 20) }
      : null;

  // ── hold ─────────────────────────────────────────────────────────────────
  const hold = sortIds(units.map((unit) => unit.id)).slice(0, 20);

  return { owner, tick: state.tick, train, build, move, attack, gather, hold, noop: true };
}

// ── Membership test (pipeline step 9) ───────────────────────────────────────

function containsPoint(targets: TargetPoint[], x: number, y: number): boolean {
  return targets.some((target) => target.x === x && target.y === y);
}

/**
 * Expand the compact set and decide whether `action` is allowed.
 *
 * Note: a `gather` without an explicit target is always allowed when there is
 * at least one gatherer, because the engine picks the nearest node itself.
 */
export function isActionLegal(set: LegalActionSet, action: Action): boolean {
  switch (action.type) {
    case 'noop':
      return true;

    case 'train':
      return set.train.some(
        (entry) => entry.buildingId === action.buildingId && entry.unitType === action.unitType,
      );

    case 'build': {
      if (set.build === null) return false;
      if (set.build.buildingType !== action.buildingType) return false;
      if (!action.unitIds.every((id) => set.build !== null && set.build.unitIds.includes(id))) {
        return false;
      }
      return containsPoint(set.build.targets, action.x, action.y);
    }

    case 'move': {
      if (set.move === null) return false;
      if (!action.unitIds.every((id) => set.move !== null && set.move.unitIds.includes(id))) {
        return false;
      }
      return containsPoint(set.move.targets, action.x, action.y);
    }

    case 'attack': {
      if (set.attack === null) return false;
      if (!action.unitIds.every((id) => set.attack !== null && set.attack.unitIds.includes(id))) {
        return false;
      }
      return set.attack.targets.some((target) => target.id === action.targetId);
    }

    case 'gather': {
      if (set.gather === null) return false;
      if (!action.unitIds.every((id) => set.gather !== null && set.gather.unitIds.includes(id))) {
        return false;
      }
      if (action.targetId === undefined) return true;
      return set.gather.targets.some((target) => target.id === action.targetId);
    }

    case 'hold':
      return action.unitIds.every((id) => set.hold.includes(id));
  }
}

/** Compact JSON handed to the LLM (docs/SPEC.md §9.3). */
export function serializeLegalActions(set: LegalActionSet): unknown[] {
  const out: unknown[] = [];
  for (const entry of set.train) out.push({ type: 'train', ...entry });
  if (set.build !== null) out.push({ type: 'build', ...set.build });
  if (set.move !== null) out.push({ type: 'move', ...set.move });
  if (set.attack !== null) out.push({ type: 'attack', ...set.attack });
  if (set.gather !== null) out.push({ type: 'gather', ...set.gather });
  if (set.hold.length > 0) out.push({ type: 'hold', unitIds: set.hold });
  out.push({ type: 'noop' });
  return out;
}

export function countLegalActionEntries(set: LegalActionSet): number {
  let count = 0;
  count += set.train.length;
  if (set.build !== null) count += 1;
  if (set.move !== null) count += 1;
  if (set.attack !== null) count += 1;
  if (set.gather !== null) count += 1;
  if (set.hold.length > 0) count += 1;
  count += 1; // noop
  return count;
}
