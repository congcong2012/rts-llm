/**
 * Snapshot interpolation (docs/ROADMAP.md 阶段 2 任务 9).
 *
 * The server ticks at 10 Hz but the browser renders at ~60 fps, so drawing raw
 * snapshot positions produces visible 10 Hz stepping. This module keeps a small
 * per-entity track (`from` → `to`, plus the wall-clock time the latest snapshot
 * arrived) and answers "where is this entity *now*?" with a linear blend.
 *
 * Deliberately pure and DOM-free so it can be unit tested:
 *   - the clock is an explicit `nowMs` argument, never `performance.now()`;
 *   - nothing here touches Phaser.
 *
 * Fades: an entity that just entered vision eases in over `FADE_TICKS`, and one
 * that vanished (left vision, or died unseen) fades out over the same window
 * instead of popping. `FADE_TICKS = 4` → 400 ms at 10 ticks/s.
 */

import type { EntityRow } from '../shared/protocol';

/** Durations, expressed in ticks so they stay tied to the simulation rate. */
export const FADE_TICKS = 4;

interface Track {
  id: string;
  /** Entity kind code (see `EntityRow.k`). */
  k: number;
  /** Owner code (see `EntityRow.o`). */
  o: number;
  /** State code; `-1` for crystals. */
  s: number;
  hp: number;
  task?: string;
  carry: number;

  fromX: number;
  fromY: number;
  toX: number;
  toY: number;

  /** Wall-clock time of the last snapshot that contained this entity. */
  lastSnapshotMs: number;
  /** Wall-clock time of the first snapshot that contained this entity. */
  appearedMs: number;
  /** Wall-clock time this entity was last seen (drives the fade-out). */
  lastSeenMs: number;
  /** Last tick the server reported for this entity (diagnostics only). */
  lastTick: number;
}

export interface SampledEntity {
  id: string;
  k: number;
  o: number;
  s: number;
  hp: number;
  task?: string;
  carry: number;
  /** Interpolated position in tile units. */
  x: number;
  y: number;
  /** 0 = fully transparent (fading out), 1 = fully opaque. */
  alpha: number;
  /** False once the fade-out finished; the renderer should drop the object. */
  alive: boolean;
}

export type TrackMap = Map<string, Track>;

export function createTrackMap(): TrackMap {
  return new Map<string, Track>();
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function ease(value: number): number {
  // Smoothstep: removes the visible "linear ramp" corner at both ends of a fade.
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

/**
 * Merge one snapshot's entity rows into the track map.
 *
 * A newly appearing entity starts with `from === to` (it did not move yet) and
 * a fresh `appearedMs`, which is what makes it fade in. An entity missing from
 * `rows` is NOT removed here — its `lastSeenMs` simply stops advancing, and
 * {@link sampleTracks} fades it out. That is how "enemy walked back into the
 * fog" becomes a graceful disappearance rather than a pop.
 */
export function applyRows(
  tracks: TrackMap,
  rows: readonly EntityRow[],
  tick: number,
  nowMs: number,
  tickMs: number,
): void {
  for (const row of rows) {
    const existing = tracks.get(row.id);
    if (existing === undefined) {
      tracks.set(row.id, {
        id: row.id,
        k: row.k,
        o: row.o,
        s: row.s,
        hp: row.hp,
        ...(row.task === undefined ? {} : { task: row.task }),
        carry: row.carry ?? 0,
        fromX: row.x,
        fromY: row.y,
        toX: row.x,
        toY: row.y,
        lastSnapshotMs: nowMs,
        appearedMs: nowMs,
        lastSeenMs: nowMs,
        lastTick: tick,
      });
      continue;
    }

    // Re-base the interpolation on the *currently displayed* position, not on
    // the previous target: if a snapshot arrives late (or the tab was hidden)
    // the blend has already run past 1 and re-using `toX` would snap backwards.
    const progress = clamp01((nowMs - existing.lastSnapshotMs) / tickMs);
    const renderX = existing.fromX + (existing.toX - existing.fromX) * progress;
    const renderY = existing.fromY + (existing.toY - existing.fromY) * progress;

    existing.k = row.k;
    existing.o = row.o;
    existing.s = row.s;
    existing.hp = row.hp;
    existing.carry = row.carry ?? existing.carry;
    if (row.task === undefined) delete existing.task;
    else existing.task = row.task;

    existing.fromX = renderX;
    existing.fromY = renderY;
    existing.toX = row.x;
    existing.toY = row.y;

    existing.lastSnapshotMs = nowMs;
    existing.lastSeenMs = nowMs;
    existing.lastTick = tick;
  }
}

/** Positions + fade for every track at wall-clock time `nowMs`. Pure. */
export function sampleTracks(tracks: TrackMap, nowMs: number, tickMs: number): SampledEntity[] {
  const fadeMs = FADE_TICKS * tickMs;
  const out: SampledEntity[] = [];

  for (const track of tracks.values()) {
    const progress = clamp01((nowMs - track.lastSnapshotMs) / tickMs);
    const x = track.fromX + (track.toX - track.fromX) * progress;
    const y = track.fromY + (track.toY - track.fromY) * progress;

    const fadeIn = fadeMs <= 0 ? 1 : ease((nowMs - track.appearedMs) / fadeMs);
    const fadeOut = fadeMs <= 0 ? 1 : 1 - ease((nowMs - track.lastSeenMs) / fadeMs);
    const alpha = Math.min(fadeIn, fadeOut);

    out.push({
      id: track.id,
      k: track.k,
      o: track.o,
      s: track.s,
      hp: track.hp,
      ...(track.task === undefined ? {} : { task: track.task }),
      carry: track.carry,
      x,
      y,
      alpha,
      alive: alpha > 0.001,
    });
  }

  // Stable order keeps draw calls (and screenshots) deterministic.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Drop tracks whose fade-out has finished. Mutates `tracks`; returns the ids. */
export function pruneTracks(tracks: TrackMap, nowMs: number, tickMs: number): string[] {
  const fadeMs = FADE_TICKS * tickMs;
  const removed: string[] = [];
  for (const [id, track] of tracks) {
    if (nowMs - track.lastSeenMs > fadeMs) {
      tracks.delete(id);
      removed.push(id);
    }
  }
  return removed;
}

/**
 * Interpolation progress in `[0, 1]` for the *next* server tick.
 *
 * Exposed because the HUD uses it to detect a stalled connection: if progress
 * pins at 1 for several frames the client is waiting for a snapshot.
 */
export function interpolationProgress(tracks: TrackMap, nowMs: number, tickMs: number): number {
  let newest = 0;
  for (const track of tracks.values()) {
    if (track.lastSnapshotMs > newest) newest = track.lastSnapshotMs;
  }
  if (newest === 0) return 1;
  return clamp01((nowMs - newest) / tickMs);
}
