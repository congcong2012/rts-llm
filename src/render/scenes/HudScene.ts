/**
 * HudScene — DOM HUD updates + the connect/disconnect & gameover overlay.
 *
 * Phase 3 additions (ROADMAP.md):
 *  - Selected-entity details (HP / state / task / queue / build progress)
 *  - Production buttons (train worker/soldier, build barracks, gather, hold) with
 *    resource / pop / limit gating (greyed when disabled) and keyboard shortcuts
 *  - Pop-cap warning, training / construction progress bars
 *  - Game-over result panel with tick count and "Play again" button
 *  - Placement-mode hint banner
 *
 * The HUD stays DOM-only: crisp at any zoom, zero per-frame canvas cost.
 * It reads exclusively from WorldModel; only NetClient/GameScene writes into it.
 */

import Phaser from 'phaser';
import { BUILDING_STATS, UNIT_STATS } from '../../game/config/constants';
import { GameScene } from './GameScene';
import { KIND_BARRACKS, KIND_BASE, KIND_SOLDIER, KIND_WORKER } from '../state/WorldModel';
import type { WorldModel } from '../state/WorldModel';
import { summarizeSelection } from '../input/selection';

const STALE_WARN_MS = 900;

const UNIT_STATE_LABEL: Record<number, string> = {
  0: '待命',
  1: '移动中',
  2: '采集',
  3: '攻击',
  4: '建造',
  5: '防守',
};
const BUILDING_STATE_LABEL: Record<number, string> = {
  0: '空闲',
  1: '建造中',
  2: '训练中',
};

const CONNECTION_LABEL: Record<WorldModel['connection'], string> = {
  connecting: '连接中',
  open: '已连接',
  closed: '已断开',
  error: '连接错误',
};

interface Elements {
  tick: HTMLElement;
  fps: HTMLElement;
  conn: HTMLElement;
  ping: HTMLElement;
  crystal: HTMLElement;
  pop: HTMLElement;
  popBar: HTMLElement;
  popWarn: HTMLElement;
  fog: HTMLElement;
  seed: HTMLElement;
  chips: HTMLElement;
  details: HTMLElement;
  events: HTMLElement;
  overlay: HTMLElement;
  overlayTitle: HTMLElement;
  overlayText: HTMLElement;
  overlayStats: HTMLElement;
  overlayActions: HTMLElement;
  spinner: HTMLElement;
  toast: HTMLElement;
  btnWorker: HTMLButtonElement;
  btnSoldier: HTMLButtonElement;
  btnBarracks: HTMLButtonElement;
  btnGather: HTMLButtonElement;
  btnHold: HTMLButtonElement;
  queueBox: HTMLElement;
  queueBar: HTMLElement;
  queueLabel: HTMLElement;
  buildBox: HTMLElement;
  buildBar: HTMLElement;
  buildLabel: HTMLElement;
  placementHint: HTMLElement;
  btnRestart: HTMLButtonElement;
  btnCopyReplay: HTMLButtonElement;
}

export class HudScene extends Phaser.Scene {
  model!: WorldModel;
  retryConnection: () => void = () => {};

  private dom!: Elements;
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
      popWarn: requireElement('pop-warn'),
      fog: requireElement('stat-fog'),
      seed: requireElement('stat-seed'),
      chips: requireElement('selection-chips'),
      details: requireElement('selection-details'),
      events: requireElement('event-list'),
      overlay: requireElement('overlay'),
      overlayTitle: requireElement('overlay-title'),
      overlayText: requireElement('overlay-text'),
      overlayStats: requireElement('overlay-stats'),
      overlayActions: requireElement('overlay-actions'),
      spinner: requireElement('overlay-spinner'),
      toast: requireElement('toast'),
      btnWorker: requireElement('btn-train-worker') as HTMLButtonElement,
      btnSoldier: requireElement('btn-train-soldier') as HTMLButtonElement,
      btnBarracks: requireElement('btn-build-barracks') as HTMLButtonElement,
      btnGather: requireElement('btn-gather') as HTMLButtonElement,
      btnHold: requireElement('btn-hold') as HTMLButtonElement,
      queueBox: requireElement('production-queue'),
      queueBar: requireElement('queue-bar'),
      queueLabel: requireElement('queue-label'),
      buildBox: requireElement('build-progress'),
      buildBar: requireElement('build-bar'),
      buildLabel: requireElement('build-label'),
      placementHint: requireElement('placement-hint'),
      btnRestart: requireElement('btn-restart') as HTMLButtonElement,
      btnCopyReplay: requireElement('btn-copy-replay') as HTMLButtonElement,
    };

    // Overlay click on background retries, but buttons stop propagation.
    this.dom.overlay.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('#overlay-actions')) return;
      if ((e.target as HTMLElement).closest('.card') !== null && this.model.status !== 'gameover') {
        // Only retry when not gameover; gameover cards shouldn't dismiss on click.
        return;
      }
      if (this.model.status === 'gameover') return;
      this.retryConnection();
    });
    this.dom.btnRestart.addEventListener('click', () => {
      // Simplest "play again": reload the page — the server will be reaped on demand
      // or, if still frozen after gameover, a reload still shows the result.
      // For a seamless restart we try /api/restart first (if the server exposes it).
      fetch('/api/restart', { method: 'POST' }).catch(() => {}).finally(() => {
        location.reload();
      });
    });
    this.dom.btnCopyReplay.addEventListener('click', async () => {
      const id = this.model.gameId || 'unknown';
      try {
        await navigator.clipboard.writeText(id);
        this.showToast(`回放ID已复制: ${id}`);
      } catch {
        this.showToast(`回放ID: ${id}`);
      }
    });

    // Production button handlers — delegate to GameScene's order sender.
    this.dom.btnWorker.addEventListener('click', () => this.handleTrain('worker'));
    this.dom.btnSoldier.addEventListener('click', () => this.handleTrain('soldier'));
    this.dom.btnBarracks.addEventListener('click', () => this.handleBuildBarracks());
    this.dom.btnGather.addEventListener('click', () => this.handleGather());
    this.dom.btnHold.addEventListener('click', () => this.handleHold());

    this.refreshSelection([], true);
  }

  override update(): void {
    const model = this.model;
    const game = this.scene.get('game') as GameScene | undefined;
    const now = performance.now();

    this.setText('tick', String(model.tick));
    this.setText('fps', model.fps > 0 ? String(model.fps) : '–');

    const stale = model.connection === 'open' && model.lastSnapshotAt > 0 && model.staleness(now) > STALE_WARN_MS;
    this.setText('conn', stale ? '卡顿' : CONNECTION_LABEL[model.connection]);
    this.setClass('conn', stale ? 'value warn' : model.connection === 'open' ? 'value' : 'value bad');
    this.setText('ping', '–');
    this.setText('crystal', String(model.crystal));
    this.setText('pop', `${model.pop} / ${model.popCap}`);
    this.setText('seed', String(model.seed));

    const cap = model.popCap > 0 ? model.popCap : 1;
    const ratio = Math.max(0, Math.min(1, model.pop / cap));
    this.setStyle('pop-bar', 'width', `${(ratio * 100).toFixed(1)}%`);

    // Pop-cap warning
    this.dom.popWarn.style.display = model.pop >= model.popCap ? '' : 'none';

    if (game !== undefined) {
      this.setText('fog', `${Math.round(game.exploredRatio * 100)}%`);
    }

    this.refreshSelection(game?.selectionIds ?? []);
    this.refreshProduction();
    this.refreshEvents();
    this.refreshOverlay(model);
    this.refreshPlacementHint(game);
  }

  // ── Production ──────────────────────────────────────────────────────────

  private handleTrain(kind: 'worker' | 'soldier'): void {
    const game = this.scene.get('game') as GameScene | undefined;
    if (game === undefined) return;
    const samples = game.sampledEntities;
    const isWorker = kind === 'worker';
    const wantedKind = isWorker ? KIND_BASE : KIND_BARRACKS;
    // Find an idle building of the right kind that can train this unit.
    const candidates = samples.filter((s) => s.k === wantedKind && s.o === 0 && s.s === 0);
    if (candidates.length === 0) {
      this.showToast(isWorker ? '没有空闲基地' : '没有空闲兵营');
      return;
    }
    // Prefer the first one (deterministic: samples already sorted by id).
    const target = candidates[0]!;
    const action = { type: 'train' as const, buildingId: target.id, unitType: kind };
    if (game.sendOrders([action])) this.showToast(isWorker ? '训练工人…' : '训练士兵…');
    else this.showToast('未连接，指令未发送');
  }

  private handleBuildBarracks(): void {
    const game = this.scene.get('game') as GameScene | undefined;
    if (game === undefined) return;
    const selection = game.selectionIds;
    // Need at least one worker capable of building (idle/holding/gathering).
    const samples = game.sampledEntities;
    const byId = new Map(samples.map((s) => [s.id, s]));
    let hasCapable = false;
    for (const id of selection) {
      const s = byId.get(id);
      if (s === undefined) continue;
      if (s.k !== KIND_WORKER) continue;
      if (s.s === 0 || s.s === 5 || s.s === 2) hasCapable = true;
    }
    if (!hasCapable) {
      const workerCount = samples.filter((s) => s.k === KIND_WORKER && s.o === 0).length;
      if (workerCount === 0) this.showToast('没有工人可建造');
      else this.showToast('请先选中空闲工人');
      return;
    }
    if (this.model.crystal < BUILDING_STATS.barracks.cost) {
      this.showToast(`水晶不足 (需${BUILDING_STATS.barracks.cost})`);
      return;
    }
    const barracksCount = samples.filter((s) => s.k === KIND_BARRACKS && s.o === 0).length;
    // Ghosts are remodelled barracks remembered but not visible — don't count them for limit;
    // count only live buildings from samples. For safety also check model? But samples is fine.
    if (barracksCount >= (BUILDING_STATS.barracks.limit || 99)) {
      this.showToast('兵营已达上限 (2)');
      return;
    }
    game.enterPlacementMode('barracks');
    this.showToast('进入建造模式：点击地图放置兵营');
  }

  private handleGather(): void {
    const game = this.scene.get('game') as GameScene | undefined;
    if (game === undefined) return;
    const ids = [...game.selectionIds];
    if (ids.length === 0) { this.showToast('先选中单位'); return; }
    const action = { type: 'gather' as const, unitIds: ids };
    if (game.sendOrders([action])) this.showToast('采集');
    else this.showToast('未连接');
  }

  private handleHold(): void {
    const game = this.scene.get('game') as GameScene | undefined;
    if (game === undefined) return;
    const ids = [...game.selectionIds];
    if (ids.length === 0) { this.showToast('先选中单位'); return; }
    const action = { type: 'hold' as const, unitIds: ids };
    if (game.sendOrders([action])) this.showToast('原地待命');
    else this.showToast('未连接');
  }

  private refreshProduction(): void {
    const game = this.scene.get('game') as GameScene | undefined;
    const model = this.model;
    const samples = game?.sampledEntities ?? [];
    const crystal = model.crystal;
    const pop = model.pop;
    const popCap = model.popCap;

    // Find idle base / barracks and count barracks.
    let hasIdleBase = false;
    let hasIdleBarracks = false;
    let barracksCount = 0;
    let activeTraining: { qp: number; queue: string[] } | null = null;
    let activeBuilding: { bp: number; bt: number } | null = null;

    for (const s of samples) {
      if (s.o !== 0) continue;
      if (s.k === KIND_BASE && s.s === 0) hasIdleBase = true;
      if (s.k === KIND_BARRACKS) {
        barracksCount += 1;
        if (s.s === 0) hasIdleBarracks = true;
      }
      if (s.k === KIND_BASE || s.k === KIND_BARRACKS) {
        if (s.s === 2 && s.queue !== undefined && s.qp !== undefined) {
          // Training
          if (activeTraining === null) activeTraining = { qp: s.qp, queue: s.queue };
        }
        if (s.s === 1 && s.bp !== undefined && s.bt !== undefined) {
          if (activeBuilding === null) activeBuilding = { bp: s.bp, bt: s.bt };
        }
      }
    }

    const canWorker = hasIdleBase && crystal >= UNIT_STATS.worker.cost && pop < popCap;
    const canSoldier = hasIdleBarracks && crystal >= UNIT_STATS.soldier.cost && pop < popCap;
    const workersSelected = (() => {
      if (game === undefined) return 0;
      const set = new Set(game.selectionIds);
      let c = 0;
      for (const s of samples) if (set.has(s.id) && s.k === KIND_WORKER) c++;
      return c;
    })();
    const canBarracks = crystal >= BUILDING_STATS.barracks.cost && barracksCount < (BUILDING_STATS.barracks.limit || 99) && workersSelected > 0;
    const canGather = workersSelected > 0;
    const canHold = game !== undefined && game.selectionIds.length > 0;

    // Also surface pop-cap reason: even if base idle, training is blocked.
    const workerBlockedByPop = hasIdleBase && crystal >= UNIT_STATS.worker.cost && pop >= popCap;
    const soldierBlockedByPop = hasIdleBarracks && crystal >= UNIT_STATS.soldier.cost && pop >= popCap;

    this.dom.btnWorker.disabled = !canWorker;
    this.dom.btnSoldier.disabled = !canSoldier;
    this.dom.btnBarracks.disabled = !canBarracks;
    this.dom.btnGather.disabled = !canGather;
    this.dom.btnHold.disabled = !canHold;

    // Tooltips reflect blocking reason for stage-3 acceptance C3/C4.
    this.dom.btnWorker.title = workerBlockedByPop ? `人口已满 (${pop}/${popCap})` : canWorker ? '基地训练工人 (B) 成本50' : hasIdleBase ? `水晶不足 (需50)` : '没有空闲基地';
    this.dom.btnSoldier.title = soldierBlockedByPop ? `人口已满 (${pop}/${popCap})` : canSoldier ? '兵营训练士兵 (S) 成本75' : hasIdleBarracks ? `水晶不足 (需75)` : '没有空闲兵营';
    this.dom.btnBarracks.title = barracksCount >= 2 ? '兵营已达上限 (2)' : canBarracks ? '工人建造兵营 (E) 成本150' : workersSelected === 0 ? '请先选中工人' : crystal < 150 ? `水晶不足 (需150)` : '不可建造';

    // Progress bars
    if (activeTraining !== null) {
      const kind = activeTraining.queue[0] as 'worker' | 'soldier' | undefined;
      const total = kind !== undefined ? UNIT_STATS[kind].trainTicks : 60;
      const pct = Math.max(0, Math.min(100, (activeTraining.qp / total) * 100));
      this.dom.queueBox.style.display = '';
      this.dom.queueBar.style.width = `${pct.toFixed(1)}%`;
      this.dom.queueLabel.textContent = kind !== undefined ? `训练 ${kind} ${Math.round(pct)}%` : `训练中 ${Math.round(pct)}%`;
    } else {
      this.dom.queueBox.style.display = 'none';
    }
    if (activeBuilding !== null) {
      const pct = Math.max(0, Math.min(100, (activeBuilding.bp / Math.max(1, activeBuilding.bt)) * 100));
      this.dom.buildBox.style.display = '';
      this.dom.buildBar.style.width = `${pct.toFixed(1)}%`;
      this.dom.buildLabel.textContent = `建造中 ${Math.round(pct)}%`;
    } else {
      this.dom.buildBox.style.display = 'none';
    }

    void workerBlockedByPop;
    void soldierBlockedByPop;
    void canBarracks;
  }

  private refreshPlacementHint(game: GameScene | undefined): void {
    const placing = game?.placingBuilding !== null;
    if (placing) this.dom.placementHint.classList.add('show');
    else this.dom.placementHint.classList.remove('show');
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────

  private setText(key: string, value: string): void {
    if (this.textCache.get(key) === value) return;
    this.textCache.set(key, value);
    const el = this.dom[key as keyof Elements];
    if (el !== undefined) (el as HTMLElement).textContent = value;
  }

  private setClass(key: string, value: string): void {
    const k = `${key}::class`;
    if (this.textCache.get(k) === value) return;
    this.textCache.set(k, value);
    const el = this.dom[key as keyof Elements];
    if (el !== undefined) (el as HTMLElement).className = value;
  }

  private setStyle(key: string, property: string, value: string): void {
    const k = `${key}::${property}`;
    if (this.textCache.get(k) === value) return;
    this.textCache.set(k, value);
    const el = this.dom[key as keyof Elements];
    if (el !== undefined) (el as HTMLElement).style.setProperty(property, value);
  }

  private refreshSelection(selection: readonly string[], force = false): void {
    const key = [...selection].sort().join(',');
    if (!force && key === this.lastSelectionKey) return;
    this.lastSelectionKey = key;

    if (selection.length === 0) {
      this.dom.chips.innerHTML = '<span class="hint">未选中单位</span>';
      this.dom.details.innerHTML = '';
      return;
    }
    const game = this.scene.get('game') as GameScene | undefined;
    const samples = game?.sampledEntities ?? [];
    const byId = new Map(samples.map((s) => [s.id, s]));
    const summary = summarizeSelection(
      samples.filter((s) => s.k === KIND_WORKER || s.k === KIND_SOLDIER),
      new Set(selection),
    );
    const parts: string[] = [];
    if (summary.workers > 0) parts.push(`<span class="chip">工人 × ${summary.workers}</span>`);
    if (summary.soldiers > 0) parts.push(`<span class="chip">士兵 × ${summary.soldiers}</span>`);
    const unknown = selection.length - summary.total;
    if (unknown > 0) parts.push(`<span class="chip">未知 × ${unknown}</span>`);
    if (parts.length === 0) parts.push('<span class="hint">未选中单位</span>');
    this.dom.chips.innerHTML = parts.join('');

    // Details of first selected entity (or building if sampled as such).
    const firstId = selection[0]!;
    const first = byId.get(firstId) ?? samples.find((s) => s.id === firstId);
    if (first !== undefined) {
      const hpLabel = first.k === KIND_WORKER || first.k === KIND_SOLDIER || first.k === KIND_BASE || first.k === KIND_BARRACKS
        ? `HP ${first.hp}/${kindMaxHp(first.k)}`
        : '';
      const stateLabel = first.k === KIND_WORKER || first.k === KIND_SOLDIER
        ? UNIT_STATE_LABEL[first.s] ?? `s${first.s}`
        : first.k === KIND_BASE || first.k === KIND_BARRACKS
          ? BUILDING_STATE_LABEL[first.s] ?? `s${first.s}`
          : '';
      const task = first.task !== undefined ? `任务 ${first.task}` : '';
      const carry = first.carry !== undefined && first.carry > 0 ? `携带 ${first.carry}` : '';
      const queue = first.queue !== undefined ? `队列 ${first.queue.join(',')} ${(first.qp ?? 0)}t` : '';
      const build = first.bp !== undefined ? `建造 ${first.bp}/${first.bt ?? '?'}` : '';
      const rows: string[] = [];
      if (hpLabel.length > 0) rows.push(`<span><strong>${hpLabel}</strong></span>`);
      if (stateLabel.length > 0) rows.push(`<span>${stateLabel}</span>`);
      if (task.length > 0) rows.push(`<span>${task}</span>`);
      if (carry.length > 0) rows.push(`<span>${carry}</span>`);
      if (queue.length > 0) rows.push(`<span>${queue}</span>`);
      if (build.length > 0) rows.push(`<span>${build}</span>`);
      const pos = `位置 (${first.x.toFixed(1)}, ${first.y.toFixed(1)})`;
      rows.push(`<span>${pos}</span>`);
      this.dom.details.innerHTML = `<div class="detail-row">${rows.join(' · ')}</div>`;
    } else {
      this.dom.details.innerHTML = '';
    }
  }

  private refreshEvents(): void {
    const events = this.model.recentEvents;
    if (events.length === this.lastEventCount) return;
    this.lastEventCount = events.length;
    const tail = events.slice(-6).reverse();
    this.dom.events.innerHTML = tail.map((e) => `<li><span class="t">[${e.tick}]</span> ${describeEvent(e)}</li>`).join('');
  }

  private refreshOverlay(model: WorldModel): void {
    const isGameover = model.status === 'gameover';
    const isConnecting = model.connection === 'connecting' || model.connection === 'closed' || model.connection === 'error';

    if (isGameover) {
      // Gameover takes precedence over connectivity overlay.
      this.dom.overlay.removeAttribute('hidden');
      this.dom.spinner.style.display = 'none';
      this.dom.overlayActions.style.display = '';
      this.dom.overlayStats.style.display = '';
      const title = model.winner === null ? '平局' : model.winner === 'p1' ? '胜利！' : '战败';
      const text = model.winner === null
        ? '双方基地同时被摧毁或超时未分胜负。'
        : model.winner === 'p1' ? '敌方基地已被摧毁。' : '我方基地已被摧毁。';
      if (this.dom.overlayTitle.textContent !== title) this.dom.overlayTitle.textContent = title;
      if (this.dom.overlayText.textContent !== text) this.dom.overlayText.textContent = text;
      this.dom.overlayStats.innerHTML = `<div>tick <strong>${model.tick}</strong> · 水晶 <strong>${model.crystal}</strong> · 人口 <strong>${model.pop}/${model.popCap}</strong> · 种子 <strong>${model.seed}</strong></div><div style="margin-top:4px">回放ID <code>${model.gameId}</code></div>`;
      return;
    }

    if (isConnecting) {
      this.dom.overlay.removeAttribute('hidden');
      this.dom.spinner.style.display = '';
      this.dom.overlayActions.style.display = 'none';
      this.dom.overlayStats.style.display = 'none';
      const title = model.connection === 'connecting' ? '正在连接服务器…' : model.connection === 'error' ? '连接出错' : '已断开连接';
      const text = model.connection === 'connecting'
        ? '若长时间无响应，请确认已运行 <code>npm run dev</code>'
        : '点击此处重新连接（服务器重启后会自动重试）';
      if (this.dom.overlayTitle.textContent !== title) this.dom.overlayTitle.textContent = title;
      if (this.dom.overlayText.innerHTML !== text) this.dom.overlayText.innerHTML = text;
      return;
    }

    // Running & connected: hide overlay.
    if (!this.dom.overlay.hasAttribute('hidden')) this.dom.overlay.setAttribute('hidden', '');
  }

  showToast(message: string): void {
    const node = document.createElement('div');
    node.textContent = message;
    this.dom.toast.appendChild(node);
    setTimeout(() => node.remove(), 2400);
  }
}

function requireElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`HudScene: missing HUD element #${id}`);
  return el;
}

function kindMaxHp(k: number): number {
  switch (k) {
    case KIND_WORKER: return UNIT_STATS.worker.hp;
    case KIND_SOLDIER: return UNIT_STATS.soldier.hp;
    case KIND_BASE: return BUILDING_STATS.base.hp;
    case KIND_BARRACKS: return BUILDING_STATS.barracks.hp;
    default: return 0;
  }
}

function describeEvent(event: { type: string; amount?: number }): string {
  switch (event.type) {
    case 'damage': return '受到攻击';
    case 'death': return '单位阵亡';
    case 'built': return '建筑完工';
    case 'trained': return '训练完成';
    case 'harvest': return event.amount === undefined ? '采集水晶' : `采集 +${Math.round(event.amount)}`;
    case 'arrive': return '抵达目标';
    case 'attack': return '发起攻击';
    case 'gameover': return '对局结束';
    default: return event.type;
  }
}
