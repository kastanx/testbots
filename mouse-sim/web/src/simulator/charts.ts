// Speed-over-time and distance-to-target-over-time charts for the trial being played.
import type { Kinematics } from '../shared/analysis';
import type { SimTimeline } from '../shared/timeline';

function setup(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  return ctx;
}

function frame(ctx: CanvasRenderingContext2D, w: number, h: number, title: string) {
  ctx.fillStyle = '#8c8c8c';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(title, 34, 11);
  ctx.strokeStyle = '#444';
  ctx.beginPath();
  ctx.moveTo(32, 14);
  ctx.lineTo(32, h - 14);
  ctx.lineTo(w - 4, h - 14);
  ctx.stroke();
}

export interface ChartSeries {
  tl: SimTimeline;
  kin: Kinematics;
  color: string; // rgba(...)
}

export function drawCharts(speedCanvas: HTMLCanvasElement, distCanvas: HTMLCanvasElement,
  series: ChartSeries[], tNow: number): void {
  const sctx = setup(speedCanvas);
  const dctx = setup(distCanvas);
  const W = speedCanvas.clientWidth;
  const H = speedCanvas.clientHeight;
  frame(sctx, W, H, 'speed (px/ms)');
  frame(dctx, W, H, 'distance to target centre (px, log)');
  if (!series.length) return;
  const n = Math.max(...series.map((s) => s.kin.speed.length));
  const maxSpeed = Math.max(...series.map((s) => s.kin.maxSpeed), 0.05);
  let maxD = 2;
  for (const s of series) for (const d of s.kin.dist) maxD = Math.max(maxD, d);
  const x = (k: number) => 32 + ((W - 36) * k) / Math.max(n - 1, 1);
  const ys = (v: number) => H - 14 - ((H - 30) * v) / maxSpeed;
  const yd = (v: number) => H - 14 - ((H - 30) * Math.log10(Math.max(v, 0.5) / 0.5)) / Math.log10(maxD / 0.5);
  const faint = (c: string) => c.replace(/[\d.]+\)$/, '0.16)');
  for (const { tl, color } of series) {
    for (const [td, tu] of tl.clicks) {
      for (const c of [sctx, dctx]) {
        c.fillStyle = faint(color);
        c.fillRect(x(td), 14, Math.max(x(tu) - x(td), 1), H - 28);
      }
    }
  }
  const half = series[0].tl.target.w / 2;
  dctx.strokeStyle = 'rgba(255,255,255,0.15)';
  dctx.setLineDash([3, 3]);
  dctx.beginPath();
  dctx.moveTo(32, yd(half));
  dctx.lineTo(W - 4, yd(half));
  dctx.stroke();
  dctx.setLineDash([]);
  for (const { kin, color } of series) {
    sctx.strokeStyle = color;
    dctx.strokeStyle = color;
    sctx.lineWidth = dctx.lineWidth = 1.4;
    sctx.beginPath();
    dctx.beginPath();
    for (let k = 0; k < kin.speed.length; k++) {
      if (k === 0) {
        sctx.moveTo(x(k), ys(kin.speed[k]));
        dctx.moveTo(x(k), yd(kin.dist[k]));
      } else {
        sctx.lineTo(x(k), ys(kin.speed[k]));
        dctx.lineTo(x(k), yd(kin.dist[k]));
      }
    }
    sctx.stroke();
    dctx.stroke();
    sctx.fillStyle = '#fff';
    for (const k of kin.dips) {
      sctx.beginPath();
      sctx.arc(x(k), ys(kin.speed[k]), 2.5, 0, Math.PI * 2);
      sctx.fill();
    }
  }
  for (const c of [sctx, dctx]) {
    c.strokeStyle = 'rgba(255,255,255,0.6)';
    c.beginPath();
    c.moveTo(x(Math.min(tNow, n - 1)), 14);
    c.lineTo(x(Math.min(tNow, n - 1)), H - 14);
    c.stroke();
  }
}
