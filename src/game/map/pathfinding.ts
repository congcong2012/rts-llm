/**
 * A* over the walkability grid (docs/SPEC.md §2.1 FR-02).
 *
 * Deliberately simple: 8-directional, octile heuristic, no corner cutting, no
 * path smoothing, binary heap open set. Units do not collide with each other,
 * so only terrain blocks a path.
 */

import type { Terrain, Vec2 } from '../../shared/types';
import { neighbors8 } from './grid';
import { idx, inBounds, isWalkable } from './terrain';

const SQRT2 = Math.SQRT2;

interface HeapNode {
  index: number;
  f: number;
}

/** Minimal binary min-heap; ties break on the smaller index for determinism. */
class MinHeap {
  private readonly items: HeapNode[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: HeapNode): void {
    this.items.push(node);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const a = this.items[i] as HeapNode;
      const b = this.items[parent] as HeapNode;
      if (b.f < a.f || (b.f === a.f && b.index <= a.index)) break;
      this.items[i] = b;
      this.items[parent] = a;
      i = parent;
    }
  }

  pop(): HeapNode | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length === 0 || last === undefined) return top;
    this.items[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      const current = this.items[smallest] as HeapNode;
      if (left < this.items.length) {
        const l = this.items[left] as HeapNode;
        if (l.f < current.f || (l.f === current.f && l.index < current.index)) smallest = left;
      }
      const best = this.items[smallest] as HeapNode;
      if (right < this.items.length) {
        const r = this.items[right] as HeapNode;
        if (r.f < best.f || (r.f === best.f && r.index < best.index)) smallest = right;
      }
      if (smallest === i) break;
      const tmp = this.items[i] as HeapNode;
      this.items[i] = this.items[smallest] as HeapNode;
      this.items[smallest] = tmp;
      i = smallest;
    }
    return top;
  }
}

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? dx + (SQRT2 - 1) * dy : dy + (SQRT2 - 1) * dx;
}

/**
 * Find a path from (sx,sy) to (tx,ty).
 *
 * @returns tile coordinates **excluding** the start tile and **including** the
 *          target tile; an empty array when start === target; `null` when no
 *          path exists (or the target is blocked / out of bounds).
 */
export function findPath(
  terrain: Terrain,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): Vec2[] | null {
  if (!inBounds(terrain, sx, sy) || !inBounds(terrain, tx, ty)) return null;
  if (!isWalkable(terrain, sx, sy) || !isWalkable(terrain, tx, ty)) return null;
  if (sx === tx && sy === ty) return [];

  const size = terrain.width * terrain.height;
  const gScore = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const open = new MinHeap();

  const startIndex = idx(terrain, sx, sy);
  const targetIndex = idx(terrain, tx, ty);
  gScore[startIndex] = 0;
  open.push({ index: startIndex, f: octile(sx, sy, tx, ty) });

  while (open.size > 0) {
    const current = open.pop();
    if (current === undefined) break;
    const currentIndex = current.index;
    if (currentIndex === targetIndex) return reconstruct(terrain, cameFrom, targetIndex);
    if (closed[currentIndex] === 1) continue;
    closed[currentIndex] = 1;

    const cx = currentIndex % terrain.width;
    const cy = Math.floor(currentIndex / terrain.width);
    const baseG = gScore[currentIndex] ?? Number.POSITIVE_INFINITY;

    for (const neighbor of neighbors8(terrain, cx, cy)) {
      const nIndex = idx(terrain, neighbor.x, neighbor.y);
      if (closed[nIndex] === 1) continue;
      const tentative = baseG + neighbor.cost;
      if (tentative >= (gScore[nIndex] ?? Number.POSITIVE_INFINITY)) continue;
      gScore[nIndex] = tentative;
      cameFrom[nIndex] = currentIndex;
      open.push({ index: nIndex, f: tentative + octile(neighbor.x, neighbor.y, tx, ty) });
    }
  }

  return null;
}

function reconstruct(terrain: Terrain, cameFrom: Int32Array, targetIndex: number): Vec2[] {
  const path: Vec2[] = [];
  let current = targetIndex;
  while (current !== -1) {
    path.push({ x: current % terrain.width, y: Math.floor(current / terrain.width) });
    const prev = cameFrom[current];
    if (prev === undefined || prev === -1) break;
    current = prev;
  }
  path.pop(); // drop the start tile
  path.reverse();
  return path;
}

/** Flood fill from a tile; used by map generation to validate connectivity. */
export function floodFill(terrain: Terrain, startX: number, startY: number): Uint8Array {
  const size = terrain.width * terrain.height;
  const visited = new Uint8Array(size);
  if (!isWalkable(terrain, startX, startY)) return visited;
  const queue: number[] = [idx(terrain, startX, startY)];
  visited[queue[0] as number] = 1;
  while (queue.length > 0) {
    const current = queue.shift() as number;
    const cx = current % terrain.width;
    const cy = Math.floor(current / terrain.width);
    for (const neighbor of neighbors8(terrain, cx, cy)) {
      const nIndex = idx(terrain, neighbor.x, neighbor.y);
      if (visited[nIndex] === 1) continue;
      visited[nIndex] = 1;
      queue.push(nIndex);
    }
  }
  return visited;
}

export function isReachable(terrain: Terrain, sx: number, sy: number, tx: number, ty: number): boolean {
  const visited = floodFill(terrain, sx, sy);
  if (!inBounds(terrain, tx, ty)) return false;
  return visited[idx(terrain, tx, ty)] === 1;
}
