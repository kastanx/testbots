// Recorder (Phase 1): one target at a time on a neutral background, the normal Windows cursor,
// every mouse report captured through getCoalescedEvents(). No score, timer, sound or feedback.
import { recorderConfig as RC } from '../shared/config';
import { ApiError, getJson, postJson } from '../shared/api';
import { Rng } from '../shared/rng';
import { countsFromNested, placeTarget, screenFeasibility } from '../shared/placement';
import { GOAL_PER_CELL, cellIndex, inside, traceTarget, type Target } from '../shared/geometry';
import { EventLog } from './capture';
import { Uploader } from './uploader';
import { computeQuality, refreshHz, type Quality } from './quality';
import { drawHeatmap } from './heatmap';

interface SetupStatus {
  exists: boolean;
  confirmed: boolean;
  setup: { setup_version?: number; mouse?: { polling_hz?: number | null }; display?: { resolution?: number[]; refresh_hz?: number; scaling_percent?: number } } | null;
  problems: string[];
}
interface Coverage { counts: number[][][]; n_sessions: number; n_movements: number; goal_per_cell: number }
interface SessionInfo { session_id: string; role: string; complete: boolean; created_at: string; n_trials: number | null }

interface TrialRec {
  trial: number;
  shape: 'circle' | 'rect';
  cx: number; cy: number; w: number; h: number; r: number; // CSS px, like the events
  cell: [number, number, number];
  t_on: number;
  t_off: number | null;
  t_hit: number | null;
  t_up: number | null;
  misses: number;
  miss_t: number[];
  warmup: boolean;
  invalid: boolean;
  invalid_reasons: string[];
  start_x: number; start_y: number;
  plan: { D: number; theta: number; along: number; across: number }; // physical px
}

type Phase = 'form' | 'intro' | 'running' | 'paused' | 'ending' | 'summary';

const APP_VERSION = 'recorder-1';
const params = new URLSearchParams(location.search);
const SOURCE = params.get('source') === 'raw' ? 'pointerrawupdate' : 'pointermove';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('stage');
const ctx = canvas.getContext('2d', { alpha: false })!;
const overlay = $('overlay');
const panel = $('panel');

let phase: Phase = 'form';
let dpr = window.devicePixelRatio || 1;
let setup: SetupStatus | null = null;
let coverage: Coverage | null = null;
let browserProblems: string[] = [];
let formFrames: number[] = [];

// Session state
let log = new EventLog();
let trials: TrialRec[] = [];
let current: TrialRec | null = null;
let currentTarget: Target | null = null; // physical px
let awaitingUp = false;
let pendingPlacement = false;
let clearPending = false;
let lastPos: { x: number; y: number } | null = null; // CSS px
let counts: Float64Array = new Float64Array(0);
let rng = new Rng();
let mode: 'steer' | 'uniform' = 'steer';
let uploader: Uploader | null = null;
let sessionMeta: Record<string, unknown> = {};
let pauseTimer: number | null = null;
let backupTimer: number | null = null;
let rafId = 0;
let sessionFrames: number[] = [];
let tFirstTarget = 0;
let resizeCount = 0;
let wasFullscreen = false;

// ---------------------------------------------------------------- drawing

function resizeCanvas(): void {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  drawScene();
}

function drawScene(): void {
  ctx.fillStyle = RC.colors.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (currentTarget) {
    ctx.fillStyle = RC.colors.target;
    traceTarget(ctx, currentTarget);
    ctx.fill();
  }
}

function showOverlay(html: string | null): void {
  overlay.innerHTML = html ?? '';
  overlay.hidden = html === null;
}

// ---------------------------------------------------------------- trials

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

function placeAndShow(ts: number): void {
  const cursor = lastPos ? { x: lastPos.x * dpr, y: lastPos.y * dpr } : { x: canvas.width / 2, y: canvas.height / 2 };
  const placed = placeTarget(cursor, { w: canvas.width, h: canvas.height }, counts, rng, RC, mode);
  if (!placed) {
    pendingPlacement = true; // try again next frame (cursor may be in an odd spot)
    return;
  }
  const t = placed.target;
  currentTarget = t;
  const index = trials.length;
  current = {
    trial: index,
    shape: t.shape,
    cx: round4(t.cx / dpr), cy: round4(t.cy / dpr), w: round4(t.w / dpr), h: round4(t.h / dpr), r: round4(t.r / dpr),
    cell: placed.cell,
    t_on: round4(ts),
    t_off: null, t_hit: null, t_up: null,
    misses: 0, miss_t: [],
    warmup: index < RC.warmup_trials,
    invalid: false, invalid_reasons: [],
    start_x: round4(cursor.x / dpr), start_y: round4(cursor.y / dpr),
    plan: { D: round4(placed.D), theta: round4(placed.thetaDeg), along: round4(placed.along), across: round4(placed.across) },
  };
  drawScene();
  log.push('target_on', ts, NaN, NaN, 0, index);
}

function invalidate(reason: string): void {
  if (!current) return;
  current.invalid = true;
  if (!current.invalid_reasons.includes(reason)) current.invalid_reasons.push(reason);
}

/** Remove the target and store the trial record. */
function closeTrial(ts: number): void {
  if (!current) return;
  currentTarget = null;
  drawScene();
  log.push('target_off', ts, NaN, NaN, 0, current.trial);
  current.t_off = round4(ts);
  if (current.t_hit === null) invalidate('no_hit');
  const valid = !current.invalid && current.t_hit !== null;
  if (valid && !current.warmup && mode === 'steer') counts[cellIndex(...current.cell)] += 1;
  trials.push(current);
  current = null;
  awaitingUp = false;
}

function scheduleNext(): void {
  if (pauseTimer !== null) clearTimeout(pauseTimer);
  const delay = rng.uniform(RC.pause_ms[0], RC.pause_ms[1]);
  pauseTimer = window.setTimeout(() => {
    pauseTimer = null;
    if (phase === 'running') pendingPlacement = true;
  }, delay);
}

function frame(ts: number): void {
  sessionFrames.push(ts);
  if (phase === 'running') {
    if (clearPending) {
      clearPending = false;
      closeTrial(ts);
      if (performance.now() - tFirstTarget >= RC.session_minutes * 60_000) {
        void endSession('time_limit');
        return;
      }
      scheduleNext();
    } else if (pendingPlacement) {
      pendingPlacement = false;
      placeAndShow(ts);
    }
  }
  rafId = requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- input

function recordMoves(e: PointerEvent): void {
  if (e.pointerType !== 'mouse') return;
  const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  if (list.length === 0) {
    log.push('move', e.timeStamp, e.clientX, e.clientY, e.buttons);
  } else {
    for (const c of list) log.push('move', c.timeStamp, c.clientX, c.clientY, c.buttons);
  }
  const last = list.length ? list[list.length - 1] : e;
  lastPos = { x: last.clientX, y: last.clientY };
}

function onDown(e: PointerEvent): void {
  if (e.pointerType !== 'mouse') return;
  log.push('down', e.timeStamp, e.clientX, e.clientY, e.buttons, e.button);
  lastPos = { x: e.clientX, y: e.clientY };
  if (phase !== 'running' || e.button !== 0 || !current || !currentTarget || awaitingUp) return;
  if (inside(currentTarget, e.clientX * dpr, e.clientY * dpr)) {
    log.push('hit', e.timeStamp, e.clientX, e.clientY, 0, current.trial);
    current.t_hit = round4(e.timeStamp);
    awaitingUp = true;
  } else {
    log.push('miss', e.timeStamp, e.clientX, e.clientY, 0, current.trial);
    current.misses += 1;
    current.miss_t.push(round4(e.timeStamp));
  }
}

function onUp(e: PointerEvent): void {
  if (e.pointerType !== 'mouse') return;
  log.push('up', e.timeStamp, e.clientX, e.clientY, e.buttons, e.button);
  lastPos = { x: e.clientX, y: e.clientY };
  if (phase === 'intro' && e.button === 0) {
    beginTrials();
  } else if (awaitingUp && e.button === 0 && current) {
    current.t_up = round4(e.timeStamp);
    awaitingUp = false;
    clearPending = true; // the target disappears in the next frame, like a button reacting to the click
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.code === 'Space') {
    e.preventDefault();
    if (e.repeat) return;
    if (phase === 'running') pause();
    else if (phase === 'paused') resume();
  } else if (e.code === 'Escape') {
    e.preventDefault();
    void endSession('esc');
  }
}

function onBlur(): void {
  log.push('blur', performance.now());
  if (phase === 'running') pause();
}

function onFocus(): void {
  log.push('focus', performance.now());
}

function onLeave(e: PointerEvent): void {
  log.push('leave', e.timeStamp, e.clientX, e.clientY);
  invalidate('pointer_left');
}

function onEnter(e: PointerEvent): void {
  log.push('enter', e.timeStamp, e.clientX, e.clientY);
}

function onFullscreenChange(): void {
  if (document.fullscreenElement) {
    wasFullscreen = true;
  } else if (wasFullscreen && (phase === 'intro' || phase === 'running' || phase === 'paused')) {
    void endSession('fullscreen_exit'); // Esc in fullscreen is swallowed by the browser
  }
}

function onResize(): void {
  if (phase === 'form' || phase === 'summary') return;
  resizeCount += 1;
  invalidate('resize');
  resizeCanvas();
}

const preventMenu = (e: Event) => e.preventDefault();

function attach(): void {
  window.addEventListener(SOURCE, recordMoves as EventListener, { capture: true, passive: true });
  window.addEventListener('pointerdown', onDown, { capture: true });
  window.addEventListener('pointerup', onUp, { capture: true });
  window.addEventListener('keydown', onKey, { capture: true });
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  window.addEventListener('contextmenu', preventMenu);
  window.addEventListener('resize', onResize);
  document.documentElement.addEventListener('pointerleave', onLeave);
  document.documentElement.addEventListener('pointerenter', onEnter);
}

function detach(): void {
  window.removeEventListener(SOURCE, recordMoves as EventListener, { capture: true });
  window.removeEventListener('pointerdown', onDown, { capture: true });
  window.removeEventListener('pointerup', onUp, { capture: true });
  window.removeEventListener('keydown', onKey, { capture: true });
  window.removeEventListener('blur', onBlur);
  window.removeEventListener('focus', onFocus);
  window.removeEventListener('contextmenu', preventMenu);
  window.removeEventListener('resize', onResize);
  document.documentElement.removeEventListener('pointerleave', onLeave);
  document.documentElement.removeEventListener('pointerenter', onEnter);
}

// ---------------------------------------------------------------- session lifecycle

function pause(): void {
  phase = 'paused';
  log.push('pause', performance.now());
  pendingPlacement = false;
  clearPending = false;
  if (pauseTimer !== null) clearTimeout(pauseTimer);
  pauseTimer = null;
  if (current) {
    invalidate('paused');
    closeTrial(performance.now());
  }
  showOverlay('<p>Paused.</p><p class="dim">Space continues · Esc ends the session</p>');
}

function resume(): void {
  phase = 'running';
  log.push('resume', performance.now());
  showOverlay(null);
  scheduleNext();
}

function beginTrials(): void {
  phase = 'running';
  showOverlay(null);
  tFirstTarget = performance.now();
  scheduleNext();
}

function pollingHz(): number {
  return setup?.setup?.mouse?.polling_hz || 1000;
}

async function startSession(): Promise<void> {
  const role = (document.querySelector('input[name=role]:checked') as HTMLInputElement).value;
  const feeling = (document.querySelector('input[name=feeling]:checked') as HTMLInputElement | null)?.value ?? null;
  const notes = $<HTMLTextAreaElement>('notes').value.trim();
  const dryrun = $<HTMLInputElement>('dryrun').checked;
  setError(null);
  if (!dryrun && blockingProblems().length) {
    setError('Fix the problems above first, or tick "Dry run".');
    return;
  }
  $<HTMLButtonElement>('start').disabled = true;
  try {
    // Some embedded browsers never settle the promise, so don't wait forever.
    await Promise.race([
      document.documentElement.requestFullscreen({ navigationUI: 'hide' }),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch {
    // handled below
  }
  if (!document.fullscreenElement && !dryrun) {
    $<HTMLButtonElement>('start').disabled = false;
    setError('The recorder needs fullscreen for real sessions.');
    return;
  }
  wasFullscreen = !!document.fullscreenElement;
  await new Promise((r) => setTimeout(r, 350)); // let the fullscreen transition settle
  panel.hidden = true;
  resizeCanvas();

  log = new EventLog();
  trials = [];
  current = null;
  currentTarget = null;
  awaitingUp = pendingPlacement = clearPending = false;
  rng = new Rng();
  mode = role === 'train' ? 'steer' : 'uniform';
  counts = coverage ? countsFromNested(coverage.counts) : new Float64Array(0);
  sessionFrames = [];
  resizeCount = 0;
  sessionMeta = {
    role, feeling, notes, dryrun,
    app_version: APP_VERSION,
    event_source: SOURCE === 'pointermove' ? 'pointermove-coalesced' : 'pointerrawupdate-coalesced',
    user_agent: navigator.userAgent,
    ua_brands: (navigator as unknown as { userAgentData?: { brands: unknown } }).userAgentData?.brands ?? null,
    devicePixelRatio: dpr,
    screen_css: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight },
    screen_phys: [Math.round(screen.width * dpr), Math.round(screen.height * dpr)],
    viewport_css: [window.innerWidth, window.innerHeight],
    canvas_phys: [canvas.width, canvas.height],
    fullscreen: !!document.fullscreenElement,
    crossOriginIsolated: window.crossOriginIsolated,
    time_origin: performance.timeOrigin,
    started_at: new Date().toISOString(),
    units: 'css_px',
    refresh_hz_before: refreshHz(formFrames),
    seed: rng.seed,
    placement_mode: mode,
    recorder_config: RC,
  };
  let sessionId: string;
  try {
    sessionId = (await postJson<{ session_id: string }>('/api/sessions', { meta: sessionMeta, dryrun })).session_id;
  } catch (e) {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    panel.hidden = false;
    $<HTMLButtonElement>('start').disabled = false;
    setError(`Could not create the session: ${e instanceof ApiError ? e.message : e}`);
    return;
  }
  uploader = new Uploader(sessionId, log, () => trials);
  phase = 'intro';
  attach();
  rafId = requestAnimationFrame(frame);
  backupTimer = window.setInterval(() => void uploader?.flush(), RC.backup_interval_s * 1000);
  showOverlay(
    `<p>${RC.instruction}</p><p class="dim">Space pauses · Esc ends the session</p>` +
    `<p class="dim">${dryrun ? 'DRY RUN (not saved to the dataset) · ' : ''}Click anywhere to begin.</p>`,
  );
}

async function endSession(reason: string): Promise<void> {
  if (phase === 'ending' || phase === 'summary' || phase === 'form') return;
  phase = 'ending';
  if (pauseTimer !== null) clearTimeout(pauseTimer);
  if (backupTimer !== null) clearInterval(backupTimer);
  pauseTimer = backupTimer = null;
  if (current) {
    invalidate('session_end');
    closeTrial(performance.now());
  }
  cancelAnimationFrame(rafId);
  detach();
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  showOverlay('<p>Saving…</p>');

  const quality = computeQuality(log, dpr, pollingHz());
  const hits = trials.filter((t) => t.t_hit !== null).length;
  const meta = {
    ...sessionMeta,
    ended_at: new Date().toISOString(),
    end_reason: reason,
    refresh_hz: refreshHz(sessionFrames),
    quality,
    n_trials: trials.length,
    n_hits: hits,
    n_misses: trials.reduce((a, t) => a + t.misses, 0),
    n_invalid: trials.filter((t) => t.invalid).length,
    resize_count: resizeCount,
  };
  const ok = await uploader!.finish(meta);
  showOverlay(null);
  phase = 'summary';
  panel.hidden = false;
  $<HTMLButtonElement>('start').disabled = false;
  renderLastSession(meta, quality, ok);
  await refreshForm();
}

// ---------------------------------------------------------------- form & summary

function setError(msg: string | null): void {
  const el = $('error');
  el.textContent = msg ?? '';
  el.hidden = !msg;
}

function blockingProblems(): string[] {
  return [...(setup?.problems ?? ['server not reachable']), ...browserProblems];
}

function fmtPct(v: number): string {
  return Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '–';
}

function fmtNum(v: unknown, digits: number): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '–';
}

function qualityHtml(q: Quality): string {
  const row = (ok: boolean, label: string, value: string, hint: string) =>
    `<tr class="${ok ? 'ok' : 'bad'}"><td>${ok ? '✓' : '✗'}</td><td>${label}</td><td>${value}</td><td class="dim">${ok ? '' : hint}</td></tr>`;
  return `<table class="quality">
    ${row(q.ok.rate, 'Event rate while moving', `${fmtNum(q.event_rate_hz, 0)} Hz (median interval ${fmtNum(q.interval_median_ms, 2)} ms)`,
      `expected about ${q.polling_hz_assumed} Hz. Try <a href="?source=raw">pointerrawupdate</a>; if that is low too, see README "native helper".`)}
    ${row(q.ok.gaps, `Gaps over ${q.gap_threshold_ms.toFixed(0)} ms while moving`, fmtPct(q.gap_share), 'events are being dropped or merged')}
    ${row(q.ok.precision, 'Whole physical pixels', fmtPct(q.whole_pixel_share),
      'the browser rounds to CSS pixels; set Windows display scaling to 100% and browser zoom to 100%')}
  </table>
  <p class="dim">${q.n_moves.toLocaleString()} mouse events, ${q.motion_intervals.toLocaleString()} intervals while moving.</p>`;
}

function renderLastSession(meta: Record<string, unknown>, q: Quality, saved: boolean): void {
  const el = $('last-session');
  el.hidden = false;
  el.innerHTML = `<h2>Last session</h2>
    <p>${meta.n_hits} targets, ${meta.n_misses} misses, ${meta.n_invalid} invalid trials · ended by ${meta.end_reason}
    · refresh ${fmtNum(meta.refresh_hz, 1)} Hz · ${meta.dryrun ? 'dry run' : `role: ${meta.role}`}</p>
    ${qualityHtml(q)}
    ${saved ? '<p class="ok">Saved.</p>' : `<p class="bad">Upload failed: ${uploader?.lastError ?? ''}</p>
      <button id="retry">Retry upload</button> <button id="download">Download the data instead</button>`}`;
  if (!saved) {
    $('retry').onclick = async () => {
      const ok = await uploader!.finish(meta);
      renderLastSession(meta, q, ok);
    };
    $('download').onclick = () => {
      const blob = new Blob([JSON.stringify({ meta, trials, events: JSON.parse(`[${log.serialize(0, log.n)}]`) })],
        { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${uploader!.sessionId}.json`;
      a.click();
    };
  }
}

/** Physical screen size (hidden tabs can report 0x0, so fall back to setup.json, then the window). */
function screenPhys(): { w: number; h: number } {
  const w = Math.round(screen.width * dpr);
  const h = Math.round(screen.height * dpr);
  if (w > 0 && h > 0) return { w, h };
  const res = setup?.setup?.display?.resolution;
  if (res) return { w: res[0], h: res[1] };
  return { w: Math.round(window.innerWidth * dpr), h: Math.round(window.innerHeight * dpr) };
}

function checkBrowser(): string[] {
  const out: string[] = [];
  const s = setup?.setup;
  if (typeof PointerEvent === 'undefined' || !('getCoalescedEvents' in PointerEvent.prototype)) {
    out.push('This browser has no PointerEvent.getCoalescedEvents(); use current Chrome or Edge.');
  }
  if (s?.display?.scaling_percent && Math.abs(dpr - s.display.scaling_percent / 100) > 0.005) {
    out.push(`devicePixelRatio is ${dpr} but setup.json says ${s.display.scaling_percent}% scaling: set browser zoom to 100%.`);
  }
  const res = s?.display?.resolution;
  if (res && screen.width > 0 && (Math.round(screen.width * dpr) !== res[0] || Math.round(screen.height * dpr) !== res[1])) {
    out.push(`This screen is ${Math.round(screen.width * dpr)}×${Math.round(screen.height * dpr)}, setup.json says ${res[0]}×${res[1]}.`);
  }
  return out;
}

async function refreshForm(): Promise<void> {
  try {
    [setup, coverage] = await Promise.all([getJson<SetupStatus>('/api/setup'), getJson<Coverage>('/api/coverage')]);
  } catch (e) {
    setup = null;
    coverage = null;
    $('setup-status').innerHTML = `<p class="bad">Server not reachable (${e}). Start it with <code>start.bat</code>.</p>`;
    return;
  }
  browserProblems = checkBrowser();
  const problems = blockingProblems();
  const warnings: string[] = [];
  if (!window.crossOriginIsolated) warnings.push('Page is not cross-origin isolated: timestamps are limited to 0.1 ms.');
  const rr = refreshHz(formFrames);
  const want = setup.setup?.display?.refresh_hz;
  if (want && Number.isFinite(rr) && Math.abs(rr - want) > 3) {
    warnings.push(`Measured refresh is ${rr.toFixed(1)} Hz, setup.json says ${want} Hz.`);
  }
  $('setup-status').innerHTML =
    (problems.length
      ? `<p class="bad">Real sessions are blocked until these are fixed (dry runs still work):</p><ul>${problems.map((p) => `<li>${p}</li>`).join('')}</ul>`
      : `<p class="ok">Settings lock OK (setup_version ${setup.setup?.setup_version}).</p>`) +
    (warnings.length ? `<ul class="warn">${warnings.map((w) => `<li>${w}</li>`).join('')}</ul>` : '');
  $('source').innerHTML = SOURCE === 'pointermove'
    ? 'Event source: pointermove + getCoalescedEvents · <a href="?source=raw">use pointerrawupdate</a>'
    : 'Event source: pointerrawupdate + getCoalescedEvents · <a href="?">use pointermove</a>';

  const sessions = await getJson<SessionInfo[]>('/api/sessions').catch(() => [] as SessionInfo[]);
  const byRole = (r: string) => sessions.filter((s) => s.role === r && s.complete).length;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const todayCount = sessions.filter((s) => s.session_id.startsWith(today)).length;
  $('sessions-summary').innerHTML =
    `Sessions so far: ${byRole('train')} training, ${byRole('val')} validation, ${byRole('test')} test.` +
    (todayCount >= 2 ? ` <span class="warn">${todayCount} sessions today already; the protocol says at most 2–3 a day.</span>` : '');

  const feasible = screenFeasibility(screenPhys(), new Rng(1), RC);
  const flat = countsFromNested(coverage.counts);
  const goal = coverage.goal_per_cell || GOAL_PER_CELL;
  const { feasible: nf, atGoal } = drawHeatmap($<HTMLCanvasElement>('heatmap'), flat, feasible, goal);
  $('heatmap-caption').textContent =
    `${coverage.n_movements.toLocaleString()} training movements over ${coverage.n_sessions} sessions · ` +
    `${atGoal} of ${nf} reachable cells have at least ${goal}.`;
}

async function checkRate(): Promise<void> {
  const btn = $<HTMLButtonElement>('rate-check');
  const out = $('rate-result');
  const probe = new EventLog();
  const handler = (e: PointerEvent) => {
    const list = e.getCoalescedEvents?.() ?? [];
    for (const c of list.length ? list : [e]) probe.push('move', c.timeStamp, c.clientX, c.clientY, c.buttons);
  };
  btn.disabled = true;
  window.addEventListener(SOURCE, handler as EventListener, { capture: true, passive: true });
  for (let s = 5; s > 0; s--) {
    out.textContent = `Move the mouse around quickly… ${s}`;
    await new Promise((r) => setTimeout(r, 1000));
  }
  window.removeEventListener(SOURCE, handler as EventListener, { capture: true });
  btn.disabled = false;
  out.innerHTML = qualityHtml(computeQuality(probe, dpr, pollingHz()));
}

function formFrame(ts: number): void {
  if (phase === 'form' || phase === 'summary') {
    formFrames.push(ts);
    if (formFrames.length > 240) formFrames.shift();
  }
  requestAnimationFrame(formFrame);
}

function init(): void {
  resizeCanvas();
  window.addEventListener('resize', () => {
    if (phase === 'form' || phase === 'summary') resizeCanvas();
  });
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (phase === 'form' || phase === 'summary')) void refreshForm();
  });
  $('start').addEventListener('click', () => void startSession());
  $('rate-check').addEventListener('click', () => void checkRate());
  $('instruction').textContent = RC.instruction;
  requestAnimationFrame(formFrame);
  void refreshForm();
}

init();
