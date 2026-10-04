#!/usr/bin/env tsx
/**
 * Headless match runner (docs/ROADMAP.md, phase 1 acceptance A3/A4/A6).
 *
 *   npm run sim -- --seed 12345 --ticks 9000
 *   npm run sim -- --seed 12345 --ticks 9000 --verbose
 *
 * Both players are driven by the built-in rule AI on a 20-tick cadence, exactly
 * like the LLM will be in phase 4. Everything runs in-process: no server, no
 * browser, no network. The final state hash is printed so two runs can be
 * compared byte for byte.
 */

import { createGame, enqueueCommands, stepTick } from '../src/game/GameLoop';
import { hashState } from '../src/game/rng';
import { findBaseOf, ownedUnits, population } from '../src/game/state/GameState';
import { PLAYERS, type PlayerId } from '../src/shared/types';
import type { GameState } from '../src/game/state/GameState';
import { decide } from '../src/llm/ruleAi';

interface Args {
  seed: number;
  ticks: number;
  interval: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { seed: 12345, ticks: 9000, interval: 20, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    const [flag, inline] = token.includes('=')
      ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
      : [token, undefined];
    const readValue = (): string | undefined => inline ?? argv[(i += 1)];
    switch (flag) {
      case '--seed':
        args.seed = Number(readValue() ?? args.seed) >>> 0;
        break;
      case '--ticks':
        args.ticks = Number(readValue() ?? args.ticks);
        break;
      case '--interval':
        args.interval = Number(readValue() ?? args.interval);
        break;
      case '--verbose':
      case '-v':
        args.verbose = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (flag.startsWith('--')) {
          console.error(`unknown option: ${flag}`);
          printUsage();
          process.exit(1);
        }
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`Usage: npm run sim -- [options]

  --seed <n>       map / match seed (default 12345)
  --ticks <n>      hard tick limit (default 9000 = 15 in-game minutes)
  --interval <n>   rule-AI decision cadence in ticks (default 20)
  --verbose, -v    print a status line every 100 ticks
  --help, -h       show this help
`);
}

const label = (player: PlayerId): string => (player === 'p1' ? 'blue(human)' : 'red(llm)');

function armyCounts(state: GameState, player: PlayerId): { workers: number; soldiers: number } {
  const units = ownedUnits(state, player);
  return {
    workers: units.filter((unit) => unit.kind === 'worker').length,
    soldiers: units.filter((unit) => unit.kind === 'soldier').length,
  };
}

function printRow(state: GameState): void {
  const parts: string[] = [`t=${String(state.tick).padStart(5)}`];
  for (const player of PLAYERS) {
    const army = armyCounts(state, player);
    const crystal = Math.round(state.players[player].resources.crystal);
    const base = findBaseOf(state, player);
    parts.push(
      `${player} crystal=${String(crystal).padStart(5)} w/s=${army.workers}/${army.soldiers} base=${
        base === undefined ? '  ---' : String(Math.round(base.hp)).padStart(5)
      }`,
    );
  }
  parts.push(`hash=${hashState(state)}`);
  console.log(parts.join('  '));
}

function printSummary(state: GameState, elapsedMs: number, rejected: number): void {
  const winner = state.winner;
  console.log('');
  console.log('─'.repeat(78));
  console.log(`winner        : ${winner === null ? 'draw' : `${winner} (${label(winner)})`}`);
  console.log(`status        : ${state.status}`);
  console.log(`total ticks   : ${state.tick} (${(state.tick / 10).toFixed(1)}s in-game)`);
  console.log(`entities      : ${state.units.length} units, ${state.buildings.length} buildings, ${state.crystals.length} crystals`);
  for (const player of PLAYERS) {
    const army = armyCounts(state, player);
    const stats = state.players[player].stats;
    console.log(
      `${label(player).padEnd(14)}: crystal=${Math.round(state.players[player].resources.crystal)} workers=${army.workers} soldiers=${army.soldiers} harvested=${Math.round(stats.harvested)} trained=${stats.trained} killed=${stats.killed} lost=${stats.lost} pop=${population(state, player)}`,
    );
  }
  console.log(`dropped actions: ${rejected} (validator rejections across the match)`);
  console.log(`elapsed       : ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log(`final hash    : ${hashState(state)}`);
  console.log('─'.repeat(78));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const state = createGame({ seed: args.seed, config: { maxTicks: args.ticks } });
  const started = Date.now();
  let rejected = 0;

  console.log(
    `headless match  seed=${args.seed}  maxTicks=${args.ticks}  decisionInterval=${args.interval}  map=${state.terrain.width}x${state.terrain.height}`,
  );
  console.log(`initial hash    : ${hashState(state)}`);
  console.log('');

  while (state.status === 'running' && state.tick < args.ticks) {
    if (state.tick % args.interval === 0) {
      for (const player of PLAYERS) {
        const decision = decide(state, player);
        enqueueCommands(state, player, decision.actions, 'rule');
      }
    }
    const result = stepTick(state);
    rejected += result.rejected.length;
    if (args.verbose && state.tick % 100 === 0) printRow(state);
  }

  printSummary(state, Date.now() - started, rejected);
}

main();
