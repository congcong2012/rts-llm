#!/usr/bin/env tsx
/**
 * Replay CLI: `npm run replay -- <file.json>` re-runs a recorded match and
 * checks that the final hash matches the one stored at record time.
 *
 * Usage:
 *   npm run replay -- logs/replays/<gameId>.json
 *   npm run replay -- logs/replays/<gameId>.json --verbose
 *   npm run sim -- --seed 12345 --replay logs/replays/sim-12345.json  (via simulate.ts)
 */

import { resolve } from 'node:path';
import { loadReplay, replayGame } from '../src/server/replay';

function printUsage(): void {
  console.log(`Usage: npm run replay -- <replay.json> [--verbose]

  <replay.json>   path to a ReplayRecord file (see src/server/replay.ts)
  --verbose, -v   print every 100 ticks
  --help, -h      show this help
`);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const file = argv.find((a) => !a.startsWith('-'));
  if (file === undefined) {
    console.error('error: missing replay file');
    printUsage();
    process.exit(1);
  }
  const verbose = argv.includes('--verbose') || argv.includes('-v');
  const resolved = resolve(file);

  let record;
  try {
    record = loadReplay(resolved);
  } catch (error) {
    console.error(`failed to load replay ${resolved}:`, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.log(`replaying ${record.gameId} (seed=${record.seed}, ${record.commands.length} commands, finalTick=${record.finalTick}, winner=${record.winner ?? 'draw'})`);
  console.log(`  original hash: ${record.finalHash}`);

  const result = replayGame({ seed: record.seed, config: record.config, commands: record.commands, finalTick: record.finalTick });

  if (verbose) {
    console.log(`  replay hash:   ${result.hash}`);
    console.log(`  replay tick:   ${result.tick} winner=${result.winner ?? 'draw'}`);
  }

  const ok = result.hash === record.finalHash;
  if (ok) {
    console.log(`✓ replay hash matches (${result.hash}) at tick ${result.tick}, winner=${result.winner ?? 'draw'}`);
    process.exit(0);
  } else {
    console.error(`✗ hash mismatch! expected ${record.finalHash} got ${result.hash} (winner ${result.winner})`);
    process.exit(2);
  }
}

main();
