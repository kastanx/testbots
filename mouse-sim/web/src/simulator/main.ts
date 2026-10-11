// Simulator (Phase 7): pick a target and watch the selected model move the cursor there, at real
// speed and on whole physical pixels, with the analysis overlays, variations and the blind test.
import { analyse, speedColor, type Kinematics } from '../shared/analysis';
import { loadLibrary, loadManifest, type BaselineParams, type Manifest } from '../shared/bundle';
import { getJson } from '../shared/api';
import { recorderConfig as RC } from '../shared/config';
import { defaultCursor, loadCursor, type CursorSprite } from '../shared/cursor';
import { cornerRadius, traceTarget, type Shape, type Target } from '../shared/geometry';
import { BaselineModel } from '../shared/models/baselines';
import type { Generative } from '../shared/models/generative';
import { Hybrid, RealReplay } from '../shared/models/hybrid';
import { Library, MotionMatching } from '../shared/models/motionMatching';
import type { SimModel } from '../shared/models/types';
import { Rng } from '../shared/rng';
import { length, posAt, type ScreenSize, type SimTimeline, type TrialConditions } from '../shared/timeline';
import { BlindTest } from './blind';
import { drawCharts } from './charts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('stage');
const ctx = canvas.getContext('2d', { alpha: false })!;
const statusEl = $('status');

interface Playback {
  tl: SimTimeline;
  kin: Kinematics;
  t0: number;
  speed: number;
  resolve?: () => void;
  ended: boolean;
  real?: { tl: SimTimeline; kin: Kinematics }; // compare mode: the owner's recorded trial
  label?: string;
}

const YOU = 'rgba(110, 170, 255, 0.95)';
const MODEL = 'rgba(255, 150, 80, 0.95)';

let manifest: Manifest | null = null;
let lib: Library | null = null;
let testLib: Library | null = null;
let mm: MotionMatching | null = null;
let gen: Generative | null = null;
const models = new Map<string, SimModel>();
let cursor: CursorSprite = defaultCursor();
let dpr = window.devicePixelRatio || 1;
let screenSize: ScreenSize = { w: 1, h: 1 };
let cursorPos = { x: 0, y: 0 };
let play: Playback | null = null;
let lastCond: TrialConditions | null = null;
let variations: SimTimeline[] = [];
let closest: SimTimeline[] = [];
let hover: { x: number; y: number } | null = null;
let busy = false;
let blind: BlindTest | null = null;
let genError = '';
let lastCompared = -1;
const rng = new Rng();

const opts = {
  trail: () => $<HTMLInputElement>('opt-trail').checked,
  markers: () => $<HTMLInputElement>('opt-markers').checked,
  charts: () => $<HTMLInputElement>('opt-charts').checked,
  closest: () => $<HTMLInputElement>('opt-closest').checked,
  speed: () => Number($<HTMLInputElement>('speed').value),
};

function setStatus(html: string): void {
  statusEl.innerHTML = html;
}

// ------------------------------------------------------------------ geometry helpers

function resize(): void {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  screenSize = { w: canvas.width, h: canvas.height };
  if (!play) cursorPos = { x: Math.min(cursorPos.x || screenSize.w / 2, screenSize.w - 1), y: Math.min(cursorPos.y || screenSize.h / 2, screenSize.h - 1) };
}

function targetAt(x: number, y: number): Target {
  const shape = $<HTMLSelectElement>('shape').value as Shape;
  const size = Math.max(2, Number($<HTMLInputElement>('size').value) || 32);
  const aspect = Math.max(1, Number($<HTMLInputElement>('aspect').value) || 1);
  const w = shape === 'circle' ? size : Math.round(size * aspect);
  const h = size;
  return { shape, cx: Math.round(x), cy: Math.round(y), w, h, r: shape === 'rect' ? cornerRadius(w, h, RC.corner_radius_px) : 0 };
}

// ------------------------------------------------------------------ playback

function startPlayback(tl: SimTimeline, real?: SimTimeline, label?: string): Promise<void> {
  return new Promise((resolve) => {
    if (play?.resolve) play.resolve();
    play = {
      tl, kin: analyse(tl), t0: performance.now(), speed: blind ? 1 : opts.speed(), resolve, ended: false,
      real: real ? { tl: real, kin: analyse(real) } : undefined, label,
    };
    cursorPos = { x: tl.pos[0], y: tl.pos[1] };
    canvas.classList.add('playing');
  });
}

function lastUp(tl: SimTimeline): number {
  return tl.clicks.length ? tl.clicks[tl.clicks.length - 1][1] : length(tl) - 1;
}

/** Replay one of the owner's recorded trials next to the model's movement for the same start and
 *  target. Motion matching may not use the trial it is compared against. */
async function compareWithMe(): Promise<void> {
  if (!lib || !mm || blind || busy) return;
  const sel = $<HTMLSelectElement>('model').value;
  const model = models.get(sel === 'real' ? 'motion_matching' : sel);
  if (!model) return;
  let i = rng.int(lib.size);
  if (i === lastCompared && lib.size > 1) i = (i + 1) % lib.size;
  lastCompared = i;
  const real = lib.replay(i);
  const cond: TrialConditions = { start: { x: real.pos[0], y: real.pos[1] }, target: real.target, screen: screenSize };
  busy = true;
  mm.exclude = new Set([i]);
  let tl: SimTimeline;
  const t0 = performance.now();
  try {
    tl = await model.generate(cond, rng);
  } catch (e) {
    setStatus(`<span class="bad">${model.label} failed: ${e}</span>`);
    return;
  } finally {
    mm.exclude = new Set();
    busy = false;
  }
  describe(model, tl, performance.now() - t0, 1);
  statusEl.innerHTML = `<span style="color:${YOU}">■ you</span> (recorded trial ${real.meta?.source}) vs ` +
    `<span style="color:${MODEL}">■ ${model.label}</span>, same start and target.\n` + statusEl.innerHTML;
  lastCond = cond;
  variations = [];
  closest = [];
  void startPlayback(tl, real, model.id === 'motion_matching' ? 'motion matching' : model.id);
}

async function runModel(cond: TrialConditions, n = 1): Promise<SimTimeline[] | null> {
  const model = models.get($<HTMLSelectElement>('model').value);
  if (!model || busy) return null;
  busy = true;
  try {
    const t0 = performance.now();
    const out: SimTimeline[] = [];
    for (let i = 0; i < n; i++) out.push(await model.generate(cond, rng));
    describe(model, out[0], performance.now() - t0, n);
    return out;
  } catch (e) {
    setStatus(`<span class="bad">${model.label} failed: ${e}</span>`);
    return null;
  } finally {
    busy = false;
  }
}

function describe(model: SimModel, tl: SimTimeline, ms: number, n: number): void {
  const m = tl.meta ?? {};
  const parts = [`${model.label}`];
  if (m.real) parts.push(`recorded trial ${m.source}`);
  else if (m.source) {
    parts.push(`from ${m.source}: rotated ${Number(m.rotationDeg).toFixed(1)}°, ×${Number(m.scale).toFixed(2)} distance, ` +
      `×${Number(m.timeScale).toFixed(2)} time`);
  }
  if (m.generative) parts.push(`generative (${m.backend}, ${Number(m.ms).toFixed(0)} ms)`);
  if (m.fallback) parts.push('no qualifying real trial → generative');
  let html = parts.join('\n');
  if (m.lowCoverage) html += '\n<span class="warn">Low coverage: no recorded trial within the limits, used the nearest one.</span>';
  html += `\n${tl.clicks.length > 1 ? `${tl.clicks.length - 1} miss(es) · ` : ''}${length(tl)} ms trial · ${n > 1 ? `${n} trials in ` : ''}${ms.toFixed(0)} ms`;
  setStatus(html);
}

async function onStageClick(e: PointerEvent): Promise<void> {
  if (blind || e.button !== 0 || busy) return;
  const target = targetAt(e.clientX * dpr, e.clientY * dpr);
  // the movement starts wherever the simulated cursor is now (where it last stopped, or mid-flight)
  const cond: TrialConditions = { start: { x: Math.round(cursorPos.x), y: Math.round(cursorPos.y) }, target, screen: screenSize };
  lastCond = cond;
  variations = [];
  closest = mm && opts.closest() ? mm.closest(cond, 5) : [];
  const res = await runModel(cond);
  if (res) void startPlayback(res[0]);
}

async function replay(): Promise<void> {
  if (!lastCond || blind) return;
  const res = await runModel(lastCond);
  if (res) void startPlayback(res[0]);
}

async function showVariations(): Promise<void> {
  if (!lastCond || blind) return;
  const res = await runModel(lastCond, 10);
  if (res) {
    variations = res;
    void startPlayback(res[0]);
  }
}

// ------------------------------------------------------------------ rendering

function drawPath(tl: SimTimeline, upto: number, style: string | ((k: number) => string), width = 1.5, dash: number[] = []): void {
  const n = Math.min(length(tl), Math.max(1, Math.floor(upto) + 1));
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  if (typeof style === 'string') {
    ctx.strokeStyle = style;
    ctx.beginPath();
    ctx.moveTo(tl.pos[0] + 0.5, tl.pos[1] + 0.5);
    for (let k = 1; k < n; k++) ctx.lineTo(tl.pos[2 * k] + 0.5, tl.pos[2 * k + 1] + 0.5);
    ctx.stroke();
  } else {
    for (let k = 1; k < n; k++) {
      ctx.strokeStyle = style(k);
      ctx.beginPath();
      ctx.moveTo(tl.pos[2 * k - 2] + 0.5, tl.pos[2 * k - 1] + 0.5);
      ctx.lineTo(tl.pos[2 * k] + 0.5, tl.pos[2 * k + 1] + 0.5);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

function drawTarget(t: Target, pressed: boolean, alpha = 1): void {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = pressed ? '#a9a9a9' : RC.colors.target;
  traceTarget(ctx, t);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function render(now: number): void {
  ctx.fillStyle = RC.colors.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let tRel = 0;
  if (play) {
    tRel = (now - play.t0) * play.speed;
    const last = Math.max(lastUp(play.tl), play.real ? lastUp(play.real.tl) : 0);
    const pressed = play.tl.clicks.some(([td, tu]) => tRel >= td && tRel < tu)
      || (play.real?.tl.clicks.some(([td, tu]) => tRel >= td && tRel < tu) ?? false);
    if (tRel <= last) drawTarget(play.tl.target, pressed);
    else if (!blind && tRel < last + 500) drawTarget(play.tl.target, false, 1 - (tRel - last) / 500);
    if (play.real && !blind) {
      drawPath(play.real.tl, tRel, YOU, 2);
      drawPath(play.tl, tRel, MODEL, 2);
      const [rx, ry] = posAt(play.real.tl, tRel);
      cursor.draw(ctx, rx, ry);
      ctx.font = `${Math.round(12 * dpr)}px system-ui, sans-serif`;
      ctx.fillStyle = YOU;
      ctx.fillText('you', rx + 14 * dpr, ry + 26 * dpr);
      const [mx, my] = posAt(play.tl, tRel);
      ctx.fillStyle = MODEL;
      ctx.fillText(play.label ?? 'model', mx + 14 * dpr, my + 26 * dpr);
    } else if (!blind) {
      for (const v of variations.slice(1)) drawPath(v, Infinity, 'rgba(255,255,255,0.28)', 1);
      if (opts.closest()) for (const c of closest) drawPath(c, Infinity, 'rgba(226,192,111,0.55)', 1.2, [4, 3]);
      if (opts.trail()) {
        const k = play.kin;
        drawPath(play.tl, tRel, (i) => speedColor(k.speed[i], k.maxSpeed, 0.9), 2);
      }
      if (opts.markers()) {
        ctx.fillStyle = '#ffffff';
        for (const i of play.kin.dips) {
          if (i > tRel) continue;
          ctx.beginPath();
          ctx.arc(play.tl.pos[2 * i] + 0.5, play.tl.pos[2 * i + 1] + 0.5, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 1.5;
        for (const i of play.kin.overshoots) {
          if (i > tRel) continue;
          const x = play.tl.pos[2 * i] + 0.5;
          const y = play.tl.pos[2 * i + 1] + 0.5;
          ctx.beginPath();
          ctx.moveTo(x - 4, y);
          ctx.lineTo(x, y - 4);
          ctx.lineTo(x + 4, y);
          ctx.lineTo(x, y + 4);
          ctx.closePath();
          ctx.stroke();
        }
      }
    }
    const [x, y] = posAt(play.tl, tRel);
    cursorPos = { x, y };
    if (pressed && !blind) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x + 0.5, y + 0.5, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (!play.ended && tRel > last + (blind ? 350 : 0)) {
      play.ended = true;
      canvas.classList.remove('playing');
      play.resolve?.();
    }
  } else if (hover && !blind) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([4, 4]);
    traceTarget(ctx, targetAt(hover.x, hover.y));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (!play || play.ended) {
    if (hover && !blind && play?.ended) {
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.setLineDash([4, 4]);
      traceTarget(ctx, targetAt(hover.x, hover.y));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  cursor.draw(ctx, cursorPos.x, cursorPos.y);
  if (!blind && opts.charts()) {
    const series = !play ? [] : play.real
      ? [{ tl: play.real.tl, kin: play.real.kin, color: YOU }, { tl: play.tl, kin: play.kin, color: MODEL }]
      : [{ tl: play.tl, kin: play.kin, color: 'rgba(232, 163, 92, 1)' }];
    drawCharts($<HTMLCanvasElement>('chart-speed'), $<HTMLCanvasElement>('chart-dist'), series, tRel);
  }
  requestAnimationFrame(render);
}

// ------------------------------------------------------------------ blind test

function enterBlind(): void {
  const model = models.get($<HTMLSelectElement>('model').value);
  if (!testLib || !model || blind) return;
  $('toolbar').classList.add('hidden');
  $('charts').classList.add('hidden');
  variations = [];
  closest = [];
  void document.documentElement.requestFullscreen?.().catch(() => undefined);
  const ui = {
    root: $('blind'), msg: $('blind-msg'), buttons: $('blind-buttons'), a: $<HTMLButtonElement>('blind-a'),
    b: $<HTMLButtonElement>('blind-b'), replay: $<HTMLButtonElement>('blind-replay'), progress: $('blind-progress'),
  };
  const screen = manifest ? { w: manifest.screen[0], h: manifest.screen[1] } : screenSize;
  blind = new BlindTest(testLib, model, screen, rng, ui, startPlayback);
  void blind.run();
}

function exitBlind(): void {
  if (!blind) return;
  blind.stop();
  blind = null;
  $('blind').hidden = true;
  $('toolbar').classList.remove('hidden');
  $('charts').classList.toggle('hidden', !opts.charts());
}

// ------------------------------------------------------------------ setup

async function init(): Promise<void> {
  resize();
  cursorPos = { x: screenSize.w / 2, y: screenSize.h / 2 };
  window.addEventListener('resize', resize);
  canvas.addEventListener('pointerdown', (e) => void onStageClick(e));
  canvas.addEventListener('pointermove', (e) => (hover = { x: e.clientX * dpr, y: e.clientY * dpr }));
  canvas.addEventListener('pointerleave', () => (hover = null));
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const el = $<HTMLInputElement>('size');
    const v = Number(el.value) * (e.deltaY < 0 ? 1.12 : 1 / 1.12);
    el.value = String(Math.round(Math.min(256, Math.max(4, v))));
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  $<HTMLSelectElement>('shape').addEventListener('change', () => {
    $('aspect-wrap').style.visibility = $<HTMLSelectElement>('shape').value === 'rect' ? 'visible' : 'hidden';
  });
  $<HTMLInputElement>('speed').addEventListener('input', () => {
    $('speed-val').textContent = `${Number($<HTMLInputElement>('speed').value).toFixed(2)}×`;
    if (play) {
      const now = performance.now();
      const t = (now - play.t0) * play.speed;
      play.speed = opts.speed();
      play.t0 = now - t / play.speed;
    }
  });
  $<HTMLInputElement>('opt-charts').addEventListener('change', () => $('charts').classList.toggle('hidden', !opts.charts()));
  $<HTMLInputElement>('opt-closest').addEventListener('change', () => {
    closest = mm && lastCond && opts.closest() ? mm.closest(lastCond, 5) : [];
  });
  $('btn-replay').addEventListener('click', () => void replay());
  $('btn-compare').addEventListener('click', () => void compareWithMe());
  $('btn-vars').addEventListener('click', () => void showVariations());
  $('btn-blind').addEventListener('click', enterBlind);
  $('btn-full').addEventListener('click', () => void document.documentElement.requestFullscreen?.().catch(() => undefined));
  $('btn-fp').addEventListener('click', () => {
    window.open(manifest?.reports?.[$<HTMLSelectElement>('model').value] ?? '/reports/', '_blank');
  });
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
    if (e.key === 'Escape') exitBlind();
    if (blind) return;
    if (e.key === 'r') void replay();
    else if (e.key === 'c') void compareWithMe();
    else if (e.key === 'v') void showVariations();
    else if (e.key === 'f') void document.documentElement.requestFullscreen?.().catch(() => undefined);
  });
  requestAnimationFrame(render);

  manifest = await loadManifest();
  cursor = await loadCursor(manifest?.components.cursor?.png, manifest?.components.cursor?.hotspot);
  if (!manifest) {
    setStatus('<span class="bad">No model bundle yet. Process recordings, then run `python -m models.export`.</span>');
    return;
  }
  const badge = $('data-badge');
  badge.textContent = manifest.data === 'synthetic' ? 'SYNTHETIC data' : 'owner data';
  badge.classList.toggle('synthetic', manifest.data === 'synthetic');
  const sel = $<HTMLSelectElement>('model');
  const add = (m: SimModel) => {
    models.set(m.id, m);
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    sel.appendChild(o);
  };
  const c = manifest.components;
  if (c.mm) {
    lib = new Library(await loadLibrary(c.mm.json, c.mm.bin));
    mm = new MotionMatching(lib);
  }
  if (c.gen) {
    setStatus('Loading the generative model…');
    try {
      const { Generative } = await import('../shared/models/generative');
      gen = await Generative.load(c.gen.onnx, c.gen.json);
    } catch (e) {
      genError = `
<span class="warn">Generative model unavailable: ${e}</span>`;
      console.error(e);
    }
  }
  if (mm) add(new Hybrid(mm, gen));
  if (mm) add(mm);
  if (gen) add(gen);
  if (lib && mm) add(new RealReplay(lib, mm));
  if (c.baselines) {
    const p = await getJson<BaselineParams>(`/bundle/${c.baselines}`);
    for (const k of ['line', 'minjerk', 'bezier'] as const) add(new BaselineModel(k, p));
  }
  if (c.test) testLib = new Library(await loadLibrary(c.test.json, c.test.bin));
  // handle for the console and the end-to-end checks in tools/
  Object.assign(window, { mouseSim: { models, gen, mm, lib, testLib } });
  $<HTMLButtonElement>('btn-blind').disabled = !testLib;
  $<HTMLButtonElement>('btn-compare').disabled = !lib;
  if (!testLib) $('btn-blind').title = 'Needs recorded test sessions (role: test)';
  const [sw, sh] = manifest.screen;
  const warn = sw !== screenSize.w || sh !== screenSize.h
    ? `\n<span class="warn">The window is ${screenSize.w}×${screenSize.h}, recordings were ${sw}×${sh}: go fullscreen on the same monitor.</span>`
    : '';
  setStatus(`Ready: ${models.size} models${gen ? ` (generative on ${gen.backend})` : ''}, ${lib?.size ?? 0} recorded trials` +
    `${testLib ? `, ${testLib.size} test trials for the blind test` : ''}.${warn}${genError}`);
}

void init();
