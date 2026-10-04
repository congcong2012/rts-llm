/**
 * Fog of war rendering (docs/ROADMAP.md 阶段 2 任务 6).
 *
 * Technique: one 1-pixel-per-tile canvas texture (`width × height` pixels, so
 * 64×64) displayed as an `Image` scaled up by `TILE_PX` with nearest-neighbour
 * sampling. Painting fog therefore costs one `fillRect` per *tile*, not per
 * screen pixel, and the browser does the upscaling on the GPU.
 *
 * The alpha of a tile is driven by three states (see `fogMask.ts`):
 *   unexplored 1.00 · explored 0.45 · visible now 0.00
 *
 * Reveal transition: each tile eases from its old alpha to its new alpha over
 * `REVEAL_TICKS`. Only rows containing a tile whose alpha is still moving get
 * repainted, so a full-map repaint happens only when the whole map changes at
 * once (which never happens after `init`).
 *
 * Efficiency contract (acceptance B9/B11): on a normal tick the dirty set is a
 * handful of rows, and the per-tick cost is a few dozen `fillRect` calls.
 */

import Phaser from 'phaser';
import { TILE_PX } from '../../game/config/constants';
import type { FogMask } from './fogMask';
import {
  EXPLORED_ALPHA,
  UNEXPLORED_ALPHA,
  VISIBLE_ALPHA,
  advanceAlpha,
  isRowBitSet,
  revealSpanMs,
} from './fogMask';
import { DEPTH } from '../draw/terrain';

export interface FogLayerOptions {
  /** Texture key; must be unique per Phaser game instance. */
  key?: string;
  /** Depth of the fog image. */
  depth?: number;
  /** Alpha step below which a tile counts as settled. */
  settleEpsilon?: number;
  /** Disable the reveal easing (used by tests / instant-reveal debugging). */
  instant?: boolean;
}

export class FogLayer {
  readonly image: Phaser.GameObjects.Image;

  private readonly scene: Phaser.Scene;
  private readonly canvasTexture: Phaser.Textures.CanvasTexture;
  private readonly context: CanvasRenderingContext2D;
  private readonly width: number;
  private readonly height: number;
  private readonly settleEpsilon: number;
  private readonly instant: boolean;
  private readonly key: string;

  /** Alpha currently painted per tile (row-major). */
  private readonly painted: Float32Array;
  /** Alpha each tile is heading towards. */
  private readonly target: Float32Array;
  /** Tiles whose alpha is still moving, as `tileIndex -> true`. */
  private readonly moving = new Set<number>();
  /** Rows that need a repaint on the next flush. */
  private readonly dirtyRows = new Set<number>();

  /** Counters exposed for the debug overlay / tests. */
  rowsPaintedLastFlush = 0;
  flushes = 0;

  constructor(scene: Phaser.Scene, mask: FogMask, options: FogLayerOptions = {}) {
    this.scene = scene;
    this.width = mask.width;
    this.height = mask.height;
    this.settleEpsilon = options.settleEpsilon ?? 0.004;
    this.instant = options.instant ?? false;
    this.key = options.key ?? `fog-${Math.random().toString(36).slice(2, 8)}`;

    const created = scene.textures.createCanvas(this.key, this.width, this.height);
    if (created === null) throw new Error('FogLayer: could not create the fog canvas texture');
    this.canvasTexture = created;
    this.context = created.getContext();

    this.painted = new Float32Array(this.width * this.height).fill(UNEXPLORED_ALPHA);
    this.target = new Float32Array(this.width * this.height).fill(UNEXPLORED_ALPHA);

    // Paint the initial state (everything the server already revealed) as
    // settled, so joining a match in progress does not replay every reveal.
    this.rebuildFromMask(mask);

    this.image = scene.add
      .image(0, 0, this.key)
      .setOrigin(0, 0)
      .setDepth(options.depth ?? DEPTH.fog)
      .setScale(TILE_PX)
      .setDisplaySize(this.width * TILE_PX, this.height * TILE_PX);

    // Nearest-neighbour keeps tile edges crisp when the 64×64 texture is blown
    // up 32×; linear filtering would blur the fog into a gradient.
    this.image.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
  }

  /** Full state sync: repaint every row and settle every tile. */
  rebuildFromMask(mask: FogMask): void {
    for (let y = 0; y < this.height; y += 1) {
      const row = mask.exploredRows[y];
      for (let x = 0; x < this.width; x += 1) {
        const explored = isRowBitSet(row, x);
        // Unknown "visible" state on a rebuild: treat explored as dim.
        const alpha = explored ? EXPLORED_ALPHA : UNEXPLORED_ALPHA;
        const index = y * this.width + x;
        this.painted[index] = alpha;
        this.target[index] = alpha;
      }
      this.dirtyRows.add(y);
    }
    this.moving.clear();
    this.flush();
  }

  /**
   * Apply a changed explored mask. `visible` is the current "clear" tile mask.
   *
   * Only the rows listed in `dirty` plus the rows where visibility changed are
   * marked for repainting; everything else keeps its painted pixels.
   */
  applyChange(mask: FogMask, visible: Uint8Array | null, dirtyRows: readonly number[]): void {
    for (const y of dirtyRows) {
      if (y < 0 || y >= this.height) continue;
      const row = mask.exploredRows[y];
      for (let x = 0; x < this.width; x += 1) {
        if (!isRowBitSet(row, x)) continue;
        const index = y * this.width + x;
        if (this.target[index] !== UNEXPLORED_ALPHA) continue;
        this.target[index] = nextTargetAlpha(visible, index);
        this.moving.add(index);
        this.dirtyRows.add(y);
      }
    }
  }

  /** Re-derive every tile's target alpha from visibility (called per snapshot). */
  syncVisibility(visible: Uint8Array | null): void {
    for (let y = 0; y < this.height; y += 1) {
      const base = y * this.width;
      for (let x = 0; x < this.width; x += 1) {
        const index = base + x;
        if (this.target[index] === UNEXPLORED_ALPHA) continue; // still unknown
        const next = nextTargetAlpha(visible, index);
        if (next === this.target[index]) continue;
        this.target[index] = next;
        this.moving.add(index);
        this.dirtyRows.add(y);
      }
    }
  }

  /**
   * Advance the reveal easing and repaint the rows that moved.
   *
   * The transition is TIME-based (a tile always crosses its full alpha range in
   * exactly `REVEAL_TICKS` ticks) rather than a per-frame exponential lerp. A
   * frame-rate-dependent lerp looks fine at 60 fps but takes twice as long at
   * 30 fps, and never quite reaches the target — which on the vision boundary
   * leaves a permanent faint haze.
   */
  update(deltaMs: number, tickRate: number): void {
    if (this.moving.size > 0) {
      const spanMs = revealSpanMs(tickRate);
      const step = this.instant ? Number.POSITIVE_INFINITY : deltaMs / spanMs;

      for (const index of this.moving) {
        const current = this.painted[index] ?? UNEXPLORED_ALPHA;
        const goal = this.target[index] ?? UNEXPLORED_ALPHA;
        const result = advanceAlpha(current, goal, step, this.settleEpsilon);
        this.painted[index] = result.alpha;
        if (result.done) this.moving.delete(index);
        this.dirtyRows.add(Math.floor(index / this.width));
      }
    }

    this.flush();
  }

  /** Repaint the dirty rows and upload the canvas to the GPU. One pass. */
  private flush(): void {
    if (this.dirtyRows.size === 0) return;
    this.rowsPaintedLastFlush = this.dirtyRows.size;

    for (const y of this.dirtyRows) {
      if (y < 0 || y >= this.height) continue;
      const base = y * this.width;

      // `clearRect` (rather than fillRect with alpha 1) is what makes an alpha of
      // 0 truly transparent — that is the "currently visible" state.
      this.context.clearRect(0, y, this.width, 1);

      // Run-length encode the row: a whole row is usually 1–3 runs (all black,
      // or black + one cleared window), so this is a handful of fillRect calls.
      let runStart = -1;
      let runAlpha = 0;
      for (let x = 0; x < this.width; x += 1) {
        const alpha = this.painted[base + x] ?? UNEXPLORED_ALPHA;
        const drawable = alpha > 0.001;

        if (runStart >= 0 && (!drawable || Math.abs(alpha - runAlpha) > 0.001)) {
          this.paintRun(y, runStart, x - runStart, runAlpha);
          runStart = -1;
        }
        if (runStart < 0 && drawable) {
          runStart = x;
          runAlpha = alpha;
        }
      }
      if (runStart >= 0) this.paintRun(y, runStart, this.width - runStart, runAlpha);
    }

    this.dirtyRows.clear();
    this.canvasTexture.refresh();
    this.flushes += 1;
  }

  private paintRun(y: number, x: number, length: number, alpha: number): void {
    if (length <= 0) return;
    this.context.fillStyle = `rgba(0, 0, 0, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
    this.context.fillRect(x, y, length, 1);
  }

  /** Force every row dirty (debug / after a resize). */
  invalidateAll(): void {
    for (let y = 0; y < this.height; y += 1) this.dirtyRows.add(y);
  }

  /** Number of tiles still animating — exposed for the debug HUD. */
  get movingTileCount(): number {
    return this.moving.size;
  }

  destroy(): void {
    this.image.destroy();
    if (this.scene.textures.exists(this.key)) this.scene.textures.remove(this.key);
  }
}

function nextTargetAlpha(visible: Uint8Array | null, index: number): number {
  if (visible !== null && visible[index] === 1) return VISIBLE_ALPHA;
  return EXPLORED_ALPHA;
}
