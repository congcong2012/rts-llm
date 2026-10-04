/**
 * Snapshot interpolation tests (acceptance B3/B10).
 *
 * The whole module is pure and takes its clock as an argument, so every case
 * here is a deterministic, exact assertion — no timers, no flakiness.
 *
 * Note on the helper: `applyRows` takes `(tracks, rows, tick, nowMs, tickMs)`.
 * The local `apply` wrapper fixes `tickMs` so a test can never silently pass
 * `undefined` and produce NaN positions.
 */

import { describe, expect, it } from 'vitest';
import type { EntityRow } from '../../src/shared/protocol';
import {
  FADE_TICKS,
  applyRows,
  createTrackMap,
  interpolationProgress,
  pruneTracks,
  sampleTracks,
} from '../../src/render/interp';
import type { TrackMap } from '../../src/render/interp';

const TICK_MS = 100;
const FADE_MS = FADE_TICKS * TICK_MS;

function row(id: string, x: number, y: number, extra: Partial<EntityRow> = {}): EntityRow {
  return { k: 0, o: 0, id, x, y, hp: 60, s: 0, ...extra };
}

function apply(tracks: TrackMap, rows: EntityRow[], tick: number, nowMs: number): void {
  applyRows(tracks, rows, tick, nowMs, TICK_MS);
}

function sampleOne(
  tracks: TrackMap,
  id: string,
  nowMs: number,
): { x: number; y: number; alpha: number; alive: boolean } {
  const found = sampleTracks(tracks, nowMs, TICK_MS).find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no sample for ${id}`);
  return { x: found.x, y: found.y, alpha: found.alpha, alive: found.alive };
}

describe('interp: position blending', () => {
  it('holds the snapshot position at t=0 and reaches the target at t=tick', () => {
    const tracks = createTrackMap();
    apply(tracks, [row('u1', 10, 10)], 1, 0);
    expect(sampleOne(tracks, 'u1', 0).x).toBeCloseTo(10, 6);

    // A second snapshot sets up a from→to blend.
    apply(tracks, [row('u1', 12, 14)], 2, TICK_MS);
    expect(sampleOne(tracks, 'u1', TICK_MS).x).toBeCloseTo(10, 6);
    expect(sampleOne(tracks, 'u1', TICK_MS).y).toBeCloseTo(10, 6);

    // Half a tick later the unit is halfway there.
    const half = sampleOne(tracks, 'u1', TICK_MS + TICK_MS / 2);
    expect(half.x).toBeCloseTo(11, 6);
    expect(half.y).toBeCloseTo(12, 6);

    // A full tick later it has arrived.
    const full = sampleOne(tracks, 'u1', TICK_MS * 2);
    expect(full.x).toBeCloseTo(12, 6);
    expect(full.y).toBeCloseTo(14, 6);
  });

  it('clamps progress instead of extrapolating past the target', () => {
    const tracks = createTrackMap();
    apply(tracks, [row('u1', 0, 0)], 1, 0);
    apply(tracks, [row('u1', 4, 0)], 2, TICK_MS);

    // Simulate a long stall (tab hidden / server hiccup): 20 ticks late.
    const late = sampleOne(tracks, 'u1', TICK_MS + TICK_MS * 20);
    expect(late.x).toBeCloseTo(4, 6);
    expect(late.x).toBeLessThanOrEqual(4);
  });

  it('re-bases from the displayed position so a late snapshot never snaps back', () => {
    const tracks = createTrackMap();
    apply(tracks, [row('u1', 0, 0)], 1, 0);
    apply(tracks, [row('u1', 10, 0)], 2, TICK_MS);

    // The blend has already visually reached ~9.5 when the next snapshot lands.
    const lateMs = TICK_MS + TICK_MS * 0.95;
    const displayed = sampleOne(tracks, 'u1', lateMs);
    expect(displayed.x).toBeCloseTo(9.5, 3);

    apply(tracks, [row('u1', 11, 0)], 3, lateMs);
    // Immediately after the update the unit must still be where it was drawn —
    // a naive implementation would jump to 10 and look like a stutter.
    const afterUpdate = sampleOne(tracks, 'u1', lateMs);
    expect(afterUpdate.x).toBeCloseTo(9.5, 3);
  });

  it('moves an entity along a multi-tick path monotonically', () => {
    const tracks = createTrackMap();
    const waypoints = [0, 1, 2, 3, 4, 5];
    let previous = -1;

    for (const [index, target] of waypoints.entries()) {
      const now = index * TICK_MS;
      apply(tracks, [row('u1', target, 0)], index + 1, now);
      const value = sampleOne(tracks, 'u1', now).x;
      // Never moves backwards between consecutive ticks.
      expect(value).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = value;
    }
    expect(sampleOne(tracks, 'u1', waypoints.length * TICK_MS).x).toBeCloseTo(5, 6);
  });
});

describe('interp: fade in and out (4 ticks)', () => {
  it('fades a new entity in from transparent to opaque', () => {
    const tracks = createTrackMap();
    // Reported on every tick, exactly like a real snapshot stream.
    for (let tick = 1; tick <= 6; tick += 1) {
      apply(tracks, [row('u1', 5, 5)], tick, (tick - 1) * TICK_MS);
    }

    // At the instant it appeared the entity is invisible…
    expect(sampleTracks(tracks, 0, TICK_MS)).toHaveLength(1);
    const atAppearance = sampleOne(tracks, 'u1', 0);
    expect(atAppearance.alpha).toBeCloseTo(0, 6);
    expect(atAppearance.alive).toBe(false);

    // …half a fade window later it is partially visible…
    const mid = sampleOne(tracks, 'u1', TICK_MS);
    expect(mid.alpha).toBeGreaterThan(0);
    expect(mid.alpha).toBeLessThan(1);

    // …and once the window has elapsed it is fully opaque.
    expect(sampleOne(tracks, 'u1', FADE_MS).alpha).toBeCloseTo(1, 6);
  });

  it('fades an entity out when the server stops mentioning it', () => {
    const tracks = createTrackMap();
    // Reported every tick up to t=400, then never again.
    for (let tick = 1; tick <= 5; tick += 1) {
      apply(tracks, [row('u1', 5, 5), row('u2', 1, 1)], tick, (tick - 1) * TICK_MS);
    }
    expect(sampleOne(tracks, 'u1', 4 * TICK_MS).alpha).toBeCloseTo(1, 6);

    const lastSeen = 4 * TICK_MS;
    // t=500: u1 has been unseen for 100 ms of a 400 ms fade.
    apply(tracks, [row('u2', 1, 1)], 6, lastSeen + TICK_MS);
    const during = sampleOne(tracks, 'u1', lastSeen + TICK_MS);
    expect(during.alpha).toBeGreaterThan(0);
    expect(during.alpha).toBeLessThan(1);

    // Once the window elapses it is gone.
    const after = sampleOne(tracks, 'u1', lastSeen + FADE_MS + 1);
    expect(after.alpha).toBe(0);
    expect(after.alive).toBe(false);
  });

  it('never fades out an entity that keeps being reported', () => {
    const tracks = createTrackMap();
    for (let tick = 0; tick < 20; tick += 1) {
      apply(tracks, [row('u1', tick, 0)], tick, tick * TICK_MS);
    }
    const sample = sampleOne(tracks, 'u1', 19 * TICK_MS);
    expect(sample.alpha).toBeCloseTo(1, 6);
    expect(sample.alive).toBe(true);
  });

  it('prunes only tracks whose fade-out finished', () => {
    const tracks = createTrackMap();
    apply(tracks, [row('gone', 1, 1), row('kept', 2, 2)], 1, 0);
    // `kept` keeps being reported until t=400; `gone` is never seen again.
    for (let tick = 2; tick <= 5; tick += 1) {
      apply(tracks, [row('kept', 2, 2)], tick, (tick - 1) * TICK_MS);
    }

    // t=600: `gone` has been unseen for 600 ms, `kept` only for 200 ms.
    const removed = pruneTracks(tracks, lastSeenOf('kept') + 200, TICK_MS);
    expect(removed).toContain('gone');
    expect(removed).not.toContain('kept');
    expect(tracks.has('gone')).toBe(false);
    expect(tracks.has('kept')).toBe(true);

    // Past the window, `kept` goes too.
    const later = pruneTracks(tracks, lastSeenOf('kept') + FADE_MS + 1, TICK_MS);
    expect(later).toContain('kept');

    /** `kept` was last reported at the 5th tick, i.e. 400 ms in. */
    function lastSeenOf(id: string): number {
      const track = tracks.get(id);
      if (track === undefined) throw new Error(`no track ${id}`);
      return track.lastSeenMs;
    }
  });
});

describe('interp: bookkeeping', () => {
  it('carries the wire fields through unchanged', () => {
    const tracks = createTrackMap();
    apply(tracks, [row('u7', 3, 4, { k: 1, o: 1, s: 3, hp: 42, task: 'u1', carry: 7 })], 1, 0);
    const sample = sampleTracks(tracks, 0, TICK_MS).find((entry) => entry.id === 'u7');
    expect(sample).toBeDefined();
    expect(sample?.k).toBe(1);
    expect(sample?.o).toBe(1);
    expect(sample?.s).toBe(3);
    expect(sample?.hp).toBe(42);
    expect(sample?.task).toBe('u1');
    expect(sample?.carry).toBe(7);
  });

  it('clears a stale task when the new snapshot omits it', () => {
    const tracks = createTrackMap();
    apply(tracks, [row('u1', 1, 1, { task: 'r1' })], 1, 0);
    apply(tracks, [row('u1', 1, 1)], 2, TICK_MS);
    const sample = sampleTracks(tracks, TICK_MS, TICK_MS).find((entry) => entry.id === 'u1');
    expect(sample?.task).toBeUndefined();
  });

  it('reports interpolation progress for connection-stall detection', () => {
    const tracks = createTrackMap();
    expect(interpolationProgress(tracks, 0, TICK_MS)).toBe(1);

    apply(tracks, [row('u1', 0, 0)], 1, 1000);
    expect(interpolationProgress(tracks, 1000, TICK_MS)).toBe(0);
    expect(interpolationProgress(tracks, 1050, TICK_MS)).toBeCloseTo(0.5, 6);
    // Stalled: progress pins at 1.
    expect(interpolationProgress(tracks, 5000, TICK_MS)).toBe(1);
  });

  it('produces a deterministic, id-sorted sample order', () => {
    const tracks = createTrackMap();
    apply(tracks, [row('u3', 1, 1), row('u1', 2, 2), row('u2', 3, 3)], 1, 0);
    expect(sampleTracks(tracks, 0, TICK_MS).map((entry) => entry.id)).toEqual(['u1', 'u2', 'u3']);
  });
});
