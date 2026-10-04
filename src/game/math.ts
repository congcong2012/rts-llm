/** Tiny geometry helpers shared by every system. Pure, allocation-free. */

import type { Vec2 } from '../shared/types';

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function distanceTo(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return distance(a.x, a.y, b.x, b.y);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Position (continuous, tile units) → tile coordinate. */
export function tileOf(value: number): number {
  return Math.floor(value);
}

/** Tile coordinate → centre of that tile in world units. */
export function tileCenter(tile: number): number {
  return tile + 0.5;
}

export function sameTile(a: Vec2, b: Vec2): boolean {
  return a.x === b.x && a.y === b.y;
}

export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Quantise to 3 decimals so long matches cannot drift into different hashes. */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Quantise to 1 decimal — the precision used on the wire (docs/SPEC.md §7.3). */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** String key for a tile, used as a Map key. */
export function vecKey(v: Vec2): string {
  return `${v.x},${v.y}`;
}
