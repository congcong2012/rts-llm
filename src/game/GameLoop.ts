/**
 * GameLoop — the fixed-timestep orchestrator (docs/SPEC.md §5.1).
 *
 * This module owns the tick order and nothing else. It has NO dependency on
 * timers, sockets or the filesystem: the caller decides when a tick happens
 * (the server uses setInterval(100ms), the simulation script loops, the tests
 * step manually). That is what makes the whole match reproducible.
 *
 * Tick order:
 *   1 tick++            2 apply validated commands      3 economy
 *   4 production        5 movement                      6 combat
 *   7 vision (fog)      8 victory / end conditions
 */

import type {
  Action,
  ActionSource,
  PendingCommand,
  PlayerId,
  TickResult,
} from '../shared/types';
import { executeAction } from './actions/executor';
import type { LegalActionSet } from './actions/legalActions';
import { buildLegalActions } from './actions/legalActions';
import { validateBatch } from './actions/validator';
import type { GameState } from './state/GameState';
import { findBaseOf, population } from './state/GameState';
import { tick as combatTick } from './systems/combat';
import { tick as economyTick } from './systems/economy';
import { tick as movementTick } from './systems/movement';
import { tick as productionTick } from './systems/production';
import type { MatchOptions } from './systems/spawn';
import { createMatch } from './systems/spawn';
import { encodeBlockedRows } from './map/terrain';
import { tick as victoryTick } from './systems/victory';
import { tick as visionTick } from './systems/vision';

export type { MatchOptions };

/**
 * Actions per batch for the human player. Larger than the LLM budget because a
 * box-select order legitimately touches many units at once; the 12-action cap
 * exists to stop an automated commander from spamming.
 */
export const HUMAN_ACTION_BUDGET = 32;

/**
 * Create a match and compute the initial vision.
 *
 * Vision must be primed before the first tick: the validator needs it to decide
 * whether an attack target is visible, and combat needs it for auto-engage.
 */
export function createGame(options: MatchOptions = {}): GameState {
  const state = createMatch(options);
  visionTick(state);
  state.events = [];
  return state;
}

/** Queue a command for the next tick. */
export function enqueueCommand(
  state: GameState,
  owner: PlayerId,
  action: Action,
  source: ActionSource = 'human',
): void {
  state.pending.push({ owner, action, source, issuedAt: state.tick });
}

export function enqueueCommands(
  state: GameState,
  owner: PlayerId,
  actions: Action[],
  source: ActionSource = 'human',
): void {
  for (const action of actions) enqueueCommand(state, owner, action, source);
}

/**
 * `GameLoop` — the tiny object the server talks to.
 *
 * It exists to make the "single execution path" and "single filtered egress"
 * rules structural rather than a matter of discipline: the gateway holds a
 * `GameLoop` and can reach the raw state, but the only ways in are
 * `dispatchHumanCommands` (validated) and `step` (the tick), and the only way
 * out for a client is the gateway's own snapshot writer.
 *
 * It owns NO timer: the server calls `step()` on its own schedule, tests call it
 * manually, and `scripts/simulate.ts` drives the core directly.
 */
export class GameLoop {
  readonly state: GameState;
  private frozen = false;

  constructor(state: GameState) {
    this.state = state;
  }

  /** True once the match ended and the loop stopped accepting work. */
  get isOver(): boolean {
    return this.frozen || this.state.status === 'gameover';
  }

  /**
   * Route human orders into the command queue.
   *
   * They are applied at the START of the next tick, together with everything else
   * already queued for the human — which matters: `applyCommands` batches per
   * (owner, source), so several `cmd` frames arriving between two ticks share one
   * 32-action budget instead of each getting their own. A client that spams
   * frames therefore cannot exceed the human budget.
   *
   * Schema parsing happens earlier, in the gateway; everything after that is the
   * shared `validateBatch` → `executeAction` pipeline, so illegal orders land in
   * `state.rejects` and never throw.
   */
  dispatchHumanCommands(actions: Action[]): number {
    if (this.isOver) return 0;
    for (const action of actions) {
      this.state.pending.push({
        owner: HUMAN_PLAYER,
        action,
        source: 'human',
        issuedAt: this.state.tick,
      });
    }
    return actions.length;
  }

  /** Advance one tick. Returns the tick result (events already filtered later). */
  step(extraCommands: PendingCommand[] = []): TickResult {
    if (this.frozen) {
      return { tick: this.state.tick, accepted: 0, rejected: [], events: [] };
    }
    const result = stepTick(this.state, extraCommands);
    return result;
  }

  /** Stop accepting work (called once the `gameover` frame has gone out). */
  markOver(): void {
    this.frozen = true;
  }

  /** Terrain bitmask rows — public information, safe to send to any client. */
  blockedRows(): string[] {
    return encodeBlockedRows(this.state.terrain);
  }
}

/** The human seat. Declared here (not in the gateway) so the core stays generic. */
export const HUMAN_PLAYER: PlayerId = 'p1';

/** Convenience factory used by the server and by tests. */
export function createLoop(options: MatchOptions = {}): GameLoop {
  return new GameLoop(createGame(options));
}


export function stepTick(state: GameState, extraCommands: PendingCommand[] = []): TickResult {
  state.events = [];
  state.rejects = [];

  const result: TickResult = {
    tick: state.tick,
    accepted: 0,
    rejected: [],
    events: state.events,
  };

  if (state.status === 'gameover') return result;

  state.tick += 1;

  const queue = [...state.pending, ...extraCommands];
  state.pending = [];
  result.accepted = applyCommands(state, queue);

  economyTick(state);
  productionTick(state);
  movementTick(state);
  combatTick(state);
  visionTick(state);
  victoryTick(state);

  if (state.status === 'running' && state.tick >= state.config.maxTicks) {
    state.status = 'gameover';
    state.endTick = state.tick;
    state.winner = decideTimeoutWinner(state);
    state.events.push({ type: 'gameover', tick: state.tick, owner: state.winner ?? undefined });
  }

  result.tick = state.tick;
  result.rejected = state.rejects;
  result.events = state.events;
  return result;
}

/** Run `count` ticks, optionally injecting commands before each one. */
export function stepTicks(
  state: GameState,
  count: number,
  onTick?: (state: GameState) => PendingCommand[] | void,
): TickResult {
  let result: TickResult = { tick: state.tick, accepted: 0, rejected: [], events: [] };
  for (let i = 0; i < count; i += 1) {
    if (state.status === 'gameover') break;
    const injected = onTick?.(state);
    result = stepTick(state, injected ?? []);
  }
  return result;
}

// ── Command application ─────────────────────────────────────────────────────

function applyCommands(state: GameState, queue: PendingCommand[]): number {
  if (queue.length === 0) return 0;

  // Batch per (owner, source) so the per-decision budget and the
  // one-order-per-unit rule apply inside a single decision, not across ticks.
  const groups = new Map<string, PendingCommand[]>();
  for (const command of queue) {
    const key = `${command.owner}|${command.source}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [command]);
    else bucket.push(command);
  }

  const legalCache = new Map<PlayerId, LegalActionSet>();
  let acceptedCount = 0;

  for (const bucket of groups.values()) {
    const first = bucket[0];
    if (first === undefined) continue;
    const owner = first.owner;
    const source = first.source;
    // Only the LLM is constrained to its advertised candidate set (SPEC §8.2
    // step 9); the rule AI and the human keep full (validated) freedom.
    const enforceLegal = source === 'llm';

    let legal: LegalActionSet | undefined;
    if (enforceLegal) {
      const cached = legalCache.get(owner);
      if (cached === undefined) {
        legal = buildLegalActions(state, owner);
        legalCache.set(owner, legal);
      } else {
        legal = cached;
      }
    }

    const batch = validateBatch(
      state,
      owner,
      bucket.map((command) => command.action),
      {
        enforceLegal,
        maxActions: source === 'human' ? HUMAN_ACTION_BUDGET : state.config.maxActionsPerTurn,
        source,
        ...(legal === undefined ? {} : { legal }),
      },
    );

    for (const action of batch.accepted) {
      if (executeAction(state, owner, action)) acceptedCount += 1;
    }
    state.acceptedTotal += batch.accepted.length;
    state.rejectedTotal += batch.rejected.length;
    for (const rejection of batch.rejected) state.rejects.push(rejection);
  }

  return acceptedCount;
}

/**
 * Deterministic tie-break when MAX_TICKS is reached: healthier base first, then
 * larger army, otherwise a draw.
 */
function decideTimeoutWinner(state: GameState): PlayerId | null {
  const bases = { p1: findBaseOf(state, 'p1'), p2: findBaseOf(state, 'p2') };
  if (bases.p1 === undefined && bases.p2 === undefined) return null;
  if (bases.p1 === undefined) return 'p2';
  if (bases.p2 === undefined) return 'p1';

  const ratio = (player: PlayerId): number => {
    const base = bases[player];
    return base === undefined ? 0 : base.hp / base.maxHp;
  };
  const r1 = ratio('p1');
  const r2 = ratio('p2');
  if (r1 > r2) return 'p1';
  if (r2 > r1) return 'p2';

  const u1 = population(state, 'p1');
  const u2 = population(state, 'p2');
  if (u1 > u2) return 'p1';
  if (u2 > u1) return 'p2';
  return null;
}
