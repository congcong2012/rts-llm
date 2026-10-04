/**
 * Static world drawing: grid + rocks (docs/ROADMAP.md 阶段 2 任务 5).
 *
 * Zero assets by design — everything is a `Graphics` primitive, so the build has
 * no image/sprite dependency and every colour comes from {@link COLORS}.
 *
 * Terrain is PUBLIC information (it is identical for both players and the server
 * sends it whole in `init`), so the rock layer is drawn once and never touched
 * again. Only the entity, ghost and fog layers are redrawn per frame.
 */

import Phaser from 'phaser';
import { TILE_PX } from '../../game/config/constants';

export const COLORS = {
  background: 0x05070c,
  gridLine: 0x1b2433,
  gridLineMajor: 0x27354a,
  rock: 0x3f4a5a,
  rockEdge: 0x5a6b82,
  crystal: 0x38bdf8,
  crystalEdge: 0x7dd3fc,
  crystalDepleted: 0x475569,
  human: 0x3b82f6,
  humanDark: 0x1d4ed8,
  llm: 0xef4444,
  llmDark: 0x991b1b,
  hpBack: 0x111827,
  hpGood: 0x22c55e,
  hpWarn: 0xf59e0b,
  hpBad: 0xef4444,
  selection: 0xfacc15,
  ghost: 0x94a3b8,
  fogBlack: 0x000000,
  /** Alpha of the "explored but not visible" dim layer (acceptance B7). */
  fogExploredAlpha: 0.45,
  /** Alpha of the "currently watched" brightening layer. */
  fogVisibleAlpha: 0.18,
  hover: 0x93c5fd,
  moveMarker: 0x60a5fa,
} as const;

/** Render order. Higher depth draws later (Phaser convention). */
export const DEPTH = {
  terrain: 0,
  crystals: 10,
  selection: 20,
  ghosts: 30,
  entities: 40,
  overlays: 50,
  fog: 60,
  fogTransition: 61,
} as const;

/** Draw the 64×64 grid plus the map border. Called once. */
export function drawGrid(
  graphics: Phaser.GameObjects.Graphics,
  width: number,
  height: number,
): void {
  const w = width * TILE_PX;
  const h = height * TILE_PX;

  graphics.lineStyle(1, COLORS.gridLine, 0.55);
  for (let x = 0; x <= width; x += 1) graphics.lineBetween(x * TILE_PX, 0, x * TILE_PX, h);
  for (let y = 0; y <= height; y += 1) graphics.lineBetween(0, y * TILE_PX, w, y * TILE_PX);

  // Every 8th line is brighter: a scale reference that survives zooming out.
  graphics.lineStyle(1, COLORS.gridLineMajor, 0.9);
  for (let x = 0; x <= width; x += 8) graphics.lineBetween(x * TILE_PX, 0, x * TILE_PX, h);
  for (let y = 0; y <= height; y += 8) graphics.lineBetween(0, y * TILE_PX, w, y * TILE_PX);

  graphics.lineStyle(2, COLORS.gridLineMajor, 1);
  graphics.strokeRect(0, 0, w, h);
}

/** Rocks: every blocked terrain tile, as a slightly inset rounded block. */
export function drawTerrain(
  graphics: Phaser.GameObjects.Graphics,
  width: number,
  height: number,
  blockedTiles: ReadonlySet<number>,
): void {
  const inset = Math.max(1, TILE_PX * 0.08);

  for (const index of blockedTiles) {
    const tx = index % width;
    const ty = Math.floor(index / width);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;

    const x = tx * TILE_PX;
    const y = ty * TILE_PX;

    graphics.fillStyle(COLORS.rock, 1);
    graphics.fillRoundedRect(x + inset, y + inset, TILE_PX - inset * 2, TILE_PX - inset * 2, 5);
    graphics.lineStyle(1.5, COLORS.rockEdge, 0.85);
    graphics.strokeRoundedRect(x + inset, y + inset, TILE_PX - inset * 2, TILE_PX - inset * 2, 5);
  }
}
