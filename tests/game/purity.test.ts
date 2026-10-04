/**
 * Zero-IO purity guard for the simulation core.
 *
 * docs/SPEC.md §4 and the project conventions state that `src/game` must be
 * runnable in plain memory: no express, no ws, no Phaser, no fetch, no fs. That
 * rule is what makes the whole engine testable and the match reproducible, so it
 * is enforced here instead of being left to code review.
 *
 * This test reads source files (it lives in `tests/`, where IO is allowed).
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC_GAME = join(process.cwd(), 'src', 'game');

/**
 * Modules the core must never reach for, and why.
 *
 * `zod` is deliberately NOT listed here: `actions/schema.ts` is the one
 * sanctioned user (it is the input boundary the LLM and the browser share), and
 * the third test below pins that exception so it cannot quietly spread.
 */
const FORBIDDEN_MODULES: { pattern: RegExp; why: string }[] = [
  { pattern: /from\s+['"]express['"]/, why: 'HTTP belongs to src/server' },
  { pattern: /from\s+['"]ws['"]/, why: 'WebSockets belong to src/server' },
  { pattern: /from\s+['"]phaser['"]/, why: 'rendering belongs to src/render' },
  { pattern: /from\s+['"]node:/, why: 'the core must not touch node built-ins' },
  { pattern: /from\s+['"](?:fs|path|http|https|net|os|child_process)['"]/, why: 'no node built-ins' },
];

/** Globals that only exist in a browser or a server host. */
const FORBIDDEN_GLOBALS: { pattern: RegExp; why: string }[] = [
  { pattern: /\bMath\.random\s*\(/, why: 'randomness must come from GameState.rng' },
  { pattern: /\bwindow\s*\./, why: 'no DOM in the core' },
  { pattern: /\bdocument\s*\./, why: 'no DOM in the core' },
  { pattern: /\bperformance\s*\.\s*now\s*\(/, why: 'the core must not read a clock' },
  { pattern: /\bsetInterval\s*\(/, why: 'the core is ticked by its caller' },
  { pattern: /\bsetTimeout\s*\(/, why: 'the core is ticked by its caller' },
  { pattern: /\bfetch\s*\(/, why: 'no network IO in the core' },
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strip block and line comments so documentation prose is not scanned. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('src/game purity', () => {
  const files = listTsFiles(SRC_GAME);

  it('finds the core sources', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('imports no host module', () => {
    const violations: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const { pattern, why } of FORBIDDEN_MODULES) {
        if (pattern.test(code)) {
          violations.push(`${relative(SRC_GAME, file)}: ${pattern} (${why})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('uses no browser/server global and no ambient randomness or clocks', () => {
    const violations: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const { pattern, why } of FORBIDDEN_GLOBALS) {
        if (pattern.test(code)) {
          violations.push(`${relative(SRC_GAME, file)}: ${pattern} (${why})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('exempts zod for the action schema only', () => {
    // `actions/schema.ts` is the single sanctioned zod user inside the core; the
    // blanket rule above must not be loosened, so this test pins the exception.
    const schemaFile = join(SRC_GAME, 'actions', 'schema.ts');
    const users = files.filter((file) => /from\s+['"]zod['"]/.test(readFileSync(file, 'utf8')));
    expect(users.map((file) => file.split(sep).slice(-2).join('/'))).toEqual(['actions/schema.ts']);
    expect(readFileSync(schemaFile, 'utf8')).toContain("from 'zod'");
  });
});
