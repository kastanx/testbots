// The TypeScript runtimes must reproduce the Python reference (fixture from tools/make_parity_fixture.py).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { filtfilt } from '../src/shared/butter';
import type { LibraryData } from '../src/shared/bundle';
import type { Target } from '../src/shared/geometry';
import { Library, MotionMatching, query } from '../src/shared/models/motionMatching';
import { clickResults } from '../src/shared/timeline';
import { movementPath, type GenMeta } from '../src/shared/models/generative';

type GenMetaSubset = Pick<GenMeta, 'n_points' | 'd_min' | 'sampling'>;

const fx = JSON.parse(readFileSync(new URL('./fixtures/parity.json', import.meta.url), 'utf8'));

describe('butterworth filtfilt matches scipy.signal.sosfiltfilt', () => {
  for (const c of fx.filtfilt as { x: number[]; y: number[] }[]) {
    it(`n=${c.x.length}`, () => {
      const y = filtfilt(c.x, 30, 1000, Math.min(c.x.length - 1, 300));
      for (let i = 0; i < y.length; i++) expect(Math.abs(y[i] - c.y[i])).toBeLessThan(1e-7);
    });
  }
});

describe('motion matching warp matches the Python matcher', () => {
  const data: LibraryData = { ...fx.library, rel: Int16Array.from(fx.library.rel) };
  const mm = new MotionMatching(new Library(data));
  for (const [k, c] of (fx.cases as {
    entry: number; start: number[]; target: Target; screen: number[]; pos: number[]; clicks: number[][]; hit: number[];
  }[]).entries()) {
    it(`case ${k} (entry ${c.entry})`, () => {
      const cond = { start: { x: c.start[0], y: c.start[1] }, target: c.target, screen: { w: c.screen[0], h: c.screen[1] } };
      const tl = mm.warp(c.entry, cond, query(cond), false)!;
      expect(tl.pos.length).toBe(c.pos.length);
      let diff = 0;
      for (let i = 0; i < c.pos.length; i++) if (tl.pos[i] !== c.pos[i]) diff++;
      // rounding exactly on .5 can flip with float noise: allow a handful of 1 px differences
      expect(diff).toBeLessThanOrEqual(Math.max(2, c.pos.length * 0.002));
      tl.clicks.forEach(([td, tu], j) => {
        expect(td).toBeCloseTo(c.clicks[j][0], 6);
        expect(tu).toBeCloseTo(c.clicks[j][1], 6);
      });
      expect(clickResults(tl).map((r) => (r.hit ? 1 : 0))).toEqual(c.hit);
    });
  }
});

describe('generative post-processing matches models/generative/sample.py', () => {
  const g = fx.gen as { meta: GenMetaSubset; screen: number[]; cases: { traj: number[]; logdur: number; end: number[];
    start: number[]; target: Target; pos: number[] }[] };
  g.cases.forEach((c, k) => {
    it(`case ${k}`, () => {
      const pos = movementPath(g.meta, { traj: Float64Array.from(c.traj), logdur: c.logdur, end: [c.end[0], c.end[1]] },
        c.start[0], c.start[1], c.target, { w: g.screen[0], h: g.screen[1] });
      expect(pos.length).toBe(c.pos.length);
      let diff = 0;
      for (let i = 0; i < pos.length; i++) if (pos[i] !== c.pos[i]) diff++;
      expect(diff).toBeLessThanOrEqual(Math.max(2, pos.length * 0.002));
    });
  });
});
