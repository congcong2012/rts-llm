import { describe, expect, it } from 'vitest';
import { enqueueCommand, stepTick, stepTicks } from '../../src/game/GameLoop';
import { BUILDING_STATS, UNIT_STATS } from '../../src/game/config/constants';
import { makeArena, placeBase, placeCrystal, placeUnit, primeVision } from '../helpers/fixtures';
import { snapshotForHuman } from '../../src/game/view/snapshot';
import { tick as visionTick, isSightingFresh } from '../../src/game/systems/vision';

describe('stage3: training and building boundaries', () => {
  it('exactly enough crystal succeeds, one less fails', () => {
    const cost = UNIT_STATS.worker.cost; // 50
    const state = makeArena({ crystal: cost });
    const base = placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18);
    primeVision(state);
    enqueueCommand(state, 'p1', { type: 'train', buildingId: base.id, unitType: 'worker' }, 'human');
    let result = stepTick(state);
    expect(result.accepted).toBe(1);
    expect(base.queue).toEqual(['worker']);

    // Now drain: set crystal to cost-1 and try to train again on idle barracks
    const state2 = makeArena({ crystal: cost - 1 });
    const base2 = placeBase(state2, 'p1', 2, 2);
    placeBase(state2, 'p2', 18, 18);
    primeVision(state2);
    enqueueCommand(state2, 'p1', { type: 'train', buildingId: base2.id, unitType: 'worker' }, 'human');
    result = stepTick(state2);
    expect(result.accepted).toBe(0);
    expect(result.rejected[0]?.reason).toBe('INSUFFICIENT_RESOURCE');
  });

  it('pop cap 80 blocks training and is visible in snapshot', () => {
    const state = makeArena({ crystal: 5000, config: { popCap: 2 } });
    const base = placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18);
    placeUnit(state, 'p1', 'worker', 3, 2);
    placeUnit(state, 'p1', 'worker', 4, 2);
    primeVision(state);
    // pop is 2/2, at cap
    expect(state.players.p1.resources.crystal).toBeGreaterThanOrEqual(50);
    enqueueCommand(state, 'p1', { type: 'train', buildingId: base.id, unitType: 'worker' }, 'human');
    const result = stepTick(state);
    expect(result.rejected[0]?.reason).toBe('POP_CAP_REACHED');
    const snap = snapshotForHuman(state);
    expect(snap.pop).toBe(2);
    expect(snap.popCap).toBe(2);
  });

  it('barracks placement rejects blocked tile and occupied tile', () => {
    const state = makeArena({ crystal: 1000 });
    placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18);
    const worker = placeUnit(state, 'p1', 'worker', 3, 2);
    placeCrystal(state, 6, 2, 1500); // occupies 6,2
    primeVision(state);
    // blocked via terrain
    state.terrain.blocked[2 * state.terrain.width + 5] = 1; // 5,2 blocked
    enqueueCommand(state, 'p1', { type: 'build', unitIds: [worker.id], buildingType: 'barracks', x: 5, y: 2 }, 'human');
    let result = stepTick(state);
    expect(result.rejected[0]?.reason).toBe('BLOCKED_TILE');

    // occupied by crystal at 6,2
    enqueueCommand(state, 'p1', { type: 'build', unitIds: [worker.id], buildingType: 'barracks', x: 6, y: 2 }, 'human');
    result = stepTick(state);
    expect(result.rejected[0]?.reason).toBe('BLOCKED_TILE');

    // valid free tile 7,2 should succeed
    enqueueCommand(state, 'p1', { type: 'build', unitIds: [worker.id], buildingType: 'barracks', x: 7, y: 2 }, 'human');
    result = stepTick(state);
    expect(result.accepted).toBe(1);
  });

  it('snapshot exposes training queue and build progress for progress bars', () => {
    const state = makeArena({ crystal: 1000 });
    const base = placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18);
    primeVision(state);
    enqueueCommand(state, 'p1', { type: 'train', buildingId: base.id, unitType: 'worker' }, 'human');
    stepTick(state);
    const snap = snapshotForHuman(state);
    const row = snap.entities.find((e) => e.id === base.id);
    expect(row).toBeDefined();
    expect(row?.queue).toEqual(['worker']);
    expect(typeof row?.qp).toBe('number');
    // Step a bit: progress advances
    stepTicks(state, 10);
    const snap2 = snapshotForHuman(state);
    const row2 = snap2.entities.find((e) => e.id === base.id);
    expect(row2?.qp).toBeGreaterThan(0);

    // Construction progress
    const worker = placeUnit(state, 'p1', 'worker', 3, 2);
    primeVision(state);
    enqueueCommand(state, 'p1', { type: 'build', unitIds: [worker.id], buildingType: 'barracks', x: 8, y: 2 }, 'human');
    stepTick(state);
    const site = state.buildings.find((b) => b.kind === 'barracks' && b.owner === 'p1' && b.state === 'constructing');
    expect(site).toBeDefined();
    stepTicks(state, 5);
    const snap3 = snapshotForHuman(state);
    const siteRow = snap3.entities.find((e) => e.id === site?.id);
    expect(siteRow?.bp).toBeDefined();
    expect(siteRow?.bt).toBe(BUILDING_STATS.barracks.buildTicks);
  });

  it('combat exposure keeps enemy visible 30 ticks after trade', () => {
    const state = makeArena();
    placeBase(state, 'p1', 0, 0);
    placeBase(state, 'p2', 19, 19);
    const a = placeUnit(state, 'p1', 'soldier', 4, 4);
    const b = placeUnit(state, 'p2', 'soldier', 5, 4);
    primeVision(state);
    stepTick(state);
    expect(state.vision.p1.visibleEntityIds.has(b.id)).toBe(true);
    // Neutralize chase: put both idle so they don't refresh exposure
    a.state = 'idle' as any;
    a.task = null;
    (a as any).path = null;
    b.state = 'idle' as any;
    b.task = null;
    (b as any).path = null;
    // Teleport both far apart, outside vision
    a.x = 1; a.y = 1;
    b.x = 18; b.y = 18;
    visionTick(state);
    // Exposure should still keep them mutually visible for 30 ticks
    expect(state.vision.p1.visibleEntityIds.has(b.id)).toBe(true);
    expect(state.vision.p2.visibleEntityIds.has(a.id)).toBe(true);
    stepTicks(state, 31);
    // Expire and recompute
    visionTick(state);
    expect(state.vision.p1.visibleEntityIds.has(b.id)).toBe(false);
    expect(state.vision.p2.visibleEntityIds.has(a.id)).toBe(false);
  });

  it('intel lastKnownEnemySighting expires after 150 ticks', () => {
    const state = makeArena();
    placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18);
    const enemy = placeUnit(state, 'p2', 'soldier', 4, 2);
    primeVision(state);
    expect(state.intel.p1.lastKnownEnemySighting).not.toBeNull();
    expect(isSightingFresh(state, 'p1')).toBe(true);
    // Move enemy far away so sighting is not refreshed each tick
    enemy.x = 18; enemy.y = 18;
    // Also move p1 units far from new position to ensure no vision
    for (const u of state.units) if (u.owner === 'p1') { u.x = 2; u.y = 2; }
    stepTicks(state, 151);
    expect(isSightingFresh(state, 'p1')).toBe(false);
  });

  it('training queue busy rejects second order with INVALID_STATE', () => {
    const state = makeArena({ crystal: 1000 });
    const base = placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18);
    primeVision(state);
    enqueueCommand(state, 'p1', { type: 'train', buildingId: base.id, unitType: 'worker' }, 'human');
    stepTick(state);
    enqueueCommand(state, 'p1', { type: 'train', buildingId: base.id, unitType: 'worker' }, 'human');
    const result = stepTick(state);
    expect(result.rejected[0]?.reason).toBe('INVALID_STATE');
  });

  it('snapshot reflects pop growth after spawn', () => {
    const state = makeArena({ crystal: 500 });
    const base = placeBase(state, 'p1', 2, 2);
    placeBase(state, 'p2', 18, 18);
    primeVision(state);
    const before = snapshotForHuman(state).pop;
    enqueueCommand(state, 'p1', { type: 'train', buildingId: base.id, unitType: 'worker' }, 'human');
    stepTicks(state, UNIT_STATS.worker.trainTicks);
    const after = snapshotForHuman(state).pop;
    expect(after).toBe(before + 1);
  });
});
