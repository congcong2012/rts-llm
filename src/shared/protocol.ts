/**
 * WebSocket wire protocol shared by the server and the renderer.
 *
 * Phase 1 only *declares* these types (nothing consumes them yet) so that the
 * contract is locked in before the renderer and the gateway exist.
 *
 * Two hard rules encoded here (docs/SPEC.md §7, §10):
 *  1. `snap` only ever carries entities the human is allowed to see.
 *  2. The human never receives the opponent's resource count.
 */

import type {
  BuildingKind,
  GameEvent,
  GameStatus,
  PlayerId,
  UnitKind,
  UnitState,
  Action,
} from './types';

/** Compact, position-encoded entity row (docs/SPEC.md §7.3). */
export interface EntityRow {
  /** `0=worker 1=soldier 2=base 3=barracks 4=crystal` */
  k: number;
  /** `0=p1 1=p2 2=neutral` */
  o: number;
  id: string;
  x: number;
  y: number;
  hp: number;
  /** State enum index; `-1` for entities without a state (crystal). */
  s: number;
  /** Current task target id, when any. */
  task?: string;
  /** Carried resources (workers only). */
  carry?: number;
  /** Building-only: training queue (e.g. ['worker']) */
  queue?: UnitKind[];
  /** Building-only: ticks progressed on the current queue item */
  qp?: number;
  /** Building-only: construction progress / total (when s === 1) */
  bp?: number;
  bt?: number;
}

/** A remembered enemy building that is currently out of sight. */
export interface GhostRow {
  id: string;
  kind: BuildingKind;
  x: number;
  y: number;
  hpPct: number;
  tick: number;
}

export interface FogInit {
  /** One hex bitmask string per map row (16 chars = 64 tiles). */
  exploredRows: string[];
}

export interface FogDelta {
  rows: { i: number; bits: string }[];
}

export interface HumanSnapshot {
  tick: number;
  status: GameStatus;
  winner: PlayerId | null;
  /** Own resources only — the opponent's economy is never disclosed. */
  crystal: number;
  pop: number;
  popCap: number;
  entities: EntityRow[];
  /** Enemy buildings known from exploration but not currently visible. */
  ghosts: GhostRow[];
  crystals: EntityRow[];
  fog?: FogDelta;
}

export interface InitMessage {
  t: 'init';
  gameId: string;
  seed: number;
  map: { w: number; h: number; blockedRows: string[] };
  you: 'human';
  tickRate: number;
  config: { fogEnabled: boolean; popCap: number };
  snapshot: HumanSnapshot;
  fog: FogInit;
}

export interface SnapMessage {
  t: 'snap';
  snapshot: HumanSnapshot;
}

export interface FogMessage {
  t: 'fog';
  delta: FogDelta;
}

export interface EventsMessage {
  t: 'events';
  events: GameEvent[];
}

export interface LlmStatusMessage {
  t: 'llm';
  status: 'thinking' | 'ok' | 'fallback' | 'error';
  latencyMs?: number;
  /** Redacted short reason; the raw `reasoning` is never sent mid-match. */
  reason?: string;
}

export interface GameOverMessage {
  t: 'gameover';
  winner: PlayerId | null;
  tick: number;
}

export interface PongMessage {
  t: 'pong';
  tick: number;
}

export type ServerMessage =
  | InitMessage
  | SnapMessage
  | FogMessage
  | EventsMessage
  | LlmStatusMessage
  | GameOverMessage
  | PongMessage;

export interface CommandMessage {
  t: 'cmd';
  actions: Action[];
  seq: number;
}

export interface PingMessage {
  t: 'ping';
}

export type ClientMessage = CommandMessage | PingMessage;

// ── Compact encoding helpers ────────────────────────────────────────────────

import type { EntityKind, UnitState as UnitStateT } from './types';

const KIND_CODES: Record<EntityKind, number> = {
  worker: 0,
  soldier: 1,
  base: 2,
  barracks: 3,
  crystal: 4,
};

const UNIT_STATE_CODES: Record<UnitStateT, number> = {
  idle: 0,
  moving: 1,
  gathering: 2,
  attacking: 3,
  building: 4,
  holding: 5,
};

const BUILDING_STATE_CODES: Record<'idle' | 'constructing' | 'training', number> = {
  idle: 0,
  constructing: 1,
  training: 2,
};

export function kindCode(kind: EntityKind): number {
  return KIND_CODES[kind];
}

export function unitStateCode(state: UnitState): number {
  return UNIT_STATE_CODES[state];
}

export function buildingStateCode(state: 'idle' | 'constructing' | 'training'): number {
  return BUILDING_STATE_CODES[state];
}

export function ownerCode(owner: PlayerId | null): number {
  if (owner === null) return 2;
  return owner === 'p1' ? 0 : 1;
}

/** Unit-kind metadata mirrored on the client (kept in sync with constants.ts). */
export interface UnitKindMeta {
  kind: UnitKind;
  vision: number;
}

export type { UnitKind };
