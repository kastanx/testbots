import { describe, expect, it } from 'vitest';
import { recorderConfig } from '../src/shared/config';
import { Rng } from '../src/shared/rng';
import { feasibleCells, placeTarget, sampleInCell, screenFeasibility } from '../src/shared/placement';
import {
  N_CELLS, cellFromIndex, cellIndex, chord, conditions, dirBin, distBin, inside, sizeBin, type Target,
} from '../src/shared/geometry';

const screen = { w: 3440, h: 1440 };

describe('geometry', () => {
  it('bins', () => {
    expect(distBin(19)).toBe(-1);
    expect(distBin(20)).toBe(0);
    expect(distBin(1599)).toBe(5);
    expect(distBin(5000)).toBe(6);
    expect(dirBin(0)).toBe(0);
    expect(dirBin(14.9)).toBe(0);
    expect(dirBin(15)).toBe(1);
    expect(dirBin(359)).toBe(0);
    expect(dirBin(90)).toBe(3);
    expect(sizeBin(8)).toBe(0);
    expect(sizeBin(128)).toBe(4);
    expect(sizeBin(40)).toBe(2);
    for (let c = 0; c < N_CELLS; c++) expect(cellIndex(...cellFromIndex(c))).toBe(c);
  });

  it('chords', () => {
    expect(chord('rect', 100, 20, 0)).toBeCloseTo(100);
    expect(chord('rect', 100, 20, Math.PI / 2)).toBeCloseTo(20);
    expect(chord('rect', 100, 100, Math.PI / 4)).toBeCloseTo(100 * Math.SQRT2);
    expect(chord('circle', 30, 30, 1.0)).toBe(30);
  });

  it('hit test', () => {
    const t: Target = { shape: 'rect', cx: 100, cy: 100, w: 40, h: 20, r: 5 };
    expect(inside(t, 100, 100)).toBe(true);
    expect(inside(t, 119, 100)).toBe(true);
    expect(inside(t, 121, 100)).toBe(false);
    expect(inside(t, 119.9, 109.9)).toBe(false); // rounded corner
    const c: Target = { shape: 'circle', cx: 0, cy: 0, w: 10, h: 10, r: 0 };
    expect(inside(c, 3, 4)).toBe(true);
    expect(inside(c, 3.6, 4)).toBe(false);
  });
});

describe('placement', () => {
  it('samples land in the requested cell and fit on screen', () => {
    const rng = new Rng(42);
    const cursor = { x: 1720, y: 720 };
    let found = 0;
    for (let c = 0; c < N_CELLS; c++) {
      for (let k = 0; k < 20; k++) {
        const p = sampleInCell(c, cursor, screen, rng, recorderConfig);
        if (!p) continue;
        found++;
        expect(cellIndex(...p.cell)).toBe(c);
        const t = p.target;
        expect(t.cx - t.w / 2).toBeGreaterThanOrEqual(recorderConfig.edge_margin_px);
        expect(t.cy + t.h / 2).toBeLessThanOrEqual(screen.h - recorderConfig.edge_margin_px);
        expect(inside(t, cursor.x, cursor.y)).toBe(false);
        const cond = conditions(cursor, t);
        expect(cond.D).toBeCloseTo(p.D);
        break;
      }
    }
    expect(found).toBeGreaterThan(200);
  });

  it('feasibility from the centre and from the whole screen', () => {
    const fromCentre = feasibleCells({ x: 1720, y: 720 }, screen, new Rng(1), recorderConfig);
    const nCentre = fromCentre.reduce((a, b) => a + b, 0);
    const all = screenFeasibility(screen, new Rng(1), recorderConfig);
    const nAll = all.reduce((a, b) => a + b, 0);
    expect(nCentre).toBeGreaterThan(150);
    expect(nAll).toBeGreaterThan(nCentre);
    // 1600+ px horizontally fits on a 3440 px wide screen, straight down does not.
    expect(all[cellIndex(6, 0, 2)]).toBe(1);
    expect(all[cellIndex(6, 3, 2)]).toBe(0);
  });

  it('steering prefers empty cells', () => {
    const rng = new Rng(3);
    const counts = new Float64Array(N_CELLS).fill(50);
    const empty = cellIndex(3, 0, 2);
    counts[empty] = 0;
    let hits = 0;
    for (let i = 0; i < 200; i++) {
      const p = placeTarget({ x: 1000, y: 720 }, screen, counts, rng, recorderConfig, 'steer');
      if (p && cellIndex(...p.cell) === empty) hits++;
    }
    expect(hits).toBeGreaterThan(150);
  });
});
