/**
 * Entity factories.
 *
 * ── Coordinate convention (IMPORTANT) ────────────────────────────────────────
 * Every entity stores its position as a **continuous centre point**:
 *   - units are placed at the centre of their tile and then move freely;
 *   - buildings and crystal nodes are created from a *tile* coordinate and are
 *     stored at `tile + 0.5`, so `tileOf(entity.x)` always recovers the tile.
 * This means distance checks never need a per-kind conversion.
 *
 * Factories are pure: the caller allocates the id, which keeps id allocation
 * centralised and deterministic in GameState.
 */

import type {
  Building,
  BuildingKind,
  PlayerId,
  ResourceNode,
  Unit,
  UnitKind,
} from '../../shared/types';
import { BUILDING_STATS, CRYSTAL_NODE_AMOUNT, UNIT_STATS } from '../config/constants';

export interface MakeUnitParams {
  id: string;
  kind: UnitKind;
  owner: PlayerId;
  /** Continuous centre position (tile units). */
  x: number;
  y: number;
}

export function makeUnit({ id, kind, owner, x, y }: MakeUnitParams): Unit {
  const stats = UNIT_STATS[kind];
  return {
    category: 'unit',
    id,
    kind,
    owner,
    x,
    y,
    hp: stats.hp,
    maxHp: stats.hp,
    vision: stats.vision,
    state: 'idle',
    task: null,
    path: null,
    pathIndex: 0,
    destTile: null,
    carry: 0,
    cooldown: 0,
    combatExposure: -1,
    attackedBy: null,
  };
}

export interface MakeBuildingParams {
  id: string;
  kind: BuildingKind;
  owner: PlayerId;
  /** Tile coordinate — converted to a centre point internally. */
  tileX: number;
  tileY: number;
  /** Start as a construction site (barracks being built). */
  underConstruction?: boolean;
}

export function makeBuilding({
  id,
  kind,
  owner,
  tileX,
  tileY,
  underConstruction = false,
}: MakeBuildingParams): Building {
  const stats = BUILDING_STATS[kind];
  return {
    category: 'building',
    id,
    kind,
    owner,
    x: tileX + 0.5,
    y: tileY + 0.5,
    hp: underConstruction ? Math.max(1, Math.round(stats.hp * 0.1)) : stats.hp,
    maxHp: stats.hp,
    vision: stats.vision,
    state: underConstruction ? 'constructing' : 'idle',
    buildProgress: 0,
    buildTotal: stats.buildTicks,
    queue: [],
    queueProgress: 0,
  };
}

export interface MakeCrystalParams {
  id: string;
  /** Tile coordinate — converted to a centre point internally. */
  tileX: number;
  tileY: number;
  amount?: number;
}

export function makeCrystal({ id, tileX, tileY, amount }: MakeCrystalParams): ResourceNode {
  const total = amount ?? CRYSTAL_NODE_AMOUNT;
  return {
    category: 'resource',
    id,
    kind: 'crystal',
    owner: null,
    x: tileX + 0.5,
    y: tileY + 0.5,
    hp: 1,
    maxHp: 1,
    vision: 0,
    amount: total,
    maxAmount: total,
  };
}
