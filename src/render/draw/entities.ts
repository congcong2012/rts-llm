/**
 * Per-frame entity drawing (docs/ROADMAP.md 阶段 2 任务 5).
 *
 * ONE `Graphics` object is cleared and repainted every frame. That is the right
 * trade-off here: at the 200-entity hard cap a full repaint is a few thousand
 * primitive calls into a single batched object, which is cheaper than managing
 * ~200 individual GameObjects with their own transforms and alpha tweens — and
 * it keeps the fade-in/fade-out alpha completely under our control.
 *
 * Shapes (no assets):
 *   worker   — small filled circle with a pick mark
 *   soldier  — larger circle with a pointed nose (facing is not simulated)
 *   base     — filled square with a corner notch
 *   barracks — triangle
 *   crystal  — diamond
 *   all      — hp bar above every damaged unit/building
 */

import Phaser from 'phaser';
import { TILE_PX, UNIT_STATS, BUILDING_STATS } from '../../game/config/constants';
import type { SampledEntity } from '../interp';
import {
  KIND_BARRACKS,
  KIND_BASE,
  KIND_CRYSTAL,
  KIND_SOLDIER,
  KIND_WORKER,
  OWNER_HUMAN,
  OWNER_NEUTRAL,
} from '../state/WorldModel';
import { COLORS, DEPTH } from './terrain';

export interface DrawEntitiesOptions {
  /** Ids to outline with the selection ring. */
  selected?: ReadonlySet<string>;
  /** Id of the entity under the cursor. */
  hovered?: string | null;
  /** Draw orders' destination marker lines. */
  showTaskLinks?: boolean;
}

/** Palette for a wire owner code. */
export function ownerFill(owner: number): number {
  if (owner === OWNER_HUMAN) return COLORS.human;
  if (owner === OWNER_NEUTRAL) return COLORS.crystal;
  return COLORS.llm;
}

export function ownerStroke(owner: number): number {
  if (owner === OWNER_HUMAN) return COLORS.humanDark;
  if (owner === OWNER_NEUTRAL) return COLORS.crystalEdge;
  return COLORS.llmDark;
}

/** Radius in world pixels for a unit kind (buildings are drawn as squares). */
function unitRadius(kind: number): number {
  return kind === KIND_WORKER ? TILE_PX * 0.28 : TILE_PX * 0.34;
}

/**
 * Repaint every visible entity.
 *
 * `samples` must already be interpolated and sorted; the caller (GameScene) holds
 * the Graphics object and the depth so this module stays free of scene wiring.
 */
export function drawEntities(
  graphics: Phaser.GameObjects.Graphics,
  samples: readonly SampledEntity[],
  options: DrawEntitiesOptions = {},
): void {
  graphics.clear();
  graphics.setDepth(DEPTH.entities);

  const selected = options.selected;

  for (const sample of samples) {
    if (!sample.alive || sample.alpha <= 0.001) continue;
    switch (sample.k) {
      case KIND_CRYSTAL:
        drawCrystal(graphics, sample.x, sample.y, sample.alpha);
        break;
      case KIND_BASE:
        drawBase(graphics, sample);
        break;
      case KIND_BARRACKS:
        drawBarracks(graphics, sample);
        break;
      case KIND_WORKER:
      case KIND_SOLDIER:
        drawUnit(graphics, sample);
        break;
      default:
        break;
    }
    if (sample.k !== KIND_CRYSTAL) drawHealthBar(graphics, sample);
  }

  if (selected !== undefined && selected.size > 0) {
    drawSelectionRings(graphics, samples, selected);
  }
  if (options.hovered !== undefined && options.hovered !== null) {
    drawHoverRing(graphics, samples, options.hovered);
  }
}

function worldX(tileX: number): number {
  return tileX * TILE_PX;
}

function drawCrystal(
  graphics: Phaser.GameObjects.Graphics,
  tileX: number,
  tileY: number,
  alpha: number,
): void {
  const cx = worldX(tileX);
  const cy = worldX(tileY);
  const size = TILE_PX * 0.36;

  graphics.fillStyle(COLORS.crystal, 0.85 * alpha);
  graphics.beginPath();
  graphics.moveTo(cx, cy - size);
  graphics.lineTo(cx + size, cy);
  graphics.lineTo(cx, cy + size);
  graphics.lineTo(cx - size, cy);
  graphics.closePath();
  graphics.fillPath();

  graphics.lineStyle(2, COLORS.crystalEdge, alpha);
  graphics.beginPath();
  graphics.moveTo(cx, cy - size);
  graphics.lineTo(cx + size, cy);
  graphics.lineTo(cx, cy + size);
  graphics.lineTo(cx - size, cy);
  graphics.closePath();
  graphics.strokePath();
}

function drawUnit(graphics: Phaser.GameObjects.Graphics, sample: SampledEntity): void {
  const cx = worldX(sample.x);
  const cy = worldX(sample.y);
  const radius = unitRadius(sample.k);
  const fill = ownerFill(sample.o);

  graphics.fillStyle(fill, 0.92 * sample.alpha);
  graphics.fillCircle(cx, cy, radius);

  graphics.lineStyle(2, ownerStroke(sample.o), sample.alpha);
  graphics.strokeCircle(cx, cy, radius);

  // Role mark: a worker carries a small bar (its pick), a soldier a spike.
  if (sample.k === KIND_WORKER) {
    graphics.fillStyle(0xffffff, 0.65 * sample.alpha);
    graphics.fillRect(cx - radius * 0.45, cy - 1, radius * 0.9, 2);
  } else {
    graphics.fillStyle(0xffffff, 0.75 * sample.alpha);
    graphics.fillTriangle(cx, cy - radius - 3, cx + radius * 0.5, cy - radius + 3, cx - radius * 0.5, cy - radius + 3);
  }

  // Carried crystal: a small blue dot trailing the worker.
  if (sample.k === KIND_WORKER && sample.carry > 0) {
    graphics.fillStyle(COLORS.crystal, 0.95 * sample.alpha);
    graphics.fillCircle(cx + radius + 3, cy - radius, 3);
  }
}

function drawBase(graphics: Phaser.GameObjects.Graphics, sample: SampledEntity): void {
  const half = TILE_PX * 0.42;
  const x = worldX(sample.x) - half;
  const y = worldX(sample.y) - half;
  const size = half * 2;

  graphics.fillStyle(ownerFill(sample.o), 0.9 * sample.alpha);
  graphics.fillRect(x, y, size, size);
  graphics.lineStyle(2.5, ownerStroke(sample.o), sample.alpha);
  graphics.strokeRect(x, y, size, size);

  // Inner notch: reads as "this is the HQ, not a generic block".
  graphics.fillStyle(0xffffff, 0.25 * sample.alpha);
  graphics.fillRect(x + size * 0.3, y + size * 0.3, size * 0.4, size * 0.4);
}

function drawBarracks(graphics: Phaser.GameObjects.Graphics, sample: SampledEntity): void {
  const half = TILE_PX * 0.44;
  const cx = worldX(sample.x);
  const cy = worldX(sample.y);

  graphics.fillStyle(ownerFill(sample.o), 0.9 * sample.alpha);
  graphics.beginPath();
  graphics.moveTo(cx, cy - half);
  graphics.lineTo(cx + half, cy + half);
  graphics.lineTo(cx - half, cy + half);
  graphics.closePath();
  graphics.fillPath();

  graphics.lineStyle(2.5, ownerStroke(sample.o), sample.alpha);
  graphics.beginPath();
  graphics.moveTo(cx, cy - half);
  graphics.lineTo(cx + half, cy + half);
  graphics.lineTo(cx - half, cy + half);
  graphics.closePath();
  graphics.strokePath();
}

function drawHealthBar(graphics: Phaser.GameObjects.Graphics, sample: SampledEntity): void {
  const maxHp = maxHpFor(sample.k);
  if (maxHp <= 0 || sample.hp >= maxHp) return;

  const width = sample.k === KIND_BASE || sample.k === KIND_BARRACKS ? TILE_PX * 0.9 : TILE_PX * 0.62;
  const height = sample.k === KIND_BASE || sample.k === KIND_BARRACKS ? 4 : 3;
  const cx = worldX(sample.x);
  const cy = worldX(sample.y);
  const top = cy - (sample.k === KIND_WORKER ? TILE_PX * 0.28 : TILE_PX * 0.34) - height - 5;
  const ratio = Math.max(0, Math.min(1, sample.hp / maxHp));

  graphics.fillStyle(COLORS.hpBack, 0.75 * sample.alpha);
  graphics.fillRect(cx - width / 2 - 1, top - 1, width + 2, height + 2);

  const color = ratio > 0.6 ? COLORS.hpGood : ratio > 0.3 ? COLORS.hpWarn : COLORS.hpBad;
  graphics.fillStyle(color, sample.alpha);
  graphics.fillRect(cx - width / 2, top, width * ratio, height);
}

/** Max hp mirrored on the client, keyed by wire kind code. */
export function maxHpFor(kind: number): number {
  switch (kind) {
    case KIND_WORKER:
      return UNIT_STATS.worker.hp;
    case KIND_SOLDIER:
      return UNIT_STATS.soldier.hp;
    case KIND_BASE:
      return BUILDING_STATS.base.hp;
    case KIND_BARRACKS:
      return BUILDING_STATS.barracks.hp;
    default:
      return 0;
  }
}

function drawSelectionRings(
  graphics: Phaser.GameObjects.Graphics,
  samples: readonly SampledEntity[],
  selected: ReadonlySet<string>,
): void {
  graphics.lineStyle(2, COLORS.selection, 0.95);
  for (const sample of samples) {
    if (!selected.has(sample.id)) continue;
    const radius = unitRadius(sample.k) + 4;
    graphics.strokeCircle(worldX(sample.x), worldX(sample.y), radius);
  }
}

function drawHoverRing(
  graphics: Phaser.GameObjects.Graphics,
  samples: readonly SampledEntity[],
  hovered: string,
): void {
  const sample = samples.find((candidate) => candidate.id === hovered);
  if (sample === undefined) return;
  graphics.lineStyle(1.5, COLORS.hover, 0.8);
  const radius = unitRadius(sample.k) + 7;
  graphics.strokeCircle(worldX(sample.x), worldX(sample.y), radius);
}

/**
 * Ghost buildings: remembered enemy structures, drawn faded with a dashed
 * outline (docs/ROADMAP.md B7). Crystals/units never become ghosts.
 */
export function drawGhosts(
  graphics: Phaser.GameObjects.Graphics,
  ghosts: readonly { id: string; kind: 'base' | 'barracks'; x: number; y: number; hpPct: number }[],
  alpha = 0.5,
): void {
  graphics.clear();
  graphics.setDepth(DEPTH.ghosts);

  for (const ghost of ghosts) {
    const cx = worldX(ghost.x + 0.5);
    const cy = worldX(ghost.y + 0.5);
    const half = TILE_PX * 0.42;

    if (ghost.kind === 'base') {
      graphics.fillStyle(COLORS.ghost, 0.12 * alpha);
      graphics.fillRect(cx - half, cy - half, half * 2, half * 2);
      drawDashedRect(graphics, cx - half, cy - half, half * 2, half * 2, alpha);
    } else {
      graphics.fillStyle(COLORS.ghost, 0.1 * alpha);
      graphics.beginPath();
      graphics.moveTo(cx, cy - half);
      graphics.lineTo(cx + half, cy + half);
      graphics.lineTo(cx - half, cy + half);
      graphics.closePath();
      graphics.fillPath();
      graphics.lineStyle(1.5, COLORS.ghost, 0.6 * alpha);
      graphics.beginPath();
      graphics.moveTo(cx, cy - half);
      graphics.lineTo(cx + half, cy + half);
      graphics.lineTo(cx - half, cy + half);
      graphics.closePath();
      graphics.strokePath();
    }
  }
}

/** Dashed rectangle outline, drawn segment by segment. */
export function drawDashedRect(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
  alpha = 1,
  dash = 5,
  gap = 4,
): void {
  graphics.lineStyle(1.5, COLORS.ghost, 0.75 * alpha);
  const segments: [number, number, number, number][] = [
    [x, y, x + width, y],
    [x + width, y, x + width, y + height],
    [x + width, y + height, x, y + height],
    [x, y + height, x, y],
  ];
  for (const [x0, y0, x1, y1] of segments) {
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (length <= 0) continue;
    const ux = (x1 - x0) / length;
    const uy = (y1 - y0) / length;
    let travelled = 0;
    while (travelled < length) {
      const end = Math.min(travelled + dash, length);
      graphics.lineBetween(
        x0 + ux * travelled,
        y0 + uy * travelled,
        x0 + ux * end,
        y0 + uy * end,
      );
      travelled = end + gap;
    }
  }
}

/** Order feedback: a pulsing marker at the destination tile. */
export function drawMoveMarker(
  graphics: Phaser.GameObjects.Graphics,
  tileX: number,
  tileY: number,
  ageMs: number,
): void {
  const life = 600;
  if (ageMs < 0 || ageMs > life) return;
  const progress = ageMs / life;
  const radius = TILE_PX * (0.18 + progress * 0.32);
  graphics.lineStyle(2, COLORS.moveMarker, 1 - progress);
  graphics.strokeCircle((tileX + 0.5) * TILE_PX, (tileY + 0.5) * TILE_PX, radius);
}

/** Selection drag rectangle, drawn in world coordinates. */
export function drawDragRect(
  graphics: Phaser.GameObjects.Graphics,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);

  graphics.fillStyle(COLORS.hover, 0.12);
  graphics.fillRect(x, y, w, h);
  graphics.lineStyle(1.5, COLORS.hover, 0.9);
  graphics.strokeRect(x, y, w, h);
}
