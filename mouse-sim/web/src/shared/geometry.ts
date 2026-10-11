// Target geometry and coverage cells. Mirrors pipeline/geometry.py; keep the two in step.
// Angles are in screen coordinates (x right, y down): 90 degrees is straight down. All lengths are
// physical pixels. "Across" is positive on the right-hand side of the direction of travel.
import { cells } from './config';

export const DIST_EDGES: number[] = cells.distance_edges.map((e) => (e === null ? Infinity : e));
export const N_DIST = DIST_EDGES.length - 1;
export const N_DIR = cells.direction_bins;
export const DIR_WIDTH = 360 / N_DIR;
export const SIZE_CENTERS: number[] = cells.size_centers;
export const N_SIZE = SIZE_CENTERS.length;
export const SIZE_EDGES: number[] = [
  SIZE_CENTERS[0] / Math.SQRT2,
  ...SIZE_CENTERS.slice(1).map((s, i) => Math.sqrt(s * SIZE_CENTERS[i])),
  SIZE_CENTERS[N_SIZE - 1] * Math.SQRT2,
];
export const N_CELLS = N_DIST * N_DIR * N_SIZE;
export const GOAL_PER_CELL: number = cells.goal_per_cell;

export type Shape = 'circle' | 'rect';

export interface Target {
  shape: Shape;
  cx: number;
  cy: number;
  w: number;
  h: number;
  r: number; // corner radius (rectangles)
}

export interface Pt {
  x: number;
  y: number;
}

export const DEG = Math.PI / 180;

export function directionDeg(dx: number, dy: number): number {
  const a = Math.atan2(dy, dx) / DEG;
  return ((a % 360) + 360) % 360;
}

/** Smallest signed difference a - b in degrees, in [-180, 180). */
export function angleDiffDeg(a: number, b: number): number {
  return ((((a - b + 180) % 360) + 360) % 360) - 180;
}

export function distBin(d: number): number {
  if (d < DIST_EDGES[0]) return -1;
  for (let i = N_DIST - 1; i >= 0; i--) if (d >= DIST_EDGES[i]) return i;
  return -1;
}

export function dirBin(thetaDeg: number): number {
  const t = (((thetaDeg + DIR_WIDTH / 2) % 360) + 360) % 360;
  return Math.min(Math.floor(t / DIR_WIDTH), N_DIR - 1);
}

export function sizeBin(s: number): number {
  for (let i = N_SIZE - 1; i >= 0; i--) if (s >= SIZE_EDGES[i]) return i;
  return 0;
}

export function cellIndex(di: number, ai: number, si: number): number {
  return (di * N_DIR + ai) * N_SIZE + si;
}

export function cellFromIndex(idx: number): [number, number, number] {
  const si = idx % N_SIZE;
  const ai = Math.floor(idx / N_SIZE) % N_DIR;
  const di = Math.floor(idx / (N_SIZE * N_DIR));
  return [di, ai, si];
}

/** Chord through the target centre in direction theta: the target's extent along it. */
export function chord(shape: Shape, w: number, h: number, thetaRad: number): number {
  if (shape === 'circle') return w;
  const c = Math.abs(Math.cos(thetaRad));
  const s = Math.abs(Math.sin(thetaRad));
  const a = c > 1e-12 ? w / c : Infinity;
  const b = s > 1e-12 ? h / s : Infinity;
  return Math.min(a, b);
}

export function sizesAlongAcross(t: Target, thetaRad: number): [number, number] {
  return [chord(t.shape, t.w, t.h, thetaRad), chord(t.shape, t.w, t.h, thetaRad + Math.PI / 2)];
}

export function cornerRadius(w: number, h: number, maxRadius: number): number {
  return Math.min(maxRadius, 0.25 * Math.min(w, h));
}

/** Hit test. Rectangles have rounded corners of radius t.r. */
export function inside(t: Target, x: number, y: number): boolean {
  const dx = x - t.cx;
  const dy = y - t.cy;
  if (t.shape === 'circle') return dx * dx + dy * dy <= (t.w / 2) ** 2;
  const qx = Math.abs(dx) - t.w / 2 + t.r;
  const qy = Math.abs(dy) - t.h / 2 + t.r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - t.r;
  return outside <= 1e-9;
}

/** Movement conditions for a start point and target. */
export function conditions(start: Pt, t: Target) {
  const dx = t.cx - start.x;
  const dy = t.cy - start.y;
  const D = Math.hypot(dx, dy);
  const thetaDeg = directionDeg(dx, dy);
  const [along, across] = sizesAlongAcross(t, thetaDeg * DEG);
  return { D, thetaDeg, along, across };
}

export function traceTarget(ctx: CanvasRenderingContext2D, t: Target): void {
  ctx.beginPath();
  if (t.shape === 'circle') ctx.arc(t.cx, t.cy, t.w / 2, 0, Math.PI * 2);
  else ctx.roundRect(t.cx - t.w / 2, t.cy - t.h / 2, t.w, t.h, t.r);
}
