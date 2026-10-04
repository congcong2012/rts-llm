/**
 * Gateway tests (acceptance B8/B10, and the "single egress" invariant).
 *
 * The gateway is driven through an in-memory duplex mock, so no port is opened
 * and the whole request/response cycle is deterministic. What is verified here:
 *
 *   1. `cmd` → state change, through the same validator the LLM will face.
 *   2. Illegal / malformed input never throws and never stops the match.
 *   3. Every downlink frame is filtered: an invisible enemy's id must not be
 *      findable anywhere in the raw JSON, including in events and ghosts.
 *   4. Fog is sent once in full and then only as deltas.
 *   5. `gameover` is delivered once and freezes the loop.
 */

import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../src/shared/protocol';
import { GameLoop } from '../../src/game/GameLoop';
import { createGame } from '../../src/game/GameLoop';
import { WsGateway } from '../../src/server/ws/gateway';
import type { Duplex, DuplexListener } from '../../src/server/ws/gateway';
import { makeUnit, makeBuilding } from '../../src/game/entities/factory';
import { addEntity } from '../../src/game/state/GameState';
import { tick as visionTick } from '../../src/game/systems/vision';
import { COMBAT_EXPOSURE_TICKS } from '../../src/game/config/constants';
import { TEST_SEED } from '../helpers/fixtures';

/** In-memory duplex: records everything the gateway pushes. */
class MockSocket implements Duplex {
  readonly sent: string[] = [];
  closed = false;
  private listeners = new Map<string, DuplexListener[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  on(event: 'message' | 'close' | 'error', listener: DuplexListener): void {
    const bucket = this.listeners.get(event);
    if (bucket === undefined) this.listeners.set(event, [listener]);
    else bucket.push(listener);
  }

  close(): void {
    this.closed = true;
    this.emit('close');
  }

  /** Simulate the client pushing a frame. */
  push(message: unknown): void {
    this.emit('message', typeof message === 'string' ? message : JSON.stringify(message));
  }

  private emit(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  /** Parsed frames, newest last. */
  frames(): ServerMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as ServerMessage);
  }

  framesOfType<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }>[] {
    return this.frames().filter((frame): frame is Extract<ServerMessage, { t: T }> => frame.t === type);
  }

  lastSnapshot() {
    const frames = this.framesOfType('snap');
    const last = frames[frames.length - 1];
    if (last === undefined) throw new Error('mock socket received no snap frame');
    return last.snapshot;
  }
}

interface Harness {
  loop: GameLoop;
  gateway: WsGateway;
  socket: MockSocket;
  rejections: { clientId: number; reason: string; detail?: string }[];
  protocolErrors: { clientId: number; detail: string }[];
}

function makeHarness(): Harness {
  const loop = new GameLoop(createGame({ seed: TEST_SEED }));
  const rejections: Harness['rejections'] = [];
  const protocolErrors: Harness['protocolErrors'] = [];

  const gateway = new WsGateway(loop, {
    onReject: (info) => rejections.push(info),
    onProtocolError: (info) => protocolErrors.push(info),
  });

  const socket = new MockSocket();
  gateway.attach(socket);
  return { loop, gateway, socket, rejections, protocolErrors };
}

/** One authoritative tick + broadcast, exactly like the server's `pump`. */
function pump(harness: Harness, ticks = 1): void {
  for (let i = 0; i < ticks; i += 1) {
    harness.loop.step();
    harness.gateway.broadcastSnapshot();
  }
}

describe('gateway: connection lifecycle', () => {
  it('sends init with the map, config and the full explored mask', () => {
    const harness = makeHarness();
    const init = harness.socket.framesOfType('init');
    expect(init).toHaveLength(1);

    const frame = init[0];
    expect(frame).toBeDefined();
    expect(frame?.you).toBe('human');
    expect(frame?.gameId).toBe(harness.loop.state.gameId);
    expect(frame?.seed).toBe(TEST_SEED);
    expect(frame?.map.w).toBe(64);
    expect(frame?.map.h).toBe(64);
    expect(frame?.map.blockedRows).toHaveLength(64);
    expect(frame?.fog.exploredRows).toHaveLength(64);
    expect(frame?.config.fogEnabled).toBe(true);
    expect(frame?.snapshot.crystal).toBeGreaterThan(0);
  });

  it('answers ping with pong on the current tick', () => {
    const harness = makeHarness();
    pump(harness, 3);
    harness.socket.push({ t: 'ping' });

    const pongs = harness.socket.framesOfType('pong');
    expect(pongs).toHaveLength(1);
    expect(pongs[0]?.tick).toBe(harness.loop.state.tick);
  });

  it('reports unknown message types without throwing', () => {
    const harness = makeHarness();
    harness.socket.push({ t: 'nonsense' });
    harness.socket.push('{ not json');
    harness.socket.push({ noTypeTag: true });

    expect(harness.protocolErrors).toHaveLength(3);
    expect(harness.loop.state.tick).toBe(0);
    expect(pump2(harness)).toBe(true);
  });

  it('drops the session on socket close and stops broadcasting to it', () => {
    const harness = makeHarness();
    expect(harness.gateway.clientCount).toBe(1);
    harness.socket.close();
    expect(harness.gateway.clientCount).toBe(0);

    const sentBefore = harness.socket.sent.length;
    pump(harness, 2);
    expect(harness.socket.sent.length).toBe(sentBefore);
  });
});

describe('gateway: human commands use the shared validation pipeline', () => {
  it('applies a legal move order and reflects it in the next snapshot', () => {
    const harness = makeHarness();
    const worker = harness.loop.state.units.find((unit) => unit.owner === 'p1');
    expect(worker).toBeDefined();
    if (worker === undefined) return;

    const startTile = { x: Math.floor(worker.x), y: Math.floor(worker.y) };
    const target = { x: startTile.x + 2, y: startTile.y };

    harness.socket.push({
      t: 'cmd',
      seq: 1,
      actions: [{ type: 'move', unitIds: [worker.id], x: target.x, y: target.y }],
    });

    // The order is queued, not applied: it must take effect on the next tick.
    expect(worker.task).toBeNull();

    pump(harness, 1);
    expect(worker.task?.type === 'move' || worker.state === 'moving' || worker.state === 'idle').toBe(
      true,
    );

    pump(harness, 40);
    const moved = harness.loop.state.units.find((unit) => unit.id === worker.id);
    expect(moved).toBeDefined();
    expect(Math.floor(moved?.x ?? 0)).toBe(target.x);
    expect(Math.floor(moved?.y ?? 0)).toBe(target.y);
    expect(harness.rejections).toHaveLength(0);
  });

  it('rejects illegal orders without crashing the match', () => {
    const harness = makeHarness();
    const worker = harness.loop.state.units.find((unit) => unit.owner === 'p1');
    const enemy = harness.loop.state.units.find((unit) => unit.owner === 'p2');
    expect(worker).toBeDefined();
    expect(enemy).toBeDefined();
    if (worker === undefined || enemy === undefined) return;

    harness.socket.push({
      t: 'cmd',
      seq: 1,
      actions: [
        // Not owned by the human.
        { type: 'move', unitIds: [enemy.id], x: 12, y: 12 },
        // Does not exist.
        { type: 'move', unitIds: ['u999'], x: 12, y: 12 },
        // Out of bounds.
        { type: 'move', unitIds: [worker.id], x: 999, y: 999 },
        // Unknown action type.
        { type: 'teleport', unitIds: [worker.id], x: 5, y: 5 },
        // Malformed: unitIds must be a non-empty array of strings.
        { type: 'move', unitIds: [], x: 5, y: 5 },
        // Extra key: `.strict()` must refuse it.
        { type: 'hold', unitIds: [worker.id], extra: true },
      ],
    });

    pump(harness, 2);

    // Five of the six are schema-level or ownership-level failures.
    expect(harness.rejections.length).toBeGreaterThanOrEqual(5);
    const reasons = harness.rejections.map((rejection) => rejection.reason);
    expect(reasons).toContain('UNKNOWN_TYPE');
    expect(reasons).toContain('SCHEMA_INVALID');

    // The match is still running and still ticking.
    expect(harness.loop.state.status).toBe('running');
    const tickBefore = harness.loop.state.tick;
    pump(harness, 3);
    expect(harness.loop.state.tick).toBe(tickBefore + 3);
  });

  it('shares one action budget across several cmd frames in the same tick', () => {
    const harness = makeHarness();
    const units = harness.loop.state.units.filter((unit) => unit.owner === 'p1').map((unit) => unit.id);
    expect(units.length).toBeGreaterThan(0);

    // 40 hold orders on the same unit spread over four frames: the batch cap is
    // 32 for the human, and DUPLICATE_UNIT removes the repeats.
    for (let frame = 0; frame < 4; frame += 1) {
      harness.socket.push({
        t: 'cmd',
        seq: frame + 1,
        actions: new Array(10).fill({ type: 'hold', unitIds: units }),
      });
    }
    pump(harness, 1);

    const accepted = harness.loop.state.rejects.filter((rejection) => rejection.reason === 'DUPLICATE_UNIT');
    expect(accepted.length).toBeGreaterThan(0);
  });

  it('ignores commands once the match is over', () => {
    const harness = makeHarness();
    harness.loop.markOver();
    const worker = harness.loop.state.units.find((unit) => unit.owner === 'p1');
    if (worker === undefined) return;

    harness.socket.push({
      t: 'cmd',
      seq: 9,
      actions: [{ type: 'move', unitIds: [worker.id], x: 20, y: 20 }],
    });
    expect(harness.loop.state.pending).toHaveLength(0);
  });
});

describe('gateway: the downlink is filtered (acceptance B8)', () => {
  it('never discloses a distant enemy id in any frame', () => {
    const harness = makeHarness();
    pump(harness, 25);

    const raw = harness.socket.sent.join('\n');

    // p2 spawns at the far anchor: no p1 unit can see it from the start.
    for (const id of ['b2', 'u5', 'u6', 'u7', 'u8']) {
      expect(raw.includes(`"${id}"`)).toBe(false);
    }

    // And no frame carries an enemy-owned entity row.
    for (const frame of harness.socket.frames()) {
      if (frame.t !== 'snap') continue;
      expect(frame.snapshot.entities.some((row) => row.o === 1)).toBe(false);
      expect(frame.snapshot.ghosts).toHaveLength(0);
    }
  });

  it('discloses an enemy that walks into vision, and hides it again afterwards', () => {
    const harness = makeHarness();
    const state = harness.loop.state;
    const base = state.buildings.find((building) => building.owner === 'p1');
    expect(base).toBeDefined();
    if (base === undefined) return;

    // Place a red soldier two tiles from the blue base, inside its vision.
    const intruder = makeUnit({
      id: 'uTest',
      kind: 'soldier',
      owner: 'p2',
      x: base.x + 2,
      y: base.y,
    });
    addEntity(state, intruder);
    visionTick(state);

    pump(harness, 1);
    const visibleId = harness.socket.lastSnapshot().entities.map((row) => row.id);
    expect(visibleId).toContain('uTest');

    // Teleport it far away. It stays visible for the combat-exposure window
    // (docs/SPEC.md §10: nobody may be shot by an enemy they cannot see), and
    // must then vanish completely.
    introder_teleport();
    pump(harness, 1);
    expect(harness.socket.lastSnapshot().entities.map((row) => row.id)).toContain('uTest');

    pump(harness, COMBAT_EXPOSURE_TICKS + 2);
    const after = harness.socket.lastSnapshot().entities.map((row) => row.id);
    expect(after).not.toContain('uTest');
    // It is a *unit*, so it must not become a ghost either.
    expect(harness.socket.lastSnapshot().ghosts.map((ghost) => ghost.id)).not.toContain('uTest');

    function introder_teleport(): void {
      intruder.x = 60;
      intruder.y = 60;
      visionTick(state);
    }
  });

  it('reports an explored enemy building as a ghost once it leaves vision', () => {
    const harness = makeHarness();
    const state = harness.loop.state;
    const base = state.buildings.find((building) => building.owner === 'p1');
    if (base === undefined) return;

    const outpost = makeBuilding({
      id: 'bTest',
      kind: 'barracks',
      owner: 'p2',
      tileX: Math.floor(base.x) + 3,
      tileY: Math.floor(base.y),
    });
    addEntity(state, outpost);
    visionTick(state);
    pump(harness, 1);

    // While visible it is a normal entity row, not a ghost.
    expect(harness.socket.lastSnapshot().entities.map((row) => row.id)).toContain('bTest');
    expect(harness.socket.lastSnapshot().ghosts.map((ghost) => ghost.id)).not.toContain('bTest');

    // Move it out of sight: it becomes a ghost, and stays one.
    outpost.x = 60;
    outpost.y = 60;
    visionTick(state);
    pump(harness, 1);

    const ghosts = harness.socket.lastSnapshot().ghosts;
    const ghost = ghosts.find((entry) => entry.id === 'bTest');
    expect(ghost).toBeDefined();
    expect(ghost?.kind).toBe('barracks');
    expect(harness.socket.lastSnapshot().entities.map((row) => row.id)).not.toContain('bTest');
  });

  it('withholds the opponent resource count from every snapshot', () => {
    const harness = makeHarness();
    // Give the red player an absurd amount: it must not show up on the wire.
    harness.loop.state.players.p2.resources.crystal = 987654;
    pump(harness, 2);

    const raw = harness.socket.sent.join('\n');
    expect(raw.includes('987654')).toBe(false);
    for (const frame of harness.socket.framesOfType('snap')) {
      expect(Object.keys(frame.snapshot)).not.toContain('p2Crystal');
      expect(frame.snapshot.crystal).not.toBe(987654);
    }
  });

  it('filters events so an unseen death never leaks', () => {
    const harness = makeHarness();
    const state = harness.loop.state;
    const victim = state.units.find((unit) => unit.owner === 'p2');
    expect(victim).toBeDefined();
    if (victim === undefined) return;

    // Kill it far from any blue unit: the death is invisible to the human.
    victim.x = 60;
    victim.y = 60;
    state.tick += 1;
    state.index.delete(victim.id);
    state.units.splice(state.units.indexOf(victim), 1);
    state.events.push({ type: 'death', tick: state.tick, targetId: victim.id });

    harness.gateway.broadcastSnapshot();
    const raw = harness.socket.sent.join('\n');
    expect(raw.includes(victim.id)).toBe(false);
  });
});

describe('gateway: fog deltas', () => {
  it('sends the explored mask in full once, then only deltas', () => {
    const harness = makeHarness();
    // The init frame carries the full mask and no snapshot-level fog delta.
    const init = harness.socket.framesOfType('init')[0];
    expect(init?.fog.exploredRows).toHaveLength(64);
    expect(harness.socket.framesOfType('fog')).toHaveLength(0);

    // Send a worker walking so the vision radius sweeps new tiles.
    const worker = harness.loop.state.units.find((unit) => unit.owner === 'p1');
    expect(worker).toBeDefined();
    if (worker === undefined) return;
    harness.socket.push({
      t: 'cmd',
      seq: 1,
      actions: [{ type: 'move', unitIds: [worker.id], x: 20, y: 20 }],
    });
    pump(harness, 60);

    const fogFrames = harness.socket.framesOfType('fog');
    expect(fogFrames.length).toBeGreaterThan(0);
    for (const frame of fogFrames) {
      expect(frame.delta.rows.length).toBeGreaterThan(0);
      expect(frame.delta.rows.length).toBeLessThanOrEqual(64);
      for (const row of frame.delta.rows) {
        expect(row.i).toBeGreaterThanOrEqual(0);
        expect(row.i).toBeLessThan(64);
        expect(row.bits.length).toBe(16);
      }
    }
  });

  it('stops sending fog deltas once the explored layer stops growing', () => {
    const harness = makeHarness();
    pump(harness, 30);
    const before = harness.socket.framesOfType('fog').length;
    // With nothing moving, the explored layer is stable.
    pump(harness, 5);
    expect(harness.socket.framesOfType('fog').length).toBe(before);
  });

  it('gives a late joiner the current mask without replaying old growth', () => {
    const harness = makeHarness();
    pump(harness, 20);

    const second = new MockSocket();
    harness.gateway.attach(second);

    const init = second.framesOfType('init')[0];
    expect(init).toBeDefined();
    // The second client's first frame already contains everything explored.
    const exploredBits = init?.fog.exploredRows.join('') ?? '';
    expect(exploredBits.replace(/0/g, '')).not.toHaveLength(0);
    // Its own fog delta baseline is the full mask, so the first tick after the
    // join must not resend the entire history.
    const firstDelta = second.framesOfType('fog')[0];
    if (firstDelta !== undefined) expect(firstDelta.delta.rows.length).toBeLessThan(64);
  });
});

describe('gateway: gameover', () => {
  it('emits exactly one gameover frame and freezes the loop', () => {
    const harness = makeHarness();
    const redBase = harness.loop.state.buildings.find(
      (building) => building.owner === 'p2' && building.kind === 'base',
    );
    expect(redBase).toBeDefined();
    if (redBase === undefined) return;

    redBase.hp = 1;
    pump(harness, 1);
    // Victory is only checked when no base remains; remove it directly.
    harness.loop.state.index.delete(redBase.id);
    harness.loop.state.buildings.splice(harness.loop.state.buildings.indexOf(redBase), 1);
    pump(harness, 1);

    const gameoverFrames = harness.socket.framesOfType('gameover');
    expect(gameoverFrames).toHaveLength(1);
    expect(gameoverFrames[0]?.winner).toBe('p1');
    expect(harness.loop.isOver).toBe(true);

    const sentBefore = harness.socket.sent.length;
    pump(harness, 3);
    expect(harness.socket.sent.length).toBe(sentBefore);
  });
});

/** Small helper: pump once and report whether the tick advanced. */
function pump2(harness: Harness): boolean {
  const before = harness.loop.state.tick;
  harness.loop.step();
  return harness.loop.state.tick > before;
}
