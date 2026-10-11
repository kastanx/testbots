// Coverage heatmap: one panel per size bin, distance bins as rows, direction bins as columns.
import { N_DIR, N_DIST, N_SIZE, SIZE_CENTERS, DIST_EDGES, cellIndex } from '../shared/geometry';

export function drawHeatmap(
  canvas: HTMLCanvasElement, counts: ArrayLike<number>, feasible: ArrayLike<number>, goal: number,
): { feasible: number; atGoal: number } {
  const cell = 14;
  const gap = 18;
  const left = 64;
  const top = 22;
  const panelW = N_DIR * cell;
  const cssW = left + N_SIZE * panelW + (N_SIZE - 1) * gap + 8;
  const cssH = top + N_DIST * cell + 34;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  let nFeasible = 0;
  let nGoal = 0;
  for (let si = 0; si < N_SIZE; si++) {
    const x0 = left + si * (panelW + gap);
    ctx.fillStyle = '#bbb';
    ctx.textAlign = 'center';
    ctx.fillText(`size ${SIZE_CENTERS[si]} px`, x0 + panelW / 2, 9);
    for (let di = 0; di < N_DIST; di++) {
      for (let ai = 0; ai < N_DIR; ai++) {
        const c = cellIndex(di, ai, si);
        const x = x0 + ai * cell;
        const y = top + di * cell;
        if (!feasible[c]) {
          ctx.fillStyle = '#2a2a2a';
        } else {
          nFeasible++;
          const f = Math.min(1, counts[c] / goal);
          if (f >= 1) nGoal++;
          // red (empty) -> amber -> green (at goal)
          const hue = 0 + 120 * f;
          ctx.fillStyle = `hsl(${hue}, ${f >= 1 ? 45 : 60}%, ${f >= 1 ? 38 : 28 + 14 * f}%)`;
        }
        ctx.fillRect(x, y, cell - 1, cell - 1);
      }
    }
    ctx.fillStyle = '#999';
    ctx.textAlign = 'center';
    for (let ai = 0; ai < N_DIR; ai += 3) {
      const arrow = ['→', '↓', '←', '↑'][ai / 3];
      ctx.fillText(arrow, x0 + ai * cell + cell / 2, top + N_DIST * cell + 9);
    }
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = '#999';
  for (let di = 0; di < N_DIST; di++) {
    const hi = DIST_EDGES[di + 1];
    const label = Number.isFinite(hi) ? `${DIST_EDGES[di]}–${hi}` : `${DIST_EDGES[di]}+`;
    ctx.fillText(label, left - 6, top + di * cell + cell / 2);
  }
  ctx.textAlign = 'left';
  ctx.fillText('rows: distance (px) · columns: direction · dark = not reachable on this screen',
    left, top + N_DIST * cell + 26);
  return { feasible: nFeasible, atGoal: nGoal };
}
