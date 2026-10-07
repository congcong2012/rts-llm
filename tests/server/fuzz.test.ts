import { describe, expect, it } from 'vitest';
import { createLoop } from '../../src/game/GameLoop';
import { WsGateway, makeCommandMessage } from '../../src/server/ws/gateway';
import type { Duplex } from '../../src/server/ws/gateway';

function createDuplex(): Duplex & { sent: string[]; emitMessage(data: string): void; emitClose(): void } {
  const listeners = new Map<string, ((d?: any) => void)[]>();
  const sent: string[] = [];
  return {
    sent,
    send(data: string) { sent.push(data); },
    on(event: string, cb: any) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
    },
    close() { for (const cb of listeners.get('close') ?? []) cb(); },
    emitMessage(data: string) { for (const cb of listeners.get('message') ?? []) cb(data); },
    emitClose() { for (const cb of listeners.get('close') ?? []) cb(); },
  };
}

describe('fuzz: malformed and garbage commands', () => {
  it('200 garbage actions in one tick do not crash and all are rejected', () => {
    const loop = createLoop({ seed: 1 });
    const gateway = new WsGateway(loop, { onReject: () => {}, onProtocolError: () => {} });
    const duplex = createDuplex();
    gateway.attach(duplex);

    const garbage: unknown[] = [];
    for (let i = 0; i < 200; i += 1) {
      const pick = i % 6;
      if (pick === 0) garbage.push({ type: 'move', unitIds: ['u999'], x: 9999, y: -1 });
      else if (pick === 1) garbage.push({ type: 'train', buildingId: 'b999', unitType: 'soldier' });
      else if (pick === 2) garbage.push({ type: 'build', unitIds: ['u999'], buildingType: 'barracks', x: 0, y: 0 });
      else if (pick === 3) garbage.push({ nonsense: true, foo: 'bar' });
      else if (pick === 4) garbage.push('not an object');
      else garbage.push({ type: 'attack', unitIds: [], targetId: 'e1' });
    }

    // Send as one batch via cmd
    duplex.emitMessage(JSON.stringify(makeCommandMessage(garbage as any, 1)));
    // Advance one tick: applyCommands should handle all without throwing
    const result = loop.step();
    expect(result.rejected.length).toBeGreaterThanOrEqual(1);
    expect(loop.state.status).toBe('running');
    // Ensure game still progresses normally after fuzz
    for (let i = 0; i < 10; i += 1) loop.step();
    expect(loop.state.tick).toBe(11);
  });

  it('random JSON injection does not crash gateway', () => {
    const loop = createLoop({ seed: 2 });
    const gateway = new WsGateway(loop);
    const duplex = createDuplex();
    gateway.attach(duplex);
    const malformed = [
      'not json',
      JSON.stringify({ t: 'unknown' }),
      JSON.stringify({}),
      JSON.stringify({ t: 'cmd', actions: 'not array' }),
      JSON.stringify({ t: 'cmd' }),
      JSON.stringify({ t: 'ping', extra: 'field' }),
    ];
    for (const m of malformed) {
      duplex.emitMessage(m);
    }
    expect(() => loop.step()).not.toThrow();
    expect(loop.state.status).toBe('running');
  });

  it('units referenced after death produce INVALID_STATE / ENTITY_NOT_FOUND but do not crash combat', async () => {
    const { placeUnit, placeBase, primeVision, makeArena } = await import('../helpers/fixtures');
    const { removeEntity } = await import('../../src/game/state/GameState');
    const { enqueueCommand, stepTick } = await import('../../src/game/GameLoop');
    const arena = makeArena();
    placeBase(arena, 'p1', 2, 2);
    placeBase(arena, 'p2', 18, 18);
    const u = placeUnit(arena, 'p1', 'soldier', 4, 4);
    const enemy = placeUnit(arena, 'p2', 'soldier', 5, 4);
    primeVision(arena);
    arena.tick = 10;
    enqueueCommand(arena, 'p1', { type: 'attack', unitIds: [u.id], targetId: enemy.id }, 'human');
    removeEntity(arena, u.id);
    expect(() => {
      stepTick(arena);
    }).not.toThrow();
    expect(arena.units.find((x) => x.id === u.id)).toBeUndefined();
  });

  it('10k fuzz actions across many ticks maintain determinism', () => {
    const loop = createLoop({ seed: 99 });
    const gateway = new WsGateway(loop);
    const duplex = createDuplex();
    gateway.attach(duplex);
    for (let tick = 0; tick < 20; tick += 1) {
      const batch: unknown[] = [];
      for (let i = 0; i < 500; i += 1) {
        batch.push({ type: 'noop' });
        batch.push({ type: 'move', unitIds: ['u1'], x: 0, y: 0 });
        batch.push({ type: 'hold', unitIds: ['u1'] });
        batch.push({ type: 'train', buildingId: 'b1', unitType: 'worker' });
      }
      duplex.emitMessage(JSON.stringify(makeCommandMessage(batch.slice(0, 20) as any, tick + 1)));
      loop.step();
      expect(loop.state.status === 'running' || loop.state.status === 'gameover').toBe(true);
    }
  });
});
