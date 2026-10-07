import { describe, expect, it } from 'vitest';
import { createGame, stepTicks, stepTick, enqueueCommand } from '../../src/game/GameLoop';
import { createRecorder, replayGame, verifyReplay } from '../../src/server/replay';
import { UNIT_STATS } from '../../src/game/config/constants';
import { decide, RULE_AI_CONFIG } from '../../src/llm/ruleAi';
import { isTileFree } from '../../src/game/state/GameState';

describe('replay', () => {
  it('same seed + same trace yields same final hash', () => {
    const seed = 4242;
    const stateA = createGame({ seed });
    const recorder = createRecorder(stateA);
    // Drive both players via rule AI like simulate does? Use manual trace: train workers.
    // For determinism, we'll just record a simple fixed command sequence.
    const base = stateA.buildings.find((b) => b.owner === 'p1' && b.kind === 'base')!;
    enqueueCommand(stateA, 'p1', { type: 'train', buildingId: base.id, unitType: 'worker' }, 'human');
    recorder.record(stateA.tick, 'p1', 'human', { type: 'train', buildingId: base.id, unitType: 'worker' });
    stepTicks(stateA, 200);
    const record = recorder.finalize(stateA);
    const replayed = replayGame({ seed: record.seed, config: record.config, commands: record.commands, finalTick: record.finalTick });
    expect(replayed.hash).toBe(record.finalHash);
    expect(replayed.winner).toBe(record.winner);
  });

  it('verifyReplay reports ok when hashes match', () => {
    const seed = 7;
    const state = createGame({ seed });
    const recorder = createRecorder(state);
    // Run a short match with a couple of commands.
    for (let i = 0; i < 100; i += 1) {
      if (state.tick % 20 === 0) {
        const base = state.buildings.find((b) => b.owner === 'p1' && b.kind === 'base');
        if (base !== undefined) {
          const crystal = state.players.p1.resources.crystal;
          if (crystal >= UNIT_STATS.worker.cost && base.state === 'idle') {
            const action = { type: 'train' as const, buildingId: base.id, unitType: 'worker' as const };
            enqueueCommand(state, 'p1', action, 'human');
            recorder.record(state.tick, 'p1', 'human', action);
          }
        }
      }
      stepTick(state);
      if (state.status === 'gameover') break;
    }
    const record = recorder.finalize(state);
    const result = verifyReplay(record);
    expect(result.ok).toBe(true);
    expect(result.expected).toBe(record.finalHash);
  });

  it('detects mismatch when a command is altered', () => {
    const seed = 123;
    const state = createGame({ seed });
    const recorder = createRecorder(state);
    const base = state.buildings.find((b) => b.owner === 'p1' && b.kind === 'base')!;
    const action = { type: 'train' as const, buildingId: base.id, unitType: 'worker' as const };
    enqueueCommand(state, 'p1', action, 'human');
    recorder.record(state.tick, 'p1', 'human', action);
    stepTicks(state, 70);
    const record = recorder.finalize(state);
    // Tamper: remove the command
    const tampered = { ...record, commands: [], finalHash: record.finalHash };
    const result = verifyReplay(tampered);
    expect(result.ok).toBe(false);
  });

  it('replay reproduces construction after builder moves away and back', () => {
    const seed = 555;
    const state = createGame({ seed });
    const worker = state.units.find((u) => u.owner === 'p1' && u.kind === 'worker')!;
    const base = state.buildings.find((b) => b.owner === 'p1' && b.kind === 'base')!;
    let target: { x: number; y: number } | null = null;
    for (let dy = -4; dy <= 4 && target === null; dy += 1) {
      for (let dx = -4; dx <= 4 && target === null; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const x = Math.floor(base.x) + dx;
        const y = Math.floor(base.y) + dy;
        if (isTileFree(state, x, y)) target = { x, y };
      }
    }
    if (target === null) throw new Error('no free tile');
    const recorder = createRecorder(state);
    const build: any = { type: 'build', unitIds: [worker.id], buildingType: 'barracks', x: target.x, y: target.y };
    enqueueCommand(state, 'p1', build, 'human');
    recorder.record(state.tick, 'p1', 'human', build);
    stepTicks(state, 40);
    const site = state.buildings.find((b) => b.kind === 'barracks' && b.owner === 'p1');
    expect(site).toBeDefined();
    const progress = site!.buildProgress;
    expect(progress).toBeGreaterThan(0);
    const move: any = { type: 'move', unitIds: [worker.id], x: 50, y: 50 };
    enqueueCommand(state, 'p1', move, 'human');
    recorder.record(state.tick, 'p1', 'human', move);
    stepTicks(state, 30);
    expect(site!.buildProgress).toBe(progress); // paused
    const record = recorder.finalize(state);
    const replayed = replayGame({ seed: record.seed, config: record.config, commands: record.commands, finalTick: record.finalTick });
    expect(replayed.hash).toBe(record.finalHash);
  });

  it('headless long run hash is stable across replay (9000 ticks)', () => {
    const seed = 12345;
    const state = createGame({ seed });
    const recorder = createRecorder(state);
    for (let i = 0; i < 9000; i += 1) {
      if (state.status === 'gameover') break;
      if (state.tick % 20 === 0) {
        const d1 = decide(state, 'p1', RULE_AI_CONFIG);
        const d2 = decide(state, 'p2', RULE_AI_CONFIG);
        for (const a of d1.actions) { enqueueCommand(state, 'p1', a, 'rule'); recorder.record(state.tick, 'p1', 'rule', a); }
        for (const a of d2.actions) { enqueueCommand(state, 'p2', a, 'rule'); recorder.record(state.tick, 'p2', 'rule', a); }
      }
      stepTick(state);
    }
    const record = recorder.finalize(state);
    const replayed = replayGame({ seed: record.seed, config: record.config, commands: record.commands, finalTick: record.finalTick });
    expect(replayed.hash).toBe(record.finalHash);
    expect(replayed.tick).toBe(record.finalTick);
  });
});
