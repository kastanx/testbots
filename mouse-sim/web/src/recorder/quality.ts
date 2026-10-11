// Data quality checks shown between sessions (the pipeline re-checks the saved data).
import type { EventLog } from './capture';
import { pipelineConfig } from '../shared/config';

export interface Quality {
  n_moves: number;
  motion_intervals: number;
  event_rate_hz: number;
  interval_median_ms: number;
  gap_share: number;
  gap_threshold_ms: number;
  whole_pixel_share: number;
  polling_hz_assumed: number;
  ok: { rate: boolean; gaps: boolean; precision: boolean };
}

export function computeQuality(log: EventLog, dpr: number, pollingHz: number): Quality {
  const cfg = pipelineConfig;
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  let whole = 0;
  for (let i = 0; i < log.n; i++) {
    if (!log.isMove(i)) continue;
    t.push(log.t[i]);
    x.push(log.x[i] * dpr);
    y.push(log.y[i] * dpr);
    const fx = Math.abs(log.x[i] * dpr - Math.round(log.x[i] * dpr));
    const fy = Math.abs(log.y[i] * dpr - Math.round(log.y[i] * dpr));
    if (fx < 1e-3 && fy < 1e-3) whole++;
  }
  const n = t.length;
  const win = cfg.motion_window_ms;
  const gapMs = 2000 / pollingHz;
  const intervals: number[] = [];
  let gaps = 0;
  let sum = 0;
  let j = 0;
  for (let i = 1; i < n; i++) {
    while (j < i && t[j] < t[i] - win) j++;
    const k = Math.min(j, i - 1);
    const span = t[i] - t[k];
    if (span <= 0) continue;
    const speed = Math.hypot(x[i] - x[k], y[i] - y[k]) / span;
    if (speed < cfg.motion_speed) continue;
    const dt = t[i] - t[i - 1];
    intervals.push(dt);
    sum += dt;
    if (dt > gapMs) gaps++;
  }
  intervals.sort((a, b) => a - b);
  const median = intervals.length ? intervals[Math.floor(intervals.length / 2)] : NaN;
  const rate = sum > 0 ? (intervals.length / sum) * 1000 : NaN;
  const gapShare = intervals.length ? gaps / intervals.length : NaN;
  const wholeShare = n ? whole / n : NaN;
  const v = cfg.validate;
  return {
    n_moves: n,
    motion_intervals: intervals.length,
    event_rate_hz: rate,
    interval_median_ms: median,
    gap_share: gapShare,
    gap_threshold_ms: gapMs,
    whole_pixel_share: wholeShare,
    polling_hz_assumed: pollingHz,
    ok: {
      rate: rate >= v.min_event_rate_frac * pollingHz,
      gaps: gapShare <= v.max_gap_share,
      precision: wholeShare >= v.min_whole_pixel_share,
    },
  };
}

/** Median rAF interval -> refresh rate. */
export function refreshHz(frameTimes: number[]): number {
  const d: number[] = [];
  for (let i = 1; i < frameTimes.length; i++) d.push(frameTimes[i] - frameTimes[i - 1]);
  if (d.length < 10) return NaN;
  d.sort((a, b) => a - b);
  return 1000 / d[Math.floor(d.length / 2)];
}
