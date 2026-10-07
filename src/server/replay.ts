/**
 * Replay recorder & replayer (docs/ROADMAP.md 阶段 3 任务 8).
 *
 * The recorder captures `{seed, config, commands[]}` during a live match.
 * The replayer takes that record and steps an isolated `GameState` forward,
 * comparing its final hash to the original so a divergence can be pinned to an
 * exact tick. The on-disk format is a single JSON file (not JSONL) so a replay
 * is a single atomic read.
 *
 * Both sides are pure: they never touch the network or the filesystem themselves
 * — the server decides when to flush to disk, and `scripts/replay.ts` decides
 * when to read from disk.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Action, ActionSource, GameConfig, PlayerId } from '../shared/types';
import { createGame, stepTick } from '../game/GameLoop';
import { hashState } from '../game/rng';
import type { GameState } from '../game/state/GameState';

export interface ReplayCommand {
  tick: number;
  owner: PlayerId;
  source: ActionSource;
  action: Action;
}

export interface ReplayRecord {
  version: 1;
  gameId: string;
  seed: number;
  config: GameConfig;
  createdAt: string;
  commands: ReplayCommand[];
  finalTick: number;
  winner: PlayerId | null;
  finalHash: string;
}

export interface ReplayOptions {
  seed: number;
  config?: Partial<GameConfig>;
  commands?: ReplayCommand[];
  /** Target tick to stop at (defaults to gameover or large limit). Tests pass finalTick for exact comparison. */
  finalTick?: number;
}

export interface ReplayResult {
  state: GameState;
  hash: string;
  winner: PlayerId | null;
  tick: number;
}

/**
 * Totally deterministic replay: rebuild the same seed/config and re-inject every
 * recorded command on the tick it was originally issued.
 *
 * Each command is enqueued *before* the tick whose `stepTick` will consume it,
 * which mirrors how `GameLoop.dispatchHumanCommands` buffers until the next tick.
 * Commands that were rejected in the original run are simply absent from the
 * record (only accepted commands are logged), so the replay never needs to deal
 * with rejections — it is a minimal, faithful trace.
 */
export function replayGame(record: ReplayOptions): ReplayResult {
  const state = createGame({ seed: record.seed, config: record.config });
  const commands = [...(record.commands ?? [])].sort((a, b) => a.tick - b.tick);

  let cursor = 0;
  const maxTick = record.finalTick ?? (commands.length > 0 ? Math.max(...commands.map((c) => c.tick)) + 9000 : 9000);

  for (;;) {
    if (state.status === 'gameover') break;
    if (state.tick >= maxTick) break;
    const batch: ReplayCommand[] = [];
    while (cursor < commands.length && commands[cursor]!.tick <= state.tick) {
      batch.push(commands[cursor]!);
      cursor += 1;
    }
    for (const cmd of batch) {
      state.pending.push({
        owner: cmd.owner,
        action: cmd.action,
        source: cmd.source,
        issuedAt: cmd.tick,
      });
    }
    stepTick(state);
    if (record.finalTick === undefined && cursor >= commands.length && state.tick > (commands[commands.length - 1]?.tick ?? 0) + 5000) break;
  }

  return { state, hash: hashState(state), winner: state.winner, tick: state.tick };
}

/**
 * In-memory recorder. The server owns one per match and calls `record` for every
 * batch that enters the pending queue, plus `finalize` once `gameover`.
 */
export class ReplayRecorder {
  readonly gameId: string;
  readonly seed: number;
  readonly config: GameConfig;
  readonly commands: ReplayCommand[] = [];
  readonly createdAt: string;

  constructor(state: GameState) {
    this.gameId = state.gameId;
    this.seed = state.seed;
    this.config = { ...state.config };
    this.createdAt = new Date().toISOString();
  }

  record(tick: number, owner: PlayerId, source: ActionSource, action: Action): void {
    this.commands.push({ tick, owner, source, action });
  }

  recordBatch(tick: number, batch: Array<{ owner: PlayerId; source: ActionSource; action: Action }>): void {
    for (const entry of batch) this.record(tick, entry.owner, entry.source, entry.action);
  }

  finalize(state: GameState): ReplayRecord {
    return {
      version: 1,
      gameId: this.gameId,
      seed: this.seed,
      config: this.config,
      createdAt: this.createdAt,
      commands: [...this.commands],
      finalTick: state.tick,
      winner: state.winner,
      finalHash: hashState(state),
    };
  }

  saveToFile(state: GameState, filePath: string): string {
    const record = this.finalize(state);
    const resolved = resolve(filePath);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, JSON.stringify(record, null, 2), 'utf8');
    return resolved;
  }
}

export function createRecorder(state: GameState): ReplayRecorder {
  return new ReplayRecorder(state);
}

export function loadReplay(filePath: string): ReplayRecord {
  const raw = readFileSync(resolve(filePath), 'utf8');
  const parsed = JSON.parse(raw) as ReplayRecord;
  if (parsed.version !== 1) throw new Error(`unsupported replay version ${parsed.version}`);
  return parsed;
}

export function verifyReplay(record: ReplayRecord): { ok: boolean; expected: string; actual: string; tick: number; winner: PlayerId | null } {
  const result = replayGame({ seed: record.seed, config: record.config, commands: record.commands, finalTick: record.finalTick });
  return {
    ok: result.hash === record.finalHash,
    expected: record.finalHash,
    actual: result.hash,
    tick: result.tick,
    winner: result.winner,
  };
}

/** Convenience hash used to correlate a replay file name without reading it. */
export function replayFileHash(record: ReplayRecord): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 8);
}
