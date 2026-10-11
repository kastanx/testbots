// Target placement for the recorder: pick a coverage cell that fits on the screen from the
// current cursor position (preferring cells with few movements so far, with some randomness),
// then a random distance, direction and size inside that cell. Everything in physical pixels.
import {
  DIR_WIDTH, DIST_EDGES, N_CELLS, SIZE_EDGES, DEG, cellFromIndex, cellIndex,
  conditions, cornerRadius, distBin, dirBin, sizeBin, type Pt, type Shape, type Target,
} from './geometry';
import type { Rng } from './rng';

export interface PlacementConfig {
  circle_probability: number;
  rect_aspect_range: number[];
  rect_side_range_px: number[];
  corner_radius_px: number;
  edge_margin_px: number;
  start_outside_margin_px: number;
  feasibility_samples: number;
  placement_samples: number;
  steering_power: number;
}

export interface Screen {
  w: number;
  h: number;
}

export interface Placed {
  target: Target;
  cell: [number, number, number];
  D: number;
  thetaDeg: number;
  along: number;
  across: number;
}

/** One random draw inside a cell; null if it doesn't fit on the screen or lands in another cell. */
export function sampleInCell(cellIdx: number, cursor: Pt, screen: Screen, rng: Rng, cfg: PlacementConfig): Placed | null {
  const [di, ai, si] = cellFromIndex(cellIdx);
  const dLo = DIST_EDGES[di];
  const dHi = Math.min(DIST_EDGES[di + 1], Math.hypot(screen.w, screen.h));
  if (dHi <= dLo) return null;
  const D0 = rng.logUniform(dLo, dHi);
  const theta = (ai * DIR_WIDTH + rng.uniform(-DIR_WIDTH / 2, DIR_WIDTH / 2)) * DEG;
  const along0 = rng.logUniform(SIZE_EDGES[si], SIZE_EDGES[si + 1]);

  let shape: Shape;
  let w: number;
  let h: number;
  if (rng.next() < cfg.circle_probability) {
    shape = 'circle';
    w = h = Math.max(2, Math.round(along0));
  } else {
    shape = 'rect';
    const c = Math.abs(Math.cos(theta));
    const s = Math.abs(Math.sin(theta));
    const aspect = rng.logUniform(cfg.rect_aspect_range[0], cfg.rect_aspect_range[1]);
    // chord along theta = h * min(aspect/|cos|, 1/|sin|); solve for h.
    const m = Math.min(c > 1e-9 ? aspect / c : Infinity, s > 1e-9 ? 1 / s : Infinity);
    h = Math.round(along0 / m);
    w = Math.round(aspect * h);
    const [lo, hi] = cfg.rect_side_range_px;
    if (w < lo || h < lo || w > hi || h > hi) return null;
  }
  const cx = Math.round(cursor.x + D0 * Math.cos(theta));
  const cy = Math.round(cursor.y + D0 * Math.sin(theta));
  const target: Target = { shape, cx, cy, w, h, r: shape === 'rect' ? cornerRadius(w, h, cfg.corner_radius_px) : 0 };

  const m = cfg.edge_margin_px;
  if (cx - w / 2 < m || cx + w / 2 > screen.w - m || cy - h / 2 < m || cy + h / 2 > screen.h - m) return null;
  const { D, thetaDeg, along, across } = conditions(cursor, target);
  if (D < along / 2 + cfg.start_outside_margin_px) return null; // cursor must start outside the target
  const cell: [number, number, number] = [distBin(D), dirBin(thetaDeg), sizeBin(along)];
  if (cellIndex(...cell) !== cellIdx) return null; // rounding pushed it over a bin edge
  return { target, cell, D, thetaDeg, along, across };
}

export function feasibleCells(cursor: Pt, screen: Screen, rng: Rng, cfg: PlacementConfig): Uint8Array {
  const ok = new Uint8Array(N_CELLS);
  for (let c = 0; c < N_CELLS; c++) {
    for (let k = 0; k < cfg.feasibility_samples; k++) {
      if (sampleInCell(c, cursor, screen, rng, cfg)) {
        ok[c] = 1;
        break;
      }
    }
  }
  return ok;
}

/**
 * Next target. 'steer' weights feasible cells by 1/(1+count)^p so sparse cells come up more often
 * (training sessions); 'uniform' weights every feasible cell equally (validation and test sessions,
 * so they stay a balanced sample instead of chasing gaps).
 */
export function placeTarget(
  cursor: Pt, screen: Screen, counts: ArrayLike<number>, rng: Rng, cfg: PlacementConfig,
  mode: 'steer' | 'uniform',
): Placed | null {
  const feasible = feasibleCells(cursor, screen, rng, cfg);
  const weights = new Float64Array(N_CELLS);
  for (let c = 0; c < N_CELLS; c++) {
    if (!feasible[c]) continue;
    weights[c] = mode === 'steer' ? 1 / Math.pow(1 + counts[c], cfg.steering_power) : 1;
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const c = rng.weighted(weights);
    if (c < 0) return null;
    for (let k = 0; k < cfg.placement_samples; k++) {
      const p = sampleInCell(c, cursor, screen, rng, cfg);
      if (p) return p;
    }
    weights[c] = 0;
  }
  return null;
}

/** Which cells can be reached from somewhere on this screen (for the coverage heatmap). */
export function screenFeasibility(screen: Screen, rng: Rng, cfg: PlacementConfig, grid = 9): Uint8Array {
  const ok = new Uint8Array(N_CELLS);
  for (let gx = 0; gx < grid; gx++) {
    for (let gy = 0; gy < grid; gy++) {
      const cursor = { x: ((gx + 0.5) / grid) * screen.w, y: ((gy + 0.5) / grid) * screen.h };
      for (let c = 0; c < N_CELLS; c++) {
        if (ok[c]) continue;
        for (let k = 0; k < 4; k++) {
          if (sampleInCell(c, cursor, screen, rng, cfg)) {
            ok[c] = 1;
            break;
          }
        }
      }
    }
  }
  // Long cells are reachable from the screen edges, which a coarse grid can miss.
  for (let c = 0; c < N_CELLS; c++) {
    if (ok[c]) continue;
    const [, ai] = cellFromIndex(c);
    const back = (ai * DIR_WIDTH + 180) * DEG;
    for (let k = 0; k < 40 && !ok[c]; k++) {
      const cursor = {
        x: Math.min(screen.w - 1, Math.max(0, screen.w / 2 + Math.cos(back) * screen.w * 0.49)),
        y: Math.min(screen.h - 1, Math.max(0, screen.h / 2 + Math.sin(back) * screen.h * 0.49 + rng.uniform(-0.3, 0.3) * screen.h)),
      };
      if (sampleInCell(c, cursor, screen, rng, cfg)) ok[c] = 1;
    }
  }
  return ok;
}

export function countsFromNested(nested: number[][][]): Float64Array {
  const out = new Float64Array(N_CELLS);
  nested.forEach((byDir, di) => byDir.forEach((bySize, ai) => bySize.forEach((n, si) => {
    out[cellIndex(di, ai, si)] = n;
  })));
  return out;
}
