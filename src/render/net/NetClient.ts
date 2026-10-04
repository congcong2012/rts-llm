/**
 * WebSocket client (docs/ROADMAP.md 阶段 2 任务 8).
 *
 * Owns the connection, the outgoing command queue and the incoming message
 * dispatch into {@link WorldModel}. Everything it sends is an *order request*;
 * the authoritative result comes back as the next snapshot.
 *
 * Reconnect policy: exponential backoff starting at 500 ms up to 5 s. A game is
 * a single long-lived session, so a reconnect re-reads the full `init` frame
 * (fresh fog mask + snapshot) — the client never tries to patch state itself.
 */

import type { ClientMessage, CommandMessage, ServerMessage } from '../../shared/protocol';
import type { Action } from '../../shared/types';
import type { WorldModel } from '../state/WorldModel';

export interface NetClientOptions {
  /** Override the WS endpoint. Defaults to `ws(s)://<host>/ws` (proxied by Vite). */
  url?: string;
  /** Called after every applied message, for HUD/debug counters. */
  onMessage?: (message: ServerMessage) => void;
  onStatusChange?: (status: WorldModel['connection']) => void;
}

/** Backoff schedule for reconnects, in ms. */
export const RECONNECT_DELAYS_MS = [500, 1000, 2000, 3000, 5000];

export class NetClient {
  private readonly model: WorldModel;
  private readonly options: NetClientOptions;
  private socket: WebSocket | null = null;
  private seq = 0;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Round-trip latency of the last ping, in ms (0 = unknown). */
  lastPingMs = 0;

  constructor(model: WorldModel, options: NetClientOptions = {}) {
    this.model = model;
    this.options = options;
  }

  get url(): string {
    if (this.options.url !== undefined) return this.options.url;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  }

  connect(): void {
    this.closedByUser = false;
    this.setStatus('connecting');

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.setStatus('open');
      this.startPing();
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      this.handleMessage(event.data);
    });

    socket.addEventListener('close', () => {
      this.stopPing();
      this.socket = null;
      if (this.closedByUser) {
        this.setStatus('closed');
        return;
      }
      this.setStatus('closed');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      this.setStatus('error');
      // `close` always follows `error`; the reconnect is scheduled there.
    });
  }

  disconnect(): void {
    this.closedByUser = true;
    this.stopPing();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setStatus('closed');
  }

  /** Queue a validated batch of orders. Returns false when offline. */
  sendActions(actions: Action[]): boolean {
    if (actions.length === 0) return true;
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;

    this.seq += 1;
    const message: CommandMessage = { t: 'cmd', actions, seq: this.seq };
    socket.send(JSON.stringify(message satisfies ClientMessage));
    return true;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || !('t' in parsed)) return;
    const message = parsed as ServerMessage;

    switch (message.t) {
      case 'init':
        this.model.applyInit(message);
        break;
      case 'snap':
        this.model.applySnapshot(message.snapshot, nowMs());
        break;
      case 'fog':
        this.model.applyFogDelta(message.delta, nowMs());
        break;
      case 'events':
        this.model.applyEvents(message.events);
        break;
      case 'gameover':
        this.model.status = 'gameover';
        this.model.winner = message.winner;
        break;
      case 'llm':
        this.model.lastLlmStatus = message.status;
        this.model.lastLlmLatencyMs = message.latencyMs ?? 0;
        break;
      case 'pong':
        this.lastPingMs = Math.max(0, nowMs() - this.lastPingSentAt);
        break;
      default:
        return;
    }

    this.options.onMessage?.(message);
  }

  private lastPingSentAt = 0;

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (socket === null || socket.readyState !== WebSocket.OPEN) return;
      this.lastPingSentAt = nowMs();
      socket.send(JSON.stringify({ t: 'ping' } satisfies ClientMessage));
    }, 2000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 5000;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setStatus(status: WorldModel['connection']): void {
    if (this.model.connection === status) return;
    this.model.connection = status;
    this.options.onStatusChange?.(status);
  }
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}
