/**
 * Fog of war computation — the single source of visibility truth.
 *
 * Both the human snapshot and the LLM state view are derived from the results
 * computed here, so the two players can never see different things
 * (docs/SPEC.md §10).
 *
 * Three states per tile:
 *   unexplored  — never seen: entities are not disclosed at all
 *   explored    — seen before, not visible now: terrain/crystals/ghosts only
 *   visible     — currently inside some own entity's vision radius
 */

import type {
  Building,
  Entity,
  Ghost,
  PlayerId,
  PlayerVision,
  Unit,
} from '../../shared/types';
import type { GameState } from '../state/GameState';
import { PLAYERS, opponentOf } from '../../shared/types';
import { COMBAT_EXPOSURE_TICKS, SIGHTING_MEMORY_TICKS } from '../config/constants';
import { tileOf } from '../math';

export function tick(state: GameState): void {
  for (const player of PLAYERS) recomputePlayerVision(state, player);
  applyCombatExposure(state);
  updateIntel(state);
}

function recomputePlayerVision(state: GameState, player: PlayerId): void {
  const vision = state.vision[player];
  const terrain = state.terrain;
  vision.visibleTiles.fill(0);
  vision.visibleEntityIds.clear();
  const seen = vision.visibleEntityIds;

  // 1. Own entities always see themselves and carve out their vision radius.
  for (const unit of state.units) {
    if (unit.owner !== player) continue;
    markCircle(vision, terrain.width, terrain.height, unit.x, unit.y, unit.vision);
    seen.add(unit.id);
  }
  for (const building of state.buildings) {
    if (building.owner !== player) continue;
    markCircle(vision, terrain.width, terrain.height, building.x, building.y, building.vision);
    seen.add(building.id);
  }

  // 2. Explored memory only grows.
  const explored = vision.explored;
  const visible = vision.visibleTiles;
  for (let i = 0; i < visible.length; i += 1) {
    if (visible[i] === 1) explored[i] = 1;
  }

  // 3. Anything else standing on a visible tile.
  for (const unit of state.units) {
    if (unit.owner === player) continue;
    if (isTileVisible(vision, terrain.width, unit.x, unit.y)) seen.add(unit.id);
  }
  for (const building of state.buildings) {
    if (building.owner === player) continue;
    if (isTileVisible(vision, terrain.width, building.x, building.y)) seen.add(building.id);
  }
  for (const crystal of state.crystals) {
    if (isTileVisible(vision, terrain.width, crystal.x, crystal.y)) seen.add(crystal.id);
  }
}

/**
 * Units that traded blows stay mutually visible for COMBAT_EXPOSURE_TICKS.
 * Without this a player could be shot by an enemy standing just outside their
 * own vision radius with no way to know.
 */
function applyCombatExposure(state: GameState): void {
  for (const unit of state.units) {
    if (unit.combatExposure < 0) continue;
    if (state.tick - unit.combatExposure > COMBAT_EXPOSURE_TICKS) continue;
    const attackerId = unit.attackedBy;
    if (attackerId === null) continue;
    const attacker = state.index.get(attackerId);
    if (attacker === undefined || attacker.owner === null) continue;
    if (attacker.owner === unit.owner) continue;
    state.vision[opponentOf(unit.owner)].visibleEntityIds.add(unit.id);
    state.vision[unit.owner].visibleEntityIds.add(attacker.id);
  }
}

function markCircle(
  vision: PlayerVision,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): void {
  if (radius <= 0) return;
  const radiusSq = radius * radius;
  const x0 = Math.max(0, Math.floor(x - radius));
  const x1 = Math.min(width - 1, Math.ceil(x + radius));
  const y0 = Math.max(0, Math.floor(y - radius));
  const y1 = Math.min(height - 1, Math.ceil(y + radius));
  for (let ty = y0; ty <= y1; ty += 1) {
    for (let tx = x0; tx <= x1; tx += 1) {
      const dx = tx + 0.5 - x;
      const dy = ty + 0.5 - y;
      if (dx * dx + dy * dy > radiusSq) continue;
      vision.visibleTiles[ty * width + tx] = 1;
    }
  }
}

// ── Queries ─────────────────────────────────────────────────────────────────

export function isTileVisible(vision: PlayerVision, width: number, x: number, y: number): boolean {
  const tx = tileOf(x);
  const ty = tileOf(y);
  if (tx < 0 || ty < 0) return false;
  const index = ty * width + tx;
  if (index < 0 || index >= vision.visibleTiles.length) return false;
  return vision.visibleTiles[index] === 1;
}

export function isTileExplored(vision: PlayerVision, width: number, x: number, y: number): boolean {
  const tx = tileOf(x);
  const ty = tileOf(y);
  if (tx < 0 || ty < 0) return false;
  const index = ty * width + tx;
  if (index < 0 || index >= vision.explored.length) return false;
  return vision.explored[index] === 1;
}

/** Can `player` currently see this entity? Own entities are always visible. */
export function isEntityVisible(state: GameState, player: PlayerId, entity: Entity): boolean {
  if (entity.owner === player) return true;
  return state.vision[player].visibleEntityIds.has(entity.id);
}

export function visibleEnemyUnits(state: GameState, player: PlayerId): Unit[] {
  const seen = state.vision[player].visibleEntityIds;
  return state.units.filter((unit) => unit.owner !== player && seen.has(unit.id));
}

export function visibleEnemyBuildings(state: GameState, player: PlayerId): Building[] {
  const seen = state.vision[player].visibleEntityIds;
  return state.buildings.filter((building) => building.owner !== player && seen.has(building.id));
}

/** Crystal nodes this player has seen at least once (they never move). */
export function knownCrystals(state: GameState, player: PlayerId) {
  const vision = state.vision[player];
  return state.crystals.filter((crystal) =>
    isTileExplored(vision, state.terrain.width, crystal.x, crystal.y),
  );
}

// ── Intel memory (player knowledge, excluded from the state hash) ───────────

function updateIntel(state: GameState): void {
  for (const player of PLAYERS) {
    const intel = state.intel[player];
    const vision = state.vision[player];
    const opponent = opponentOf(player);

    for (const building of state.buildings) {
      if (building.owner !== opponent) continue;
      if (!vision.visibleEntityIds.has(building.id)) continue;
      const tileX = tileOf(building.x);
      const tileY = tileOf(building.y);
      intel.buildings.set(building.id, {
        id: building.id,
        kind: building.kind,
        x: tileX,
        y: tileY,
        hpPct: building.maxHp > 0 ? building.hp / building.maxHp : 0,
        tick: state.tick,
      });
      if (building.kind === 'base') {
        intel.lastKnownEnemyBase = { x: tileX, y: tileY, tick: state.tick };
      }
    }

    for (const unit of state.units) {
      if (unit.owner !== opponent) continue;
      if (!vision.visibleEntityIds.has(unit.id)) continue;
      intel.lastKnownEnemySighting = {
        x: tileOf(unit.x),
        y: tileOf(unit.y),
        tick: state.tick,
      };
      break;
    }
  }
}

/** Enemy buildings remembered but not currently visible (for the ghost layer). */
export function ghostBuildings(state: GameState, player: PlayerId): Ghost[] {
  const vision = state.vision[player];
  const result: Ghost[] = [];
  for (const ghost of state.intel[player].buildings.values()) {
    // Skip only when the building is alive *and* currently visible — a ghost
    // whose building died unobserved is intentionally kept (stale by design).
    if (vision.visibleEntityIds.has(ghost.id)) continue;
    result.push(ghost);
  }
  return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function isSightingFresh(state: GameState, player: PlayerId): boolean {
  const sighting = state.intel[player].lastKnownEnemySighting;
  if (sighting === null) return false;
  return state.tick - sighting.tick <= SIGHTING_MEMORY_TICKS;
}
