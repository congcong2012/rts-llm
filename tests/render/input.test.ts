/**
 * Selection, order resolution and hotkey mapping (acceptance B2/B3/B4).
 *
 * All three modules are pure: they take the currently rendered samples and
 * return ids or actions. That makes the human's control scheme testable without
 * a browser, which matters because B2 ("不可见实体无法被选中") is a security-ish
 * requirement, not just a UI detail.
 */

import { describe, expect, it } from 'vitest';
import type { SampledEntity } from '../../src/render/interp';
import {
  MAX_SELECTION,
  pickUnit,
  pickUnitsInRect,
  rectFromPoints,
  summarizeSelection,
  toggleSelection,
} from '../../src/render/input/selection';
import { gatherNearest, holdPosition, resolveRightClick, splitSelection } from '../../src/render/input/commands';
import { ZOOM_MAX, ZOOM_MIN, clampZoom, intentForCode } from '../../src/render/input/hotkeys';
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

const WORKER_A = sample('u1', KIND_WORKER, OWNER_HUMAN, 3.5, 3.5);
const WORKER_B = sample('u2', KIND_WORKER, OWNER_HUMAN, 9.5, 3.5);
const SOLDIER = sample('u3', KIND_SOLDIER, OWNER_HUMAN, 6.5, 6.5);
const ENEMY = sample('u9', KIND_SOLDIER, OWNER_LLM, 5.5, 3.5);
const BASE = sample('b1', KIND_BASE, OWNER_HUMAN, 1.5, 1.5);
const CRYSTAL = sample('r1', KIND_CRYSTAL, OWNER_NEUTRAL, 12.5, 3.5, { hp: 1 });

const ALL = [WORKER_A, WORKER_B, SOLDIER, ENEMY, BASE, CRYSTAL];

describe('selection: hit testing', () => {
  it('picks the own unit under the cursor', () => {
    expect(pickUnit(ALL, 3.5, 3.5)).toBe('u1');
    expect(pickUnit(ALL, 6.5, 6.5)).toBe('u3');
  });

  it('returns null on empty ground and outside the pick radius', () => {
    expect(pickUnit(ALL, 20.5, 20.5)).toBeNull();
    // 0.8 tiles away is beyond the 0.55 default radius.
    expect(pickUnit(ALL, 3.5, 4.3)).toBeNull();
  });

  it('never selects an enemy, a building or a crystal (B2)', () => {
    // Right on top of the enemy — a normal click must not pick it up.
    expect(pickUnit(ALL, 5.5, 3.5)).toBeNull();
    expect(pickUnit(ALL, 1.5, 1.5)).toBeNull();
    expect(pickUnit(ALL, 12.5, 3.5)).toBeNull();
  });

  it('never selects an entity that is fading out (just left vision)', () => {
    const fading = [sample('u4', KIND_SOLDIER, OWNER_HUMAN, 4.5, 4.5, { alpha: 0.1 })];
    expect(pickUnit(fading, 4.5, 4.5)).toBeNull();
  });

  it('breaks an exact tie deterministically by id', () => {
    // Units do not collide in this MVP (docs/SPEC.md §17 P1-10), so two of them
    // really can share a tile. The distances are then bit-identical and only the
    // id tie-break can decide — and it must always pick the same unit.
    const a = sample('u2', KIND_WORKER, OWNER_HUMAN, 5.5, 5.5);
    const b = sample('u1', KIND_WORKER, OWNER_HUMAN, 5.5, 5.5);
    expect(pickUnit([a, b], 5.5, 5.5)).toBe('u1');
    expect(pickUnit([b, a], 5.5, 5.5)).toBe('u1');
  });

  it('prefers the closer unit, not the first one in the list', () => {
    const far = sample('u1', KIND_WORKER, OWNER_HUMAN, 5.5, 4.5);
    const near = sample('u2', KIND_WORKER, OWNER_HUMAN, 5.05, 4.5);
    expect(pickUnit([far, near], 5.0, 4.5)).toBe('u2');
  });
});

describe('selection: box select', () => {
  it('collects every own unit inside the rectangle', () => {
    const rect = rectFromPoints(0, 0, 10, 10);
    expect(pickUnitsInRect(ALL, rect)).toEqual(['u1', 'u2', 'u3']);
  });

  it('is order independent (a drag in any direction works)', () => {
    const forward = pickUnitsInRect(ALL, rectFromPoints(2, 2, 10, 10));
    const backward = pickUnitsInRect(ALL, rectFromPoints(10, 10, 2, 2));
    expect(forward).toEqual(backward);
  });

  it('skips enemies even when they are inside the box', () => {
    const rect = rectFromPoints(5, 3, 6, 4);
    // Only the enemy sits there, so the result is empty.
    expect(pickUnitsInRect(ALL, rect)).toEqual([]);
  });

  it('caps the selection at the human action budget', () => {
    const crowd = Array.from({ length: MAX_SELECTION + 8 }, (_, index) =>
      sample(`u${100 + index}`, KIND_WORKER, OWNER_HUMAN, 20.5, 20.5 + index * 0.01),
    );
    expect(pickUnitsInRect(crowd, rectFromPoints(19, 19, 22, 24))).toHaveLength(MAX_SELECTION);
  });
});

describe('selection: additive toggle', () => {
  it('adds hits to the existing selection', () => {
    expect(toggleSelection(['u1'], ['u3'])).toEqual(['u1', 'u3']);
  });

  it('removes a hit that was already selected', () => {
    expect(toggleSelection(['u1', 'u3'], ['u3'])).toEqual(['u1']);
  });

  it('does not remove anything when no hit was selected yet', () => {
    expect(toggleSelection(['u1'], ['u2', 'u3'])).toEqual(['u1', 'u2', 'u3']);
  });

  it('summarizes a selection by unit kind', () => {
    expect(summarizeSelection(ALL, new Set(['u1', 'u2', 'u3']))).toEqual({
      workers: 2,
      soldiers: 1,
      total: 3,
    });
    expect(summarizeSelection(ALL, new Set())).toEqual({ workers: 0, soldiers: 0, total: 0 });
  });

  it('splits a mixed selection into workers and soldiers', () => {
    expect(splitSelection(['u1', 'u3', 'u2'], ALL)).toEqual({
      workers: ['u1', 'u2'],
      soldiers: ['u3'],
    });
  });
});

describe('commands: right-click resolution', () => {
  const context = { selection: ['u1', 'u3'], entities: ALL };

  it('orders a move when clicking empty ground', () => {
    const resolved = resolveRightClick(context, {
      tileX: 20,
      tileY: 22,
      entity: null,
      worldX: 20.5,
      worldY: 22.5,
    });
    expect(resolved?.label).toBe('move');
    expect(resolved?.actions).toEqual([
      { type: 'move', unitIds: ['u1', 'u3'], x: 20, y: 22 },
    ]);
  });

  it('orders workers to gather when clicking a crystal', () => {
    const resolved = resolveRightClick(context, {
      tileX: 12,
      tileY: 3,
      entity: CRYSTAL,
      worldX: 12.5,
      worldY: 3.5,
    });
    expect(resolved?.label).toBe('gather');
    // Workers gather; the soldier walks to the node instead.
    expect(resolved?.actions).toEqual([
      { type: 'gather', unitIds: ['u1'], targetId: 'r1' },
      { type: 'move', unitIds: ['u3'], x: 12, y: 3 },
    ]);
  });

  it('orders soldiers to attack a visible enemy and pulls workers back', () => {
    const resolved = resolveRightClick(context, {
      tileX: 5,
      tileY: 3,
      entity: ENEMY,
      worldX: 5.5,
      worldY: 3.5,
    });
    expect(resolved?.actions).toEqual([
      { type: 'attack', unitIds: ['u3'], targetId: 'u9' },
      { type: 'hold', unitIds: ['u1'] },
    ]);
    // A worker must never receive an attack order: `canInitiateAttack` is false
    // in the simulation, so it would be rejected.
    for (const action of resolved?.actions ?? []) {
      if (action.type === 'attack') expect(action.unitIds).not.toContain('u1');
    }
  });

  it('sends only soldiers when the selection has no workers', () => {
    const resolved = resolveRightClick(
      { selection: ['u3'], entities: ALL },
      { tileX: 5, tileY: 3, entity: ENEMY, worldX: 5.5, worldY: 3.5 },
    );
    expect(resolved?.actions).toEqual([{ type: 'attack', unitIds: ['u3'], targetId: 'u9' }]);
  });

  it('moves the group onto an own building without issuing an illegal order', () => {
    const resolved = resolveRightClick(context, {
      tileX: 1,
      tileY: 1,
      entity: BASE,
      worldX: 1.5,
      worldY: 1.5,
    });
    expect(resolved?.actions).toEqual([
      { type: 'move', unitIds: ['u1', 'u3'], x: 1, y: 1 },
    ]);
  });

  it('treats an own construction site as "assist"', () => {
    const site = sample('b7', KIND_BARRACKS, OWNER_HUMAN, 8.5, 8.5, { s: 1 });
    const resolved = resolveRightClick(
      { selection: ['u1'], entities: [...ALL, site], ownConstructionSiteIds: new Set(['b7']) },
      { tileX: 8, tileY: 8, entity: site, worldX: 8.5, worldY: 8.5 },
    );
    expect(resolved?.label).toBe('assist');
    expect(resolved?.actions).toEqual([{ type: 'move', unitIds: ['u1'], x: 8, y: 8 }]);
  });

  it('returns null for an empty selection', () => {
    expect(
      resolveRightClick(
        { selection: [], entities: ALL },
        { tileX: 3, tileY: 3, entity: null, worldX: 3.5, worldY: 3.5 },
      ),
    ).toBeNull();
  });

  it('clamps out-of-range tiles instead of emitting an illegal coordinate', () => {
    const resolved = resolveRightClick(context, {
      tileX: -5,
      tileY: 99999,
      entity: null,
      worldX: -5,
      worldY: 99999,
    });
    expect(resolved?.actions[0]).toEqual({ type: 'move', unitIds: ['u1', 'u3'], x: 0, y: 1023 });
  });

  it('builds gather / hold orders that omit the target when asked to', () => {
    expect(gatherNearest(['u1', 'u2'])).toEqual({ type: 'gather', unitIds: ['u1', 'u2'] });
    expect(holdPosition(['u1'])).toEqual({ type: 'hold', unitIds: ['u1'] });
    expect(gatherNearest([])).toBeNull();
    expect(holdPosition([])).toBeNull();
  });
});

describe('hotkeys: key mapping and zoom limits', () => {
  it('maps WASD and the arrow keys to camera panning', () => {
    expect(intentForCode('KeyW')).toEqual({ kind: 'pan', dx: 0, dy: -1 });
    expect(intentForCode('ArrowDown')).toEqual({ kind: 'pan', dx: 0, dy: 1 });
    expect(intentForCode('KeyA')).toEqual({ kind: 'pan', dx: -1, dy: 0 });
    expect(intentForCode('ArrowRight')).toEqual({ kind: 'pan', dx: 1, dy: 0 });
  });

  it('maps the utility keys', () => {
    expect(intentForCode('Space')).toEqual({ kind: 'center-base' });
    expect(intentForCode('Escape')).toEqual({ kind: 'clear-selection' });
    expect(intentForCode('KeyG')).toEqual({ kind: 'gather' });
    expect(intentForCode('KeyH')).toEqual({ kind: 'hold' });
    expect(intentForCode('KeyX')).toEqual({ kind: 'stop' });
    expect(intentForCode('Tab')).toEqual({ kind: 'cycle-idle' });
  });

  it('zooms out and in, with Shift amplifying', () => {
    expect(intentForCode('KeyQ', false)).toEqual({ kind: 'zoom', factor: 0.85 });
    expect(intentForCode('KeyQ', true)).toEqual({ kind: 'zoom', factor: 0.7 });
    expect(intentForCode('KeyE', false)).toEqual({ kind: 'zoom', factor: 1.18 });
    expect(intentForCode('KeyE', true)).toEqual({ kind: 'zoom', factor: 1.4 });
  });

  it('ignores unmapped keys', () => {
    expect(intentForCode('KeyZ')).toBeNull();
    expect(intentForCode('F5')).toBeNull();
  });

  it('clamps zoom to [0.35, 2.0] (B6)', () => {
    expect(ZOOM_MIN).toBe(0.35);
    expect(ZOOM_MAX).toBe(2.0);
    expect(clampZoom(0.01)).toBe(0.35);
    expect(clampZoom(99)).toBe(2.0);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(Number.NaN)).toBe(1);
    // A long sequence of zoom-outs can never escape the range.
    let zoom = 1;
    for (let i = 0; i < 40; i += 1) zoom = clampZoom(zoom * 0.85);
    expect(zoom).toBe(0.35);
    for (let i = 0; i < 40; i += 1) zoom = clampZoom(zoom * 1.18);
    expect(zoom).toBe(2.0);
  });
});
