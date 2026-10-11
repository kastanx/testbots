// Motion matching runtime (mirrors models/motion_matching/matcher.py; keep the two in step).
import type { LibraryData } from '../bundle';
import { filtfilt } from '../butter';
import { DEG, angleDiffDeg, directionDeg, inside, sizesAlongAcross, type Shape, type Target } from '../geometry';
import type { Rng } from '../rng';
import {
  clampPath, interpGrid, outOfScreen, toPixels, type ScreenSize, type SimTimeline, type TrialConditions,
} from '../timeline';
import type { SimModel } from './types';

const SHAPES: Record<Shape, number> = { circle: 0, rect: 1 };

export interface Query {
  D: number;
  theta: number;
  along: number;
  across: number;
  shape: number;
  startRel: [number, number];
}

export interface Candidate {
  index: number;
  distance: number;
  qualifies: boolean;
}

export class Library {
  constructor(readonly data: LibraryData) {}

  get size(): number {
    return this.data.n;
  }

  entryLength(i: number): number {
    return this.data.offsets[i + 1] - this.data.offsets[i];
  }

  /** [tDown, tUp, hit] rows of entry i. */
  clicks(i: number): [number, number, number][] {
    const d = this.data;
    const out: [number, number, number][] = [];
    for (let c = d.click_offsets[i]; c < d.click_offsets[i + 1]; c++) {
      out.push([d.clicks[3 * c], d.clicks[3 * c + 1], d.clicks[3 * c + 2]]);
    }
    return out;
  }

  /** Recorded start position and target of entry i, on the recording's screen. */
  original(i: number): { start: { x: number; y: number }; target: Target } {
    const d = this.data;
    const sx = Math.round(d.start_rel[2 * i] * d.screen[0]);
    const sy = Math.round(d.start_rel[2 * i + 1] * d.screen[1]);
    const th = d.theta[i] * DEG;
    const shape: Shape = d.shape[i] ? 'rect' : 'circle';
    return {
      start: { x: sx, y: sy },
      target: {
        shape, cx: sx + d.D[i] * Math.cos(th), cy: sy + d.D[i] * Math.sin(th),
        w: d.target[3 * i], h: d.target[3 * i + 1], r: d.target[3 * i + 2],
      },
    };
  }

  /** The recorded trial exactly as it happened (its own start and target). */
  replay(i: number): SimTimeline {
    const d = this.data;
    const { start, target } = this.original(i);
    const a = d.offsets[i];
    const n = this.entryLength(i);
    const pos = new Int32Array(2 * n);
    for (let k = 0; k < n; k++) {
      pos[2 * k] = start.x + d.rel[2 * (a + k)];
      pos[2 * k + 1] = start.y + d.rel[2 * (a + k) + 1];
    }
    return {
      pos, clicks: this.clicks(i).map(([td, tu]) => [td, tu] as [number, number]), target,
      screen: { w: d.screen[0], h: d.screen[1] }, meta: { source: d.keys[i], real: true },
    };
  }
}

export function query(cond: TrialConditions): Query {
  const dx = cond.target.cx - cond.start.x;
  const dy = cond.target.cy - cond.start.y;
  const theta = directionDeg(dx, dy);
  const [along, across] = sizesAlongAcross(cond.target, theta * DEG);
  return {
    D: Math.max(Math.hypot(dx, dy), 1), theta, along: Math.max(along, 1), across: Math.max(across, 1),
    shape: SHAPES[cond.target.shape], startRel: [cond.start.x / cond.screen.w, cond.start.y / cond.screen.h],
  };
}

export class MotionMatching implements SimModel {
  readonly id = 'motion_matching';
  readonly label = 'Motion matching';
  private last = -1;
  /** Library entries the next queries may not use (e.g. the trial being compared against). */
  exclude = new Set<number>();
  lastInfo: { lowCoverage: boolean; source?: string; rotationDeg?: number; scale?: number; timeScale?: number } = { lowCoverage: false };

  constructor(readonly lib: Library) {}

  get cfg() {
    return this.lib.data.config;
  }

  candidates(q: Query): Candidate[] {
    const d = this.lib.data;
    const w = this.cfg.weights;
    const lim = this.cfg.limits;
    const out: Candidate[] = [];
    for (let i = 0; i < d.n; i++) {
      if (this.exclude.has(i)) continue;
      const dth = angleDiffDeg(d.theta[i], q.theta);
      const rd = d.D[i] / q.D;
      const ra = d.along[i] / q.along;
      const rc = d.across[i] / q.across;
      const qualifies = Math.abs(dth) <= lim.direction_deg && rd >= lim.distance_ratio[0] && rd <= lim.distance_ratio[1]
        && ra >= lim.size_ratio[0] && ra <= lim.size_ratio[1] && rc >= lim.across_ratio[0] && rc <= lim.across_ratio[1];
      const distance = w.log_distance * Math.abs(Math.log(rd)) + w.direction_rad * Math.abs(dth * DEG)
        + w.log_size_along * Math.abs(Math.log(ra)) + w.log_size_across * Math.abs(Math.log(rc))
        + w.start * Math.hypot(d.start_rel[2 * i] - q.startRel[0], d.start_rel[2 * i + 1] - q.startRel[1])
        + w.shape * (d.shape[i] !== q.shape ? 1 : 0);
      out.push({ index: i, distance, qualifies });
    }
    return out;
  }

  hasCoverage(cond: TrialConditions): boolean {
    return this.candidates(query(cond)).some((c) => c.qualifies);
  }

  private mt(D: number, along: number): number {
    const f = this.lib.data.fitts;
    return Math.max(f.a_nominal + f.b_nominal * Math.log2(D / along + 1), 50);
  }

  /** Rotate/scale entry i about its start onto the new conditions and stretch its movement in time. */
  warp(i: number, cond: TrialConditions, q: Query = query(cond), check = true): SimTimeline | null {
    const d = this.lib.data;
    const rot = angleDiffDeg(q.theta, d.theta[i]) * DEG;
    const scale = q.D / d.D[i];
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const n = this.lib.entryLength(i);
    const a = d.offsets[i];
    const rel = d.rel.subarray(2 * a, 2 * (a + n));
    const clicks = this.lib.clicks(i);
    const kOn = d.onset[i];
    const tLast = clicks[clicks.length - 1][0];
    const r = this.mt(q.D, q.along) / this.mt(d.D[i], d.along[i]);
    const segOld = Math.max(tLast - kOn, 0);
    const extra = segOld * (r - 1);
    const newT = (t: number) => (t < kOn ? t : t <= tLast ? kOn + (t - kOn) * r : t + extra);
    const oldT = (t: number) => (t < kOn ? t : t <= kOn + segOld * r ? kOn + (t - kOn) / r : t - extra);
    const K = Math.max(Math.floor(newT(n - 1)) + 1, 2);
    const path = new Float64Array(2 * K);
    if (Math.abs(rot) < 1e-9 && Math.abs(scale - 1) < 1e-9 && Math.abs(r - 1) < 1e-9) {
      for (let k = 0; k < K; k++) {
        path[2 * k] = cond.start.x + rel[2 * Math.min(k, n - 1)];
        path[2 * k + 1] = cond.start.y + rel[2 * Math.min(k, n - 1) + 1];
      }
    } else {
      const fc = this.cfg.warp_lowpass_hz ?? 0;
      let srcX: ArrayLike<number>;
      let srcY: ArrayLike<number>;
      const xs = new Float64Array(n);
      const ys = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        xs[k] = rel[2 * k];
        ys[k] = rel[2 * k + 1];
      }
      if (fc && n >= 30) {
        const pad = Math.min(n - 1, 300);
        srcX = filtfilt(xs, fc, 1000, pad);
        srcY = filtfilt(ys, fc, 1000, pad);
      } else {
        srcX = xs;
        srcY = ys;
      }
      for (let k = 0; k < K; k++) {
        const t = oldT(k);
        const x = interpGrid(t, srcX, 1, 0, n);
        const y = interpGrid(t, srcY, 1, 0, n);
        path[2 * k] = cond.start.x + scale * (c * x - s * y);
        path[2 * k + 1] = cond.start.y + scale * (s * x + c * y);
      }
    }
    const pos = toPixels(outOfScreen(path, cond.screen) ? clampPath(path, cond.screen) : path, cond.screen);
    const newClicks = clicks.map(([td, tu]) => [newT(td), Math.min(newT(tu), K - 1)] as [number, number]);
    if (check) {
      for (let j = 0; j < clicks.length; j++) {
        const k = Math.max(0, Math.min(K - 1, Math.ceil(newClicks[j][0])));
        if (inside(cond.target, pos[2 * k], pos[2 * k + 1]) !== Boolean(clicks[j][2])) return null;
      }
    }
    return {
      pos, clicks: newClicks, target: cond.target, screen: cond.screen,
      meta: { source: d.keys[i], rotationDeg: rot / DEG, scale, timeScale: r },
    };
  }

  /** Ranked candidates (qualifying first, or all when none qualify) without the last one used. */
  ranked(cond: TrialConditions): { order: Candidate[]; low: boolean } {
    const all = this.candidates(query(cond));
    const qual = all.filter((x) => x.qualifies);
    const low = qual.length === 0;
    let order = (low ? all : qual).sort((x, y) => x.distance - y.distance);
    if (order.length > 1) order = order.filter((x) => x.index !== this.last);
    return { order, low };
  }

  async generate(cond: TrialConditions, rng: Rng): Promise<SimTimeline> {
    const q = query(cond);
    const { order, low } = this.ranked(cond);
    const k = this.cfg.top_k;
    const tau = this.cfg.similarity_tau;
    const pool = order.slice(0, 6 * k);
    while (pool.length) {
      const top = pool.slice(0, k);
      const dmin = Math.min(...top.map((x) => x.distance));
      const pick = top[rng.weighted(top.map((x) => Math.exp(-(x.distance - dmin) / tau)))];
      const tl = this.warp(pick.index, cond, q);
      if (tl) {
        this.last = pick.index;
        this.lastInfo = { lowCoverage: low, source: String(tl.meta?.source), rotationDeg: Number(tl.meta?.rotationDeg),
          scale: Number(tl.meta?.scale), timeScale: Number(tl.meta?.timeScale) };
        tl.meta = { ...tl.meta, lowCoverage: low, distance: pick.distance };
        return tl;
      }
      pool.splice(pool.indexOf(pick), 1);
    }
    const best = order[0];
    const tl = this.warp(best.index, cond, q, false)!;
    this.last = best.index;
    this.lastInfo = { lowCoverage: true, source: String(tl.meta?.source) };
    tl.meta = { ...tl.meta, lowCoverage: true, distance: best.distance };
    return tl;
  }

  /** The closest real trials warped onto these conditions (for the overlay). */
  closest(cond: TrialConditions, n = 5): SimTimeline[] {
    const q = query(cond);
    const { order } = this.ranked(cond);
    return order.slice(0, n).map((c) => this.warp(c.index, cond, q, false)!).filter(Boolean);
  }

  /** Nearest entry to these conditions by condition distance, ignoring the limits. */
  nearest(cond: TrialConditions): number {
    const all = this.candidates(query(cond));
    return all.reduce((best, x) => (x.distance < best.distance ? x : best), all[0]).index;
  }
}

export function screenOf(lib: Library): ScreenSize {
  return { w: lib.data.screen[0], h: lib.data.screen[1] };
}
