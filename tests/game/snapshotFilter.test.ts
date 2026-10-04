/**
 * Anti-cheat snapshot filtering (acceptance A9).
 *
 * The human client must never receive information its fog hides: unseen enemy
 * units, the opponent's economy, or events describing something it could not
 * observe. These tests grep the *serialised* payload, which is what a modified
 * client would actually see.
 */

import { describe, expect, it } from 'vitest';
import { removeEntity } from '../../src/game/state/GameState';
import type { GameState } from '../../src/game/state/GameState';
import { tick as visionTick } from '../../src/game/systems/vision';
import { encodeFogRows } from '../../src/game/view/fogCodec';
import { eventsForHuman, snapshotForHuman } from '../../src/game/view/snapshot';
import { opponentOf } from '../../src/shared/types';
import { makeMatch, makeValidatorArena, TEST_SEED } from '../helpers/fixtures';

const enemyUnitIds = (state: GameState): string[] =>
  state.units.filter((unit) => unit.owner === 'p2').map((unit) => unit.id);

const unseenEnemyUnitIds = (state: GameState): string[] =>
  enemyUnitIds(state).filter((id) => !state.vision.p1.visibleEntityIds.has(id));

describe('snapshotForHuman', () => {
  it('never contains an invisible enemy unit id', () => {
    const state = makeMatch(TEST_SEED);
    const hidden = unseenEnemyUnitIds(state);
    expect(hidden.length).toBeGreaterThan(0); // otherwise the test proves nothing

    const payload = JSON.stringify(snapshotForHuman(state));
    for (const id of hidden) {
      expect(payload.includes(`"${id}"`), `leaked ${id}`).toBe(false);
    }
  });

  it('never contains the opponent crystal count', () => {
    const state = makeMatch(TEST_SEED);
    state.players.p2.resources.crystal = 777;
    const snapshot = snapshotForHuman(state);

    expect(Object.keys(snapshot)).not.toContain('p2');
    expect(JSON.stringify(snapshot)).not.toContain('777');
    expect(snapshot.crystal).toBe(Math.round(state.players.p1.resources.crystal));
  });

  it('includes own entities and visible enemy entities', () => {
    const arena = makeValidatorArena();
    const ids = snapshotForHuman(arena.state).entities.map((row) => row.id);
    expect(ids).toContain(arena.p1Base.id);
    expect(ids).toContain(arena.p1Worker.id);
    expect(ids).toContain(arena.nearEnemy.id); // visible to p1
    expect(ids).not.toContain(arena.farEnemy.id); // out of vision
  });

  it('reports ghosts for remembered enemy buildings only', () => {
    const arena = makeValidatorArena();
    const scout = arena.p1Soldier;
    scout.x = 15.5;
    scout.y = 16.5;
    visionTick(arena.state);

    scout.x = 4.5;
    scout.y = 2.5;
    visionTick(arena.state);

    const snapshot = snapshotForHuman(arena.state);
    expect(snapshot.ghosts.map((ghost) => ghost.id)).toContain(arena.p2Base.id);
    expect(snapshot.ghosts.every((ghost) => ghost.kind === 'base' || ghost.kind === 'barracks')).toBe(true);
    expect(snapshot.entities.map((row) => row.id)).not.toContain(arena.p2Base.id);
  });

  it('carries the explored layer as a row delta (first send)', () => {
    const state = makeMatch(TEST_SEED);
    const snapshot = snapshotForHuman(state);
    expect(snapshot.fog).toBeDefined();

    // The first delta is measured against an all-zero mask, so it contains one
    // entry per row that has at least one explored tile — never the whole map.
    const exploredRows = snapshot.fog?.rows ?? [];
    expect(exploredRows.length).toBeGreaterThan(0);
    expect(exploredRows.length).toBeLessThanOrEqual(state.terrain.height);
    expect(exploredRows.every((row) => /^[0-9a-f]+$/.test(row.bits) && row.bits !== '0'.repeat(row.bits.length))).toBe(true);

    // Sending the same state again yields no delta at all.
    const again = snapshotForHuman(state, {
      previousFogRows: encodeFogRows(
        state.vision.p1.explored,
        state.terrain.width,
        state.terrain.height,
      ),
    });
    expect(again.fog?.rows).toEqual([]);
  });
});

describe('eventsForHuman', () => {
  it('hides the death of an enemy that was never seen', () => {
    const arena = makeValidatorArena();
    arena.state.events = [];
    removeEntity(arena.state, arena.farEnemy.id);
    expect(arena.state.events).toHaveLength(1);
    expect(eventsForHuman(arena.state, arena.state.events)).toHaveLength(0);
  });

  it('reports the death of an enemy that was visible', () => {
    const arena = makeValidatorArena();
    arena.state.events = [];
    removeEntity(arena.state, arena.nearEnemy.id);
    expect(eventsForHuman(arena.state, arena.state.events)).toHaveLength(1);
  });

  it('always reports own losses and the game-over event', () => {
    const arena = makeValidatorArena();
    arena.state.events = [];
    removeEntity(arena.state, arena.p1Worker.id);
    arena.state.events.push({ type: 'gameover', tick: 0, owner: opponentOf('p1') });
    const visible = eventsForHuman(arena.state, arena.state.events);
    expect(visible.map((event) => event.type)).toEqual(['death', 'gameover']);
  });
});
