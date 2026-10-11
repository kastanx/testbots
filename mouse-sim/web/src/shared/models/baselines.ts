// The three naive baselines (mirrors models/baselines/__init__.py).
import type { BaselineParams } from '../bundle';
import { chord } from '../geometry';
import type { Rng } from '../rng';
import { toPixels, type SimTimeline, type TrialConditions } from '../timeline';
import type { SimModel } from './types';

export type BaselineKind = 'line' | 'minjerk' | 'bezier';

export class BaselineModel implements SimModel {
  readonly id: string;
  readonly label: string;

  constructor(readonly kind: BaselineKind, private p: BaselineParams) {
    this.id = `baseline_${kind}`;
    this.label = { line: 'Baseline: straight line', minjerk: 'Baseline: minimum jerk', bezier: 'Baseline: Bézier' }[kind];
  }

  async generate(cond: TrialConditions, rng: Rng): Promise<SimTimeline> {
    const { p } = this;
    const sx = cond.start.x;
    const sy = cond.start.y;
    const ex = cond.target.cx;
    const ey = cond.target.cy;
    const dx = ex - sx;
    const dy = ey - sy;
    const D = Math.hypot(dx, dy);
    const along = chord(cond.target.shape, cond.target.w, cond.target.h, Math.atan2(dy, dx));
    const mt = p.a_nominal + p.b_nominal * Math.log2(D / Math.max(along, 1) + 1);
    const move = Math.max(Math.round(mt - p.dwell), 40);
    const rt = Math.round(p.rt);
    const dwell = Math.round(p.dwell);
    const hold = Math.round(p.hold);
    const n = rt + move + 1 + dwell + hold;
    const path = new Float64Array(2 * n);
    let bend = 0;
    let bend2 = 0;
    if (this.kind === 'bezier') {
      bend = rng.uniform(0.05, 0.25) * (rng.next() < 0.5 ? -1 : 1);
      bend2 = bend * rng.uniform(0.3, 1.0);
    }
    const nx = -dy;
    const ny = dx;
    for (let k = 0; k < n; k++) {
      let x = sx;
      let y = sy;
      if (k >= rt + move) {
        x = ex;
        y = ey;
      } else if (k > rt) {
        const s = (k - rt) / move;
        if (this.kind === 'bezier') {
          const e = 0.5 - 0.5 * Math.cos(Math.PI * s);
          const u = 1 - e;
          const p1x = sx + dx / 3 + nx * bend;
          const p1y = sy + dy / 3 + ny * bend;
          const p2x = sx + (2 * dx) / 3 + nx * bend2;
          const p2y = sy + (2 * dy) / 3 + ny * bend2;
          x = u ** 3 * sx + 3 * u * u * e * p1x + 3 * u * e * e * p2x + e ** 3 * ex;
          y = u ** 3 * sy + 3 * u * u * e * p1y + 3 * u * e * e * p2y + e ** 3 * ey;
        } else {
          const prog = this.kind === 'line' ? s : 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5;
          x = sx + dx * prog;
          y = sy + dy * prog;
        }
      }
      path[2 * k] = x;
      path[2 * k + 1] = y;
    }
    const tDown = rt + move + dwell;
    return { pos: toPixels(path, cond.screen), clicks: [[tDown, tDown + hold]], target: cond.target, screen: cond.screen };
  }
}
