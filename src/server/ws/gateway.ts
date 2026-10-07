/**
 * WebSocket gateway — the ONLY bridge between the browser and the simulation
 * core (docs/SPEC.md §7, §9).
 *
 * Two invariants live here and nowhere else:
 *
 *  1. **Single filtered egress.** Every outbound message is built from
 *     `snapshotForHuman()` / `eventsForHuman()`. There is deliberately no other
 *     code path that serialises game state to a client, so a renderer bug can
 *     never leak an invisible enemy (acceptance B8).
 *  2. **Single execution path.** A `cmd` message does NOT touch state directly:
 *     it is dispatched through `GameLoop.dispatchHumanCommands()`, i.e. the very
 *     same `validateBatch` → `executeAction` pipeline the LLM and the rule AI
 *     use. A modified client gets exactly the authority a legal order has.
 *
 * The gateway is transport-agnostic on purpose: `attach(duplex)` accepts any
 * object with `send` / `on('message')` / `on('close')`. The server passes a real
 * `ws.WebSocket`; `tests/server/gateway.test.ts` passes an in-memory duplex mock,
 * so the whole gateway is testable without opening a port.
 */

import type {
  ClientMessage,
  CommandMessage,
  FogDelta,
  FogInit,
  ServerMessage,
} from '../../shared/protocol';
import type { Action, PlayerId } from '../../shared/types';
import { encodeActionList } from '../../game/actions/schema';
import type { GameLoop } from '../../game/GameLoop';
import { HUMAN_PLAYER } from '../../game/GameLoop';
import { diffFogRows } from '../../game/view/fogCodec';
import { eventsForHuman, fullFogRows, snapshotForHuman } from '../../game/view/snapshot';

/**
 * The human always plays `p1` (blue). Re-exported from the core so there is
 * exactly one declaration of the seat anywhere in the project.
 */
export const HUMAN: PlayerId = HUMAN_PLAYER;

/**
 * Minimal duplex surface the gateway needs from a socket — *not* `ws.WebSocket`
 * so the whole gateway can be exercised against an in-memory mock in Vitest.
 */
export type DuplexListener = (payload?: unknown) => void;

export interface Duplex {
  send(data: string): void;
  on(event: 'message' | 'close' | 'error', listener: DuplexListener): void;
  close?(): void;
}

/** Per-connection state. The fog delta is relative to what THIS client holds. */
interface ClientSession {
  id: number;
  socket: Duplex;
  /** Explored rows already delivered — the baseline for the next fog delta. */
  previousFogRows: string[];
  /** Last snapshot tick sent, used to drop duplicate frames. */
  lastSentTick: number;
  commandSeq: number;
  /** Rejections already reported, so the client log is not spammed. */
  rejectedSeen: number;
  closed: boolean;
}

export interface GatewayOptions {
  /** Called for every dropped client action; the server writes it to the log. */
  onReject?: (info: { clientId: number; reason: string; detail?: string }) => void;
  /** Called when a client sends malformed JSON / an unparsable message. */
  onProtocolError?: (info: { clientId: number; detail: string }) => void;
  /** Emitted whenever a client connects / disconnects (used for server logs). */
  onConnectionChange?: (info: { clientId: number; connected: boolean }) => void;
  /** Hook fired after accepted human actions are enqueued (for replay recording). */
  onHumanCommands?: (actions: Action[], tick: number) => void;
}

/**
 * Routes traffic between sockets and one authoritative `GameLoop`.
 *
 * Ticking is NOT owned here: the server drives the loop with `setInterval` and
 * then calls `broadcastSnapshot()`. That keeps the gateway free of timers and
 * makes it deterministic under test.
 */
export class WsGateway {
  private loop: GameLoop;
  private readonly options: GatewayOptions;
  private readonly sessions = new Map<number, ClientSession>();
  private nextClientId = 1;
  /**
   * Set once the `gameover` frame has been delivered. After that the gateway
   * goes silent for good: a snapshot taken after the match ended carries no new
   * information, and re-sending `gameover` every tick would spam the client.
   */
  private finished = false;

  constructor(loop: GameLoop, options: GatewayOptions = {}) {
    this.loop = loop;
    this.options = options;
  }

  /** Swap the authoritative loop (used by POST /api/restart to begin a fresh match). */
  setLoop(loop: GameLoop): void {
    this.loop = loop;
    this.finished = false;
    // Existing sessions keep their fog baseline, but on next broadcast they'll get a fresh snapshot.
    // Reset their per-session fog so the new map's explored layer is correctly diffed.
    // The next attach will send a new init; live sessions will be force-refreshed on next tick
    // via broadcastSnapshot's fullFogRows diff. Clear baseline to force full resync.
    for (const session of this.sessions.values()) {
      session.previousFogRows = [];
      session.lastSentTick = -1;
    }
  }

  get clientCount(): number {
    return this.sessions.size;
  }

  /** Register a new connection and immediately hand it the `init` message. */
  attach(socket: Duplex): number {
    const clientId = this.nextClientId;
    this.nextClientId += 1;

    const session: ClientSession = {
      id: clientId,
      socket,
      previousFogRows: [],
      lastSentTick: -1,
      commandSeq: 0,
      rejectedSeen: 0,
      closed: false,
    };
    this.sessions.set(clientId, session);

    socket.on('message', (data) => this.handleMessage(session, data));
    socket.on('close', () => this.detach(session));
    socket.on('error', () => this.detach(session));

    this.sendInit(session);
    // A client joining after the match ended must still be told the outcome —
    // `broadcastSnapshot` has already gone quiet by then.
    if (this.finished || this.loop.state.status === 'gameover') {
      this.send(session, {
        t: 'gameover',
        winner: this.loop.state.winner,
        tick: this.loop.state.endTick ?? this.loop.state.tick,
      });
    }
    this.options.onConnectionChange?.({ clientId, connected: true });
    return clientId;
  }

  /** Attach every client in `sessions`-friendly form (tests drive this). */
  detach(session: ClientSession): void {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.id);
    this.options.onConnectionChange?.({ clientId: session.id, connected: false });
  }

  // ── Uplink ────────────────────────────────────────────────────────────────

  private handleMessage(session: ClientSession, data: unknown): void {
    if (session.closed) return;
    const text = typeof data === 'string' ? data : String(data);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.options.onProtocolError?.({ clientId: session.id, detail: 'invalid JSON' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || !('t' in parsed)) {
      this.options.onProtocolError?.({ clientId: session.id, detail: 'missing type tag' });
      return;
    }

    const message = parsed as ClientMessage;
    switch (message.t) {
      case 'ping':
        this.send(session, { t: 'pong', tick: this.loop.state.tick });
        return;
      case 'cmd':
        this.handleCommand(session, message);
        return;
      default:
        this.options.onProtocolError?.({
          clientId: session.id,
          detail: `unknown message type: ${String((message as { t: unknown }).t)}`,
        });
    }
  }

  /**
   * Human orders go through the SAME validator/executor as everything else.
   * Schema failures are rejected here (never silently ignored) and the game
   * keeps running — acceptance B8 / C9 depend on this.
   */
  private handleCommand(session: ClientSession, message: CommandMessage): void {
    const rawActions: unknown[] = Array.isArray(message.actions) ? message.actions : [];
    if (rawActions.length === 0) return;

    const parsed = encodeActionList(rawActions);
    for (const failure of parsed.rejected) {
      this.options.onReject?.({
        clientId: session.id,
        reason: failure.reason,
        detail: failure.detail,
      });
    }
    if (parsed.actions.length === 0) return;

    session.commandSeq = Math.max(session.commandSeq, message.seq);
    if (this.loop.state.status === 'gameover') return;

    const tick = this.loop.state.tick;
    this.loop.dispatchHumanCommands(parsed.actions);
    this.options.onHumanCommands?.(parsed.actions, tick);
  }

  // ── Downlink ──────────────────────────────────────────────────────────────

  /** The `init` frame: map (public), config, first snapshot and full fog mask. */
  private sendInit(session: ClientSession): void {
    const state = this.loop.state;
    const snapshot = snapshotForHuman(state, { includeFog: false });
    session.previousFogRows = fullFogRows(state);
    session.lastSentTick = state.tick;

    const fog: FogInit = { exploredRows: session.previousFogRows };
    this.send(session, {
      t: 'init',
      gameId: state.gameId,
      seed: state.seed,
      map: {
        w: state.terrain.width,
        h: state.terrain.height,
        blockedRows: this.loop.blockedRows(),
      },
      you: 'human',
      tickRate: state.config.tickRate,
      config: { fogEnabled: state.config.fogEnabled, popCap: state.config.popCap },
      snapshot,
      fog,
    });
  }

  /**
   * Called once per simulation tick by the server.
   *
   * Sends `snap` (filtered), `fog` (only when the explored layer grew) and
   * `events` (filtered), then `gameover` once. Every payload is produced here,
   * which is what makes "no bypass" enforceable by inspection.
   */
  broadcastSnapshot(): void {
    if (this.finished) return;
    const state = this.loop.state;
    if (this.sessions.size === 0) return;

    const tick = state.tick;
    const events = eventsForHuman(state, state.events);

    for (const session of this.sessions.values()) {
      if (session.closed) continue;

      const snapshot = snapshotForHuman(state, {
        previousFogRows: session.previousFogRows,
        includeFog: false,
      });

      // Fog deltas are per-client: each session tracks its own baseline, so a
      // late joiner is never sent the growth that happened before it connected.
      const rows = fullFogRows(state);
      const delta: FogDelta = diffFogRows(session.previousFogRows, rows);

      session.previousFogRows = rows;
      session.lastSentTick = tick;

      this.send(session, { t: 'snap', snapshot });
      if (delta.rows.length > 0) this.send(session, { t: 'fog', delta });
      if (events.length > 0) this.send(session, { t: 'events', events });

      // Surface this tick's human-order drops. Validation failures are never
      // silent, but they are reported once per batch, not once per frame.
      for (const reject of state.rejects) {
        if (reject.source !== 'human') continue;
        this.options.onReject?.({
          clientId: session.id,
          reason: reject.reason,
          detail: reject.detail,
        });
      }
    }

    if (state.status === 'gameover') {
      const winner = state.winner;
      for (const session of this.sessions.values()) {
        if (session.closed) continue;
        this.send(session, { t: 'gameover', winner, tick: state.endTick ?? tick });
      }
      // Freeze the loop and go quiet: exactly one `gameover` frame, ever.
      this.loop.markOver();
      this.finished = true;
    }
  }

  /** Push an LLM status blip (used from phase 4; harmless no-op shape now). */
  broadcastLlmStatus(message: Extract<ServerMessage, { t: 'llm' }>): void {
    for (const session of this.sessions.values()) {
      if (session.closed) continue;
      this.send(session, message);
    }
  }

  private send(session: ClientSession, message: ServerMessage): void {
    if (session.closed) return;
    try {
      session.socket.send(JSON.stringify(message));
    } catch {
      this.detach(session);
    }
  }

  /** Close every connection (server shutdown). */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.closed = true;
      try {
        session.socket.close?.();
      } catch {
        // Ignore: the socket is already gone.
      }
    }
    this.sessions.clear();
  }
}

/** Exported for tests: build a command message without importing the schema. */
export function makeCommandMessage(actions: Action[], seq = 1): CommandMessage {
  return { t: 'cmd', actions, seq };
}
