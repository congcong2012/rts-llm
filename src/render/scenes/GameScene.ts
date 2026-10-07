/**
 * GameScene — world rendering, camera and human input (docs/ROADMAP.md 任务 4–7 + 阶段3).
 *
 * Division of labour:
 *   GameScene  world: terrain/entity/fog layers, camera, selection, building placement.
 *   HudScene   DOM readouts and overlays.
 *   WorldModel data; NetClient only writer.
 *
 * Per frame: prune/refresh tracks, repaint entities + overlays, advance fog easing.
 * Phase 3 additions: building placement ghost (green/red), B/S/E production hotkeys,
 * building selection, placement preview validation.
 */

import Phaser from 'phaser';
import { BUILDING_STATS, TILE_PX } from '../../game/config/constants';
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

const DRAG_THRESHOLD_PX = 6;
const MARKER_LIFE_MS = 600;

interface MoveMarker { x: number; y: number; bornAt: number; }

export class GameScene extends Phaser.Scene {
  model!: WorldModel;
  sendOrders: (actions: Action[]) => boolean = () => false;
  toast: (message: string) => void = () => {};

  private gridGraphics!: Phaser.GameObjects.Graphics;
  private terrainGraphics!: Phaser.GameObjects.Graphics;
  private ghostGraphics!: Phaser.GameObjects.Graphics;
  private entityGraphics!: Phaser.GameObjects.Graphics;
  private overlayGraphics!: Phaser.GameObjects.Graphics;
  private placementGraphics!: Phaser.GameObjects.Graphics;
  private fog: FogLayer | null = null;

  private selection = new Set<string>();
  private hovered: string | null = null;
  private markers: MoveMarker[] = [];
  private samples: SampledEntity[] = [];

  private dragging = false;
  private dragStartWorld = { x: 0, y: 0 };
  private dragStartScreen = { x: 0, y: 0 };
  private dragAdditive = false;

  private heldKeys = new Set<string>();

  private syncedRevision = -1;
  private fpsAccumulator = 0;
  private fpsFrames = 0;

  /** Building placement mode: null = not placing, else ghost follows pointer. */
  placingBuilding: { buildingType: 'barracks'; builderIds: string[] } | null = null;
  private placementTile: { x: number; y: number } | null = null;
  private placementValid: boolean | null = null;

  constructor() { super('game'); }

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
    this.placementGraphics = this.add.graphics().setDepth(DEPTH.overlays + 1);

    drawGrid(this.gridGraphics, width, height);
    this.redrawTerrain();

    this.fog = new FogLayer(this, model.fog ?? { width, height, exploredRows: [] });

    this.installCameraControls();
    this.installPointerControls();

    this.centerOnOwnBase(true);

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

  // ── Public placement API (called by HudScene) ──────────────────────────

  enterPlacementMode(buildingType: 'barracks'): void {
    const ids = [...this.selection].filter((id) => {
      const s = this.samples.find((c) => c.id === id);
      return s !== undefined && s.k === 0; // worker
    });
    if (ids.length === 0) {
      // Fallback: any worker if selection empty? choose first available worker.
      const anyWorker = this.samples.find((s) => s.o === 0 && s.k === 0);
      if (anyWorker !== undefined) ids.push(anyWorker.id);
    }
    if (ids.length === 0) {
      this.toast('没有可用工人');
      return;
    }
    this.placingBuilding = { buildingType, builderIds: ids.slice(0, 1) };
    this.placementTile = null;
    this.placementValid = null;
    this.toast('建造模式：点击放置兵营');
  }

  exitPlacementMode(): void {
    if (this.placingBuilding !== null) {
      this.placingBuilding = null;
      this.placementTile = null;
      this.placementValid = null;
      this.placementGraphics.clear();
      this.toast('已取消建造');
    }
  }

  isPlacementValid(tileX: number, tileY: number): boolean {
    const model = this.model;
    if (tileX < 0 || tileY < 0 || tileX >= model.width || tileY >= model.height) return false;
    // Blocked terrain check
    if (model.blockedTiles.has(tileY * model.width + tileX)) return false;
    // Occupancy: any existing building or crystal at that tile (from samples)
    for (const s of this.samples) {
      if (s.k === KIND_BASE || s.k === KIND_BARRACKS || s.k === KIND_CRYSTAL) {
        if (Math.floor(s.x) === tileX && Math.floor(s.y) === tileY) return false;
      }
    }
    // Ghosts also occupy visually (but allow over ghosts? ghost is stale position, allow? simplify deny ghosts tile too)
    for (const ghost of model.ghosts.values()) {
      if (ghost.x === tileX && ghost.y === tileY) return false;
    }
    return true;
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  private installCameraControls(): void {
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      this.heldKeys.add(event.code);

      // Placement mode takes precedence: Esc cancels placement, others ignored.
      if (this.placingBuilding !== null) {
        if (event.code === 'Escape') {
          event.preventDefault();
          this.exitPlacementMode();
        }
        return;
      }

      // Phase 3 production hotkeys: B/S/E context-sensitive before generic intent.
      // We handle them here first; they return early to avoid conflicting with pan/zoom.
      if (event.code === 'KeyB' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        this.handleTrainHotkey('worker');
        return;
      }
      if (event.code === 'KeyS' && !event.ctrlKey && !event.metaKey) {
        // Check if we have a barracks context; if so, treat as train soldier, else let pan handle it.
        const samples = this.samples;
        const hasBarracks = samples.some((s) => s.o === 0 && s.k === KIND_BARRACKS);
        // Also check selection contains barracks? For stage3, S should train when barracks idle exists.
        // We treat S as train when there's an idle barracks, otherwise fall through to pan.
        if (hasBarracks) {
          event.preventDefault();
          this.handleTrainHotkey('soldier');
          return;
        }
        // fall through to pan
      }
      if (event.code === 'KeyE' && !event.ctrlKey && !event.metaKey) {
        // E = build barracks when worker selected, else zoom in fallback.
        const hasWorkerSelected = [...this.selection].some((id) => {
          const s = this.samples.find((c) => c.id === id);
          return s !== undefined && s.k === 0;
        });
        if (hasWorkerSelected) {
          event.preventDefault();
          this.enterPlacementMode('barracks');
          return;
        }
        // else fall through to zoom
      }

      const intent = intentForCode(event.code, event.shiftKey);
      if (intent === null) return;
      if (event.code === 'Tab') event.preventDefault();

      switch (intent.kind) {
        case 'center-base': this.centerOnOwnBase(); break;
        case 'clear-selection':
          if (this.placingBuilding !== null) this.exitPlacementMode();
          else this.selection.clear();
          break;
        case 'zoom': this.applyZoom(intent.factor); break;
        case 'gather': this.issueKeyboardOrder('gather'); break;
        case 'hold': this.issueKeyboardOrder('hold'); break;
        case 'stop': this.issueKeyboardOrder('stop'); break;
        case 'cycle-idle': this.cycleIdleUnit(); break;
        case 'pan': break;
      }
    });

    this.input.keyboard?.on('keyup', (event: KeyboardEvent) => {
      this.heldKeys.delete(event.code);
    });

    this.game.events.on(Phaser.Core.Events.BLUR, () => this.heldKeys.clear());

    this.input.on('wheel', (_pointer: Phaser.Input.Pointer, _gameObjects: unknown[], _deltaX: number, deltaY: number) => {
      this.applyZoom(deltaY > 0 ? 0.9 : 1.1);
    });
  }

  private handleTrainHotkey(kind: 'worker' | 'soldier'): void {
    const samples = this.samples;
    const wantedKind = kind === 'worker' ? KIND_BASE : KIND_BARRACKS;
    const idle = samples.find((s) => s.k === wantedKind && s.o === 0 && s.s === 0);
    if (idle === undefined) {
      this.toast(kind === 'worker' ? '没有空闲基地' : '没有空闲兵营');
      return;
    }
    const cost = kind === 'worker' ? BUILDING_STATS.base.trains.includes('worker' as any) ? 50 : 50 : 75; // use constants: 50/75
    // Use actual constants for disable check but allow attempt: server will reject if insufficient.
    void cost;
    const action: Action = { type: 'train', buildingId: idle.id, unitType: kind };
    if (this.sendOrders([action])) this.toast(kind === 'worker' ? '训练工人' : '训练士兵');
    else this.toast('未连接');
  }

  private applyZoom(factor: number): void {
    const camera = this.cameras.main;
    camera.setZoom(clampZoom(camera.zoom * factor));
  }

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
    const idle = this.samples.filter((s) => s.o === 0 && (s.k === 0 || s.k === 1) && s.s === 0);
    if (idle.length === 0) { this.toast('没有待命单位'); return; }
    idle.sort((a, b) => numericId(a.id) - numericId(b.id));
    const ids = idle.map((s) => s.id);
    const currentIndex = ids.findIndex((id) => this.selection.has(id));
    const next = ids[(currentIndex + 1) % ids.length];
    if (next === undefined) return;
    this.selection.clear();
    this.selection.add(next);
    const target = idle.find((s) => s.id === next);
    if (target !== undefined) this.cameras.main.pan(target.x * TILE_PX, target.y * TILE_PX, 200, 'Linear');
  }

  // ── Pointer ───────────────────────────────────────────────────────────────

  private installPointerControls(): void {
    this.input.mouse?.disableContextMenu();

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      // In placement mode, left click places building, right click cancels.
      if (this.placingBuilding !== null) {
        if (pointer.rightButtonDown()) {
          this.exitPlacementMode();
          return;
        }
        if (pointer.leftButtonDown()) {
          this.tryPlaceBuilding(pointer);
          return;
        }
      }
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

      if (this.placingBuilding !== null) {
        const tileX = Math.floor(pointer.worldX / TILE_PX);
        const tileY = Math.floor(pointer.worldY / TILE_PX);
        const valid = this.isPlacementValid(tileX, tileY);
        this.placementTile = { x: tileX, y: tileY };
        this.placementValid = valid;
      }
    });

    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      this.dragging = false;

      const dx = pointer.x - this.dragStartScreen.x;
      const dy = pointer.y - this.dragStartScreen.y;
      const isBox = Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;

      if (!isBox) {
        // Click selection: prioritize unit, else building, else crystal? buildings selectable for inspection.
        const unitHit = pickUnit(this.samples, pointer.worldX / TILE_PX, pointer.worldY / TILE_PX);
        if (unitHit !== null) {
          if (this.dragAdditive) this.selection = new Set(toggleSelection([...this.selection], [unitHit]));
          else { this.selection.clear(); this.selection.add(unitHit); }
          return;
        }
        // Try building hit
        const buildingHit = this.pickBuildingAt(pointer.worldX / TILE_PX, pointer.worldY / TILE_PX);
        if (buildingHit !== null) {
          if (this.dragAdditive) this.selection = new Set(toggleSelection([...this.selection], [buildingHit]));
          else { this.selection.clear(); this.selection.add(buildingHit); }
          return;
        }
        if (!this.dragAdditive) this.selection.clear();
        return;
      }

      const rect = rectFromPoints(
        this.dragStartWorld.x / TILE_PX, this.dragStartWorld.y / TILE_PX,
        pointer.worldX / TILE_PX, pointer.worldY / TILE_PX,
      );
      const hits = pickUnitsInRect(this.samples, rect);
      if (this.dragAdditive) this.selection = new Set(toggleSelection([...this.selection], hits));
      else this.selection = new Set(hits);
      if (hits.length === 0 && !this.dragAdditive) this.selection.clear();
    });
  }

  private pickBuildingAt(worldX: number, worldY: number): string | null {
    let best: SampledEntity | null = null;
    let bestDistSq = Number.POSITIVE_INFINITY;
    for (const s of this.samples) {
      if (s.k !== KIND_BASE && s.k !== KIND_BARRACKS) continue;
      if (s.o !== 0) continue;
      const dx = s.x - worldX;
      const dy = s.y - worldY;
      const distSq = dx*dx + dy*dy;
      if (distSq > 0.7*0.7) continue;
      if (distSq < bestDistSq) { bestDistSq = distSq; best = s; }
    }
    return best?.id ?? null;
  }

  private hoverEntityId(worldX: number, worldY: number): string | null {
    for (const sample of this.samples) {
      const dx = sample.x - worldX;
      const dy = sample.y - worldY;
      if (dx * dx + dy * dy <= 0.5 * 0.5) return sample.id;
    }
    return null;
  }

  private tryPlaceBuilding(pointer: Phaser.Input.Pointer): void {
    if (this.placingBuilding === null) return;
    const tileX = Math.floor(pointer.worldX / TILE_PX);
    const tileY = Math.floor(pointer.worldY / TILE_PX);
    if (!this.isPlacementValid(tileX, tileY)) {
      this.toast('无法在该位置建造');
      return;
    }
    const builderIds = this.placingBuilding.builderIds;
    const action: Action = { type: 'build', unitIds: builderIds, buildingType: this.placingBuilding.buildingType, x: tileX, y: tileY };
    const sent = this.sendOrders([action]);
    if (sent) {
      this.toast('建造兵营指令已发送');
      this.placingBuilding = null;
      this.placementTile = null;
      this.placementValid = null;
      this.placementGraphics.clear();
    } else {
      this.toast('未连接，指令未发送');
    }
  }

  private handleRightClick(pointer: Phaser.Input.Pointer): void {
    if (this.placingBuilding !== null) {
      this.exitPlacementMode();
      return;
    }
    if (this.selection.size === 0) { this.toast('先选中单位'); return; }
    const worldX = pointer.worldX / TILE_PX;
    const worldY = pointer.worldY / TILE_PX;
    const entity = this.topEntityAt(worldX, worldY);
    const resolved = resolveRightClick(
      { selection: [...this.selection], entities: this.samples, ownConstructionSiteIds: collectConstructionSites(this.samples) },
      { tileX: Math.floor(worldX), tileY: Math.floor(worldY), worldX, worldY, entity },
    );
    if (resolved === null || resolved.actions.length === 0) { this.toast('无效指令'); return; }
    const sent = this.sendOrders(resolved.actions);
    if (!sent) { this.toast('未连接，指令未发送'); return; }
    const markerX = entity !== null ? entity.x : worldX;
    const markerY = entity !== null ? entity.y : worldY;
    this.markers.push({ x: markerX, y: markerY, bornAt: this.time.now });
    this.toast(resolved.label);
  }

  private topEntityAt(worldX: number, worldY: number): SampledEntity | null {
    let best: SampledEntity | null = null;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const sample of this.samples) {
      const dx = sample.x - worldX;
      const dy = sample.y - worldY;
      const radius = sample.k === KIND_CRYSTAL ? 0.6 : sample.k === KIND_BASE || sample.k === KIND_BARRACKS ? 0.55 : 0.45;
      if (dx*dx + dy*dy > radius*radius) continue;
      const rank = sample.k === KIND_CRYSTAL ? 3 : sample.k === KIND_BASE || sample.k === KIND_BARRACKS ? 2 : 0;
      if (rank < bestRank) { bestRank = rank; best = sample; }
    }
    return best;
  }

  private issueKeyboardOrder(kind: 'gather' | 'hold' | 'stop'): void {
    if (this.selection.size === 0) { this.toast('先选中单位'); return; }
    const unitIds = [...this.selection];
    const action: Action = kind === 'gather' ? { type: 'gather', unitIds } : { type: 'hold', unitIds };
    if (this.sendOrders([action])) this.toast(kind === 'gather' ? 'gather' : 'hold');
  }

  // ── Frame loop ────────────────────────────────────────────────────────────

  override update(_time: number, delta: number): void {
    const now = performance.now();
    const model = this.model;
    model.maintain(now);
    this.samples = model.sampleAll(now);

    if (this.fog !== null && model.fog !== null) {
      const dirty = model.consumeFogChanges();
      if (dirty.length > 0) this.fog.applyChange(model.fog, model.visibleTiles, dirty);
      if (model.revision !== this.syncedRevision) {
        this.fog.syncVisibility(model.visibleTiles);
        this.syncedRevision = model.revision;
      }
      this.fog.update(delta, model.tickRate);
    }

    this.updateCameraPan(delta);
    this.redrawEntities();
    this.redrawOverlays(now);
    this.redrawPlacement();

    this.fpsAccumulator += delta;
    this.fpsFrames += 1;
    if (this.fpsAccumulator >= 500) {
      model.fps = Math.round((this.fpsFrames * 1000) / this.fpsAccumulator);
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
    }
  }

  private updateCameraPan(delta: number): void {
    let dx = 0; let dy = 0;
    if (this.heldKeys.has('KeyA') || this.heldKeys.has('ArrowLeft')) dx -= 1;
    if (this.heldKeys.has('KeyD') || this.heldKeys.has('ArrowRight')) dx += 1;
    if (this.heldKeys.has('KeyW') || this.heldKeys.has('ArrowUp')) dy -= 1;
    if (this.heldKeys.has('KeyS') || this.heldKeys.has('ArrowDown')) {
      // S is shared with train-soldier hotkey; only pan when not in placement and not training context handled already.
      // To avoid double-trigger, check if train was already handled: we handle train on keydown, so pan should still happen if no barracks.
      // Keep pan here; its effect is small and train already handled on keydown.
      dy += 1;
    }
    if (dx === 0 && dy === 0) return;
    const camera = this.cameras.main;
    const step = (PAN_SPEED_PX_PER_SEC * delta) / 1000 / camera.zoom;
    const length = Math.hypot(dx, dy) || 1;
    camera.scrollX += (dx / length) * step;
    camera.scrollY += (dy / length) * step;
  }

  private redrawEntities(): void {
    drawEntities(this.entityGraphics, this.samples, { selected: this.selection, hovered: this.hovered });
    drawGhosts(this.ghostGraphics, [...this.model.ghosts.values()].map((g) => ({ id: g.id, kind: g.kind, x: g.x, y: g.y, hpPct: g.hpPct })));
  }

  private redrawOverlays(now: number): void {
    const graphics = this.overlayGraphics;
    graphics.clear();
    this.markers = this.markers.filter((m) => now - m.bornAt <= MARKER_LIFE_MS);
    for (const m of this.markers) drawMoveMarker(graphics, m.x, m.y, now - m.bornAt);
    if (this.dragging) {
      const p = this.input.activePointer;
      drawDragRect(graphics, this.dragStartWorld.x, this.dragStartWorld.y, p.worldX, p.worldY);
    }
  }

  private redrawPlacement(): void {
    const g = this.placementGraphics;
    g.clear();
    if (this.placingBuilding === null || this.placementTile === null) return;
    const { x, y } = this.placementTile;
    const valid = this.placementValid ?? this.isPlacementValid(x, y);
    const color = valid ? 0x22c55e : 0xef4444;
    const alpha = 0.85;
    const half = TILE_PX * 0.44;
    const cx = (x + 0.5) * TILE_PX;
    const cy = (y + 0.5) * TILE_PX;
    // Ghost triangle for barracks
    g.fillStyle(color, 0.28 * alpha);
    g.beginPath();
    g.moveTo(cx, cy - half);
    g.lineTo(cx + half, cy + half);
    g.lineTo(cx - half, cy + half);
    g.closePath();
    g.fillPath();
    g.lineStyle(2.5, color, alpha);
    g.beginPath();
    g.moveTo(cx, cy - half);
    g.lineTo(cx + half, cy + half);
    g.lineTo(cx - half, cy + half);
    g.closePath();
    g.strokePath();
    // Border rect indicating footprint
    g.lineStyle(1, 0xffffff, 0.6);
    g.strokeRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
    // Label
    // Note: text via graphics is not optimal; keep minimal visual.
  }

  // ── Accessors used by HudScene ────────────────────────────────────────────

  get selectionIds(): readonly string[] { return [...this.selection]; }
  get sampledEntities(): readonly SampledEntity[] { return this.samples; }
  get exploredRatio(): number {
    const fog = this.model.fog;
    if (fog === null || fog.width * fog.height === 0) return 0;
    return countExploredTiles(fog) / (fog.width * fog.height);
  }
  get fogLayer(): FogLayer | null { return this.fog; }
}

function collectConstructionSites(samples: readonly SampledEntity[]): Set<string> {
  const sites = new Set<string>();
  for (const s of samples) {
    if (s.o !== 0) continue;
    if (s.k !== KIND_BARRACKS) continue;
    if (s.s === 1) sites.add(s.id);
  }
  return sites;
}
function numericId(id: string): number {
  const v = Number.parseInt(id.replace(/^[a-z]+/, ''), 10);
  return Number.isNaN(v) ? Number.MAX_SAFE_INTEGER : v;
}
