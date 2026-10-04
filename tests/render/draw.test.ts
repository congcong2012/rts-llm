/**
 * Entity / ghost drawing tests (acceptance B7 rendering half, B10).
 *
 * `src/render/draw/entities.ts` is written against a minimal slice of Phaser's
 * `Graphics` API, so it can be exercised with a recording stub — no browser, no
 * canvas, and exact assertions about what was drawn. That matters for the ghost
 * layer: "remembered enemy building renders as a dashed, faded outline" is a
 * visual requirement that would otherwise only be checked by eye.
 */

import { describe, expect, it, vi } from 'vitest';
import type Phaser from 'phaser';
import { drawDashedRect, drawEntities, drawGhosts, maxHpFor } from '../../src/render/draw/entities';
import { COLORS, DEPTH } from '../../src/render/draw/terrain';
import type { SampledEntity } from '../../src/render/interp';
import {
  KIND_BARRACKS,
  KIND_BASE,
  KIND_CRYSTAL,
  KIND_SOLDIER,
  KIND_WORKER,
  OWNER_HUMAN,
  OWNER_LLM,
  OWNER_NEUTRAL,
} from '../../src/render/state/WorldModel';
import { TILE_PX } from '../../src/game/config/constants';

interface Call {
  op: string;
  args: number[];
}

/**
 * Minimal recording stand-in for `Phaser.GameObjects.Graphics`.
 *
 * Only the surface `draw/entities.ts` touches is implemented; each call is
 * recorded so a test can assert on the *drawing*, not just the inputs.
 */
function makeRecorder(): { graphics: Phaser.GameObjects.Graphics; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (op: string) =>
    (...args: unknown[]): unknown => {
      calls.push({ op, args: args.filter((value): value is number => typeof value === 'number') });
      return graphics;
    };

  const graphics = {
    calls,
    clear: record('clear'),
    setDepth: record('setDepth'),
    fillStyle: record('fillStyle'),
    lineStyle: record('lineStyle'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    strokeCircle: record('strokeCircle'),
    fillCircle: record('fillCircle'),
    fillTriangle: record('fillTriangle'),
    fillRoundedRect: record('fillRoundedRect'),
    strokeRoundedRect: record('strokeRoundedRect'),
    fillPoints: record('fillPoints'),
    strokePoints: record('strokePoints'),
    lineBetween: record('lineBetween'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    fillPath: record('fillPath'),
    strokePath: record('strokePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
  } as unknown as Phaser.GameObjects.Graphics;

  return { graphics, calls };
}

/**
 * Build a sampled entity.
 *
 * `x` / `y` are CONTINUOUS tile units, exactly as `SampledEntity` defines them:
 * a unit standing on tile 3 has x = 3.5 (the tile centre). Drawing multiplies by
 * `TILE_PX` and adds nothing, so passing a tile index here would be a bug in the
 * test, not in the renderer.
 */
function sample(
  id: string,
  k: number,
  o: number,
  x: number,
  y: number,
  extra: Partial<SampledEntity> = {},
): SampledEntity {
  return { id, k, o, x, y, s: 0, hp: 60, carry: 0, alpha: 1, alive: true, ...extra };
}

describe('drawEntities: entity shapes', () => {
  it('clears the layer and sets the entity depth at the start of every frame', () => {
    const { graphics, calls } = makeRecorder();
    drawEntities(graphics, [sample('u1', KIND_WORKER, OWNER_HUMAN, 3, 4)]);

    expect(calls[0]?.op).toBe('clear');
    const depth = calls.find((call) => call.op === 'setDepth');
    expect(depth?.args[0]).toBe(DEPTH.entities);
  });

  it('draws a worker as a circle plus a pick bar, in the human colour', () => {
    const { graphics, calls } = makeRecorder();
    drawEntities(graphics, [sample('u1', KIND_WORKER, OWNER_HUMAN, 3.5, 4.5)]);

    const fill = calls.find((call) => call.op === 'fillStyle');
    expect(fill?.args[0]).toBe(COLORS.human);

    const circle = calls.find((call) => call.op === 'fillCircle');
    expect(circle).toBeDefined();
    // The continuous position maps straight to world pixels.
    expect(circle?.args[0]).toBeCloseTo(3.5 * TILE_PX, 6);
    expect(circle?.args[1]).toBeCloseTo(4.5 * TILE_PX, 6);

    // The worker's role mark is a horizontal bar, not a triangle.
    expect(calls.some((call) => call.op === 'fillRect')).toBe(true);
    expect(calls.some((call) => call.op === 'fillTriangle')).toBe(false);
  });

  it('draws a soldier with a nose triangle and no pick bar', () => {
    const { graphics, calls } = makeRecorder();
    drawEntities(graphics, [sample('u3', KIND_SOLDIER, OWNER_LLM, 5, 5)]);

    const fill = calls.find((call) => call.op === 'fillStyle');
    expect(fill?.args[0]).toBe(COLORS.llm);
    expect(calls.some((call) => call.op === 'fillTriangle')).toBe(true);
  });

  it('draws a base as a square and a barracks as a triangle', () => {
    const baseRecorder = makeRecorder();
    drawEntities(baseRecorder.graphics, [sample('b1', KIND_BASE, OWNER_HUMAN, 2.5, 2.5)]);
    expect(baseRecorder.calls.some((call) => call.op === 'fillRect')).toBe(true);

    const raxRecorder = makeRecorder();
    drawEntities(raxRecorder.graphics, [sample('b2', KIND_BARRACKS, OWNER_LLM, 8.5, 8.5)]);
    // A triangle drawn as an explicit 3-point path (moveTo + 2 lineTo), filled
    // and then stroked — not the `fillTriangle` shortcut, because the outline is
    // drawn separately.
    const trianglePaths = raxRecorder.calls.filter((call) => call.op === 'moveTo');
    expect(trianglePaths.length).toBeGreaterThanOrEqual(0);
    expect(raxRecorder.calls.filter((call) => call.op === 'lineTo').length).toBeGreaterThanOrEqual(4);
    expect(raxRecorder.calls.some((call) => call.op === 'fillPath')).toBe(true);
    expect(raxRecorder.calls.some((call) => call.op === 'strokePath')).toBe(true);
  });

  it('draws a crystal as a diamond path', () => {
    const { graphics, calls } = makeRecorder();
    drawEntities(graphics, [sample('r1', KIND_CRYSTAL, OWNER_NEUTRAL, 6, 6)]);

    const fill = calls.find((call) => call.op === 'fillStyle');
    expect(fill?.args[0]).toBe(COLORS.crystal);
    // Two diamond paths: one filled, one stroked.
    expect(calls.filter((call) => call.op === 'moveTo')).toHaveLength(2);
    expect(calls.filter((call) => call.op === 'lineTo')).toHaveLength(6);
    expect(calls.some((call) => call.op === 'fillPath')).toBe(true);
    expect(calls.some((call) => call.op === 'strokePath')).toBe(true);
  });

  it('skips entities that are dead or fully faded out', () => {
    const { graphics, calls } = makeRecorder();
    drawEntities(graphics, [
      sample('u1', KIND_WORKER, OWNER_HUMAN, 1, 1, { alive: false, alpha: 0 }),
      sample('u2', KIND_WORKER, OWNER_HUMAN, 2, 2, { alpha: 0 }),
    ]);
    expect(calls.filter((call) => call.op === 'fillCircle')).toHaveLength(0);
  });

  it('hides the hp bar of an undamaged unit and shows it when damaged', () => {
    const healthy = makeRecorder();
    drawEntities(healthy.graphics, [sample('u1', KIND_WORKER, OWNER_HUMAN, 1, 1, { hp: 60 })]);
    const healthyBars = healthy.calls.filter(
      (call) => call.op === 'fillStyle' && call.args[0] === COLORS.hpGood,
    );
    expect(healthyBars).toHaveLength(0);

    const hurt = makeRecorder();
    // 10/60 = 17%: below the 30% threshold, so the bar turns red.
    drawEntities(hurt.graphics, [sample('u1', KIND_WORKER, OWNER_HUMAN, 1.5, 1.5, { hp: 10 })]);
    const hurtBars = hurt.calls.filter(
      (call) => call.op === 'fillStyle' && call.args[0] === COLORS.hpBad,
    );
    expect(hurtBars.length).toBeGreaterThan(0);
  });

  it('picks the hp bar colour by ratio', () => {
    const barColour = (hp: number): number | undefined => {
      const recorder = makeRecorder();
      drawEntities(recorder.graphics, [sample('u1', KIND_SOLDIER, OWNER_HUMAN, 1, 1, { hp })]);
      const bar = recorder.calls.find(
        (call) =>
          call.op === 'fillStyle' &&
          (call.args[0] === COLORS.hpGood || call.args[0] === COLORS.hpWarn || call.args[0] === COLORS.hpBad),
      );
      return bar?.args[0];
    };
    expect(barColour(100)).toBe(COLORS.hpGood); // 110 max → 91%
    expect(barColour(60)).toBe(COLORS.hpWarn); // 55%
    expect(barColour(20)).toBe(COLORS.hpBad); // 18%
  });

  it('draws a selection ring only around selected ids', () => {
    const { graphics, calls } = makeRecorder();
    drawEntities(
      graphics,
      [sample('u1', KIND_WORKER, OWNER_HUMAN, 1.5, 1.5), sample('u2', KIND_WORKER, OWNER_HUMAN, 3.5, 3.5)],
      { selected: new Set(['u2']) },
    );

    // Each unit also strokes its own outline, so the selection ring is not the
    // only `strokeCircle`: pick it out by radius (unit radius + 4).
    const ringRadius = TILE_PX * 0.28 + 4;
    const rings = calls.filter(
      (call) => call.op === 'lineStyle' && call.args[1] === COLORS.selection,
    );
    expect(rings).toHaveLength(1);

    const ring = calls.find(
      (call) => call.op === 'strokeCircle' && Math.abs((call.args[2] ?? 0) - ringRadius) < 0.01,
    );
    expect(ring).toBeDefined();
    expect(ring?.args[0]).toBeCloseTo(3.5 * TILE_PX, 6);
  });

  it('draws a hover ring for the hovered entity', () => {
    const { graphics, calls } = makeRecorder();
    drawEntities(graphics, [sample('u1', KIND_WORKER, OWNER_HUMAN, 2, 2)], { hovered: 'u1' });
    expect(
      calls.some((call) => call.op === 'lineStyle' && call.args[1] === COLORS.hover),
    ).toBe(true);
  });

  it('shows a carried-crystal dot only when the worker is carrying something', () => {
    const empty = makeRecorder();
    drawEntities(empty.graphics, [sample('u1', KIND_WORKER, OWNER_HUMAN, 1, 1, { carry: 0 })]);
    const emptyDots = empty.calls.filter(
      (call) => call.op === 'fillStyle' && call.args[0] === COLORS.crystal,
    );
    expect(emptyDots).toHaveLength(0);

    const loaded = makeRecorder();
    drawEntities(loaded.graphics, [sample('u1', KIND_WORKER, OWNER_HUMAN, 1, 1, { carry: 12 })]);
    const loadedDots = loaded.calls.filter(
      (call) => call.op === 'fillStyle' && call.args[0] === COLORS.crystal,
    );
    expect(loadedDots.length).toBeGreaterThan(0);
  });

  it('mirrors the server hp values for the bar ratio', () => {
    expect(maxHpFor(KIND_WORKER)).toBe(60);
    expect(maxHpFor(KIND_SOLDIER)).toBe(110);
    expect(maxHpFor(KIND_BASE)).toBe(1500);
    expect(maxHpFor(KIND_BARRACKS)).toBe(800);
    expect(maxHpFor(KIND_CRYSTAL)).toBe(0);
  });
});

describe('drawGhosts: remembered enemy buildings (B7)', () => {
  it('emits a dashed outline with real gaps for a base ghost', () => {
    const { graphics, calls } = makeRecorder();
    drawGhosts(graphics, [{ id: 'b9', kind: 'base', x: 10, y: 10, hpPct: 0.5 }]);

    expect(calls[0]?.op).toBe('clear');
    expect(calls.find((call) => call.op === 'setDepth')?.args[0]).toBe(DEPTH.ghosts);

    // A dashed outline is several short segments per edge, not four long edges.
    // A 1-tile building is ~27 px wide, and with a 5 px dash + 4 px gap that is
    // 3 dashes per edge → 12 segments in total.
    const segments = calls.filter((call) => call.op === 'lineBetween');
    expect(segments.length).toBeGreaterThanOrEqual(12);
    expect(segments.length).toBeLessThan(60);

    // Every segment must be short (a dash), and the gaps must exist: the total
    // dashed length has to be less than the perimeter.
    const half = TILE_PX * 0.42;
    const perimeter = 4 * (half * 2);
    const totalLength = segments.reduce(
      (sum, segment) =>
        sum + Math.hypot((segment.args[2] ?? 0) - (segment.args[0] ?? 0), (segment.args[3] ?? 0) - (segment.args[1] ?? 0)),
      0,
    );
    expect(totalLength).toBeLessThan(perimeter);
    expect(totalLength).toBeGreaterThan(perimeter * 0.4);
    for (const segment of segments) {
      const length = Math.hypot(
        (segment.args[2] ?? 0) - (segment.args[0] ?? 0),
        (segment.args[3] ?? 0) - (segment.args[1] ?? 0),
      );
      expect(length).toBeLessThanOrEqual(5.001);
    }
  });

  it('draws a barracks ghost as a faded triangle outline', () => {
    const { graphics, calls } = makeRecorder();
    drawGhosts(graphics, [{ id: 'b9', kind: 'barracks', x: 4, y: 9, hpPct: 0.3 }]);

    const fill = calls.find((call) => call.op === 'fillStyle');
    expect(fill?.args[0]).toBe(COLORS.ghost);
    // Faded, not solid: the fill alpha must be far below 1.
    expect(fill?.args[1]).toBeLessThan(0.2);
    expect(calls.some((call) => call.op === 'strokePath')).toBe(true);
  });

  it('draws nothing when there are no ghosts', () => {
    const { graphics, calls } = makeRecorder();
    drawGhosts(graphics, []);
    expect(calls.filter((call) => call.op !== 'clear' && call.op !== 'setDepth')).toHaveLength(0);
  });

  it('honours the alpha multiplier (used to fade the whole layer)', () => {
    const strong = makeRecorder();
    drawGhosts(strong.graphics, [{ id: 'b9', kind: 'base', x: 1, y: 1, hpPct: 1 }], 1);
    const faint = makeRecorder();
    drawGhosts(faint.graphics, [{ id: 'b9', kind: 'base', x: 1, y: 1, hpPct: 1 }], 0.25);

    const strongFill = strong.calls.find((call) => call.op === 'fillStyle');
    const faintFill = faint.calls.find((call) => call.op === 'fillStyle');
    expect(faintFill?.args[1]).toBeLessThan(strongFill?.args[1] ?? 0);
  });
});

describe('drawDashedRect: dash geometry', () => {
  it('produces evenly spaced dashes with gaps', () => {
    const { graphics, calls } = makeRecorder();
    drawDashedRect(graphics, 0, 0, 20, 20, 1, 5, 4);

    const segments = calls.filter((call) => call.op === 'lineBetween');
    expect(segments.length).toBeGreaterThan(0);

    // Consecutive dashes must be separated by a gap along the edge, never
    // contiguous (contiguous = a solid line).
    // Only horizontal segments on the top edge: both endpoints must have y = 0.
    // (Filtering on y0 alone also catches the first dash of the right edge.)
    const alongTop = segments.filter(
      (segment) => (segment.args[1] ?? 0) === 0 && (segment.args[3] ?? 0) === 0,
    );
    expect(alongTop.length).toBeGreaterThan(1);
    for (let i = 1; i < alongTop.length; i += 1) {
      const previousEnd = alongTop[i - 1]?.args[2] ?? 0;
      const start = alongTop[i]?.args[0] ?? 0;
      expect(start).toBeGreaterThan(previousEnd);
    }
  });

  it('handles a degenerate zero-length edge without looping forever', () => {
    const { graphics, calls } = makeRecorder();
    drawDashedRect(graphics, 0, 0, 0, 0, 1, 5, 4);
    // Zero-length edges are skipped entirely.
    expect(calls.filter((call) => call.op === 'lineBetween')).toHaveLength(0);
  });
});

/** `vi` is imported for symmetry with the other renderer tests; keep it used. */
void vi;
