/**
 * Action schema — step 1 of the validation pipeline (docs/SPEC.md §8.2).
 *
 * Strict on purpose: `.strict()` rejects unknown keys, so an LLM that invents an
 * extra field gets the whole action dropped with `SCHEMA_INVALID` instead of
 * having that field silently ignored.
 *
 * `x` / `y` are bounded loosely here (0..1023); the exact map-bounds check is
 * step 8 of the pipeline and produces the more precise `OUT_OF_BOUNDS` reason.
 */

import { z } from 'zod';
import type { Action } from '../../shared/types';

const MAX_COORD = 1023;
const MAX_UNIT_REFS = 24;

const idString = z.string().min(1).max(64);
const idList = z.array(idString).min(1).max(MAX_UNIT_REFS);
const coord = z.number().int().min(0).max(MAX_COORD);

export const unitKindSchema = z.enum(['worker', 'soldier']);
export const buildingKindSchema = z.enum(['base', 'barracks']);

export const trainActionSchema = z
  .object({
    type: z.literal('train'),
    buildingId: idString,
    unitType: unitKindSchema,
  })
  .strict();

export const buildActionSchema = z
  .object({
    type: z.literal('build'),
    unitIds: idList,
    buildingType: buildingKindSchema,
    x: coord,
    y: coord,
  })
  .strict();

export const moveActionSchema = z
  .object({
    type: z.literal('move'),
    unitIds: idList,
    x: coord,
    y: coord,
  })
  .strict();

export const attackActionSchema = z
  .object({
    type: z.literal('attack'),
    unitIds: idList,
    targetId: idString,
  })
  .strict();

export const gatherActionSchema = z
  .object({
    type: z.literal('gather'),
    unitIds: idList,
    // Omitted => "pick the nearest crystal for me".
    targetId: idString.optional(),
  })
  .strict();

export const holdActionSchema = z
  .object({
    type: z.literal('hold'),
    unitIds: idList,
  })
  .strict();

export const noopActionSchema = z.object({ type: z.literal('noop') }).strict();

export const actionSchema = z.discriminatedUnion('type', [
  trainActionSchema,
  buildActionSchema,
  moveActionSchema,
  attackActionSchema,
  gatherActionSchema,
  holdActionSchema,
  noopActionSchema,
]);

export type ParseActionResult =
  | { ok: true; action: Action }
  | { ok: false; error: string };

/** Parse an unknown payload into a typed Action, or report why it failed. */
export function parseAction(input: unknown): ParseActionResult {
  const result = actionSchema.safeParse(input);
  if (result.success) return { ok: true, action: result.data as Action };

  const issue = result.error.issues[0];
  const path = issue?.path.join('.') ?? '';
  const message = issue?.message ?? 'invalid action';
  return { ok: false, error: path.length > 0 ? `${path}: ${message}` : message };
}

/** Parse the full `actions` array of an LLM response, dropping bad entries. */
export function parseActionList(input: unknown): {
  actions: Action[];
  errors: { index: number; error: string }[];
} {
  const actions: Action[] = [];
  const errors: { index: number; error: string }[] = [];
  if (!Array.isArray(input)) {
    return { actions, errors: [{ index: -1, error: 'actions must be an array' }] };
  }
  input.forEach((raw, index) => {
    const parsed = parseAction(raw);
    if (parsed.ok) actions.push(parsed.action);
    else errors.push({ index, error: parsed.error });
  });
  return { actions, errors };
}

/** Reason an action was dropped, in the same shape used by the wire protocol. */
export const ACTION_TYPE_SET: ReadonlySet<string> = new Set([
  'train',
  'build',
  'move',
  'attack',
  'gather',
  'hold',
  'noop',
]);
