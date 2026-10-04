/**
 * GameState — the authoritative, serialisable match state plus the only
 * sanctioned mutation helpers (entity registry + id allocation).
 *
 * This module intentionally imports NO system: systems depend on the state,
 * never the other way round. That keeps the dependency graph acyclic and lets
 * the whole core run in-memory inside Vitest.
 */

import type {
  Building,
  Entity,
  GameEvent,
  GameConfig,
  GameStatus,
  Ghost,
  PendingCommand,
  PlayerId,
  PlayerIntel,
  PlayerState,
  PlayerVision,
  RejectedAction,
  ResourceNode,
  Rng,
  Terrain,
  Unit,
  Vision,
} from '../../shared/types';
import { PLAYERS, opponentOf } from '../../shared/types';
import { DEFAULT_CONFIG } from '../config/constants';
import { tileOf } from '../math';
import { createRng } from '../rng';
import { releaseReferencesTo } from './unitOps';

export interface IdCounters {
  u: number;
  b: number;
  r: number;
}

export type IdPrefix = keyof IdCounters;

export interface GameState {
  gameId: string;
  seed: number;
  tick: number;
  status: GameStatus;
  winner: PlayerId | null;
  /** Tick at which the match ended (null while running). */
  endTick: number | null;
  config: GameConfig;
  terrain: Terrain;
  /** The single RNG instance of the match — shared by every system. */
  rng: Rng;
  idCounters: IdCounters;

  units: Unit[];
  buildings: Building[];
  crystals: ResourceNode[];
  /** O(1) lookup by entity id. Always kept in sync with the arrays above. */
  index: Map<string, Entity>;

  players: Record<PlayerId, PlayerState>;
  /** Commands waiting to be applied on the next tick. */
  pending: PendingCommand[];
  /** Events produced during the current tick (cleared at the start of each). */
  events: GameEvent[];
  /** Rejections produced during the current tick, kept for logging/tests. */
  rejects: RejectedAction[];

  vision: Vision;
  intel: Record<PlayerId, PlayerIntel>;

  /** Monotonic count of every action ever dropped, for logging/reporting. */
  rejectedTotal: number;
  /** Monotonic count of every action ever accepted. */
  acceptedTotal: number;
}

// ── Construction ────────────────────────────────────────────────────────────

export function createVision(player: PlayerId, width: number, height: number): PlayerVision {
  return {
    owner: player,
    visibleTiles: new Uint8Array(width * height),
    explored: new Uint8Array(width * height),
    visibleEntityIds: new Set<string>(),
  };
}

export function createIntel(): PlayerIntel {
  return {
    buildings: new Map<string, Ghost>(),
    lastKnownEnemyBase: null,
    lastKnownEnemySighting: null,
  };
}

export function createEmptyState(params: {
  gameId: string;
  seed: number;
  terrain: Terrain;
  config?: Partial<GameConfig>;
  startCrystal: number;
}): GameState {
  const config: GameConfig = { ...DEFAULT_CONFIG, ...(params.config ?? {}) };
  const players = {} as Record<PlayerId, PlayerState>;
  for (const player of PLAYERS) {
    players[player] = {
      id: player,
      resources: { crystal: params.startCrystal },
      stats: { trained: 0, harvested: 0, killed: 0, lost: 0 },
    };
  }

  return {
    gameId: params.gameId,
    seed: params.seed,
    tick: 0,
    status: 'running',
    winner: null,
    endTick: null,
    config,
    terrain: params.terrain,
    rng: createRng(params.seed >>> 0),
    idCounters: { u: 0, b: 0, r: 0 },
    units: [],
    buildings: [],
    crystals: [],
    index: new Map<string, Entity>(),
    players,
    pending: [],
    events: [],
    rejects: [],
    vision: {
      p1: createVision('p1', params.terrain.width, params.terrain.height),
      p2: createVision('p2', params.terrain.width, params.terrain.height),
    },
    intel: { p1: createIntel(), p2: createIntel() },
    rejectedTotal: 0,
    acceptedTotal: 0,
  };
}

// ── Id allocation ───────────────────────────────────────────────────────────

export function allocId(state: GameState, prefix: IdPrefix): string {
  state.idCounters[prefix] += 1;
  return `${prefix}${state.idCounters[prefix]}`;
}

// ── Entity registry ─────────────────────────────────────────────────────────

export function addEntity(state: GameState, entity: Entity): void {
  if (state.index.has(entity.id)) {
    throw new Error(`addEntity: duplicate id ${entity.id}`);
  }
  state.index.set(entity.id, entity);
  switch (entity.category) {
    case 'unit':
      state.units.push(entity);
      break;
    case 'building':
      state.buildings.push(entity);
      break;
    case 'resource':
      state.crystals.push(entity);
      break;
  }
}

export function getEntity(state: GameState, id: string | null | undefined): Entity | undefined {
  if (id === null || id === undefined) return undefined;
  return state.index.get(id);
}

export function getUnit(state: GameState, id: string | null | undefined): Unit | undefined {
  const entity = getEntity(state, id);
  return entity !== undefined && entity.category === 'unit' ? entity : undefined;
}

export function getBuilding(state: GameState, id: string | null | undefined): Building | undefined {
  const entity = getEntity(state, id);
  return entity !== undefined && entity.category === 'building' ? entity : undefined;
}

export function getCrystal(state: GameState, id: string | null | undefined): ResourceNode | undefined {
  const entity = getEntity(state, id);
  return entity !== undefined && entity.category === 'resource' ? entity : undefined;
}

export function hasEntity(state: GameState, id: string): boolean {
  return state.index.has(id);
}

/**
 * Remove an entity from the match and emit a death event.
 *
 * Ghost bookkeeping: if the dead entity is a building that the opponent was
 * currently able to see, their remembered ghost is dropped too. A building
 * destroyed while unobserved stays in the ghost list — that is intentional
 * (docs/SPEC.md §10.2: ghosts are allowed to be stale).
 */
export function removeEntity(state: GameState, id: string, reason: GameEvent['type'] = 'death'): void {
  const entity = state.index.get(id);
  if (entity === undefined) return;

  // Capture observers *before* the entity leaves the state: the human's event
  // stream must not reveal a death nobody could see (see GameEvent.visibleTo).
  const visibleTo = PLAYERS.filter((player) => state.vision[player].visibleEntityIds.has(id));

  state.index.delete(id);

  switch (entity.category) {
    case 'unit': {
      const at = state.units.findIndex((u) => u.id === id);
      if (at >= 0) state.units.splice(at, 1);
      state.players[entity.owner].stats.lost += 1;
      break;
    }
    case 'building': {
      const at = state.buildings.findIndex((b) => b.id === id);
      if (at >= 0) state.buildings.splice(at, 1);
      for (const player of PLAYERS) {
        if (player === entity.owner) continue;
        if (state.vision[player].visibleEntityIds.has(id)) {
          state.intel[player].buildings.delete(id);
        }
      }
      state.players[entity.owner].stats.lost += 1;
      break;
    }
    case 'resource': {
      const at = state.crystals.findIndex((c) => c.id === id);
      if (at >= 0) state.crystals.splice(at, 1);
      break;
    }
  }

  state.events.push({
    type: reason,
    tick: state.tick,
    targetId: id,
    owner: entity.owner ?? undefined,
    visibleTo,
  });

  // Any order pointing at the dead entity is dropped so units re-acquire a
  // target instead of chasing a ghost forever.
  releaseReferencesTo(state.units, id);
}

// ── Queries ─────────────────────────────────────────────────────────────────

export function population(state: GameState, player: PlayerId): number {
  let count = 0;
  for (const unit of state.units) if (unit.owner === player) count += 1;
  return count;
}

export function ownedUnits(state: GameState, player: PlayerId): Unit[] {
  return state.units.filter((unit) => unit.owner === player);
}

export function ownedBuildings(state: GameState, player: PlayerId): Building[] {
  return state.buildings.filter((building) => building.owner === player);
}

export function findBaseOf(state: GameState, player: PlayerId): Building | undefined {
  return state.buildings.find((building) => building.owner === player && building.kind === 'base');
}

export function countBuildings(state: GameState, player: PlayerId, kind: Building['kind']): number {
  let count = 0;
  for (const building of state.buildings) {
    if (building.owner === player && building.kind === kind) count += 1;
  }
  return count;
}

export function allEntities(state: GameState): Entity[] {
  return [...state.units, ...state.buildings, ...state.crystals];
}

export function totalEntityCount(state: GameState): number {
  return state.units.length + state.buildings.length + state.crystals.length;
}

/** True when a tile can host a new building / unit (walkable, no occupant). */
export function isTileFree(state: GameState, x: number, y: number): boolean {
  const terrain = state.terrain;
  if (x < 0 || y < 0 || x >= terrain.width || y >= terrain.height) return false;
  if (terrain.blocked[y * terrain.width + x] === 1) return false;
  for (const building of state.buildings) {
    if (tileOf(building.x) === x && tileOf(building.y) === y) return false;
  }
  for (const crystal of state.crystals) {
    if (tileOf(crystal.x) === x && tileOf(crystal.y) === y) return false;
  }
  return true;
}

export function enemyOf(player: PlayerId): PlayerId {
  return opponentOf(player);
}
