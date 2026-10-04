/**
 * HudScene — DOM HUD updates + the connect/disconnect overlay.
 *
 * The HUD is plain DOM (not canvas text) for three reasons: crisp text at any
 * camera zoom, native accessibility/selection, and zero per-frame cost — the DOM
 * is only touched when a displayed value actually changes.
 *
 * This scene never reads game state directly: it reads {@link WorldModel}, which
 * is fed exclusively by the server. So a HUD number can never disagree with what
 * the player is allowed to know.
 */

import Phaser from 'phaser';
import { GameScene } from './GameScene';
import { KIND_SOLDIER, KIND_WORKER } from '../state/WorldModel';
import type { WorldModel } from '../state/WorldModel';
import { summarizeSelection } from '../input/selection';

/** Staleness above which the HUD warns that snapshots stopped arriving. */
const STALE_WARN_MS = 900;

interface Elements {
  tick: HTMLElement;
  fps: HTMLElement;
  conn: HTMLElement;
  ping: HTMLElement;
  crystal: HTMLElement;
  pop: HTMLElement;
  popBar: HTMLElement;
  fog: HTMLElement;
  seed: HTMLElement;
  chips: HTMLElement;
  events: HTMLElement;
  overlay: HTMLElement;
  overlayTitle: HTMLElement;
  overlayText: HTMLElement;
  spinner: HTMLElement;
  toast: HTMLElement;
}

const CONNECTION_LABEL: Record<WorldModel['connection'], string> = {
  connecting: '连接中',
  open: '已连接',
  closed: '已断开',
  error: '连接错误',
};

export class HudScene extends Phaser.Scene {
  model!: WorldModel;
  /** Injected capability: ask the client to retry the connection now. */
  retryConnection: () => void = () => {};

  private dom!: Elements;
  /** Last rendered values, so the DOM is only written when something changed. */
  private textCache = new Map<string, string>();
  private lastEventCount = 0;
  private lastSelectionKey = '';

  constructor() {
    super({ key: 'hud', active: true });
  }

  create(): void {
    this.dom = {
      tick: requireElement('stat-tick'),
      fps: requireElement('stat-fps'),
      conn: requireElement('stat-conn'),
      ping: requireElement('stat-ping'),
      crystal: requireElement('stat-crystal'),
      pop: requireElement('stat-pop'),
      popBar: requireElement('pop-bar'),
      fog: requireElement('stat-fog'),
      seed: requireElement('stat-seed'),
      chips: requireElement('selection-chips'),
      events: requireElement('event-list'),
      overlay: requireElement('overlay'),
      overlayTitle: requireElement('overlay-title'),
      overlayText: requireElement('overlay-text'),
      spinner: requireElement('overlay-spinner'),
      toast: requireElement('toast'),
    };

    // A click anywhere on the overlay retries the connection — the fastest path
    // from "server restarted" back into the match.
    this.dom.overlay.addEventListener('click', () => this.retryConnection());

    this.refreshSelection([], true);
  }

  override update(): void {
    const model = this.model;
    const game = this.scene.get('game') as GameScene;
    const now = performance.now();

    this.setText('tick', String(model.tick));
    this.setText('fps', model.fps > 0 ? String(model.fps) : '–');

    const stale = model.connection === 'open' && model.lastSnapshotAt > 0 && model.staleness(now) > STALE_WARN_MS;
    this.setText('conn', stale ? '卡顿' : CONNECTION_LABEL[model.connection]);
    this.setClass('conn', stale ? 'value warn' : model.connection === 'open' ? 'value' : 'value bad');

    this.setText('ping', game !== undefined && game.scene.isActive() ? '–' : '–');
    this.setText('crystal', String(model.crystal));
    this.setText('pop', `${model.pop} / ${model.popCap}`);
    this.setText('seed', String(model.seed));

    const cap = model.popCap > 0 ? model.popCap : 1;
    const ratio = Math.max(0, Math.min(1, model.pop / cap));
    this.setStyle('pop-bar', 'width', `${(ratio * 100).toFixed(1)}%`);

    if (game !== undefined) {
      this.setText('fog', `${Math.round(game.exploredRatio * 100)}%`);
    }

    this.refreshSelection(game?.selectionIds ?? []);
    this.refreshEvents();
    this.refreshOverlay(model);
  }

  // ── DOM helpers (write-on-change) ─────────────────────────────────────────

  private setText(key: string, value: string): void {
    if (this.textCache.get(key) === value) return;
    this.textCache.set(key, value);
    const element = this.dom[key as keyof Elements];
    if (element !== undefined) element.textContent = value;
  }

  private setClass(key: string, value: string): void {
    const classNameKey = `${key}::class`;
    if (this.textCache.get(classNameKey) === value) return;
    this.textCache.set(classNameKey, value);
    const element = this.dom[key as keyof Elements];
    if (element !== undefined) element.className = value;
  }

  private setStyle(key: string, property: string, value: string): void {
    const styleKey = `${key}::${property}`;
    if (this.textCache.get(styleKey) === value) return;
    this.textCache.set(styleKey, value);
    const element = this.dom[key as keyof Elements];
    if (element !== undefined) element.style.setProperty(property, value);
  }

  private refreshSelection(selection: readonly string[], force = false): void {
    const key = [...selection].sort().join(',');
    if (!force && key === this.lastSelectionKey) return;
    this.lastSelectionKey = key;

    if (selection.length === 0) {
      this.dom.chips.innerHTML = '<span class="hint">未选中单位</span>';
      return;
    }

    const game = this.scene.get('game') as GameScene | undefined;
    const samples = game?.sampledEntities ?? [];
    const summary = summarizeSelection(
      samples.filter((sample) => sample.k === KIND_WORKER || sample.k === KIND_SOLDIER),
      new Set(selection),
    );

    const parts: string[] = [];
    if (summary.workers > 0) parts.push(`<span class="chip">工人 × ${summary.workers}</span>`);
    if (summary.soldiers > 0) parts.push(`<span class="chip">士兵 × ${summary.soldiers}</span>`);
    const unknown = selection.length - summary.total;
    if (unknown > 0) parts.push(`<span class="chip">未知 × ${unknown}</span>`);
    if (parts.length === 0) parts.push('<span class="hint">未选中单位</span>');

    this.dom.chips.innerHTML = parts.join('');
  }

  private refreshEvents(): void {
    // Recent-event list is rebuilt only when the tail changed; events are capped
    // at 40 in the model, so the render list stays short.
    const events = this.model.recentEvents;
    if (events.length === this.lastEventCount) return;
    this.lastEventCount = events.length;

    const tail = events.slice(-6).reverse();
    this.dom.events.innerHTML = tail
      .map((event) => `<li><span class="t">[${event.tick}]</span> ${describeEvent(event)}</li>`)
      .join('');
  }

  private refreshOverlay(model: WorldModel): void {
    const shouldShow =
      model.connection === 'connecting' || model.connection === 'closed' || model.connection === 'error';
    const hidden = this.dom.overlay.hasAttribute('hidden');
    if (shouldShow && hidden) this.dom.overlay.removeAttribute('hidden');
    if (!shouldShow && !hidden) this.dom.overlay.setAttribute('hidden', '');

    if (!shouldShow) {
      if (model.status === 'gameover') this.showResult(model);
      return;
    }

    this.dom.spinner.style.display = '';
    const title =
      model.connection === 'connecting'
        ? '正在连接服务器…'
        : model.connection === 'error'
          ? '连接出错'
          : '已断开连接';
    const text =
      model.connection === 'connecting'
        ? '若长时间无响应，请确认已运行 <code>npm run dev</code>'
        : '点击此处重新连接（服务器重启后会自动重试）';
    if (this.dom.overlayTitle.textContent !== title) this.dom.overlayTitle.textContent = title;
    if (this.dom.overlayText.innerHTML !== text) this.dom.overlayText.innerHTML = text;
  }

  private showResult(model: WorldModel): void {
    this.dom.spinner.style.display = 'none';
    const title =
      model.winner === null ? '平局' : model.winner === 'p1' ? '胜利！' : '战败';
    const text =
      model.winner === null
        ? '双方基地同时被摧毁或超时未分胜负。'
        : model.winner === 'p1'
          ? '敌方基地已被摧毁。'
          : '我方基地已被摧毁。';
    if (this.dom.overlayTitle.textContent !== title) this.dom.overlayTitle.textContent = title;
    if (this.dom.overlayText.textContent !== text) this.dom.overlayText.textContent = text;
  }

  /** Floating message, auto-removed by CSS animation. */
  showToast(message: string): void {
    const node = document.createElement('div');
    node.textContent = message;
    this.dom.toast.appendChild(node);
    setTimeout(() => node.remove(), 2400);
  }
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`HudScene: missing HUD element #${id}`);
  return element;
}

/** One-line human description of a game event. */
function describeEvent(event: { type: string; amount?: number; owner?: string }): string {
  switch (event.type) {
    case 'damage':
      return '受到攻击';
    case 'death':
      return '单位阵亡';
    case 'built':
      return '建筑完工';
    case 'trained':
      return '训练完成';
    case 'harvest':
      return event.amount === undefined ? '采集水晶' : `采集 +${Math.round(event.amount)}`;
    case 'arrive':
      return '抵达目标';
    case 'attack':
      return '发起攻击';
    case 'gameover':
      return '对局结束';
    default:
      return event.type;
  }
}
