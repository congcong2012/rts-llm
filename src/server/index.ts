/**
 * HTTP + WebSocket host (docs/SPEC.md §9).
 *
 * Responsibilities, and nothing more:
 *  1. Serve the built renderer (production) and answer `/api/health`.
 *  2. Own the ONE timer that advances the match: `setInterval(TICK_MS)` →
 *     `loop.step()` → `gateway.broadcastSnapshot()`.
 *  3. Register sockets with the gateway.
 *  4. Log every dropped order (and, in phase 4, every LLM request/response).
 *
 * Catch-up policy: if a timing callback is late the server advances at most
 * `MAX_CATCHUP_TICKS` ticks, so a starved process slows game time down instead
 * of spiralling into a CPU-saturated loop.
 *
 * Phase 2 drives the red player with the built-in rule commander so the sandbox
 * is alive and the fog of war has something to reveal; phase 4 replaces that one
 * call with the LLM controller.
 */

import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type Express } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import { RULE_AI_DECIDE_INTERVAL_TICKS, TICK_MS } from '../game/config/constants';
import type { GameLoop } from '../game/GameLoop';
import { createLoop } from '../game/GameLoop';
import { RULE_AI_CONFIG, decide } from '../llm/ruleAi';
import type { Duplex } from './ws/gateway';
import { HUMAN, WsGateway } from './ws/gateway';
import { logger } from './logger';

/** Max ticks executed in one timer callback to avoid a death spiral. */
export const MAX_CATCHUP_TICKS = 3;

export interface ServerOptions {
  port?: number;
  seed?: number;
  /** Path to the built client. Defaults to `dist/`. */
  staticDir?: string;
  /**
   * Drive the red player with the rule commander. Defaults to true; set
   * `OPPONENT=off` (or pass `withOpponent: false`) for a peaceful sandbox where
   * the human can learn the controls without being attacked.
   */
  withOpponent?: boolean;
  /** Silence logs (used by tests). */
  quiet?: boolean;
}

export interface RtsServer {
  app: Express;
  httpServer: Server;
  loop: GameLoop;
  gateway: WsGateway;
  port: number;
  /** Advance the match exactly `n` ticks and broadcast. Used by tests/benches. */
  pump(n?: number): void;
  start(): Promise<number>;
  stop(): Promise<void>;
}

/** Adapt a real `ws` socket to the gateway's transport-agnostic `Duplex`. */
function adaptSocket(socket: WebSocket): Duplex {
  return {
    send: (data: string) => {
      socket.send(data);
    },
    on: (event, listener) => {
      switch (event) {
        case 'message':
          socket.on('message', (raw: unknown) => listener(raw));
          break;
        case 'close':
          socket.on('close', () => listener());
          break;
        case 'error':
          socket.on('error', (error: Error) => listener(error));
          break;
      }
    },
    close: () => {
      socket.close();
    },
  };
}

/** Build (but do not start) the server. `start()` binds the port. */
export function createRtsServer(options: ServerOptions = {}): RtsServer {
  const seed = options.seed ?? Number(process.env.GAME_SEED ?? 12345);
  const quiet = options.quiet ?? false;

  const loop = createLoop({ seed });

  const gateway = new WsGateway(loop, {
    onReject: ({ clientId, reason, detail }) => {
      logger.channel('rejects', { source: 'human', clientId, reason, detail: detail ?? null });
      if (!quiet) logger.warn(`dropped human action (${reason})`, { clientId, detail });
    },
    onProtocolError: ({ clientId, detail }) => {
      logger.channel('rejects', { source: 'protocol', clientId, detail });
      if (!quiet) logger.warn(`protocol error: ${detail}`, { clientId });
    },
    onConnectionChange: ({ clientId, connected }) => {
      if (!quiet) logger.info(connected ? 'client connected' : 'client disconnected', { clientId });
    },
  });

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      gameId: loop.state.gameId,
      seed: loop.state.seed,
      tick: loop.state.tick,
      status: loop.state.status,
      clients: gateway.clientCount,
    });
  });

  const staticDir = resolve(options.staticDir ?? 'dist');
  if (existsSync(staticDir)) app.use(express.static(staticDir));

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (socket: WebSocket) => {
    gateway.attach(adaptSocket(socket));
  });

  const opponentEnabled = options.withOpponent ?? process.env.OPPONENT !== 'off';

  /** One authoritative advance: plan (periodically), tick, then fan out. */
  const pump = (n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      if (loop.isOver) break;

      // The commander re-plans on a fixed cadence, never every tick: a decision
      // is expensive (it enumerates the legal set) and 20 ticks is the contract
      // shared with the LLM (LLM_DECIDE_INTERVAL_TICKS).
      if (opponentEnabled && loop.state.tick % RULE_AI_DECIDE_INTERVAL_TICKS === 0) {
        const decision = decide(loop.state, 'p2', RULE_AI_CONFIG);
        for (const action of decision.actions) {
          loop.state.pending.push({
            owner: 'p2',
            action,
            source: 'rule',
            issuedAt: loop.state.tick,
          });
        }
      }

      loop.step();
      gateway.broadcastSnapshot();
    }
  };

  let timer: NodeJS.Timeout | null = null;
  let nextTickAt = 0;

  const start = (): Promise<number> =>
    new Promise((resolvePort, rejectPort) => {
      const port = options.port ?? Number(process.env.PORT ?? 3001);
      const onError = (error: Error): void => rejectPort(error);
      httpServer.once('error', onError);
      httpServer.listen(port, () => {
        httpServer.removeListener('error', onError);
        if (!quiet) {
          logger.info(`rts server listening on http://localhost:${port}`, {
            seed: loop.state.seed,
            gameId: loop.state.gameId,
            opponent: opponentEnabled ? 'rule-ai' : 'none',
          });
        }
        nextTickAt = Date.now() + TICK_MS;
        timer = setInterval(() => {
          if (loop.isOver) {
            if (timer !== null) {
              clearInterval(timer);
              timer = null;
              if (!quiet) logger.info('match over; tick loop stopped', { tick: loop.state.tick });
            }
            return;
          }
          // Wall-clock catch-up, capped so a starved process cannot spiral.
          const now = Date.now();
          let due = 0;
          while (nextTickAt <= now && due < MAX_CATCHUP_TICKS) {
            nextTickAt += TICK_MS;
            due += 1;
          }
          if (nextTickAt > now) nextTickAt = Math.max(nextTickAt, now + TICK_MS);
          pump(due > 0 ? due : 1);
        }, TICK_MS);
        resolvePort(port);
      });
    });

  const stop = (): Promise<void> =>
    new Promise((resolveStop) => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      gateway.closeAll();
      wss.close(() => {
        httpServer.close(() => resolveStop());
      });
    });

  // The gateway hardcodes the human seat; keep the two declarations tied.
  if (HUMAN !== 'p1') throw new Error('server: human seat must be p1');

  return { app, httpServer, loop, gateway, port: options.port ?? 3001, pump, start, stop };
}

/** Entry point when this module is run directly (`tsx src/server/index.ts`). */
async function main(): Promise<void> {
  const server = createRtsServer();
  await server.start();

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

const invokedDirectly =
  process.argv[1] !== undefined && /server[\\/]index\.tsx?$/.test(process.argv[1]);
if (invokedDirectly) void main();
