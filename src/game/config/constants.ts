/**
 * THE single source of truth for every balance / timing number (docs/SPEC.md §3).
 *
 * Rules:
 *  - No system may hardcode a magic number; everything comes from here.
 *  - All durations are expressed in TICKS (10 ticks = 1 second).
 *  - All speeds are expressed in tiles per tick (tile/s ÷ TICK_RATE).
 *
 * Changing a number here changes the simulation for both players; the state
 * hash covers entity stats indirectly (via hp), so replays stay valid only if
 * this file is unchanged.
 */

import type { BuildingKind, GameConfig, UnitKind } from '../../shared/types';

// ── Global ──────────────────────────────────────────────────────────────────

export const TICK_RATE = 10;
export const TICK_MS = 1000 / TICK_RATE;

export const MAP_W = 64;
export const MAP_H = 64;
export const TILE_PX = 32;

export const POP_CAP = 80;
export const ENTITY_HARD_CAP = 200;

/** Hard safety net for headless runs / tests (9000 ticks = 15 in-game minutes). */
export const MAX_TICKS = 9000;

// ── Economy ─────────────────────────────────────────────────────────────────

export const START_CRYSTAL = 250;
export const START_WORKERS = 4;

export const CRYSTAL_NODE_AMOUNT = 1500;
export const GATHER_RATE = 0.5; // crystal per tick while in range
export const CARRY_CAPACITY = 20;

/**
 * 1.5 tiles (not 1.2): at 1.2 a worker could only serve a node from an
 * orthogonally adjacent tile (distance 1.0) and never from a diagonal one
 * (1.414). 1.5 accepts both but still rejects anything 2 tiles away.
 */
export const GATHER_RANGE = 1.5;
export const DEPOSIT_RANGE = 1.5;
/** Builder must stay this close to the construction site for progress. */
export const BUILD_RANGE = 2.0;

/** Max crystal a single worker can bring home per trip = CARRY_CAPACITY. */

// ── Units ───────────────────────────────────────────────────────────────────

export interface UnitStats {
  kind: UnitKind;
  hp: number;
  vision: number;
  /** tiles per tick */
  speed: number;
  attack: number;
  /** attack range in tiles */
  range: number;
  /** ticks between two attacks */
  cooldownTicks: number;
  cost: number;
  trainTicks: number;
  /** workers gather & build; soldiers fight */
  canGather: boolean;
  canBuild: boolean;
  /** soldiers may be ordered to attack; workers only retaliate */
  canInitiateAttack: boolean;
}

export const UNIT_STATS: Record<UnitKind, UnitStats> = {
  worker: {
    kind: 'worker',
    hp: 60,
    vision: 6,
    speed: 1.6 / TICK_RATE,
    attack: 4,
    range: 1.0,
    cooldownTicks: 15,
    cost: 50,
    trainTicks: 60,
    canGather: true,
    canBuild: true,
    canInitiateAttack: false,
  },
  soldier: {
    kind: 'soldier',
    hp: 110,
    vision: 8,
    speed: 1.4 / TICK_RATE,
    attack: 12,
    range: 1.5,
    cooldownTicks: 10,
    cost: 75,
    trainTicks: 80,
    canGather: false,
    canBuild: false,
    canInitiateAttack: true,
  },
};

// ── Buildings ───────────────────────────────────────────────────────────────

export interface BuildingStats {
  kind: BuildingKind;
  hp: number;
  vision: number;
  cost: number;
  buildTicks: number;
  /** Which units this building can produce. */
  trains: UnitKind[];
  /** Max simultaneous instances per player (0 = unlimited). */
  limit: number;
  /** Can be placed by a worker (false = starting building only). */
  buildable: boolean;
}

export const BUILDING_STATS: Record<BuildingKind, BuildingStats> = {
  base: {
    kind: 'base',
    hp: 1500,
    vision: 10,
    cost: 0,
    buildTicks: 0,
    trains: ['worker'],
    limit: 0,
    buildable: false,
  },
  barracks: {
    kind: 'barracks',
    hp: 800,
    vision: 8,
    cost: 150,
    buildTicks: 150,
    trains: ['soldier'],
    limit: 2,
    buildable: true,
  },
};

// ── Combat & vision ─────────────────────────────────────────────────────────

/** Ticks during which two units that traded blows keep seeing each other. */
export const COMBAT_EXPOSURE_TICKS = 30;
/** A unit that took damage this recently will abandon its order and fight back. */
export const RETALIATE_WINDOW_TICKS = 20;
/** How long a sighting stays in `intel.lastKnownEnemySighting`. */
export const SIGHTING_MEMORY_TICKS = 150;

// ── Orders & validation ─────────────────────────────────────────────────────

export const MAX_ACTIONS_PER_TURN = 12;
export const ARRIVE_EPSILON = 0.05;
/** Distance used to consider a move order "arrived" at its destination tile. */
export const MOVE_ARRIVE_EPSILON = 0.2;
/** Max units referenced by a single compact legalActions entry. */
export const LEGAL_UNIT_CAP = 12;
/** Max candidate destination tiles offered per move/build entry. */
export const LEGAL_TARGET_CAP = 8;
/** Spiral search radius used when looking for a free spawn / placement tile. */
export const FREE_TILE_SEARCH_RADIUS = 4;

// ── Map generation ──────────────────────────────────────────────────────────

export const BASE_ANCHORS: Record<'p1' | 'p2', { x: number; y: number }> = {
  p1: { x: 10, y: 10 },
  p2: { x: 53, y: 53 },
};
/** Half-extent of the guaranteed-clear rectangle around each base (5x5 → 2). */
export const BASE_CLEAR_RADIUS = 2;
export const ROCK_CLUSTERS_MIN = 2;
export const ROCK_CLUSTERS_MAX = 4;
export const ROCK_CLUSTER_SIZE_MIN = 3;
export const ROCK_CLUSTER_SIZE_MAX = 8;
export const ROCK_MIN_DISTANCE_FROM_BASE = 12;
export const CRYSTAL_CLUSTERS_PER_BASE = 3;
export const CRYSTAL_CLUSTER_SIZE_MIN = 3;
export const CRYSTAL_CLUSTER_SIZE_MAX = 5;
export const CRYSTAL_CLUSTER_DIST_MIN = 6;
export const CRYSTAL_CLUSTER_DIST_MAX = 12;
export const NEUTRAL_CRYSTAL_CLUSTERS = 4;

// ── Default game config ─────────────────────────────────────────────────────

export const DEFAULT_CONFIG: GameConfig = {
  width: MAP_W,
  height: MAP_H,
  tickRate: TICK_RATE,
  popCap: POP_CAP,
  entityHardCap: ENTITY_HARD_CAP,
  gatherRange: GATHER_RANGE,
  depositRange: DEPOSIT_RANGE,
  buildRange: BUILD_RANGE,
  maxActionsPerTurn: MAX_ACTIONS_PER_TURN,
  arriveEpsilon: MOVE_ARRIVE_EPSILON,
  fogEnabled: true,
  maxTicks: MAX_TICKS,
};

export function resolveConfig(overrides?: Partial<GameConfig>): GameConfig {
  return { ...DEFAULT_CONFIG, ...(overrides ?? {}) };
}

/** Total hp a training item requires. */
export function trainTicksFor(kind: UnitKind): number {
  return UNIT_STATS[kind].trainTicks;
}
