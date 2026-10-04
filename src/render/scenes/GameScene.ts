/**
 * GameScene — world rendering, camera and human input (docs/ROADMAP.md 任务 4–7).
 *
 * Division of labour inside the renderer:
 *   GameScene  owns the world: terrain/entity/fog layers, camera, selection.
 *   HudScene   owns the DOM readouts and the connect/disconnect overlay.
 *   WorldModel owns the data; NetClient is the only writer into it.
 *
 * Per frame this scene does exactly three things: prune/refresh the client-side
 * tracks, repaint the entity + overlay graphics from the interpolated samples,
 * and advance the fog easing. Nothing is simulated here.
 */

import Phaser from 'phaser';
import { TILE_PX } from '../../game/config/constants';
import type { Action } from '../../shared/types';
import { DEPTH, drawGrid, drawTerrain } from '../draw/terrain';
import {
  drawDragRect,
  drawEntities,
  drawGhosts,
  drawMoveMarker,
} from '../draw/entities';
import { FogLayer } from '../fog/fogLayer';
import { countExploredTiles } from '../fog/fogMask';
import type { SampledEntity } from '../interp';
import { PICK_RADIUS_TILES, pickUnit, pickUnitsInRect, rectFromPoints, toggleSelection } from '../input/selection';
import { resolveRightClick } from '../input/commands';
import { PAN_SPEED_PX_PER_SEC, clampZoom, intentForCode } from '../input/hotkeys';
import type { WorldModel } from '../state/WorldModel';
import { KIND_BASE, KIND_BARRACKS, KIND_CRYSTAL } from '../state/WorldModel';

/** Drag beyond this many pixels counts as a box-select, not a click. */
const DRAG_THRESHOLD_PX = 6;
/** How long an order marker stays visible. */
const MARKER_LIFE_MS = 600;

interface MoveMarker {
  x: number;
  y: number;
  bornAt: number;
}

export class GameScene extends Phaser.Scene {
  /** Injected by `main.ts` before the scene starts. */
  model!: WorldModel;
  /** Called with a batch of orders; injected by `main.ts` (NetClient). */
  sendOrders: (actions: Action[]) => boolean = () => false;
  /** Called with a short label for the HUD toast. */
  toast: (message: string) => void = () => {};

  private gridGraphics!: Phaser.GameObjects.Graphics;
  private terrainGraphics!: Phaser.GameObjects.Graphics;
  private ghostGraphics!: Phaser.GameObjects.Graphics;
  private entityGraphics!: Phaser.GameObjects.Graphics;
  private overlayGraphics!: Phaser.GameObjects.Graphics;
  private fog: FogLayer | null = null;

  private selection = new Set<string>();
  private hovered: string | null = null;
  private markers: MoveMarker[] = [];
  private samples: SampledEntity[] = [];

  /** Drag-box state. */
  private dragging = false;
  private dragStartWorld = { x: 0, y: 0 };
  private dragStartScreen = { x: 0, y: 0 };
  private dragAdditive = false;

  /** Keys currently held, for smooth camera panning. */
  private heldKeys = new Set<string>();

  /** Snapshot revision last synced into the fog layer. */
  private syncedRevision = -1;
  /** Latest FPS measurement written into the model for the HUD. */
  private fpsAccumulator = 0;
  private fpsFrames = 0;

  constructor() {
    super('game');
  }

  create(): void {
    const model = this.model;
    const width = model.width || 64;
    const height = model.height || 64;
    const worldW = width * TILE_PX;
    const worldH = height * TILE_PX;

    this.cameras.main.setBackgroundColor(0x05070c);
    this.cameras.main.setBounds(0, 0, worldW, worldH);

    this.gridGraphics = this.add.graphics().setDepth(DEPTH.terrain);
    this.terrainGraphics = this.add.graphics().setDepth(DEPTH.terrain + 1);
    this.ghostGraphics = this.add.graphics().setDepth(DEPTH.ghosts);
    this.entityGraphics = this.add.graphics().setDepth(DEPTH.entities);
    this.overlayGraphics = this.add.graphics().setDepth(DEPTH.overlays);

    drawGrid(this.gridGraphics, width, height);
    this.redrawTerrain();

    this.fog = new FogLayer(this, model.fog ?? { width, height, exploredRows: [] });

    this.installCameraControls();
    this.installPointerControls();

    // Start looking at the player's own base rather than the map corner.
    this.centerOnOwnBase(true);

    // Re-draw the static layers as soon as `init` arrives (the scene may boot
    // before the socket is open, in which case width/height are still 0).
    this.game.events.on('world-init', this.onWorldInit, this);
    this.events.once('shutdown', () => {
      this.game.events.off('world-init', this.onWorldInit, this);
      this.fog?.destroy();
      this.fog = null;
    });
  }

  private onWorldInit = (): void => {
    const model = this.model;
    const width = model.width;
    const height = model.height;
    if (width <= 0 || height <= 0) return;

    this.cameras.main.setBounds(0, 0, width * TILE_PX, height * TILE_PX);
    this.gridGraphics.clear();
    this.terrainGraphics.clear();
    drawGrid(this.gridGraphics, width, height);
    this.redrawTerrain();

    this.fog?.destroy();
    this.fog = model.fog === null ? null : new FogLayer(this, model.fog);
    this.syncedRevision = -1;

    this.centerOnOwnBase(true);
  };

  private redrawTerrain(): void {
    if (this.model.width <= 0) return;
    drawTerrain(this.terrainGraphics, this.model.width, this.model.height, this.model.blockedTiles);
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  private installCameraControls(): void {
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      this.heldKeys.add(event.code);

      const intent = intentForCode(event.code, event.shiftKey);
      if (intent === null) return;
      // Let the browser keep Tab's focus behaviour out of the game loop.
      if (event.code === 'Tab') event.preventDefault();

      switch (intent.kind) {
        case 'center-base':
          this.centerOnOwnBase();
          break;
        case 'clear-selection':
          this.selection.clear();
          break;
        case 'zoom':
          this.applyZoom(intent.factor);
          break;
        case 'gather':
          this.issueKeyboardOrder('gather');
          break;
        case 'hold':
          this.issueKeyboardOrder('hold');
          break;
        case 'stop':
          this.issueKeyboardOrder('stop');
          break;
        case 'cycle-idle':
          this.cycleIdleUnit();
          break;
        case 'pan':
          break;
      }
    });

    this.input.keyboard?.on('keyup', (event: KeyboardEvent) => {
      this.heldKeys.delete(event.code);
    });

    // Dropping focus must not leave a key stuck "held".
    this.game.events.on(Phaser.Core.Events.BLUR, () => this.heldKeys.clear());

    this.input.on(
      'wheel',
      (
        _pointer: Phaser.Input.Pointer,
        _gameObjects: unknown[],
        _deltaX: number,
        deltaY: number,
      ) => {
        this.applyZoom(deltaY > 0 ? 0.9 : 1.1);
      },
    );
  }

  private applyZoom(factor: number): void {
    const camera = this.cameras.main;
    camera.setZoom(clampZoom(camera.zoom * factor));
  }

  /**
   * Centre the camera on the player's own base.
   *
   * Reads the position from the world model, NOT from the interpolated samples:
   * this runs at `create()` and again on `world-init`, both of which are before
   * the first render frame has produced any samples. Relying on the samples here
   * left the camera parked at the map centre, with the base off-screen.
   */
  private centerOnOwnBase(snap = false): void {
    const camera = this.cameras.main;
    const base = this.model.ownBase;

    if (base === null) {
      camera.centerOn((this.model.width * TILE_PX) / 2, (this.model.height * TILE_PX) / 2);
      return;
    }

    const x = base.x * TILE_PX;
    const y = base.y * TILE_PX;
    if (snap) camera.centerOn(x, y);
    else camera.pan(x, y, 260, 'Sine.easeInOut');
  }

  private cycleIdleUnit(): void {
    const idle = this.samples.filter(
      (sample) => sample.o === 0 && (sample.k === 0 || sample.k === 1) && sample.s === 0,
    );
    if (idle.length === 0) {
      this.toast('没有待命单位');
      return;
    }
    // Ids are `u<number>`; sorting numerically makes the cycle predictable.
    idle.sort((a, b) => numericId(a.id) - numericId(b.id));
    const ids = idle.map((sample) => sample.id);
    const currentIndex = ids.findIndex((id) => this.selection.has(id));
    const next = ids[(currentIndex + 1) % ids.length];
    if (next === undefined) return;
    this.selection.clear();
    this.selection.add(next);
    const target = idle.find((sample) => sample.id === next);
    if (target !== undefined) this.cameras.main.pan(target.x * TILE_PX, target.y * TILE_PX, 200, 'Linear');
  }

  // ── Pointer ───────────────────────────────────────────────────────────────

  private installPointerControls(): void {
    // Right-click issues orders, so the browser menu must not appear.
    this.input.mouse?.disableContextMenu();

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown()) {
        this.handleRightClick(pointer);
        return;
      }
      if (!pointer.leftButtonDown()) return;
      this.dragging = true;
      this.dragAdditive = pointer.event.shiftKey === true;
      this.dragStartWorld = { x: pointer.worldX, y: pointer.worldY };
      this.dragStartScreen = { x: pointer.x, y: pointer.y };
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      const worldX = pointer.worldX / TILE_PX;
      const worldY = pointer.worldY / TILE_PX;
      this.hovered = pickUnit(this.samples, worldX, worldY, PICK_RADIUS_TILES) ?? this.hoverEntityId(worldX, worldY);
    });

    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      this.dragging = false;

      const dx = pointer.x - this.dragStartScreen.x;
      const dy = pointer.y - this.dragStartScreen.y;
      const isBox = Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;

      if (!isBox) {
        const hit = pickUnit(this.samples, pointer.worldX / TILE_PX, pointer.worldY / TILE_PX);
        if (this.dragAdditive) {
          this.selection = new Set(toggleSelection([...this.selection], hit === null ? [] : [hit]));
        } else if (hit === null) {
          this.selection.clear();
        } else {
          this.selection.clear();
          this.selection.add(hit);
        }
        return;
      }

      const rect = rectFromPoints(
        this.dragStartWorld.x / TILE_PX,
        this.dragStartWorld.y / TILE_PX,
        pointer.worldX / TILE_PX,
        pointer.worldY / TILE_PX,
      );
      const hits = pickUnitsInRect(this.samples, rect);
      if (this.dragAdditive) {
        this.selection = new Set(toggleSelection([...this.selection], hits));
      } else {
        this.selection = new Set(hits);
      }
      if (hits.length === 0 && !this.dragAdditive) this.selection.clear();
    });
  }

  private hoverEntityId(worldX: number, worldY: number): string | null {
    for (const sample of this.samples) {
      const dx = sample.x - worldX;
      const dy = sample.y - worldY;
      if (dx * dx + dy * dy <= 0.5 * 0.5) return sample.id;
    }
    return null;
  }

  private handleRightClick(pointer: Phaser.Input.Pointer): void {
    if (this.selection.size === 0) {
      this.toast('先选中单位');
      return;
    }

    const worldX = pointer.worldX / TILE_PX;
    const worldY = pointer.worldY / TILE_PX;
    const entity = this.topEntityAt(worldX, worldY);

    const resolved = resolveRightClick(
      {
        selection: [...this.selection],
        entities: this.samples,
        ownConstructionSiteIds: collectConstructionSites(this.samples),
      },
      {
        tileX: Math.floor(worldX),
        tileY: Math.floor(worldY),
        worldX,
        worldY,
        entity,
      },
    );

    if (resolved === null || resolved.actions.length === 0) {
      this.toast('无效指令');
      return;
    }

    const sent = this.sendOrders(resolved.actions);
    if (!sent) {
      this.toast('未连接，指令未发送');
      return;
    }

    // Local feedback: the authoritative result still arrives via the snapshot.
    const markerX = entity !== null ? entity.x : worldX;
    const markerY = entity !== null ? entity.y : worldY;
    this.markers.push({ x: markerX, y: markerY, bornAt: this.time.now });
    this.toast(resolved.label);
  }

  /** Topmost entity under the cursor: units first, then buildings, then crystals. */
  private topEntityAt(worldX: number, worldY: number): SampledEntity | null {
    let best: SampledEntity | null = null;
    let bestRank = Number.POSITIVE_INFINITY;

    for (const sample of this.samples) {
      const dx = sample.x - worldX;
      const dy = sample.y - worldY;
      const radius = sample.k === KIND_CRYSTAL ? 0.6 : sample.k === KIND_BASE || sample.k === KIND_BARRACKS ? 0.55 : 0.45;
      if (dx * dx + dy * dy > radius * radius) continue;
      const rank = sample.k === KIND_CRYSTAL ? 3 : sample.k === KIND_BASE || sample.k === KIND_BARRACKS ? 2 : 0;
      if (rank < bestRank) {
        bestRank = rank;
        best = sample;
      }
    }
    return best;
  }

  private issueKeyboardOrder(kind: 'gather' | 'hold' | 'stop'): void {
    if (this.selection.size === 0) {
      this.toast('先选中单位');
      return;
    }
    const unitIds = [...this.selection];
    const action: Action =
      kind === 'gather' ? { type: 'gather', unitIds } : { type: 'hold', unitIds };
    if (this.sendOrders([action])) this.toast(kind === 'gather' ? 'gather' : 'hold');
  }

  // ── Frame loop ────────────────────────────────────────────────────────────

  override update(_time: number, delta: number): void {
    const now = performance.now();
    const model = this.model;

    // 1. Advance interpolation and drop finished fades.
    model.maintain(now);
    this.samples = model.sampleAll(now);

    // 2. Fog: paint newly explored rows, then sync visibility and ease.
    if (this.fog !== null && model.fog !== null) {
      const dirty = model.consumeFogChanges();
      if (dirty.length > 0) this.fog.applyChange(model.fog, model.visibleTiles, dirty);
      if (model.revision !== this.syncedRevision) {
        this.fog.syncVisibility(model.visibleTiles);
        this.syncedRevision = model.revision;
      }
      this.fog.update(delta, model.tickRate);
    }

    // 3. Camera panning from held keys.
    this.updateCameraPan(delta);

    // 4. Repaint.
    this.redrawEntities();
    this.redrawOverlays(now);

    // 5. FPS meter (2 Hz refresh keeps the HUD text stable).
    this.fpsAccumulator += delta;
    this.fpsFrames += 1;
    if (this.fpsAccumulator >= 500) {
      model.fps = Math.round((this.fpsFrames * 1000) / this.fpsAccumulator);
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
    }
  }

  private updateCameraPan(delta: number): void {
    let dx = 0;
    let dy = 0;
    if (this.heldKeys.has('KeyA') || this.heldKeys.has('ArrowLeft')) dx -= 1;
    if (this.heldKeys.has('KeyD') || this.heldKeys.has('ArrowRight')) dx += 1;
    if (this.heldKeys.has('KeyW') || this.heldKeys.has('ArrowUp')) dy -= 1;
    if (this.heldKeys.has('KeyS') || this.heldKeys.has('ArrowDown')) dy += 1;
    if (dx === 0 && dy === 0) return;

    const camera = this.cameras.main;
    // Divide by zoom so panning feels the same at every zoom level.
    const step = (PAN_SPEED_PX_PER_SEC * delta) / 1000 / camera.zoom;
    const length = Math.hypot(dx, dy) || 1;
    camera.scrollX += (dx / length) * step;
    camera.scrollY += (dy / length) * step;
  }

  private redrawEntities(): void {
    drawEntities(this.entityGraphics, this.samples, {
      selected: this.selection,
      hovered: this.hovered,
    });

    drawGhosts(
      this.ghostGraphics,
      [...this.model.ghosts.values()].map((ghost) => ({
        id: ghost.id,
        kind: ghost.kind,
        x: ghost.x,
        y: ghost.y,
        hpPct: ghost.hpPct,
      })),
    );
  }

  private redrawOverlays(now: number): void {
    const graphics = this.overlayGraphics;
    graphics.clear();

    // Order markers age out.
    this.markers = this.markers.filter((marker) => now - marker.bornAt <= MARKER_LIFE_MS);
    for (const marker of this.markers) {
      drawMoveMarker(graphics, marker.x, marker.y, now - marker.bornAt);
    }

    if (this.dragging) {
      const pointer = this.input.activePointer;
      drawDragRect(graphics, this.dragStartWorld.x, this.dragStartWorld.y, pointer.worldX, pointer.worldY);
    }
  }

  // ── Accessors used by HudScene ────────────────────────────────────────────

  get selectionIds(): readonly string[] {
    return [...this.selection];
  }

  get sampledEntities(): readonly SampledEntity[] {
    return this.samples;
  }

  get exploredRatio(): number {
    const fog = this.model.fog;
    if (fog === null || fog.width * fog.height === 0) return 0;
    return countExploredTiles(fog) / (fog.width * fog.height);
  }

  /** Exposed for the debug overlay / tests. */
  get fogLayer(): FogLayer | null {
    return this.fog;
  }
}

/** Own, unfinished barracks count as construction sites for "assist" orders. */
function collectConstructionSites(samples: readonly SampledEntity[]): Set<string> {
  const sites = new Set<string>();
  for (const sample of samples) {
    if (sample.o !== 0) continue;
    if (sample.k !== KIND_BARRACKS) continue;
    // Building state code 1 = 'constructing' (see protocol buildingStateCode).
    if (sample.s === 1) sites.add(sample.id);
  }
  return sites;
}

function numericId(id: string): number {
  const value = Number.parseInt(id.replace(/^[a-z]+/, ''), 10);
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
}
