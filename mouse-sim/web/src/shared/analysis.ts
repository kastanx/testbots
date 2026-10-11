// Light-weight kinematics for the simulator's charts and markers (the harness does the real
// measuring in Python; this only has to look right).
import { length, type SimTimeline } from './timeline';

export interface Kinematics {
  speed: Float64Array;      // px/ms, smoothed
  dist: Float64Array;       // distance to the target centre, px
  dips: number[];           // indices where a new submovement starts
  overshoots: number[];     // indices where the cursor passes the target centre along the movement axis
  maxSpeed: number;
}

function gaussian(x: Float64Array, sigma: number): Float64Array {
  const r = Math.ceil(3 * sigma);
  const w: number[] = [];
  for (let i = -r; i <= r; i++) w.push(Math.exp((-0.5 * i * i) / (sigma * sigma)));
  const out = new Float64Array(x.length);
  for (let k = 0; k < x.length; k++) {
    let s = 0;
    let ws = 0;
    for (let i = -r; i <= r; i++) {
      const j = Math.min(Math.max(k + i, 0), x.length - 1);
      s += w[i + r] * x[j];
      ws += w[i + r];
    }
    out[k] = s / ws;
  }
  return out;
}

export function analyse(tl: SimTimeline): Kinematics {
  const n = length(tl);
  const h = 5;
  const raw = new Float64Array(n);
  const dist = new Float64Array(n);
  const sx = tl.pos[0];
  const sy = tl.pos[1];
  const ux0 = tl.target.cx - sx;
  const uy0 = tl.target.cy - sy;
  const D = Math.hypot(ux0, uy0) || 1;
  const ux = ux0 / D;
  const uy = uy0 / D;
  const proj = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - h);
    const b = Math.min(n - 1, k + h);
    raw[k] = b > a ? Math.hypot(tl.pos[2 * b] - tl.pos[2 * a], tl.pos[2 * b + 1] - tl.pos[2 * a + 1]) / (b - a) : 0;
    const x = tl.pos[2 * k];
    const y = tl.pos[2 * k + 1];
    dist[k] = Math.hypot(x - tl.target.cx, y - tl.target.cy);
    proj[k] = (x - sx) * ux + (y - sy) * uy;
  }
  const speed = gaussian(raw, 6);
  let maxSpeed = 0;
  for (const v of speed) maxSpeed = Math.max(maxSpeed, v);
  // Submovements, same rule as pipeline/features.py count_submovements: a dip below half of the
  // preceding peak, followed by a new peak above max(0.05, 10% of the top speed) covering >= 2 px.
  const floor = Math.max(0.05, 0.1 * maxSpeed);
  const peaks: number[] = [];
  for (let k = 1; k < n - 1; k++) if (speed[k] >= floor && speed[k] > speed[k - 1] && speed[k] >= speed[k + 1]) peaks.push(k);
  const dips: number[] = [];
  let ref = peaks.length ? peaks[0] : -1;
  for (const p of peaks.slice(1)) {
    let v = ref;
    for (let k = ref; k <= p; k++) if (speed[k] < speed[v]) v = k;
    if (speed[v] < 0.5 * speed[ref]) {
      let e = p;
      while (e < n && speed[e] >= 0.5 * speed[p]) e++;
      let area = 0;
      for (let k = v; k < e; k++) area += speed[k];
      if (area >= 2) {
        dips.push(v);
        ref = p;
        continue;
      }
    }
    if (speed[p] > speed[ref]) ref = p;
  }
  const overshoots: number[] = [];
  for (let k = 1; k < n; k++) if (proj[k - 1] < D && proj[k] >= D) overshoots.push(k);
  return { speed, dist, dips, overshoots, maxSpeed };
}

export function speedColor(v: number, max: number, alpha = 1): string {
  const f = Math.min(1, v / Math.max(max, 1e-6));
  return `hsla(${220 - 220 * f}, 85%, ${55 + 5 * f}%, ${alpha})`;
}
