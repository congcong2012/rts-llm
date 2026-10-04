/**
 * Deterministic pseudo-random number generator + state hashing.
 *
 * The whole simulation draws from exactly one RNG instance owned by GameState,
 * so `seed + command log` fully determines a match (docs/SPEC.md §11).
 * `Math.random()` is forbidden anywhere in src/game.
 */

import type { Rng, UnitTask } from '../../shared/types';
import { round3 } from '../math';
import type { GameState } from '../state/GameState';

/** mulberry32 — small, fast, well-distributed for our purposes. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int(min: number, max: number): number {
      if (max <= min) return min;
      return min + Math.floor(next() * (max - min + 1));
    },
    range(min: number, max: number): number {
      return min + next() * (max - min);
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('rng.pick: empty array');
      const index = Math.min(items.length - 1, Math.floor(next() * items.length));
      // Safe: index is clamped into range.
      return items[index] as T;
    },
    state(): number {
      return a >>> 0;
    },
  };
  return rng;
}

/** FNV-1a, 32 bit, rendered as 8 hex chars. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function taskKey(task: UnitTask | null): string {
  if (task === null) return '-';
  switch (task.type) {
    case 'gather':
      return `g:${task.nodeId}`;
    case 'deposit':
      return `d:${task.baseId}`;
    case 'attack':
      return `a:${task.targetId}`;
    case 'build':
      return `b:${task.buildingId}`;
    case 'move':
      return `m:${task.x},${task.y}`;
  }
}

/**
 * Canonical hash of the authoritative state.
 *
 * Excluded on purpose:
 *  - `vision` / `intel` (derived view data, not simulation state);
 *  - `pending` commands and `events` (transient);
 *  - entity array ordering (entities are sorted by id here).
 */
export function hashState(state: GameState): string {
  const parts: string[] = [
    `s${state.seed}`,
    `t${state.tick}`,
    `st${state.status}`,
    `w${state.winner ?? '-'}`,
    `r${round3(state.players.p1.resources.crystal)},${round3(state.players.p2.resources.crystal)}`,
    `g${state.rng.state()}`,
  ];

  const units = [...state.units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const u of units) {
    parts.push(
      [
        'u',
        u.id,
        u.kind,
        u.owner,
        round3(u.x),
        round3(u.y),
        u.hp,
        u.state,
        taskKey(u.task),
        round3(u.carry),
        u.cooldown,
      ].join('|'),
    );
  }

  const buildings = [...state.buildings].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const b of buildings) {
    parts.push(
      [
        'b',
        b.id,
        b.kind,
        b.owner,
        round3(b.x),
        round3(b.y),
        b.hp,
        b.state,
        b.buildProgress,
        b.queue.join('+'),
        b.queueProgress,
      ].join('|'),
    );
  }

  const crystals = [...state.crystals].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const c of crystals) {
    parts.push(['c', c.id, round3(c.x), round3(c.y), round3(c.amount)].join('|'));
  }

  return fnv1a(parts.join(';'));
}

/** Hash of an arbitrary serialisable value — used by tests and log correlation. */
export function hashValue(value: unknown): string {
  return fnv1a(JSON.stringify(value) ?? 'undefined');
}
