/**
 * Shared domain types for the RTS MVP.
 *
 * This module is dependency-free on purpose: it is imported by the simulation
 * core, the server, the renderer and the tests, so it must never pull in any
 * runtime dependency (no Phaser, no Express, no zod).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Players
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal player id.
 *  - `p1` = human, blue, spawns at the bottom-left anchor.
 *  - `p2` = LLM, red, spawns at the top-right anchor.
 *
 * The LLM-facing view re-labels these as `human` / `llm` (see docs/SPEC.md §5.2).
 */
export type PlayerId = 'p1' | 'p2';

export const PLAYERS: readonly PlayerId[] = ['p1', 'p2'];

export function opponentOf(player: PlayerId): PlayerId {
  return player === 'p1' ? 'p2' : 'p1';
}

/** Colour convention: red = p2 (LLM), blue = p1 (human). */
export const PLAYER_COLORS: Record<PlayerId, number> = {
  p1: 0x3b82f6, // blue
  p2: 0xef4444, // red
};

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

export interface Vec2 {
  x: number;
  y: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity kinds
// ─────────────────────────────────────────────────────────────────────────────

export type UnitKind = 'worker' | 'soldier';
export type BuildingKind = 'base' | 'barracks';
export type ResourceKind = 'crystal';
export type EntityKind = UnitKind | BuildingKind | ResourceKind;
export type EntityCategory = 'unit' | 'building' | 'resource';

/**
 * Unit activity. This enum is part of the LLM contract (docs/LLM_PROMPT.md §2)
 * and must not be extended without bumping the prompt version.
 *
 * Note: the full gather cycle ("walk to node" -> "mine" -> "carry home" ->
 * "deposit") is reported as `gathering`; the fine-grained phase lives in
 * `Unit.task` so the wire format stays small.
 */
export type UnitState = 'idle' | 'moving' | 'gathering' | 'attacking' | 'building' | 'holding';

export type BuildingState = 'idle' | 'constructing' | 'training';

export type GameStatus = 'running' | 'gameover';

// ─────────────────────────────────────────────────────────────────────────────
// Tasks (the "what am I currently doing" of a unit)
// ─────────────────────────────────────────────────────────────────────────────

export type UnitTask =
  | { type: 'gather'; nodeId: string }
  | { type: 'deposit'; baseId: string }
  | { type: 'attack'; targetId: string }
  | { type: 'build'; buildingId: string }
  | { type: 'move'; x: number; y: number };

// ─────────────────────────────────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────────────────────────────────

export interface Unit {
  readonly category: 'unit';
  id: string;
  kind: UnitKind;
  owner: PlayerId;
  /** Continuous position in tile units, `[0, mapWidth)`. */
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  vision: number;
  state: UnitState;
  task: UnitTask | null;
  /** Remaining path as tile coordinates (integers). `null` when not moving. */
  path: Vec2[] | null;
  pathIndex: number;
  /** Tile the current path leads to, used to avoid recomputing A* every tick. */
  destTile: Vec2 | null;
  /** Carried crystal (0..CARRY_CAPACITY). */
  carry: number;
  /** Ticks remaining until this unit may attack again. */
  cooldown: number;
  /** Last tick this unit dealt or received damage; -1 when it has never fought. */
  combatExposure: number;
  /** Id of the last entity that damaged this unit (used for auto-retaliation). */
  attackedBy: string | null;
}

export interface Building {
  readonly category: 'building';
  id: string;
  kind: BuildingKind;
  owner: PlayerId;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  vision: number;
  state: BuildingState;
  /** Ticks accumulated while `constructing`. */
  buildProgress: number;
  /** Ticks required to finish construction. */
  buildTotal: number;
  /** Pending training queue (MVP: at most one entry at a time). */
  queue: UnitKind[];
  /** Ticks accumulated on `queue[0]`. */
  queueProgress: number;
}

export interface ResourceNode {
  readonly category: 'resource';
  id: string;
  kind: ResourceKind;
  owner: null;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  vision: number;
  amount: number;
  maxAmount: number;
}

export type Entity = Unit | Building | ResourceNode;

export function isUnit(entity: Entity | undefined): entity is Unit {
  return entity !== undefined && entity.category === 'unit';
}

export function isBuilding(entity: Entity | undefined): entity is Building {
  return entity !== undefined && entity.category === 'building';
}

export function isResource(entity: Entity | undefined): entity is ResourceNode {
  return entity !== undefined && entity.category === 'resource';
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

export interface TrainAction {
  type: 'train';
  buildingId: string;
  unitType: UnitKind;
}

export interface BuildAction {
  type: 'build';
  unitIds: string[];
  buildingType: BuildingKind;
  x: number;
  y: number;
}

export interface MoveAction {
  type: 'move';
  unitIds: string[];
  x: number;
  y: number;
}

export interface AttackAction {
  type: 'attack';
  unitIds: string[];
  targetId: string;
}

export interface GatherAction {
  type: 'gather';
  unitIds: string[];
  /** Omitted => the game picks the nearest crystal node. */
  targetId?: string;
}

export interface HoldAction {
  type: 'hold';
  unitIds: string[];
}

export interface NoopAction {
  type: 'noop';
}

export type Action =
  | TrainAction
  | BuildAction
  | MoveAction
  | AttackAction
  | GatherAction
  | HoldAction
  | NoopAction;

export type ActionType = Action['type'];

export const ACTION_TYPES: readonly ActionType[] = [
  'train',
  'build',
  'move',
  'attack',
  'gather',
  'hold',
  'noop',
];

/** Where an action came from — recorded in logs and replays. */
export type ActionSource = 'human' | 'llm' | 'rule' | 'system';

export interface PendingCommand {
  owner: PlayerId;
  action: Action;
  source: ActionSource;
  /** Tick at which the command was enqueued (used for latency/lag reporting). */
  issuedAt: number;
}

/**
 * Reason an action was dropped. Every rejection is logged with one of these
 * codes (docs/SPEC.md §8.2) — no action is ever dropped silently.
 */
export type RejectReason =
  | 'SCHEMA_INVALID'
  | 'UNKNOWN_TYPE'
  | 'ENTITY_NOT_FOUND'
  | 'NOT_OWNED'
  | 'INVALID_STATE'
  | 'INSUFFICIENT_RESOURCE'
  | 'PRODUCTION_BLOCKED'
  | 'POP_CAP_REACHED'
  | 'INVALID_TARGET'
  | 'OUT_OF_BOUNDS'
  | 'BLOCKED_TILE'
  | 'NOT_IN_LEGAL_ACTIONS'
  | 'TURN_BUDGET_EXCEEDED'
  | 'DUPLICATE_UNIT'
  | 'INTERNAL_ERROR';

export interface RejectedAction {
  owner: PlayerId;
  tick: number;
  source: ActionSource;
  reason: RejectReason;
  detail?: string;
  action: unknown;
}

export type ValidationResult = { ok: true } | { ok: false; reason: RejectReason; detail?: string };

// ─────────────────────────────────────────────────────────────────────────────
// Events (drives renderer effects + the LLM event triggers)
// ─────────────────────────────────────────────────────────────────────────────

export type GameEventType =
  | 'damage'
  | 'death'
  | 'built'
  | 'trained'
  | 'harvest'
  | 'arrive'
  | 'attack'
  | 'gameover';

export interface GameEvent {
  type: GameEventType;
  tick: number;
  /** Actor (attacker / producer / harvester). */
  entityId?: string;
  /** Subject (victim / spawned unit / build site). */
  targetId?: string;
  owner?: PlayerId;
  x?: number;
  y?: number;
  amount?: number;
  /**
   * Players who could observe this event first-hand (captured at emit time,
   * because a `death` event is emitted after the entity left the state and its
   * visibility can no longer be evaluated). Used to filter the event stream so
   * an unseen death never leaks to the opponent.
   */
  visibleTo?: PlayerId[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Fog of war
// ─────────────────────────────────────────────────────────────────────────────

export interface PlayerVision {
  owner: PlayerId;
  /** 1 = tile is currently visible to this player. Cleared every tick. */
  visibleTiles: Uint8Array;
  /** 1 = tile has ever been visible. Monotonically non-decreasing. */
  explored: Uint8Array;
  /** Ids of entities this player can currently see (own entities included). */
  visibleEntityIds: Set<string>;
}

export interface Vision {
  p1: PlayerVision;
  p2: PlayerVision;
}

/** Last-known position of an enemy building (docs/SPEC.md §10.2). */
export interface Ghost {
  id: string;
  kind: BuildingKind;
  x: number;
  y: number;
  hpPct: number;
  /** Tick at which the ghost was last refreshed. */
  tick: number;
}

/**
 * "Player knowledge" — deliberately kept OUT of the deterministic state hash:
 * it is a view concern, not simulation state.
 */
export interface PlayerIntel {
  /** Enemy buildings remembered at their last observed position. */
  buildings: Map<string, Ghost>;
  lastKnownEnemyBase: { x: number; y: number; tick: number } | null;
  lastKnownEnemySighting: { x: number; y: number; tick: number } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Game state
// ─────────────────────────────────────────────────────────────────────────────

export interface PlayerState {
  id: PlayerId;
  resources: { crystal: number };
  stats: {
    trained: number;
    harvested: number;
    killed: number;
    lost: number;
  };
}

export interface Terrain {
  width: number;
  height: number;
  /** Row-major walkability layer: 1 = blocked (rock), 0 = walkable. */
  blocked: Uint8Array;
}

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** Current internal state — used to fold RNG position into the state hash. */
  state(): number;
}

export interface GameConfig {
  width: number;
  height: number;
  tickRate: number;
  popCap: number;
  entityHardCap: number;
  gatherRange: number;
  depositRange: number;
  buildRange: number;
  maxActionsPerTurn: number;
  arriveEpsilon: number;
  fogEnabled: boolean;
  maxTicks: number;
}

export interface TickResult {
  tick: number;
  accepted: number;
  rejected: RejectedAction[];
  events: GameEvent[];
}
