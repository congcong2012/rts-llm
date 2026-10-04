/**
 * Server-side logger (the ONLY file IO in the whole project).
 *
 * Rules (docs/SPEC.md §9, §11):
 *  - Never log a secret. API keys are passed through `redact()` before writing.
 *  - One line per event, newline-delimited JSON-ish text, so a match can be
 *    replayed from `logs/` alone.
 *  - Logging is best-effort: a full disk must not crash the match.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERN = /(sk-[A-Za-z0-9_-]{6,})/g;

/** Replace anything that smells like an API key. Used on every log line. */
export function redact(text: string): string {
  return text.replace(SECRET_PATTERN, (match) => `${match.slice(0, 6)}***REDACTED`);
}

export interface LoggerOptions {
  /** Directory that receives `<gameId>.log`. Defaults to `logs/`. */
  dir?: string;
  /** Minimum level written to the file. Defaults to `LOG_LEVEL` or `info`. */
  level?: LogLevel;
  /** Also write to stdout. Defaults to true in development. */
  console?: boolean;
}

export class Logger {
  private readonly dir: string;
  private readonly level: LogLevel;
  private readonly toConsole: boolean;
  private files = new Set<string>();

  constructor(options: LoggerOptions = {}) {
    this.dir = resolve(options.dir ?? process.env.LOG_DIR ?? 'logs');
    this.level = options.level ?? ((process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info');
    this.toConsole = options.console ?? process.env.NODE_ENV !== 'test';
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  /** Write a structured record append-only to `<channel>.log`. */
  channel(channel: string, record: Record<string, unknown>): void {
    const file = this.fileFor(channel);
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
    this.append(file, line);
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
    const line = `[${level}] ${message}${suffix}`;
    const safe = redact(line);
    if (this.toConsole) {
      if (level === 'error') console.error(safe);
      else if (level === 'warn') console.warn(safe);
      else console.log(safe);
    }
    this.append(this.fileFor(process.env.LOG_FILE ?? 'server'), `${safe}\n`);
  }

  private fileFor(channel: string): string {
    const safeChannel = channel.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return resolve(this.dir, `${safeChannel}.log`);
  }

  private append(file: string, text: string): void {
    try {
      if (!this.files.has(file)) {
        mkdirSync(dirname(file), { recursive: true });
        this.files.add(file);
      }
      appendFileSync(file, text, 'utf8');
    } catch {
      // Best effort: logging must never take the match down.
    }
  }
}

export const logger = new Logger();
