/**
 * RuleAi — the built-in commander.
 *
 * Two jobs (docs/ROADMAP.md):
 *   1. Phase 1: it plays red so the headless simulation can run a full match.
 *   2. Phase 4: it is the guaranteed fallback whenever the LLM times out,
 *      answers with malformed JSON, or is cooling down after repeated failures.
 *
 * It is therefore held to a hard invariant: **it only ever emits actions drawn
 * from the compact legal action set**, exactly like the LLM must. That is
 * verified by tests/llm/ruleAi.test.ts, so the fallback can never be the reason
 * a match breaks.
 *
 * The AI is deterministic — no RNG — which keeps replays reproducible.
 */

import type { Action, PlayerId, Unit, Vec2 } from '../shared/types';
import type { GameState } from '../game/state/GameState';
import { buildLegalActions } from '../game/actions/legalActions';
import type { LegalActionSet } from '../game/actions/legalActions';
import { distance } from '../game/math';
import { findBaseOf, ownedUnits } from '../game/state/GameState';
import { isSightingFresh, visibleEnemyBuildings, visibleEnemyUnits } from '../game/systems/vision';

export interface RuleAiDecision {
  reasoning: string;
  actions: Action[];
}

export interface RuleAiConfig {
  /** Keep training workers until this many. */
  targetWorkers: number;
  /** Do not invest in a barracks below this worker count. */
  minWorkersForBarracks: number;
  /** Max barracks to own (matches BUILDING_STATS.barracks.limit). */
  maxBarracks: number;
  /** Soldiers required before marching on the enemy. */
  offenseThreshold: number;
  /** Enemies closer than this to the base count as a base threat. */
  defenseRadius: number;
  /** Max actions per decision (must stay <= the server budget). */
  maxActions: number;
}

export const RULE_AI_CONFIG: RuleAiConfig = {
  targetWorkers: 8,
  minWorkersForBarracks: 5,
  maxBarracks: 2,
  offenseThreshold: 6,
  defenseRadius: 14,
  maxActions: 12,
};

/** Working set shared by the planners below. */
interface Ctx {
  state: GameState;
  owner: PlayerId;
  legal: LegalActionSet;
  actions: Action[];
  used: Set<string>;
  config: RuleAiConfig;
}

const room = (ctx: Ctx): number => ctx.config.maxActions - ctx.actions.length;
const free = (ctx: Ctx, ids: string[]): string[] => ids.filter((id) => !ctx.used.has(id));

export function decide(
  state: GameState,
  owner: PlayerId,
  config: RuleAiConfig = RULE_AI_CONFIG,
): RuleAiDecision {
  const ctx: Ctx = {
    state,
    owner,
    legal: buildLegalActions(state, owner),
    actions: [],
    used: new Set<string>(),
    config,
  };
  const notes: string[] = [];

  const units = ownedUnits(state, owner);
  const workers = units.filter((unit) => unit.kind === 'worker');
  const soldiers = units.filter((unit) => unit.kind === 'soldier');
  const base = findBaseOf(state, owner);
  const anchor: Vec2 = base !== undefined ? { x: base.x, y: base.y } : { x: 0, y: 0 };

  const enemyUnits = visibleEnemyUnits(state, owner);
  const enemyBuildings = visibleEnemyBuildings(state, owner);
  const threats =
    base === undefined
      ? []
      : enemyUnits.filter((enemy) => distance(enemy.x, enemy.y, base.x, base.y) <= config.defenseRadius);

  // ── 1. Defence always gets the first call on the budget ──────────────────
  if (threats.length > 0) {
    const target = nearestTo(threats, anchor);
    if (target !== null && planAttack(ctx, [target.id])) {
      notes.push(`回防 ${target.id}`);
    } else {
      const fallback = findMoveTarget(ctx, anchor);
      if (fallback !== null && planMove(ctx, soldiers, fallback)) notes.push('撤回基地防守');
    }
  }

  // ── 2. Economy: keep the worker count up ────────────────────────────────
  if (workers.length < config.targetWorkers && planTrain(ctx, 'worker')) {
    notes.push(`补工人至 ${workers.length + 1}`);
  }

  // ── 3. Tech: barracks unlock soldiers ───────────────────────────────────
  const barracksCount = state.buildings.filter(
    (building) => building.owner === owner && building.kind === 'barracks',
  ).length;
  const wantsBarracks =
    barracksCount === 0
      ? workers.length >= config.minWorkersForBarracks
      : barracksCount < config.maxBarracks && workers.length >= config.targetWorkers;
  if (wantsBarracks && planBuild(ctx, anchor)) {
    notes.push(`建造兵营 (${barracksCount + 1}/${config.maxBarracks})`);
  }

  // ── 4. Keep the barracks busy ───────────────────────────────────────────
  if ((barracksCount > 0 || ctx.legal.build !== null) && planTrain(ctx, 'soldier')) {
    notes.push('训练士兵');
  }

  // ── 5. Idle workers go mining ───────────────────────────────────────────
  const idleWorkers = workers.filter(
    (worker) => worker.state === 'idle' || worker.state === 'holding',
  );
  if (idleWorkers.length > 0 && planGather(ctx, idleWorkers, anchor)) {
    notes.push(`工人采集 x${idleWorkers.length}`);
  }

  // ── 6. Offence ──────────────────────────────────────────────────────────
  const intel = state.intel[owner];
  const readySoldiers = free(ctx, soldiers.map((soldier) => soldier.id));
  // Enemy units first; when the field is clear, push on the buildings.
  const offenceTarget = nearestTo(enemyUnits, anchor) ?? nearestTo(enemyBuildings, anchor);

  if (readySoldiers.length >= config.offenseThreshold) {
    if (offenceTarget !== null && planAttack(ctx, [offenceTarget.id])) {
      notes.push('全军进攻');
    } else if (intel.lastKnownEnemyBase !== null) {
      const target = findMoveTarget(ctx, {
        x: intel.lastKnownEnemyBase.x,
        y: intel.lastKnownEnemyBase.y,
      });
      const movers = soldiers.filter((soldier) => readySoldiers.includes(soldier.id));
      if (target !== null && planMove(ctx, movers, target)) notes.push('向已知敌基地进军');
    } else {
      // Nothing seen yet: march towards the far side so the army scouts the map
      // instead of standing at home forever.
      const scout = scoutDestination(ctx, anchor);
      const movers = soldiers.filter((soldier) => readySoldiers.includes(soldier.id));
      if (scout !== null && planMove(ctx, movers, scout)) notes.push('全军前出侦察');
    }
  } else if (offenceTarget !== null && isSightingFresh(state, owner)) {
    // Small force: only engage what is already in sight, never wander off.
    if (planAttack(ctx, [offenceTarget.id])) notes.push('小股部队接敌');
  }

  // ── 7. Nothing to do: hold position ─────────────────────────────────────
  if (ctx.actions.length === 0) {
    const idle = units.filter((unit) => unit.state === 'idle');
    if (idle.length > 0 && planHold(ctx, idle)) notes.push('原地待命');
  }

  if (ctx.actions.length === 0) {
    return { reasoning: '无明显可行动作，跳过本回合', actions: [{ type: 'noop' }] };
  }
  return { reasoning: notes.join('；'), actions: ctx.actions };
}

// ── Target selection (always resolved through the legal set) ────────────────

function nearestTo<T extends { x: number; y: number; id: string }>(
  items: T[],
  origin: Vec2,
): T | null {
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const d = distance(item.x, item.y, origin.x, origin.y);
    if (d < bestDistance || (d === bestDistance && best !== null && item.id < best.id)) {
      best = item;
      bestDistance = d;
    }
  }
  return best;
}

function nearestPoint(points: Vec2[], desired: Vec2): Vec2 | null {
  let best: Vec2 | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const d = distance(point.x, point.y, desired.x, desired.y);
    if (d < bestDistance) {
      best = point;
      bestDistance = d;
    }
  }
  return best;
}

function findMoveTarget(ctx: Ctx, desired: Vec2): Vec2 | null {
  const entry = ctx.legal.move;
  if (entry === null || entry.targets.length === 0 || room(ctx) <= 0) return null;
  return nearestPoint(entry.targets, desired);
}

/** Preferred scouting destination: the far quadrant, else the map centre. */
function scoutDestination(ctx: Ctx, anchor: Vec2): Vec2 | null {
  const entry = ctx.legal.move;
  if (entry === null || room(ctx) <= 0) return null;
  const byLabel = (label: string): Vec2 | null => {
    const found = entry.targets.find((target) => target.label === label);
    return found === undefined ? null : { x: found.x, y: found.y };
  };
  return byLabel('far_quadrant') ?? byLabel('map_center') ?? farthestPoint(entry.targets, anchor);
}

function farthestPoint(points: Vec2[], from: Vec2): Vec2 | null {
  let best: Vec2 | null = null;
  let bestDistance = -1;
  for (const point of points) {
    const d = distance(point.x, point.y, from.x, from.y);
    if (d > bestDistance) {
      best = { x: point.x, y: point.y };
      bestDistance = d;
    }
  }
  return best;
}

function nearestEntityId(ctx: Ctx, ids: string[], origin: Vec2): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const entity = ctx.state.index.get(id);
    if (entity === undefined) continue;
    const d = distance(entity.x, entity.y, origin.x, origin.y);
    if (d < bestDistance || (d === bestDistance && best !== null && id < best)) {
      best = id;
      bestDistance = d;
    }
  }
  return best;
}

// ── Action emitters (each returns false when it cannot be done) ─────────────

function planTrain(ctx: Ctx, unitType: Unit['kind']): boolean {
  if (room(ctx) <= 0) return false;
  const entry = ctx.legal.train.find((candidate) => candidate.unitType === unitType);
  if (entry === undefined) return false;
  ctx.actions.push({ type: 'train', buildingId: entry.buildingId, unitType });
  return true;
}

function planBuild(ctx: Ctx, anchor: Vec2): boolean {
  const entry = ctx.legal.build;
  if (entry === null || room(ctx) <= 0) return false;
  const candidates = free(ctx, entry.unitIds);
  const builderId = candidates[0];
  if (builderId === undefined) return false;
  const target = nearestPoint(entry.targets, anchor);
  if (target === null) return false;
  ctx.used.add(builderId);
  ctx.actions.push({
    type: 'build',
    unitIds: [builderId],
    buildingType: entry.buildingType,
    x: target.x,
    y: target.y,
  });
  return true;
}

function planGather(ctx: Ctx, workers: Unit[], anchor: Vec2): boolean {
  const entry = ctx.legal.gather;
  if (entry === null || room(ctx) <= 0) return false;
  const candidates = free(
    ctx,
    workers.map((worker) => worker.id).filter((id) => entry.unitIds.includes(id)),
  );
  if (candidates.length === 0) return false;
  const targetId = nearestEntityId(
    ctx,
    entry.targets.map((target) => target.id),
    anchor,
  );
  if (targetId === null) return false;

  const ids = candidates.slice(0, room(ctx));
  ids.forEach((id) => ctx.used.add(id));
  ctx.actions.push({ type: 'gather', unitIds: ids, targetId });
  return true;
}

function planAttack(ctx: Ctx, targetIds: string[]): boolean {
  const entry = ctx.legal.attack;
  if (entry === null || room(ctx) <= 0) return false;
  const target = entry.targets.find((candidate) => targetIds.includes(candidate.id));
  if (target === undefined) return false;
  const candidates = free(ctx, entry.unitIds);
  const ids = candidates.slice(0, room(ctx));
  if (ids.length === 0) return false;
  ids.forEach((id) => ctx.used.add(id));
  ctx.actions.push({ type: 'attack', unitIds: ids, targetId: target.id });
  return true;
}

function planMove(ctx: Ctx, units: Unit[], target: Vec2): boolean {
  const entry = ctx.legal.move;
  if (entry === null || room(ctx) <= 0) return false;
  const candidates = free(
    ctx,
    units.map((unit) => unit.id).filter((id) => entry.unitIds.includes(id)),
  );
  const ids = candidates.slice(0, room(ctx));
  if (ids.length === 0) return false;
  ids.forEach((id) => ctx.used.add(id));
  ctx.actions.push({ type: 'move', unitIds: ids, x: target.x, y: target.y });
  return true;
}

function planHold(ctx: Ctx, units: Unit[]): boolean {
  if (room(ctx) <= 0) return false;
  const candidates = free(
    ctx,
    units.map((unit) => unit.id).filter((id) => ctx.legal.hold.includes(id)),
  );
  const ids = candidates.slice(0, room(ctx));
  if (ids.length === 0) return false;
  ids.forEach((id) => ctx.used.add(id));
  ctx.actions.push({ type: 'hold', unitIds: ids });
  return true;
}
