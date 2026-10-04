/**
 * Client-side world model.
 *
 * Holds exactly what the server told us and nothing else: the explored fog mask,
 * the interpolated entity tracks, the ghost list, the HUD numbers and the
 * connection status. The renderer and the HUD read from here; only `NetClient`
 * writes here.
 *
 * No simulation logic lives on the client — orders are *requests*, and the
 * authoritative answer always arrives as the next snapshot (docs/SPEC.md §7).
 */

import type { EntityRow, GhostRow, HumanSnapshot, InitMessage } from '../../shared/protocol';
import type { GameEvent, GameStatus, PlayerId } from '../../shared/types';
import { TILE_PX, UNIT_STATS, BUILDING_STATS } from '../../game/config/constants';
import type { FogMask } from '../fog/fogMask';
import { initFogMask, mergeFogDelta, visibleTilesFromEntities } from '../fog/fogMask';
import type { SampledEntity, TrackMap } from '../interp';
import { applyRows, createTrackMap, pruneTracks, sampleTracks } from '../interp';

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'error';

/** Owner codes as they appear on the wire (see `ownerCode`). */
export const OWNER_HUMAN = 0;
export const OWNER_LLM = 1;
export const OWNER_NEUTRAL = 2;

/** Kind codes as they appear on the wire (see `kindCode`). */
export const KIND_WORKER = 0;
export const KIND_SOLDIER = 1;
export const KIND_BASE = 2;
export const KIND_BARRACKS = 3;
export const KIND_CRYSTAL = 4;

/** Terrain tiles as a `Set` of `y * width + x`, built from `init.map.blockedRows`. */
export class WorldModel {
  gameId = '';
  seed = 0;
  width = 0;
  height = 0;
  tickRate = 10;
  fogEnabled = true;
  popCap = 0;

  /** Blocked terrain tiles (rocks). Public information — sent in `init`. */
  blockedTiles = new Set<number>();

  fog: FogMask | null = null;
  tracks: TrackMap = createTrackMap();
  /** Ghost rows, keyed by id so a refresh replaces the previous entry. */
  ghosts = new Map<string, GhostRow>();

  crystal = 0;
  pop = 0;
  tick = 0;
  status: GameStatus = 'running';
  winner: PlayerId | null = null;

  /**
   * The human's own base, in tile units.
   *
   * Cached straight from the snapshot (own buildings are always present) rather
   * than derived from the render tracks: the camera needs it the instant `init`
   * is applied, which is before the first render frame has produced any samples.
   */
  ownBase: { id: string; x: number; y: number } | null = null;

  /** Set of tile indices currently considered "watched" (cosmetic highlight). */
  visibleTiles: Uint8Array | null = null;

  /** Rows whose explored bits changed but which the renderer has not painted. */
  private pendingFogRows: number[] = [];
  /**
   * Incremented on every applied snapshot. The renderer compares it against its
   * own copy to know when the visible-tile mask needs re-syncing, without having
   * to diff the whole mask every frame.
   */
  revision = 0;

  connection: ConnectionStatus = 'connecting';
  /** Wall-clock time of the most recent snapshot (used for the stale warning). */
  lastSnapshotAt = 0;
  /** Rolling estimate of snapshot interval in ms (drives the HUD). */
  snapshotIntervalMs = 100;

  /** Recent events, newest last; the HUD shows the tail. */
  recentEvents: GameEvent[] = [];

  /** Last LLM status blip from the server (phase 4; unused in phase 2). */
  lastLlmStatus: 'thinking' | 'ok' | 'fallback' | 'error' | null = null;
  lastLlmLatencyMs = 0;

  /** Instantaneous frame rate, maintained by the renderer. */
  fps = 0;

  applyInit(message: InitMessage): void {
    this.gameId = message.gameId;
    this.seed = message.seed;
    this.width = message.map.w;
    this.height = message.map.h;
    this.tickRate = message.tickRate;
    this.fogEnabled = message.config.fogEnabled;
    this.popCap = message.config.popCap;

    this.blockedTiles = decodeBlockedRows(message.map.blockedRows, this.width, this.height);
    this.fog = initFogMask(message.fog, this.width, this.height);
    this.tracks = createTrackMap();
    this.ghosts.clear();
    this.recentEvents = [];

    this.applySnapshot(message.snapshot, performanceNow());
  }

  applySnapshot(snapshot: HumanSnapshot, nowMs: number): void {
    if (nowMs - this.lastSnapshotAt > 0) {
      // Exponential smoothing keeps the HUD number readable.
      const delta = nowMs - this.lastSnapshotAt;
      if (delta < 1000) this.snapshotIntervalMs = this.snapshotIntervalMs * 0.8 + delta * 0.2;
    }
    this.lastSnapshotAt = nowMs;

    this.tick = snapshot.tick;
    this.status = snapshot.status;
    this.winner = snapshot.winner;
    this.crystal = snapshot.crystal;
    this.pop = snapshot.pop;
    if (snapshot.popCap > 0) this.popCap = snapshot.popCap;

    for (const row of snapshot.entities) {
      if (row.k === KIND_BASE && row.o === OWNER_HUMAN) {
        this.ownBase = { id: row.id, x: row.x, y: row.y };
        break;
      }
    }

    const tickMs = 1000 / this.tickRate;
    applyRows(this.tracks, snapshot.entities, snapshot.tick, nowMs, tickMs);
    applyRows(this.tracks, snapshot.crystals, snapshot.tick, nowMs, tickMs);

    // Ghosts are a *position memory*, not a movement: they never interpolate, so
    // they are rebuilt wholesale and rendered from the plain row data.
    this.ghosts.clear();
    for (const ghost of snapshot.ghosts) this.ghosts.set(ghost.id, ghost);

    if (this.fog !== null) {
      this.visibleTiles = visibleTilesFromEntities(
        this.fog,
        (owner, kind) => visionRadiusFor(owner, kind),
        snapshot.entities,
      );
    }

    this.revision += 1;
  }

  /**
   * Merge a fog delta. Returns the rows that changed; they are also queued so a
   * renderer that polls (rather than reacts) can drain them via
   * {@link consumeFogChanges}.
   */
  applyFogDelta(delta: { rows: { i: number; bits: string }[] }, nowMs: number): number[] {
    if (this.fog === null) return [];
    const changed = mergeFogDelta(this.fog, delta, nowMs).changedRows;
    for (const row of changed) {
      if (!this.pendingFogRows.includes(row)) this.pendingFogRows.push(row);
    }
    return changed;
  }

  /** Drain the queue of explored rows awaiting a repaint. */
  consumeFogChanges(): number[] {
    if (this.pendingFogRows.length === 0) return [];
    const rows = this.pendingFogRows;
    this.pendingFogRows = [];
    return rows;
  }

  applyEvents(events: GameEvent[]): void {
    this.recentEvents.push(...events);
    if (this.recentEvents.length > 40) {
      this.recentEvents.splice(0, this.recentEvents.length - 40);
    }
  }

  /** Drop tracks whose fade-out finished and refresh the visible-tile highlight. */
  maintain(nowMs: number): void {
    const tickMs = 1000 / this.tickRate;
    pruneTracks(this.tracks, nowMs, tickMs);
  }

  /** Interpolated, fade-weighted view of every known entity. Called per frame. */
  sampleAll(nowMs: number): SampledEntity[] {
    return sampleTracks(this.tracks, nowMs, 1000 / this.tickRate);
  }

  /** ms elapsed since the last snapshot — the HUD warns when this grows. */
  staleness(nowMs: number): number {
    if (this.lastSnapshotAt === 0) return 0;
    return nowMs - this.lastSnapshotAt;
  }

  entityTrack(id: string): ReturnType<TrackMap['get']> {
    return this.tracks.get(id);
  }

  /** Look up the current (interpolated) position of an entity, in world px. */
  worldPositionOf(id: string, nowMs: number): { x: number; y: number } | null {
    const track = this.tracks.get(id);
    if (track === undefined) return null;
    const tickMs = 1000 / this.tickRate;
    const progress = Math.min(1, Math.max(0, (nowMs - track.lastSnapshotMs) / tickMs));
    return {
      x: (track.fromX + (track.toX - track.fromX) * progress) * TILE_PX,
      y: (track.fromY + (track.toY - track.fromY) * progress) * TILE_PX,
    };
  }
}

/** Decode `init.map.blockedRows` into a tile-index set. */
export function decodeBlockedRows(rows: string[], width: number, height: number): Set<number> {
  const blocked = new Set<number>();
  for (let y = 0; y < height; y += 1) {
    const row = rows[y];
    if (row === undefined) continue;
    for (let x = 0; x < width; x += 1) {
      const nibble = parseInt(row[x >> 2] ?? '0', 16);
      if (Number.isNaN(nibble)) continue;
      if ((nibble & (1 << (3 - (x & 3)))) !== 0) blocked.add(y * width + x);
    }
  }
  return blocked;
}

/**
 * Vision radius of a wire entity, in tiles. Mirrors `constants.ts` on the client
 * so the "watched area" highlight matches the simulation exactly. Returns 0 for
 * entities the player cannot see (they would not be on the wire anyway).
 */
export function visionRadiusFor(owner: number, kind: number): number {
  if (owner === OWNER_NEUTRAL) return 0;
  if (kind === KIND_WORKER) return UNIT_STATS.worker.vision;
  if (kind === KIND_SOLDIER) return UNIT_STATS.soldier.vision;
  if (kind === KIND_BASE) return BUILDING_STATS.base.vision;
  if (kind === KIND_BARRACKS) return BUILDING_STATS.barracks.vision;
  return 0;
}

/** Wall-clock helper, isolated so the model stays testable outside a browser. */
export function performanceNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** Convenience: is this wire entity owned by the human? */
export function isOwn(row: { o: number }): boolean {
  return row.o === OWNER_HUMAN;
}

/** Convenience: is this wire entity an enemy (unit or building)? */
export function isEnemy(row: { o: number }): boolean {
  return row.o === OWNER_LLM;
}

export function isCrystalRow(row: EntityRow): boolean {
  return row.k === KIND_CRYSTAL;
}
