/**
 * The ten-step validation pipeline (docs/SPEC.md §8.2).
 *
 * Each row of the table below pins the reason code produced by one failure
 * mode, so a regression in ordering (e.g. reporting NOT_IN_LEGAL_ACTIONS where
 * BLOCKED_TILE is expected) fails the suite.
 */

import { describe, expect, it } from 'vitest';
import type { RejectReason, ValidationResult } from '../../src/shared/types';
import { buildLegalActions } from '../../src/game/actions/legalActions';
import { isActionAcceptable, validateBatch } from '../../src/game/actions/validator';
import { placeBarracks } from '../helpers/fixtures';
import type { ArenaSetup } from '../helpers/fixtures';
import { makeValidatorArena } from '../helpers/fixtures';

type Case = {
  name: string;
  /** Build the raw payload; may tweak the arena first. */
  make: (arena: ArenaSetup) => unknown;
  expect: RejectReason | 'ACCEPTED';
};

const cases: Case[] = [
  // ── train ────────────────────────────────────────────────────────────────
  {
    name: 'train worker from own base',
    make: (a) => ({ type: 'train', buildingId: a.p1Base.id, unitType: 'worker' }),
    expect: 'ACCEPTED',
  },
  {
    name: 'train from an unknown building',
    make: () => ({ type: 'train', buildingId: 'b99', unitType: 'worker' }),
    expect: 'ENTITY_NOT_FOUND',
  },
  {
    name: 'train from the enemy base',
    make: (a) => ({ type: 'train', buildingId: a.p2Base.id, unitType: 'worker' }),
    expect: 'NOT_OWNED',
  },
  {
    name: 'base cannot train soldiers',
    make: (a) => ({ type: 'train', buildingId: a.p1Base.id, unitType: 'soldier' }),
    expect: 'PRODUCTION_BLOCKED',
  },
  {
    name: 'train without enough crystal',
    make: (a) => {
      a.state.players.p1.resources.crystal = 10;
      return { type: 'train', buildingId: a.p1Base.id, unitType: 'worker' };
    },
    expect: 'INSUFFICIENT_RESOURCE',
  },
  {
    name: 'train at the population cap',
    make: (a) => {
      a.state.config.popCap = 2; // p1 already owns 1 worker + 1 soldier
      return { type: 'train', buildingId: a.p1Base.id, unitType: 'worker' };
    },
    expect: 'POP_CAP_REACHED',
  },

  // ── move ─────────────────────────────────────────────────────────────────
  {
    name: 'move own worker',
    make: (a) => ({ type: 'move', unitIds: [a.p1Worker.id], x: 5, y: 5 }),
    expect: 'ACCEPTED',
  },
  {
    name: 'move an unknown unit',
    make: () => ({ type: 'move', unitIds: ['u404'], x: 5, y: 5 }),
    expect: 'ENTITY_NOT_FOUND',
  },
  {
    name: 'move an enemy unit',
    make: (a) => ({ type: 'move', unitIds: [a.farEnemy.id], x: 5, y: 5 }),
    expect: 'NOT_OWNED',
  },
  {
    name: 'move outside the map',
    make: (a) => ({ type: 'move', unitIds: [a.p1Worker.id], x: 99, y: 5 }),
    expect: 'OUT_OF_BOUNDS',
  },
  {
    name: 'move into rock',
    make: (a) => ({ type: 'move', unitIds: [a.p1Worker.id], x: a.rock.x, y: a.rock.y }),
    expect: 'BLOCKED_TILE',
  },
  {
    name: 'fractional coordinates are not a tile',
    make: (a) => ({ type: 'move', unitIds: [a.p1Worker.id], x: 5.5, y: 5 }),
    expect: 'SCHEMA_INVALID',
  },
  {
    name: 'unknown extra field is rejected',
    make: (a) => ({ type: 'move', unitIds: [a.p1Worker.id], x: 5, y: 5, note: 'sneaky' }),
    expect: 'SCHEMA_INVALID',
  },
  {
    name: 'a string coordinate is rejected',
    make: (a) => ({ type: 'move', unitIds: [a.p1Worker.id], x: '5', y: 5 }),
    expect: 'SCHEMA_INVALID',
  },
  {
    name: 'unitIds must be an array',
    make: () => ({ type: 'move', unitIds: 'u1', x: 5, y: 5 }),
    expect: 'SCHEMA_INVALID',
  },
  {
    name: 'garbage payload',
    make: () => ({ nonsense: true }),
    expect: 'SCHEMA_INVALID',
  },
  {
    name: 'null payload',
    make: () => null,
    expect: 'SCHEMA_INVALID',
  },

  // ── attack ───────────────────────────────────────────────────────────────
  {
    name: 'soldier attacks a visible enemy',
    make: (a) => ({ type: 'attack', unitIds: [a.p1Soldier.id], targetId: a.nearEnemy.id }),
    expect: 'ACCEPTED',
  },
  {
    name: 'a worker may not initiate an attack',
    make: (a) => ({ type: 'attack', unitIds: [a.p1Worker.id], targetId: a.nearEnemy.id }),
    expect: 'INVALID_STATE',
  },
  {
    name: 'attack an unseen enemy is rejected',
    make: (a) => ({ type: 'attack', unitIds: [a.p1Soldier.id], targetId: a.farEnemy.id }),
    expect: 'INVALID_TARGET',
  },
  {
    name: 'attack your own entity is rejected',
    make: (a) => ({ type: 'attack', unitIds: [a.p1Soldier.id], targetId: a.p1Base.id }),
    expect: 'INVALID_TARGET',
  },
  {
    name: 'crystal nodes are not attackable',
    make: (a) => ({ type: 'attack', unitIds: [a.p1Soldier.id], targetId: a.crystal.id }),
    expect: 'INVALID_TARGET',
  },
  {
    name: 'attack an unknown target',
    make: (a) => ({ type: 'attack', unitIds: [a.p1Soldier.id], targetId: 'e9' }),
    expect: 'ENTITY_NOT_FOUND',
  },

  // ── gather ───────────────────────────────────────────────────────────────
  {
    name: 'worker gathers a specific node',
    make: (a) => ({ type: 'gather', unitIds: [a.p1Worker.id], targetId: a.crystal.id }),
    expect: 'ACCEPTED',
  },
  {
    name: 'gather may omit the target (auto nearest)',
    make: (a) => ({ type: 'gather', unitIds: [a.p1Worker.id] }),
    expect: 'ACCEPTED',
  },
  {
    name: 'soldiers cannot gather',
    make: (a) => ({ type: 'gather', unitIds: [a.p1Soldier.id], targetId: a.crystal.id }),
    expect: 'INVALID_STATE',
  },
  {
    name: 'gathering a depleted node is rejected',
    make: (a) => ({ type: 'gather', unitIds: [a.p1Worker.id], targetId: a.depleted.id }),
    expect: 'INVALID_TARGET',
  },
  {
    name: 'gathering an unknown node',
    make: (a) => ({ type: 'gather', unitIds: [a.p1Worker.id], targetId: 'r99' }),
    expect: 'ENTITY_NOT_FOUND',
  },

  // ── build ────────────────────────────────────────────────────────────────
  {
    name: 'worker builds a barracks on a free tile',
    make: (a) => ({
      type: 'build',
      unitIds: [a.p1Worker.id],
      buildingType: 'barracks',
      x: a.free.x,
      y: a.free.y,
    }),
    expect: 'ACCEPTED',
  },
  {
    name: 'the base cannot be built',
    make: (a) => ({
      type: 'build',
      unitIds: [a.p1Worker.id],
      buildingType: 'base',
      x: a.free.x,
      y: a.free.y,
    }),
    expect: 'PRODUCTION_BLOCKED',
  },
  {
    name: 'cannot build on rock',
    make: (a) => ({
      type: 'build',
      unitIds: [a.p1Worker.id],
      buildingType: 'barracks',
      x: a.rock.x,
      y: a.rock.y,
    }),
    expect: 'BLOCKED_TILE',
  },
  {
    name: 'cannot build on top of the base',
    make: (a) => ({
      type: 'build',
      unitIds: [a.p1Worker.id],
      buildingType: 'barracks',
      x: 2,
      y: 2,
    }),
    expect: 'BLOCKED_TILE',
  },
  {
    name: 'cannot build without crystal',
    make: (a) => {
      a.state.players.p1.resources.crystal = 10;
      return {
        type: 'build',
        unitIds: [a.p1Worker.id],
        buildingType: 'barracks',
        x: a.free.x,
        y: a.free.y,
      };
    },
    expect: 'INSUFFICIENT_RESOURCE',
  },
  {
    name: 'barracks limit is enforced',
    make: (a) => {
      placeBarracks(a.state, 'p1', 1, 5);
      placeBarracks(a.state, 'p1', 1, 6);
      return {
        type: 'build',
        unitIds: [a.p1Worker.id],
        buildingType: 'barracks',
        x: a.free.x,
        y: a.free.y,
      };
    },
    expect: 'PRODUCTION_BLOCKED',
  },

  // ── hold / noop ──────────────────────────────────────────────────────────
  {
    name: 'hold own units',
    make: (a) => ({ type: 'hold', unitIds: [a.p1Worker.id, a.p1Soldier.id] }),
    expect: 'ACCEPTED',
  },
  {
    name: 'hold an enemy unit',
    make: (a) => ({ type: 'hold', unitIds: [a.farEnemy.id] }),
    expect: 'NOT_OWNED',
  },
  {
    name: 'noop is always allowed',
    make: () => ({ type: 'noop' }),
    expect: 'ACCEPTED',
  },
  {
    name: 'noop rejects extra fields',
    make: () => ({ type: 'noop', reason: 'because' }),
    expect: 'SCHEMA_INVALID',
  },
];

describe('validateAction — pipeline table', () => {
  for (const testCase of cases) {
    it(`${testCase.expect === 'ACCEPTED' ? 'accepts' : `rejects (${testCase.expect})`}: ${testCase.name}`, () => {
      const arena = makeValidatorArena();
      const raw = testCase.make(arena);
      const result: ValidationResult = isActionAcceptable(arena.state, 'p1', raw, {
        enforceLegal: false,
      });
      if (testCase.expect === 'ACCEPTED') {
        expect(result, JSON.stringify(raw)).toEqual({ ok: true });
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason, JSON.stringify(raw)).toBe(testCase.expect);
      }
    });
  }
});

describe('validateAction — legal action membership (step 9)', () => {
  it('rejects an action outside the advertised legal set', () => {
    const arena = makeValidatorArena();
    const legal = buildLegalActions(arena.state, 'p1');
    const result = isActionAcceptable(
      arena.state,
      'p1',
      { type: 'move', unitIds: [arena.p1Worker.id], x: 1, y: 1 },
      { enforceLegal: true, legal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_IN_LEGAL_ACTIONS');
  });

  it('accepts an action inside the advertised legal set', () => {
    const arena = makeValidatorArena();
    const legal = buildLegalActions(arena.state, 'p1');
    const target = legal.move?.targets[0];
    expect(target).toBeDefined();
    if (target === undefined) return;
    const result = isActionAcceptable(
      arena.state,
      'p1',
      { type: 'move', unitIds: [arena.p1Worker.id], x: target.x, y: target.y },
      { enforceLegal: true, legal },
    );
    expect(result).toEqual({ ok: true });
  });

  it('treats noop as legal without a candidate set, and guards other actions', () => {
    const arena = makeValidatorArena();
    // noop never needs the set: it is legal by definition.
    expect(
      isActionAcceptable(arena.state, 'p1', { type: 'noop' }, { enforceLegal: true }),
    ).toEqual({ ok: true });

    // Any other action without a set is an internal error, not a crash.
    const move = isActionAcceptable(
      arena.state,
      'p1',
      { type: 'move', unitIds: [arena.p1Worker.id], x: 5, y: 5 },
      { enforceLegal: true },
    );
    expect(move.ok).toBe(false);
    if (!move.ok) expect(move.reason).toBe('INTERNAL_ERROR');
  });
});

describe('validateBatch — batch level rules', () => {
  it('drops a second order for the same unit (DUPLICATE_UNIT)', () => {
    const arena = makeValidatorArena();
    const batch = validateBatch(
      arena.state,
      'p1',
      [
        { type: 'move', unitIds: [arena.p1Worker.id], x: 5, y: 5 },
        { type: 'move', unitIds: [arena.p1Worker.id], x: 6, y: 6 },
      ],
      { enforceLegal: false, maxActions: 12, source: 'human' },
    );
    expect(batch.accepted).toHaveLength(1);
    expect(batch.rejected).toHaveLength(1);
    expect(batch.rejected[0]?.reason).toBe('DUPLICATE_UNIT');
  });

  it('enforces the per-batch action budget', () => {
    const arena = makeValidatorArena();
    const raws = Array.from({ length: 4 }, () => ({ type: 'noop' }));
    const batch = validateBatch(arena.state, 'p1', raws, {
      enforceLegal: false,
      maxActions: 3,
      source: 'llm',
    });
    expect(batch.accepted).toHaveLength(3);
    expect(batch.rejected).toHaveLength(1);
    expect(batch.rejected[0]?.reason).toBe('TURN_BUDGET_EXCEEDED');
  });

  it('keeps processing the batch after a bad entry', () => {
    const arena = makeValidatorArena();
    const batch = validateBatch(
      arena.state,
      'p1',
      [
        { type: 'move', unitIds: ['u404'], x: 1, y: 1 },
        { type: 'train', buildingId: arena.p1Base.id, unitType: 'worker' },
        { nonsense: 1 },
        { type: 'hold', unitIds: [arena.p1Soldier.id] },
      ],
      { enforceLegal: false, maxActions: 12, source: 'llm' },
    );
    expect(batch.accepted).toHaveLength(2);
    expect(batch.rejected.map((r) => r.reason)).toEqual(['ENTITY_NOT_FOUND', 'SCHEMA_INVALID']);
  });
});
