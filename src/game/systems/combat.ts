/**
 * Combat: target acquisition, pursuit, cooldown gated damage and death sweep.
 *
 * Rules implemented here (docs/SPEC.md §8.3, §10.3):
 *  - `attacking` units pursue and hit their ordered target.
 *  - `idle` / `holding` units auto-engage the nearest enemy they can *see*.
 *  - Any unit that took damage recently abandons its order and fights back.
 *  - Damage is applied simultaneously after every attacker has resolved, so two
 *    units killing each other on the same tick both die.
 *  - Damage marks both parties with a `combatExposure` timestamp, which is what
 *    keeps two units that traded blows mutually visible even out of sight.
 */

import type { Unit } from '../../shared/types';
import type { GameState } from '../state/GameState';
import { COMBAT_EXPOSURE_TICKS, RETALIATE_WINDOW_TICKS, UNIT_STATS } from '../config/constants';
import { distance, distanceSq, tileOf } from '../math';
import { removeEntity } from '../state/GameState';
import { clearPath } from '../state/unitOps';
import { ensurePath } from './movement';

interface PendingDamage {
  attacker: Unit;
  victimId: string;
  amount: number;
}

export function tick(state: GameState): void {
  for (const unit of state.units) {
    if (unit.cooldown > 0) unit.cooldown -= 1;
  }

  applyRetaliation(state);

  const pending: PendingDamage[] = [];
  for (const unit of state.units) resolveAttack(state, unit, pending);
  applyDamage(state, pending);
}

// ── Retaliation ─────────────────────────────────────────────────────────────

function applyRetaliation(state: GameState): void {
  for (const unit of state.units) {
    if (unit.attackedBy === null) continue;
    if (state.tick - unit.combatExposure > RETALIATE_WINDOW_TICKS) {
      unit.attackedBy = null;
      continue;
    }
    const attacker = state.index.get(unit.attackedBy);
    if (
      attacker === undefined ||
      attacker.owner === null ||
      attacker.owner === unit.owner ||
      unit.state === 'attacking'
    ) {
      if (attacker === undefined) unit.attackedBy = null;
      continue;
    }
    unit.state = 'attacking';
    unit.task = { type: 'attack', targetId: attacker.id };
    clearPath(unit);
  }
}

// ── Target acquisition ──────────────────────────────────────────────────────

/** Nearest enemy entity this unit can currently see, within its vision radius. */
export function nearestVisibleEnemy(state: GameState, unit: Unit, radius?: number): string | null {
  const limit = radius ?? unit.vision;
  const seen = state.vision[unit.owner].visibleEntityIds;
  const limitSq = limit * limit;
  let bestId: string | null = null;
  let bestDistanceSq = Number.POSITIVE_INFINITY;

  const consider = (id: string, owner: string | null, x: number, y: number): void => {
    if (owner === null || owner === unit.owner) return;
    if (!seen.has(id)) return;
    const d = distanceSq(unit.x, unit.y, x, y);
    if (d > limitSq) return;
    if (d < bestDistanceSq || (d === bestDistanceSq && bestId !== null && id < bestId)) {
      bestId = id;
      bestDistanceSq = d;
    }
  };

  for (const other of state.units) consider(other.id, other.owner, other.x, other.y);
  for (const building of state.buildings) {
    consider(building.id, building.owner, building.x, building.y);
  }
  return bestId;
}

// ── Resolution ──────────────────────────────────────────────────────────────

function resolveAttack(state: GameState, unit: Unit, pending: PendingDamage[]): void {
  let targetId: string | null = null;
  if (unit.state === 'attacking') {
    targetId = unit.task !== null && unit.task.type === 'attack' ? unit.task.targetId : nearestVisibleEnemy(state, unit);
  } else if (unit.state === 'idle' || unit.state === 'holding') {
    targetId = nearestVisibleEnemy(state, unit);
  }

  if (targetId === null) {
    if (unit.state === 'attacking') {
      unit.state = 'idle';
      unit.task = null;
      clearPath(unit);
    }
    return;
  }

  const target = state.index.get(targetId);
  if (target === undefined || target.owner === null || target.owner === unit.owner) {
    if (unit.state === 'attacking') {
      unit.state = 'idle';
      unit.task = null;
      clearPath(unit);
    }
    return;
  }

  const stats = UNIT_STATS[unit.kind];
  const d = distance(unit.x, unit.y, target.x, target.y);

  if (d <= stats.range) {
    clearPath(unit);
    if (unit.cooldown <= 0) {
      pending.push({ attacker: unit, victimId: target.id, amount: stats.attack });
      unit.cooldown = stats.cooldownTicks;
    }
    return;
  }

  if (unit.state === 'attacking') {
    const reachable = ensurePath(state, unit, tileOf(target.x), tileOf(target.y));
    if (!reachable) {
      unit.state = 'idle';
      unit.task = null;
    }
  }
}

function applyDamage(state: GameState, pending: PendingDamage[]): void {
  for (const hit of pending) {
    const victim = state.index.get(hit.victimId);
    if (victim === undefined || victim.owner === null) continue;

    victim.hp -= hit.amount;
    if (victim.category === 'unit') {
      victim.combatExposure = state.tick;
      victim.attackedBy = hit.attacker.id;
    }
    hit.attacker.combatExposure = state.tick;

    state.events.push({
      type: 'damage',
      tick: state.tick,
      entityId: hit.attacker.id,
      targetId: victim.id,
      owner: hit.attacker.owner,
      amount: hit.amount,
      x: tileOf(victim.x),
      y: tileOf(victim.y),
    });

    if (victim.hp <= 0) {
      state.players[hit.attacker.owner].stats.killed += 1;
      removeEntity(state, victim.id);
    }
  }
}

export { COMBAT_EXPOSURE_TICKS };
