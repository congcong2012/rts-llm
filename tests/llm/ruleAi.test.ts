/**
 * RuleAi invariant (acceptance A7).
 *
 * The rule AI doubles as the LLM fallback, so it must be *impossible* for it to
 * produce an illegal action. This suite samples 200 real positions from two
 * different matches and runs every decision through the validator with legality
 * enforcement turned on — the same setting the LLM path uses.
 */

import { describe, expect, it } from 'vitest';
import { buildLegalActions } from '../../src/game/actions/legalActions';
import { validateBatch } from '../../src/game/actions/validator';
import { createGame, stepTick } from '../../src/game/GameLoop';
import { PLAYERS } from '../../src/shared/types';
import { decide } from '../../src/llm/ruleAi';
import { makeValidatorArena } from '../helpers/fixtures';

const SAMPLES = 200;

interface SampleResult {
  samples: number;
  rejections: string[];
  emptyDecisions: number;
  actionCount: number;
}

function sampleMatch(seed: number): SampleResult {
  const state = createGame({ seed });
  const result: SampleResult = { samples: 0, rejections: [], emptyDecisions: 0, actionCount: 0 };

  while (result.samples < SAMPLES / 2 && state.status === 'running' && state.tick < 9000) {
    if (state.tick % 20 === 0) {
      for (const player of PLAYERS) {
        const decision = decide(state, player);
        result.samples += 1;
        result.actionCount += decision.actions.length;
        if (decision.actions.length === 0) result.emptyDecisions += 1;

        const legal = buildLegalActions(state, player);
        const batch = validateBatch(state, player, decision.actions, {
          enforceLegal: true,
          legal,
          maxActions: 12,
          source: 'llm',
        });
        for (const rejection of batch.rejected) {
          result.rejections.push(`${player}@${state.tick} ${rejection.reason} ${JSON.stringify(rejection.action)}`);
        }
      }
    }
    stepTick(state);
  }

  return result;
}

describe('rule AI legality', () => {
  it(`produces 100% legal actions across ${SAMPLES} sampled decisions`, () => {
    const first = sampleMatch(12345);
    const second = sampleMatch(999);
    const rejections = [...first.rejections, ...second.rejections];
    const samples = first.samples + second.samples;

    expect(samples).toBeGreaterThanOrEqual(SAMPLES - 2);
    expect(rejections).toEqual([]);
    expect(first.emptyDecisions + second.emptyDecisions).toBe(0);
    expect(first.actionCount + second.actionCount).toBeGreaterThan(samples);
  });

  it('never references an entity that does not exist', () => {
    const state = createGame({ seed: 77 });
    for (let i = 0; i < 40 && state.status === 'running'; i += 1) {
      for (const player of PLAYERS) {
        for (const action of decide(state, player).actions) {
          const ids =
            'unitIds' in action ? action.unitIds : 'buildingId' in action ? [action.buildingId] : [];
          for (const id of ids) {
            expect(state.index.has(id), `${id} missing in ${JSON.stringify(action)}`).toBe(true);
          }
        }
      }
      state.tick += 20;
      stepTick(state);
      state.tick += 19;
    }
    expect(state.tick).toBeGreaterThan(0);
  });

  it('opens with economy: it raises workers and starts gathering', () => {
    const state = createGame({ seed: 2024 });
    const decision = decide(state, 'p2');
    const types = decision.actions.map((action) => action.type);
    expect(types).toContain('train');
    expect(decision.actions.some((a) => a.type === 'gather' || a.type === 'move')).toBe(true);
    expect(decision.reasoning.length).toBeGreaterThan(0);
  });

  it('falls back to noop on an empty board', () => {
    const arena = makeValidatorArena();
    // Remove every entity owned by p2 except nothing at all.
    const { state } = arena;
    for (const unit of [...state.units]) {
      if (unit.owner === 'p2') state.index.delete(unit.id);
    }
    state.units = state.units.filter((unit) => unit.owner !== 'p2');
    state.buildings = state.buildings.filter((building) => building.owner !== 'p2');
    for (const building of [...state.index.values()]) {
      if (building.owner === 'p2') state.index.delete(building.id);
    }

    const decision = decide(state, 'p2');
    expect(decision.actions).toEqual([{ type: 'noop' }]);
  });

  it('is deterministic for the same position', () => {
    const state = createGame({ seed: 31 });
    const a = decide(state, 'p1');
    const b = decide(state, 'p1');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
