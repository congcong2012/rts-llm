/**
 * Right-click order resolution (docs/ROADMAP.md 阶段 2 任务 7).
 *
 * Turns "the player right-clicked at world tile (x, y) with this selection" into
 * a list of `Action`s. The rules mirror the simulation's validator exactly, so
 * the common cases never produce a rejected order:
 *
 *   ground                  → `move`   (A* is the server's job)
 *   own crystal / own base  → `gather` (workers) / `move` (soldiers)
 *   visible enemy           → `attack` (soldiers; workers just walk closer)
 *   own construction site   → `build-assist`, expressed as `move` onto it
 *
 * Workers and soldiers are split automatically: ordering a mixed group at an
 * enemy sends the soldiers to fight and the workers to a nearby gathering spot,
 * which is what a human expects and what keeps every emitted action legal.
 *
 * There is no client-side "cheat": an order for an entity the server cannot see
 * is simply rejected and logged — this module only avoids the obvious mistakes.
 */

import type { Action, BuildingKind, UnitKind } from '../../shared/types';
import type { SampledEntity } from '../interp';
import {
  KIND_BARRACKS,
  KIND_BASE,
  KIND_CRYSTAL,
  KIND_SOLDIER,
  KIND_WORKER,
  OWNER_HUMAN,
  OWNER_LLM,
} from '../state/WorldModel';

export interface CommandTarget {
  /** Tile the click landed on. */
  tileX: number;
  tileY: number;
  /** Entity under the cursor, if any (interpolated sample). */
  entity: SampledEntity | null;
  /** Fractional world position of the click, in tiles. */
  worldX: number;
  worldY: number;
}

export interface CommandContext {
  selection: readonly string[];
  entities: readonly SampledEntity[];
  /** True when a worker is standing on / next to its own construction site. */
  ownConstructionSiteIds?: ReadonlySet<string>;
}

/** Split a selection into workers and soldiers using the sampled rows. */
export function splitSelection(
  selection: readonly string[],
  entities: readonly SampledEntity[],
): { workers: string[]; soldiers: string[] } {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const workers: string[] = [];
  const soldiers: string[] = [];
  for (const id of selection) {
    const entity = byId.get(id);
    if (entity === undefined) continue;
    if (entity.k === KIND_WORKER) workers.push(id);
    else if (entity.k === KIND_SOLDIER) soldiers.push(id);
  }
  return { workers, soldiers };
}

export interface ResolvedCommand {
  actions: Action[];
  /** Short label for the HUD toast ("move", "gather", "attack", ...). */
  label: string;
}

/**
 * Resolve a right-click into orders. Returns `null` when nothing should be sent
 * (empty selection, or a click that has no meaningful meaning).
 */
export function resolveRightClick(
  context: CommandContext,
  target: CommandTarget,
): ResolvedCommand | null {
  const { workers, soldiers } = splitSelection(context.selection, context.entities);
  if (workers.length === 0 && soldiers.length === 0) return null;

  const entity = target.entity;
  const tileX = clampTile(target.tileX);
  const tileY = clampTile(target.tileY);

  // ── Own construction site: give the workers a hand ────────────────────────
  if (entity !== null && isOwnBuilding(entity, context.ownConstructionSiteIds)) {
    const actions: Action[] = [];
    if (workers.length > 0) {
      actions.push({ type: 'move', unitIds: workers, x: tileX, y: tileY });
    }
    if (soldiers.length > 0) {
      actions.push({ type: 'move', unitIds: soldiers, x: tileX, y: tileY });
    }
    return { actions, label: 'assist' };
  }

  // ── Crystal node: workers gather, soldiers hold position ──────────────────
  if (entity !== null && entity.k === KIND_CRYSTAL) {
    const actions: Action[] = [];
    if (workers.length > 0) {
      actions.push({ type: 'gather', unitIds: workers, targetId: entity.id });
    }
    if (soldiers.length > 0) {
      actions.push({ type: 'move', unitIds: soldiers, x: tileX, y: tileY });
    }
    return { actions, label: 'gather' };
  }

  // ── Visible enemy: soldiers attack, workers fall back ────────────────────
  if (entity !== null && isEnemyEntity(entity)) {
    const actions: Action[] = [];
    if (soldiers.length > 0) {
      actions.push({ type: 'attack', unitIds: soldiers, targetId: entity.id });
    }
    if (workers.length > 0) {
      // Workers cannot initiate an attack (constants: canInitiateAttack=false),
      // so they are pulled back towards the base instead of standing in a fight.
      actions.push({ type: 'hold', unitIds: workers });
    }
    return { actions, label: workers.length > 0 ? 'attack (workers hold)' : 'attack' };
  }

  // ── Own base / barracks: a worker walks over (deposit / assist) ───────────
  if (
    entity !== null &&
    entity.o === OWNER_HUMAN &&
    (entity.k === KIND_BASE || entity.k === KIND_BARRACKS)
  ) {
    return {
      actions: [{ type: 'move', unitIds: [...workers, ...soldiers], x: tileX, y: tileY }],
      label: 'move',
    };
  }

  // ── Plain ground ─────────────────────────────────────────────────────────
  return {
    actions: [{ type: 'move', unitIds: [...workers, ...soldiers], x: tileX, y: tileY }],
    label: 'move',
  };
}

function isOwnBuilding(
  entity: SampledEntity,
  ownConstructionSiteIds?: ReadonlySet<string>,
): boolean {
  if (entity.o !== OWNER_HUMAN) return false;
  if (entity.k !== KIND_BASE && entity.k !== KIND_BARRACKS) return false;
  if (ownConstructionSiteIds === undefined) return false;
  return ownConstructionSiteIds.has(entity.id);
}

function isEnemyEntity(entity: SampledEntity): boolean {
  return entity.o === OWNER_LLM;
}

function clampTile(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const tile = Math.floor(value);
  return tile < 0 ? 0 : tile > 1023 ? 1023 : tile;
}

// ── Keyboard shortcuts → semantic orders (testable without Phaser) ──────────

/** Order a selection to gather the nearest node without aiming at one. */
export function gatherNearest(selection: readonly string[]): Action | null {
  if (selection.length === 0) return null;
  // `targetId` omitted: the server picks the nearest crystal for us, which is
  // exactly the documented behaviour of the gather action.
  return { type: 'gather', unitIds: [...selection] };
}

export function holdPosition(selection: readonly string[]): Action | null {
  if (selection.length === 0) return null;
  return { type: 'hold', unitIds: [...selection] };
}

export function stopUnit(selection: readonly string[]): Action | null {
  if (selection.length === 0) return null;
  // "Stop" is modelled as hold (clear path, keep the ground); the MVP has no
  // separate stop action, so this is the closest legal equivalent.
  return { type: 'hold', unitIds: [...selection] };
}

/** Queue a train order on a building (phase 3 UI, kept here for reuse). */
export function trainUnit(buildingId: string, unitType: UnitKind): Action {
  return { type: 'train', buildingId, unitType };
}

/** Queue a build order for workers (phase 3 UI, kept here for reuse). */
export function buildStructure(
  unitIds: readonly string[],
  buildingType: BuildingKind,
  x: number,
  y: number,
): Action {
  return { type: 'build', unitIds: [...unitIds], buildingType, x, y };
}

