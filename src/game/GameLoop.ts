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
