// Generative model runtime (mirrors models/generative/sample.py; keep the two in step). The denoising
// network runs in onnxruntime-web (WebGPU, falling back to WASM); the sampling loop runs here.
import type * as OrtModule from 'onnxruntime-web/webgpu';
import { getJson } from '../api';
import { filtfilt } from '../butter';
import { chord, inside, sizeBin, sizesAlongAcross, type Target } from '../geometry';
import type { Rng } from '../rng';
import { clampPath, rint, toPixels, type ScreenSize, type SimTimeline, type TrialConditions } from '../timeline';
import type { SimModel } from './types';

type Ort = typeof OrtModule;
type BankEntry = [number, [number, number, number][]];
type BankName = 'reaction' | 'after_miss' | 'dwell' | 'dwell_after_miss' | 'click';

export interface GenMeta {
  format: number;
  n_points: number;
  d_min: number;
  in_ch: number;
  sampling: {
    steps: number; sampler: 'euler' | 'heun'; max_attempts: number; lowpass_hz: number; start_ramp: number;
    end_fit: 'similarity' | 'ramp' | 'none'; end_ramp_start: number;
  };
  cond_names: string[];
  norm: {
    traj_mean: number[][];
    traj_std: number[];
    logdur_mean: number;
    logdur_std: number;
    end_mean: number[];
    end_std: number[];
    cond_mean: number[];
    cond_std: number[];
  };
  session_vector: number[] | null;
  banks: Record<BankName, BankEntry[][]>;
  run: string;
  params: number;
}

let ortPromise: Promise<Ort> | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} in ${ms / 1000} s`)), ms))]);
}

function loadOrt(): Promise<Ort> {
  // Unbundled ORT from /ort/ (scripts/copy-ort.mjs), outside Vite's module graph: ORT's worker
  // threads re-import its module, and a bundled chunk sharing helpers with the app would run the app
  // in every worker (multi-threaded start-up then hangs).
  const url: string = '/ort/ort.webgpu.min.mjs';
  ortPromise ??= (import(/* @vite-ignore */ url) as Promise<Ort>).then((ort) => {
    ort.env.logLevel = 'error'; // node-placement notices are expected (shape ops run on the CPU)
    ort.env.wasm.numThreads = window.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
    return ort;
  });
  return ortPromise;
}

interface Frame {
  c: number;
  s: number;
  scale: number;
  D: number;
  thetaDeg: number;
}

function frame(sx: number, sy: number, tx: number, ty: number, dMin: number): Frame {
  const vx = tx - sx;
  const vy = ty - sy;
  const D = Math.hypot(vx, vy);
  const th = Math.atan2(vy, vx);
  return { c: Math.cos(th), s: Math.sin(th), scale: Math.max(D, dMin), D, thetaDeg: (((th * 180) / Math.PI) % 360 + 360) % 360 };
}

/** Relative path of length + 1 samples from a compact change list (data.expand in Python). */
function expand(changes: [number, number, number][], length: number): Int32Array {
  const out = new Int32Array(2 * (length + 1));
  for (const [k, dx, dy] of changes) {
    if (k > length) continue;
    for (let j = k; j <= length; j++) {
      out[2 * j] = dx;
      out[2 * j + 1] = dy;
    }
  }
  return out;
}

export interface Sampled {
  traj: Float64Array; // canonical x, y pairs
  logdur: number;
  end: [number, number]; // end offset in target-size units (along, across)
}

/** Pin the path to the cursor at onset and make it end on the predicted end point (sample.fit_end). */
function fitEnds(pts: Float64Array, P: number, sx: number, sy: number, gx: number, gy: number,
  cfg: GenMeta['sampling']): void {
  const smooth = (u: number) => u * u * (3 - 2 * u);
  const ox = pts[0] - sx;
  const oy = pts[1] - sy;
  for (let p = 0; p < P; p++) {
    const tau = p / (P - 1);
    const u = cfg.start_ramp > 0 ? Math.min(tau / cfg.start_ramp, 1) : 1;
    const w = 1 - smooth(u);
    pts[2 * p] -= w * ox;
    pts[2 * p + 1] -= w * oy;
  }
  if (cfg.end_fit === 'none') return;
  const ax = pts[2 * (P - 1)] - sx;
  const ay = pts[2 * (P - 1) + 1] - sy;
  const bx = gx - sx;
  const by = gy - sy;
  const na = Math.hypot(ax, ay);
  const nb = Math.hypot(bx, by);
  if (cfg.end_fit === 'similarity' && na > 5 && nb > 0.5 * na) {
    const k = nb / na;
    const ang = Math.atan2(by, bx) - Math.atan2(ay, ax);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (let p = 0; p < P; p++) {
      const x = pts[2 * p] - sx;
      const y = pts[2 * p + 1] - sy;
      pts[2 * p] = sx + k * (x * c - y * s);
      pts[2 * p + 1] = sy + k * (x * s + y * c);
    }
    return;
  }
  const dx = gx - pts[2 * (P - 1)];
  const dy = gy - pts[2 * (P - 1) + 1];
  const r0 = cfg.end_ramp_start;
  for (let p = 0; p < P; p++) {
    const w = smooth(Math.min(Math.max((p / (P - 1) - r0) / (1 - r0), 0), 1));
    pts[2 * p] += w * dx;
    pts[2 * p + 1] += w * dy;
  }
}

/** Canonical path -> whole-pixel positions at t = 0..K ms after onset (sample.movement_path). */
export function movementPath(meta: Pick<GenMeta, 'n_points' | 'd_min' | 'sampling'>, m: Sampled, sx: number, sy: number,
  target: Target, screen: ScreenSize): Int32Array {
  const { n_points: P, sampling } = meta;
  const f = frame(sx, sy, target.cx, target.cy, meta.d_min);
  const K = Math.max(rint(Math.exp(m.logdur)), 1);
  const [along, across] = sizesAlongAcross(target, (f.thetaDeg * Math.PI) / 180);
  const ea = m.end[0] * Math.max(along, 1);
  const ec = m.end[1] * Math.max(across, 1);
  const gx = target.cx + f.c * ea - f.s * ec;
  const gy = target.cy + f.s * ea + f.c * ec;
  const pts = new Float64Array(2 * P);
  for (let p = 0; p < P; p++) {
    const qx = m.traj[2 * p];
    const qy = m.traj[2 * p + 1];
    pts[2 * p] = sx + f.scale * (f.c * qx - f.s * qy);
    pts[2 * p + 1] = sy + f.scale * (f.s * qx + f.c * qy);
  }
  fitEnds(pts, P, sx, sy, gx, gy, sampling);
  let xs: Float64Array = new Float64Array(K + 1);
  let ys: Float64Array = new Float64Array(K + 1);
  for (let g = 0; g <= K; g++) {
    const u = (g * (P - 1)) / K;
    const i = Math.min(Math.floor(u), P - 2);
    const w = u - i;
    xs[g] = pts[2 * i] + (pts[2 * i + 2] - pts[2 * i]) * w;
    ys[g] = pts[2 * i + 1] + (pts[2 * i + 3] - pts[2 * i + 1]) * w;
  }
  if (sampling.lowpass_hz && K + 1 >= 30) {
    const pad = Math.min(K, 300);
    xs = filtfilt(xs, sampling.lowpass_hz, 1000, pad);
    ys = filtfilt(ys, sampling.lowpass_hz, 1000, pad);
  }
  const path = new Float64Array(2 * (K + 1));
  for (let g = 0; g <= K; g++) {
    path[2 * g] = xs[g];
    path[2 * g + 1] = ys[g];
  }
  path[0] = sx;
  path[1] = sy;
  return toPixels(clampPath(path, screen), screen);
}

export class Generative implements SimModel {
  readonly id = 'generative';
  readonly label = 'Generative';
  backend = '';
  lastMs = 0;

  private constructor(private ort: Ort, private session: OrtModule.InferenceSession, readonly meta: GenMeta) {}

  static async load(onnxPath: string, jsonPath: string): Promise<Generative> {
    const [ort, meta] = await Promise.all([loadOrt(), getJson<GenMeta>(`/bundle/${jsonPath}`)]);
    if (meta.format !== 2) throw new Error(`gen.json format ${meta.format} is not supported; re-run python -m models.export`);
    const url = `/bundle/${onnxPath}`;
    // ?ep=wasm (or webgpu) forces a backend; otherwise WebGPU first, then WASM.
    const forced = new URLSearchParams(location.search).get('ep');
    const tries: string[][] = forced ? [[forced]] : 'gpu' in navigator ? [['webgpu'], ['wasm']] : [['wasm']];
    let lastError: unknown;
    for (const eps of tries) {
      try {
        // Some WebGPU setups (e.g. headless browsers) hang instead of failing: don't wait forever.
        const session = await withTimeout(ort.InferenceSession.create(url, { executionProviders: eps }),
          eps[0] === 'webgpu' ? 20_000 : 120_000, `${eps[0]} backend did not start`);
        const g = new Generative(ort, session, meta);
        g.backend = eps[0];
        return g;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }

  private condVector(cx: number, cy: number, cond: TrialConditions, afterMiss: boolean): number[] {
    const t = cond.target;
    const f = frame(cx, cy, t.cx, t.cy, this.meta.d_min);
    const th = (f.thetaDeg * Math.PI) / 180;
    const [along, across] = sizesAlongAcross(t, th);
    return [Math.log(Math.max(f.D, 1)), Math.sin(th), Math.cos(th), Math.log(Math.max(along, 1)),
      Math.log(Math.max(across, 1)), t.shape === 'rect' ? 1 : 0, cx / cond.screen.w, cy / cond.screen.h, afterMiss ? 1 : 0];
  }

  private async velocity(x: Float32Array, t: number, cond: OrtModule.Tensor, B: number): Promise<Float32Array> {
    const out = await this.session.run({
      x: new this.ort.Tensor('float32', x, [B, this.meta.in_ch, this.meta.n_points]),
      t: new this.ort.Tensor('float32', new Float32Array(B).fill(t), [B]),
      cond,
    });
    return (await out.v.getData()) as Float32Array;
  }

  /** Flow-matching integration from noise, batched. */
  async sampleMovements(conds: number[][], noise: Float32Array): Promise<Sampled[]> {
    const { n_points: P, in_ch: CH, norm, session_vector, sampling } = this.meta;
    const B = conds.length;
    const sv = session_vector ?? [];
    const C = conds[0].length + sv.length;
    const cn = new Float32Array(B * C);
    conds.forEach((c, b) => {
      c.forEach((v, j) => (cn[b * C + j] = (v - norm.cond_mean[j]) / norm.cond_std[j]));
      sv.forEach((v, j) => (cn[b * C + c.length + j] = v));
    });
    const condT = new this.ort.Tensor('float32', cn, [B, C]);
    const x = new Float32Array(noise);
    const steps = sampling.steps;
    const dt = 1 / steps;
    for (let i = 0; i < steps; i++) {
      let v = await this.velocity(x, i * dt, condT, B);
      if (sampling.sampler === 'heun' && i < steps - 1) {
        const x2 = new Float32Array(x.length);
        for (let j = 0; j < x.length; j++) x2[j] = x[j] + dt * v[j];
        const v2 = await this.velocity(x2, (i + 1) * dt, condT, B);
        const avg = new Float32Array(x.length);
        for (let j = 0; j < x.length; j++) avg[j] = 0.5 * (v[j] + v2[j]);
        v = avg;
      }
      for (let j = 0; j < x.length; j++) x[j] += dt * v[j];
    }
    const out: Sampled[] = [];
    for (let b = 0; b < B; b++) {
      const o = b * CH * P;
      const traj = new Float64Array(2 * P);
      let ld = 0;
      let e0 = 0;
      let e1 = 0;
      for (let p = 0; p < P; p++) {
        traj[2 * p] = x[o + p] * norm.traj_std[0] + norm.traj_mean[0][p];
        traj[2 * p + 1] = x[o + P + p] * norm.traj_std[1] + norm.traj_mean[1][p];
        ld += x[o + 2 * P + p];
        e0 += x[o + 3 * P + p];
        e1 += x[o + 4 * P + p];
      }
      out.push({
        traj, logdur: (ld / P) * norm.logdur_std + norm.logdur_mean,
        end: [(e0 / P) * norm.end_std[0] + norm.end_mean[0], (e1 / P) * norm.end_std[1] + norm.end_mean[1]],
      });
    }
    return out;
  }

  movementPath(m: Sampled, sx: number, sy: number, target: Target, screen: ScreenSize): Int32Array {
    return movementPath(this.meta, m, sx, sy, target, screen);
  }

  private bank(name: BankName, si: number, rng: Rng): BankEntry {
    const b = this.meta.banks[name][si];
    return b[rng.int(b.length)];
  }

  private noise(rng: Rng): Float32Array {
    const out = new Float32Array(this.meta.in_ch * this.meta.n_points);
    for (let i = 0; i < out.length; i++) out[i] = rng.normal();
    return out;
  }

  private offset(rel: Int32Array, x: number, y: number): Int32Array {
    for (let k = 0; k < rel.length; k += 2) {
      rel[k] += x;
      rel[k + 1] += y;
    }
    return rel;
  }

  async generate(cond: TrialConditions, rng: Rng): Promise<SimTimeline> {
    const t0 = performance.now();
    const tgt = cond.target;
    const si = sizeBin(chord(tgt.shape, tgt.w, tgt.h, Math.atan2(tgt.cy - cond.start.y, tgt.cx - cond.start.x)));
    const [rt, drift] = this.bank('reaction', si, rng);
    const reaction = this.offset(expand(drift, rt), Math.trunc(cond.start.x), Math.trunc(cond.start.y));
    const chunks: Int32Array[] = [reaction];
    let cx = reaction[reaction.length - 2];
    let cy = reaction[reaction.length - 1];
    let t = rt;
    const clicks: [number, number][] = [];
    for (let attempt = 0; attempt < this.meta.sampling.max_attempts; attempt++) {
      const [m] = await this.sampleMovements([this.condVector(cx, cy, cond, attempt > 0)], this.noise(rng));
      const path = this.movementPath(m, cx, cy, tgt, cond.screen);
      chunks.push(path.subarray(2));
      t += path.length / 2 - 1;
      const sx = path[path.length - 2];
      const sy = path[path.length - 1];
      const [dwell, dwellDrift] = this.bank(attempt === 0 ? 'dwell' : 'dwell_after_miss', si, rng);
      const kDwell = Math.max(rint(dwell), 0);
      const pause = this.offset(expand(dwellDrift, kDwell), sx, sy);
      chunks.push(pause.subarray(2));
      const tDown = t + kDwell;
      const dx = pause[pause.length - 2];
      const dy = pause[pause.length - 1];
      const [hold, slip] = this.bank('click', si, rng);
      const kHold = Math.max(rint(hold), 1);
      const holdPath = this.offset(expand(slip, kHold), dx, dy);
      chunks.push(holdPath.subarray(2));
      clicks.push([tDown, tDown + kHold]);
      t = tDown + kHold;
      cx = holdPath[holdPath.length - 2];
      cy = holdPath[holdPath.length - 1];
      if (inside(tgt, dx, dy)) break;
      const [rr, d2] = this.bank('after_miss', si, rng);
      if (rr > 0) {
        const re = this.offset(expand(d2, rr), cx, cy);
        chunks.push(re.subarray(2));
        cx = re[re.length - 2];
        cy = re[re.length - 1];
      }
      t += rr;
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const pos = new Int32Array(total);
    let o = 0;
    for (const c of chunks) {
      pos.set(c, o);
      o += c.length;
    }
    for (let k = 0; k < pos.length; k += 2) {
      pos[k] = Math.min(Math.max(pos[k], 0), cond.screen.w - 1);
      pos[k + 1] = Math.min(Math.max(pos[k + 1], 0), cond.screen.h - 1);
    }
    this.lastMs = performance.now() - t0;
    return { pos, clicks, target: tgt, screen: cond.screen, meta: { generative: true, ms: this.lastMs, backend: this.backend } };
  }
}
