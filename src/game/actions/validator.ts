/**
 * CommandValidator — the ten-step rejection pipeline (docs/SPEC.md §8.2).
 *
 * Every action, from the human client and from the LLM alike, goes through this
 * module. A rejection never throws and never aborts the rest of the batch: it
 * returns a reason code that gets logged.
 *
 * Step order matters, because the *first* failure decides the reason code:
 *   1 schema · 2 type whitelist · 3 entity exists · 4 ownership · 5 state allows
 *   6 resources / production / population · 7 target legality · 8 coordinates
 *   9 legal-action membership · 10 accepted
 * (Batch-level: budget + one-order-per-unit are enforced around the pipeline.)
 */

import type {
  Action,
  PlayerId,
  RejectReason,
  RejectedAction,
  ValidationResult,
} from '../../shared/types';
import type { GameState } from '../state/GameState';
import { ACTION_TYPES } from '../../shared/types';
import { BUILDING_STATS, UNIT_STATS } from '../config/constants';
import { distance } from '../math';
import { isWalkable } from '../map/terrain';
import {
  countBuildings,
  getBuilding,
  getCrystal,
  getEntity,
  getUnit,
  population,
} from '../state/GameState';
import { canAcceptTraining } from '../systems/production';
import type { LegalActionSet } from './legalActions';
import { isActionLegal } from './legalActions';
import { parseAction } from './schema';

export interface ValidationContext {
  /** Required when `enforceLegal` is true (the LLM path). */
  legal?: LegalActionSet;
  /** Humans may act freely; the LLM may only pick from its legal set. */
  enforceLegal: boolean;
  /** Remaining accepted-action budget for this batch. */
  budgetRemaining: number;
  /** Units already ordered this batch — one order per unit per tick. */
  claimedUnitIds: Set<string>;
}

function fail(reason: RejectReason, detail?: string): ValidationResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

function inMap(state: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.terrain.width && y < state.terrain.height;
}

/** Validate a single action. Never throws. */
export function validateAction(
  state: GameState,
  owner: PlayerId,
  raw: unknown,
  ctx: ValidationContext,
): ValidationResult {
  try {
    if (ctx.budgetRemaining <= 0) {
      return fail('TURN_BUDGET_EXCEEDED', 'batch action budget exhausted');
    }

    // 1. Schema / shape.
    const parsed = parseAction(raw);
    if (!parsed.ok) return fail('SCHEMA_INVALID', parsed.error);
    const action = parsed.action;

    // 2. Type whitelist (defensive: the schema already restricts this).
    if (!ACTION_TYPES.includes(action.type)) {
      return fail('UNKNOWN_TYPE', `unknown action type`);
    }

    const resources = state.players[owner].resources.crystal;

    switch (action.type) {
      case 'noop':
        break;

      case 'train': {
        // 3. exists
        const building = getBuilding(state, action.buildingId);
        if (building === undefined) {
          return fail('ENTITY_NOT_FOUND', `building ${action.buildingId} does not exist`);
        }
        // 4. ownership
        if (building.owner !== owner) return fail('NOT_OWNED', `building ${building.id}`);
        // 6. production capability
        const stats = BUILDING_STATS[building.kind];
        if (!stats.trains.includes(action.unitType)) {
          return fail('PRODUCTION_BLOCKED', `${building.kind} cannot train ${action.unitType}`);
        }
        // 5. state allows
        if (!canAcceptTraining(building)) {
          return fail('INVALID_STATE', `${building.id} is ${building.state}`);
        }
        // 6. resources / population
        if (resources < UNIT_STATS[action.unitType].cost) {
          return fail('INSUFFICIENT_RESOURCE', `${UNIT_STATS[action.unitType].cost} required`);
        }
        if (population(state, owner) >= state.config.popCap) {
          return fail('POP_CAP_REACHED', `pop cap ${state.config.popCap}`);
        }
        break;
      }

      case 'build': {
        const stats = BUILDING_STATS[action.buildingType];
        if (!stats.buildable) {
          return fail('PRODUCTION_BLOCKED', `${action.buildingType} cannot be built`);
        }
        if (action.unitIds.length === 0) return fail('INVALID_STATE', 'no builder given');
        for (const id of action.unitIds) {
          const unit = getUnit(state, id);
          if (unit === undefined) return fail('ENTITY_NOT_FOUND', `unit ${id} does not exist`);
          if (unit.owner !== owner) return fail('NOT_OWNED', `unit ${id}`);
          if (!UNIT_STATS[unit.kind].canBuild) {
            return fail('INVALID_STATE', `${unit.kind} cannot build`);
          }
          // A gathering worker may be redirected to a construction site (the
          // standard RTS behaviour); one already building may not.
          const allowed =
            unit.state === 'idle' || unit.state === 'holding' || unit.state === 'gathering';
          if (!allowed) {
            return fail('INVALID_STATE', `unit ${id} is ${unit.state}`);
          }
        }
        if (resources < stats.cost) return fail('INSUFFICIENT_RESOURCE', `${stats.cost} required`);
        if (stats.limit > 0 && countBuildings(state, owner, action.buildingType) >= stats.limit) {
          return fail('PRODUCTION_BLOCKED', `${action.buildingType} limit reached`);
        }
        if (!inMap(state, action.x, action.y)) return fail('OUT_OF_BOUNDS', `${action.x},${action.y}`);
        if (!isWalkable(state.terrain, action.x, action.y)) {
          return fail('BLOCKED_TILE', `${action.x},${action.y} is rock`);
        }
        const occupied =
          state.buildings.some((b) => Math.floor(b.x) === action.x && Math.floor(b.y) === action.y) ||
          state.crystals.some((c) => Math.floor(c.x) === action.x && Math.floor(c.y) === action.y);
        if (occupied) return fail('BLOCKED_TILE', `${action.x},${action.y} is occupied`);
        break;
      }

      case 'move': {
        for (const id of action.unitIds) {
          const unit = getUnit(state, id);
          if (unit === undefined) return fail('ENTITY_NOT_FOUND', `unit ${id} does not exist`);
          if (unit.owner !== owner) return fail('NOT_OWNED', `unit ${id}`);
          // Note: pulling a builder off a site IS allowed (the site merely
          // pauses). Only the LLM's advertised set hides builders, so an LLM
          // cannot accidentally stall its own construction.
        }
        if (!inMap(state, action.x, action.y)) return fail('OUT_OF_BOUNDS', `${action.x},${action.y}`);
        if (!isWalkable(state.terrain, action.x, action.y)) {
          return fail('BLOCKED_TILE', `${action.x},${action.y}`);
        }
        break;
      }

      case 'attack': {
        for (const id of action.unitIds) {
          const unit = getUnit(state, id);
          if (unit === undefined) return fail('ENTITY_NOT_FOUND', `unit ${id} does not exist`);
          if (unit.owner !== owner) return fail('NOT_OWNED', `unit ${id}`);
          if (!UNIT_STATS[unit.kind].canInitiateAttack) {
            return fail('INVALID_STATE', `${unit.kind} cannot initiate an attack`);
          }
        }
        const target = getEntity(state, action.targetId);
        if (target === undefined) {
          return fail('ENTITY_NOT_FOUND', `target ${action.targetId} does not exist`);
        }
        if (target.owner === null) return fail('INVALID_TARGET', 'resource nodes are not attackable');
        if (target.owner === owner) return fail('INVALID_TARGET', 'cannot attack your own entity');
        if (!state.vision[owner].visibleEntityIds.has(target.id)) {
          return fail('INVALID_TARGET', `target ${target.id} is not visible`);
        }
        break;
      }

      case 'gather': {
        for (const id of action.unitIds) {
          const unit = getUnit(state, id);
          if (unit === undefined) return fail('ENTITY_NOT_FOUND', `unit ${id} does not exist`);
          if (unit.owner !== owner) return fail('NOT_OWNED', `unit ${id}`);
          if (!UNIT_STATS[unit.kind].canGather) {
            return fail('INVALID_STATE', `${unit.kind} cannot gather`);
          }
        }
        if (action.targetId !== undefined) {
          const node = getCrystal(state, action.targetId);
          if (node === undefined) {
            return fail('ENTITY_NOT_FOUND', `crystal ${action.targetId} does not exist`);
          }
          if (node.amount <= 0) return fail('INVALID_TARGET', `crystal ${node.id} is depleted`);
        } else if (!state.crystals.some((node) => node.amount > 0)) {
          return fail('INVALID_TARGET', 'no crystal node left on the map');
        }
        break;
      }

      case 'hold': {
        for (const id of action.unitIds) {
          const unit = getUnit(state, id);
          if (unit === undefined) return fail('ENTITY_NOT_FOUND', `unit ${id} does not exist`);
          if (unit.owner !== owner) return fail('NOT_OWNED', `unit ${id}`);
        }
        break;
      }
    }

    // Duplicate claims: one order per unit per batch.
    for (const id of unitIdsOf(action)) {
      if (ctx.claimedUnitIds.has(id)) {
        return fail('DUPLICATE_UNIT', `unit ${id} was already ordered this batch`);
      }
    }

    // 9. legal-action membership (LLM path only).
    if (ctx.enforceLegal && action.type !== 'noop') {
      // `noop` is legal by definition, so it needs no candidate set.
      if (ctx.legal === undefined) {
        return fail('INTERNAL_ERROR', 'legal action set missing while enforcing legality');
      }
      if (!isActionLegal(ctx.legal, action)) {
        return fail('NOT_IN_LEGAL_ACTIONS', describeAction(action));
      }
    }

    // 10. accepted
    return { ok: true };
  } catch (error) {
    return fail('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  }
}

function unitIdsOf(action: Action): string[] {
  switch (action.type) {
    case 'build':
    case 'move':
    case 'attack':
    case 'gather':
    case 'hold':
      return action.unitIds;
    default:
      return [];
  }
}

function describeAction(action: Action): string {
  switch (action.type) {
    case 'move':
    case 'build':
      return `${action.type} -> ${action.x},${action.y}`;
    case 'attack':
    case 'gather':
      return `${action.type} -> ${action.targetId ?? 'auto'}`;
    case 'train':
      return `train ${action.unitType} @ ${action.buildingId}`;
    default:
      return action.type;
  }
}

// ── Batch entry point ───────────────────────────────────────────────────────

export interface BatchOptions {
  legal?: LegalActionSet;
  enforceLegal: boolean;
  maxActions: number;
  source: RejectedAction['source'];
}

export interface BatchResult {
  accepted: Action[];
  rejected: RejectedAction[];
}

/**
 * Validate a whole batch, dropping the bad entries.
 *
 * Never throws: an unexpected error inside one entry is recorded as
 * `INTERNAL_ERROR` and the remaining entries are still processed.
 */
export function validateBatch(
  state: GameState,
  owner: PlayerId,
  raws: unknown[],
  options: BatchOptions,
): BatchResult {
  const accepted: Action[] = [];
  const rejected: RejectedAction[] = [];
  const claimedUnitIds = new Set<string>();

  let budget = Math.min(options.maxActions, state.config.maxActionsPerTurn);

  for (const raw of raws) {
    const ctx: ValidationContext = {
      enforceLegal: options.enforceLegal,
      budgetRemaining: budget,
      claimedUnitIds,
    };
    if (options.legal !== undefined) ctx.legal = options.legal;

    const result = validateAction(state, owner, raw, ctx);
    if (!result.ok) {
      const entry: RejectedAction = {
        owner,
        tick: state.tick,
        source: options.source,
        reason: result.reason,
        action: raw,
      };
      if (result.detail !== undefined) entry.detail = result.detail;
      rejected.push(entry);
      continue;
    }
    const parsed = parseAction(raw);
    if (!parsed.ok) continue; // unreachable: validateAction already parsed it
    accepted.push(parsed.action);
    for (const id of unitIdsOf(parsed.action)) claimedUnitIds.add(id);
    budget -= 1;
  }

  return { accepted, rejected };
}

/** Convenience wrapper used by tests and debugging tools. */
export function isActionAcceptable(
  state: GameState,
  owner: PlayerId,
  raw: unknown,
  options: { legal?: LegalActionSet; enforceLegal: boolean; maxActions?: number },
): ValidationResult {
  const ctx: ValidationContext = {
    enforceLegal: options.enforceLegal,
    budgetRemaining: options.maxActions ?? state.config.maxActionsPerTurn,
    claimedUnitIds: new Set<string>(),
  };
  if (options.legal !== undefined) ctx.legal = options.legal;
  return validateAction(state, owner, raw, ctx);
}

/** Distance helper re-exported so action modules do not import math directly. */
export { distance };
