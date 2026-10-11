// A trial on the 1 ms grid (mirrors pipeline/timeline.py): pos[k] is the cursor k ms after the target
// appeared, in whole physical pixels; clicks are [tDown, tUp] in ms.
import { inside, type Target } from './geometry';

export interface ScreenSize {
  w: number;
  h: number;
}

export interface SimTimeline {
  pos: Int32Array; // x0, y0, x1, y1, ...
  clicks: [number, number][];
  target: Target;
  screen: ScreenSize;
  meta?: Record<string, unknown>;
}

export interface TrialConditions {
  start: { x: number; y: number };
  target: Target;
  screen: ScreenSize;
}

export function length(tl: SimTimeline): number {
  return tl.pos.length / 2;
}

/** Latest sample at or before t (what a real cursor shows), clamped to the timeline. */
export function posAt(tl: SimTimeline, t: number): [number, number] {
  const k = Math.max(0, Math.min(length(tl) - 1, Math.floor(t)));
  return [tl.pos[2 * k], tl.pos[2 * k + 1]];
}

/** Where each press happened (sample at ceil(tDown), like the Python side) and whether it hit. */
export function clickResults(tl: SimTimeline): { x: number; y: number; hit: boolean }[] {
  const n = length(tl);
  return tl.clicks.map(([td]) => {
    const k = Math.max(0, Math.min(n - 1, Math.ceil(td)));
    const x = tl.pos[2 * k];
    const y = tl.pos[2 * k + 1];
    return { x, y, hit: inside(tl.target, x, y) };
  });
}

/** Integrate per-ms displacements like a real cursor: stuck at the edges, lost movement stays lost.
 *  path: x0, y0, x1, y1, ... (floats). */
export function clampPath(path: Float64Array, screen: ScreenSize): Float64Array {
  const out = new Float64Array(path.length);
  let x = path[0];
  let y = path[1];
  out[0] = x;
  out[1] = y;
  for (let i = 2; i < path.length; i += 2) {
    x = Math.min(Math.max(x + (path[i] - path[i - 2]), 0), screen.w - 1);
    y = Math.min(Math.max(y + (path[i + 1] - path[i - 1]), 0), screen.h - 1);
    out[i] = x;
    out[i + 1] = y;
  }
  return out;
}

export function outOfScreen(path: Float64Array, screen: ScreenSize): boolean {
  for (let i = 0; i < path.length; i += 2) {
    if (path[i] < 0 || path[i + 1] < 0 || path[i] > screen.w - 1 || path[i + 1] > screen.h - 1) return true;
  }
  return false;
}

/** Whole physical pixels inside the screen (numpy rint: round half to even). */
export function toPixels(path: Float64Array, screen: ScreenSize): Int32Array {
  const out = new Int32Array(path.length);
  for (let i = 0; i < path.length; i += 2) {
    out[i] = Math.min(Math.max(rint(path[i]), 0), screen.w - 1);
    out[i + 1] = Math.min(Math.max(rint(path[i + 1]), 0), screen.h - 1);
  }
  return out;
}

export function rint(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** np.interp: linear interpolation on an integer grid 0..n-1, clamped at the ends. */
export function interpGrid(t: number, values: ArrayLike<number>, stride: number, offset: number, n: number): number {
  if (t <= 0) return values[offset];
  if (t >= n - 1) return values[(n - 1) * stride + offset];
  const i = Math.floor(t);
  const f = t - i;
  const a = values[i * stride + offset];
  const b = values[(i + 1) * stride + offset];
  return a + (b - a) * f;
}
