/* Click Recorder — renderer.
 *
 * Editing model: on disk each event carries a cumulative `time` (ms from the
 * start of the recording). That is awkward to edit, so in the editor we hold
 * `delay` (ms since the previous click) instead and convert on load/save. The
 * round-trip is exact, so recordings.json stays byte-compatible with the CLI.
 */

const $ = (id) => document.getElementById(id);

const el = {
  monitorDot: $('monitorDot'),
  btnHotkeys: $('btnHotkeys'),
  hotkeyLabel: $('hotkeyLabel'),
  btnRecord: $('btnRecord'),
  btnPlay: $('btnPlay'),
  btnPause: $('btnPause'),
  btnStop: $('btnStop'),
  optHumanize: $('optHumanize'),
  optDuration: $('optDuration'),
  btnSave: $('btnSave'),
  btnNew: $('btnNew'),
  btnReveal: $('btnReveal'),
  recordingList: $('recordingList'),
  recordingName: $('recordingName'),
  btnAddHere: $('btnAddHere'),
  btnPick: $('btnPick'),
  btnFit: $('btnFit'),
  btnUndo: $('btnUndo'),
  btnRedo: $('btnRedo'),
  canvasWrap: $('canvasWrap'),
  canvas: $('canvas'),
  canvasHint: $('canvasHint'),
  countdown: $('countdown'),
  statusText: $('statusText'),
  screenInfo: $('screenInfo'),
  eventList: $('eventList'),
  clickCount: $('clickCount'),
  totalDuration: $('totalDuration'),
  log: $('log')
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_DELAY = 500;

const state = {
  recordings: [],
  selectedId: null,      // null => unsaved draft
  name: '',
  items: [],             // [{x, y, delay, button}]
  selectedIndex: null,
  baseline: '',          // serialised snapshot used for the dirty check
  screen: { width: 1920, height: 1080 },
  view: null,            // null => auto-fit; set once the user zooms or pans
  hotkeysArmed: true,
  monitorReady: false,
  mode: 'idle',          // idle | recording | playing
  paused: false,
  playingIndex: null,
  playlistIds: new Set(),
  undo: [],
  redo: []
};

/* ------------------------------------------------------------- conversions */

// `extra` carries any fields we don't model (older recordings have a
// `randomize` flag, for instance) so editing a recording never drops them.
const toItems = (events) =>
  (events || []).map((e, i) => {
    const { x, y, time, button, ...extra } = e;
    return {
      x: Math.round(x),
      y: Math.round(y),
      delay: Math.max(0, Math.round(time - (i > 0 ? events[i - 1].time : 0))),
      button: button || 0,
      extra
    };
  });

const toEvents = (items) => {
  let t = 0;
  return items.map((it) => {
    t += Math.max(0, Math.round(it.delay) || 0);
    return {
      x: Math.round(it.x),
      y: Math.round(it.y),
      time: t,
      button: it.button || 0,
      ...(it.extra || {})
    };
  });
};

const totalMs = (items) => items.reduce((sum, it) => sum + (Number(it.delay) || 0), 0);

const fmtDuration = (ms) =>
  ms < 60000 ? `${(ms / 1000).toFixed(1)}s`
             : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;

/* -------------------------------------------------------------------- misc */

function log(message, kind) {
  const line = document.createElement('div');
  if (kind) line.className = kind;
  const now = new Date();
  const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  line.textContent = `${stamp}  ${message}`;
  el.log.appendChild(line);
  while (el.log.childElementCount > 300) el.log.removeChild(el.log.firstChild);
  el.log.scrollTop = el.log.scrollHeight;
}

const serialise = () => JSON.stringify({ name: state.name, items: state.items });
const isDirty = () => serialise() !== state.baseline;

function markClean() {
  state.baseline = serialise();
  refreshChrome();
}

function pushUndo() {
  state.undo.push(serialise());
  if (state.undo.length > 100) state.undo.shift();
  state.redo.length = 0;
}

function applySnapshot(raw) {
  const snap = JSON.parse(raw);
  state.name = snap.name;
  state.items = snap.items;
  if (state.selectedIndex !== null && state.selectedIndex >= state.items.length) {
    state.selectedIndex = state.items.length ? state.items.length - 1 : null;
  }
  el.recordingName.value = state.name;
  renderAll();
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(serialise());
  applySnapshot(state.undo.pop());
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(serialise());
  applySnapshot(state.redo.pop());
}

/* --------------------------------------------------------------- rendering */

function renderAll() {
  renderSidebar();
  renderCanvas();
  renderEventList();
  refreshChrome();
}

function refreshChrome() {
  const dirty = isDirty();
  const busy = state.mode !== 'idle';

  el.btnSave.disabled = !dirty || busy;
  el.btnUndo.disabled = !state.undo.length || busy;
  el.btnRedo.disabled = !state.redo.length || busy;
  el.btnAddHere.disabled = busy;
  el.btnPick.disabled = busy;
  el.btnFit.disabled = !state.view;
  el.btnNew.disabled = busy;
  el.recordingName.disabled = busy;
  el.optHumanize.disabled = state.mode === 'playing';
  el.optDuration.disabled = state.mode === 'playing';

  el.clickCount.textContent = state.items.length;
  el.totalDuration.textContent = fmtDuration(totalMs(state.items));

  el.btnRecord.classList.toggle('active', state.mode === 'recording');
  el.btnPlay.classList.toggle('active', state.mode === 'playing');
  el.btnPlay.hidden = state.mode === 'playing';
  el.btnPause.hidden = state.mode !== 'playing';
  el.btnStop.hidden = state.mode === 'idle';
  el.btnPause.textContent = state.paused ? 'Resume' : 'Pause';
  el.btnRecord.disabled = state.mode === 'playing';

  const where = state.selectedId ? '' : ' · unsaved';
  const label =
    state.mode === 'recording' ? `Recording — press Space to capture a click, S to stop`
    : state.mode === 'playing' ? (state.paused ? 'Playback paused' : 'Playing…')
    : `${state.items.length} click${state.items.length === 1 ? '' : 's'}${dirty ? ' · modified' : ''}${where}`;
  el.statusText.textContent = label;
}

function renderSidebar() {
  el.recordingList.innerHTML = '';

  if (!state.recordings.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No recordings yet. Press R (or Record) to capture one.';
    el.recordingList.appendChild(li);
    return;
  }

  for (const rec of state.recordings) {
    const li = document.createElement('li');
    li.classList.toggle('active', rec.id === state.selectedId);

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.title = 'Include in playlist (random order each loop)';
    check.checked = state.playlistIds.has(rec.id);
    check.addEventListener('click', (e) => e.stopPropagation());
    check.addEventListener('change', () => {
      if (check.checked) state.playlistIds.add(rec.id);
      else state.playlistIds.delete(rec.id);
      refreshChrome();
    });

    const name = document.createElement('span');
    name.className = 'rec-name';
    name.textContent = rec.name;
    name.title = rec.name;

    const meta = document.createElement('span');
    meta.className = 'rec-meta';
    meta.textContent = `${rec.events.length}`;

    const actions = document.createElement('span');
    actions.className = 'row-actions';

    const dup = document.createElement('button');
    dup.className = 'icon-btn';
    dup.textContent = '⧉';
    dup.title = 'Duplicate';
    dup.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await window.api.recordings.duplicate(rec.id);
      if (!res.ok) return log(res.error, 'err');
      await reloadRecordings();
      log(`Duplicated "${rec.name}"`, 'good');
    });

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '×';
    del.title = 'Delete';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const yes = await window.api.confirm({
        title: 'Delete recording',
        message: `Delete "${rec.name}"?`,
        detail: `${rec.events.length} clicks will be removed from recordings.json.`
      });
      if (!yes) return;
      const res = await window.api.recordings.remove(rec.id);
      if (!res.ok) return log(res.error, 'err');
      state.playlistIds.delete(rec.id);
      if (state.selectedId === rec.id) newDraft();
      await reloadRecordings();
      log(`Deleted "${rec.name}"`, 'good');
    });

    actions.append(dup, del);
    li.append(check, name, meta, actions);
    li.addEventListener('click', () => selectRecording(rec.id));
    el.recordingList.appendChild(li);
  }
}

/* ------------------------------------------------------------------ canvas */

let viewBox = { x: 0, y: 0, w: 1920, h: 1080 };
let unitsPerPixel = 1;

/** The whole screen plus any clicks that fall outside it. */
function fitViewBox() {
  const pad = Math.round(Math.max(state.screen.width, state.screen.height) * 0.03);
  let minX = 0, minY = 0;
  let maxX = state.screen.width, maxY = state.screen.height;

  for (const it of state.items) {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x);
    maxY = Math.max(maxY, it.y);
  }
  return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}

function computeViewBox() {
  // state.view is set once the user zooms or pans; until then track the data.
  viewBox = state.view ? { ...state.view } : fitViewBox();
}

function resetView() {
  state.view = null;
  renderCanvas();
  refreshChrome();
}

function zoomBy(factor, anchor) {
  const base = state.view || fitViewBox();
  const fit = fitViewBox();

  // Don't let the user zoom out past the fit, or in past ~4px of screen space.
  const minW = 40;
  const maxW = fit.w;
  const w = Math.min(maxW, Math.max(minW, base.w * factor));
  const scale = w / base.w;
  const h = base.h * scale;

  state.view = {
    x: anchor.x - (anchor.x - base.x) * scale,
    y: anchor.y - (anchor.y - base.y) * scale,
    w,
    h
  };
  renderCanvas();
  refreshChrome();
}

function sizeCanvas() {
  const wrap = el.canvasWrap.getBoundingClientRect();
  const availW = Math.max(80, wrap.width - 36);
  const availH = Math.max(80, wrap.height - 36);
  const aspect = viewBox.w / viewBox.h;

  let w = availW;
  let h = w / aspect;
  if (h > availH) { h = availH; w = h * aspect; }

  el.canvas.setAttribute('width', Math.round(w));
  el.canvas.setAttribute('height', Math.round(h));
  el.canvas.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
  unitsPerPixel = viewBox.w / w;
}

function renderCanvas() {
  computeViewBox();
  sizeCanvas();

  while (el.canvas.firstChild) el.canvas.removeChild(el.canvas.firstChild);

  // dashed outline of the actual screen
  const frame = document.createElementNS(SVG_NS, 'rect');
  frame.setAttribute('class', 'screen-frame');
  frame.setAttribute('x', 0);
  frame.setAttribute('y', 0);
  frame.setAttribute('width', state.screen.width);
  frame.setAttribute('height', state.screen.height);
  frame.setAttribute('vector-effect', 'non-scaling-stroke');
  el.canvas.appendChild(frame);

  if (state.items.length > 1) {
    const path = document.createElementNS(SVG_NS, 'polyline');
    path.setAttribute('class', 'link-line');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.setAttribute('points', state.items.map((it) => `${it.x},${it.y}`).join(' '));
    el.canvas.appendChild(path);
  }

  const r = 13 * unitsPerPixel;

  state.items.forEach((it, i) => {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'point' +
      (i === state.selectedIndex ? ' active' : '') +
      (i === state.playingIndex ? ' playing' : ''));
    g.dataset.index = String(i);

    const halo = document.createElementNS(SVG_NS, 'circle');
    halo.setAttribute('class', 'halo');
    halo.setAttribute('cx', it.x); halo.setAttribute('cy', it.y);
    halo.setAttribute('r', r * 1.75);

    const body = document.createElementNS(SVG_NS, 'circle');
    body.setAttribute('class', 'body');
    body.setAttribute('cx', it.x); body.setAttribute('cy', it.y);
    body.setAttribute('r', r);
    body.setAttribute('vector-effect', 'non-scaling-stroke');

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', it.x); label.setAttribute('y', it.y);
    label.setAttribute('font-size', 11 * unitsPerPixel);
    label.textContent = String(i + 1);

    g.append(halo, body, label);
    el.canvas.appendChild(g);
  });
}

/** Update point positions without rebuilding the DOM (used while dragging). */
function repaintPoint(index) {
  const g = el.canvas.querySelector(`g.point[data-index="${index}"]`);
  if (!g) return;
  const it = state.items[index];
  for (const c of g.querySelectorAll('circle')) {
    c.setAttribute('cx', it.x); c.setAttribute('cy', it.y);
  }
  const t = g.querySelector('text');
  t.setAttribute('x', it.x); t.setAttribute('y', it.y);

  const line = el.canvas.querySelector('polyline.link-line');
  if (line) line.setAttribute('points', state.items.map((p) => `${p.x},${p.y}`).join(' '));
}

function clientToUser(evt) {
  const ctm = el.canvas.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const pt = el.canvas.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const p = pt.matrixTransform(ctm.inverse());
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/* -------------------------------------------------------------- event list */

let rowRefs = [];

function renderEventList() {
  el.eventList.innerHTML = '';
  rowRefs = [];

  if (!state.items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No clicks yet.\nClick anywhere on the map to add one, or press Record.';
    el.eventList.appendChild(li);
    return;
  }

  state.items.forEach((it, i) => {
    const li = document.createElement('li');
    li.className = 'event-row' +
      (i === state.selectedIndex ? ' active' : '') +
      (i === state.playingIndex ? ' playing' : '');

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);

    const mkNum = (field, min) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.value = it[field];
      if (min !== undefined) input.min = String(min);
      input.addEventListener('focus', () => selectIndex(i));
      input.addEventListener('change', () => {
        pushUndo();
        const n = Math.round(Number(input.value) || 0);
        state.items[i][field] = min !== undefined ? Math.max(min, n) : n;
        input.value = state.items[i][field];
        renderCanvas();
        refreshChrome();
      });
      return input;
    };

    const xIn = mkNum('x');
    const yIn = mkNum('y');
    const dIn = mkNum('delay', 0);

    const del = document.createElement('button');
    del.className = 'row-del';
    del.textContent = '×';
    del.title = 'Delete this click';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteIndex(i); });

    li.append(idx, xIn, yIn, dIn, del);
    li.addEventListener('mousedown', () => selectIndex(i));
    el.eventList.appendChild(li);
    rowRefs.push({ li, xIn, yIn, dIn });
  });
}

function syncRow(i) {
  const ref = rowRefs[i];
  if (!ref) return;
  ref.xIn.value = state.items[i].x;
  ref.yIn.value = state.items[i].y;
}

function selectIndex(i) {
  if (state.selectedIndex === i) return;
  state.selectedIndex = i;
  for (let k = 0; k < rowRefs.length; k++) rowRefs[k].li.classList.toggle('active', k === i);
  for (const g of el.canvas.querySelectorAll('g.point')) {
    g.classList.toggle('active', Number(g.dataset.index) === i);
  }
}

/* ------------------------------------------------------------- mutations */

function addPoint(x, y, atIndex) {
  pushUndo();
  const item = { x: Math.round(x), y: Math.round(y), delay: state.items.length ? DEFAULT_DELAY : 0, button: 0 };
  const index = atIndex === undefined ? state.items.length : atIndex;
  state.items.splice(index, 0, item);
  state.selectedIndex = index;
  renderCanvas();
  renderEventList();
  refreshChrome();
  return index;
}

function deleteIndex(i) {
  if (i < 0 || i >= state.items.length) return;
  pushUndo();
  state.items.splice(i, 1);
  if (state.selectedIndex !== null) {
    if (state.selectedIndex === i) state.selectedIndex = state.items.length ? Math.min(i, state.items.length - 1) : null;
    else if (state.selectedIndex > i) state.selectedIndex--;
  }
  renderCanvas();
  renderEventList();
  refreshChrome();
}

function moveIndex(from, to) {
  if (to < 0 || to >= state.items.length) return;
  pushUndo();
  const [item] = state.items.splice(from, 1);
  state.items.splice(to, 0, item);
  state.selectedIndex = to;
  renderCanvas();
  renderEventList();
  refreshChrome();
}

function nudge(dx, dy) {
  const i = state.selectedIndex;
  if (i === null) return;
  pushUndo();
  state.items[i].x += dx;
  state.items[i].y += dy;
  repaintPoint(i);
  syncRow(i);
  refreshChrome();
}

/* --------------------------------------------------------- load / save */

async function reloadRecordings() {
  const res = await window.api.recordings.list();
  if (!res.ok) return log(res.error, 'err');
  state.recordings = res.data;
  for (const id of [...state.playlistIds]) {
    if (!state.recordings.some((r) => r.id === id)) state.playlistIds.delete(id);
  }
  renderSidebar();
  refreshChrome();
}

async function confirmDiscard() {
  if (!isDirty()) return true;
  return window.api.confirm({
    title: 'Discard changes?',
    message: 'You have unsaved changes.',
    detail: 'Switching now will lose them.',
    confirmLabel: 'Discard'
  });
}

async function selectRecording(id) {
  if (id === state.selectedId) return;
  if (!(await confirmDiscard())) return;

  const rec = state.recordings.find((r) => r.id === id);
  if (!rec) return;

  state.selectedId = rec.id;
  state.name = rec.name;
  state.items = toItems(rec.events);
  state.selectedIndex = null;
  state.playingIndex = null;
  state.view = null;
  state.undo.length = 0;
  state.redo.length = 0;
  el.recordingName.value = rec.name;
  markClean();
  renderAll();
}

async function newDraft(items, name) {
  state.selectedId = null;
  state.name = name || `Recording ${new Date().toLocaleTimeString()}`;
  state.items = items || [];
  state.selectedIndex = null;
  state.playingIndex = null;
  state.view = null;
  state.undo.length = 0;
  state.redo.length = 0;
  el.recordingName.value = state.name;
  state.baseline = '';   // a draft always counts as unsaved
  renderAll();
}

async function save() {
  const events = toEvents(state.items);
  const name = (state.name || '').trim() || 'Untitled';

  const res = state.selectedId
    ? await window.api.recordings.update(state.selectedId, { name, events })
    : await window.api.recordings.create(name, events);

  if (!res.ok) return log(res.error, 'err');

  state.selectedId = res.data.id;
  state.name = res.data.name;
  el.recordingName.value = state.name;
  markClean();
  await reloadRecordings();
  renderSidebar();
  log(`Saved "${name}" (${events.length} clicks)`, 'good');
}

/* ---------------------------------------------------------------- actions */

async function addAtCursor() {
  const res = await window.api.cursor();
  if (!res.ok) return log(res.error, 'err');
  const i = addPoint(res.data.x, res.data.y);
  log(`Added click ${i + 1} at (${res.data.x}, ${res.data.y})`);
}

async function pickFromScreen() {
  el.countdown.hidden = false;
  for (let n = 3; n > 0; n--) {
    el.countdown.innerHTML = `${n}<small>move the cursor where you want the click</small>`;
    await new Promise((r) => setTimeout(r, 1000));
  }
  el.countdown.hidden = true;
  await addAtCursor();
}

function currentPlaylist() {
  if (state.playlistIds.size) {
    return state.recordings
      .filter((r) => state.playlistIds.has(r.id))
      .map((r) => ({ name: r.name, events: r.events }));
  }
  return [{ name: state.name || 'current', events: toEvents(state.items) }];
}

async function startPlayback() {
  if (state.mode !== 'idle') return;
  const playlist = currentPlaylist();
  const clicks = playlist.reduce((n, c) => n + c.events.length, 0);
  if (!clicks) return log('Nothing to play — add some clicks first.', 'err');

  const res = await window.api.play.start(playlist, {
    humanize: el.optHumanize.checked,
    durationMin: Number(el.optDuration.value) || 120
  });
  if (!res.ok) log(res.error, 'err');
}

/* ------------------------------------------------------------------ wiring */

el.btnRecord.addEventListener('click', () => {
  if (state.mode === 'recording') window.api.record.stop();
  else window.api.record.start();
});
el.btnPlay.addEventListener('click', startPlayback);
el.btnStop.addEventListener('click', () => {
  if (state.mode === 'recording') window.api.record.stop();
  else window.api.play.stop();
});
el.btnPause.addEventListener('click', () => window.api.play.pause(!state.paused));
el.btnSave.addEventListener('click', save);
el.btnNew.addEventListener('click', async () => {
  if (!(await confirmDiscard())) return;
  newDraft([], 'New recording');
});
el.btnReveal.addEventListener('click', () => window.api.recordings.reveal());
el.btnAddHere.addEventListener('click', addAtCursor);
el.btnPick.addEventListener('click', pickFromScreen);
el.btnFit.addEventListener('click', resetView);
el.btnUndo.addEventListener('click', undo);
el.btnRedo.addEventListener('click', redo);

el.recordingName.addEventListener('input', () => {
  state.name = el.recordingName.value;
  refreshChrome();
});

/* canvas: click empty space to add, drag points to move */

let drag = null;

el.canvas.addEventListener('wheel', (evt) => {
  evt.preventDefault();
  zoomBy(evt.deltaY > 0 ? 1.15 : 1 / 1.15, clientToUser(evt));
}, { passive: false });

el.canvas.addEventListener('pointerdown', (evt) => {
  if (state.mode !== 'idle') return;

  // Middle button or Shift+drag pans the view.
  if (evt.button === 1 || evt.shiftKey) {
    drag = {
      panning: true,
      originClientX: evt.clientX,
      originClientY: evt.clientY,
      base: state.view || fitViewBox()
    };
    el.canvas.setPointerCapture(evt.pointerId);
    evt.preventDefault();
    return;
  }

  const g = evt.target.closest('g.point');
  if (g) {
    const index = Number(g.dataset.index);
    selectIndex(index);
    pushUndo();
    drag = { index, moved: false, start: clientToUser(evt) };
    el.canvas.setPointerCapture(evt.pointerId);
    evt.preventDefault();
    return;
  }
  drag = { adding: true, at: clientToUser(evt) };
});

el.canvas.addEventListener('pointermove', (evt) => {
  if (drag && drag.panning) {
    // clientToUser depends on the live viewBox, so measure against the box the
    // pan started from rather than the one we keep rewriting.
    const rect = el.canvas.getBoundingClientRect();
    const upp = drag.base.w / rect.width;
    state.view = {
      ...drag.base,
      x: drag.base.x - (evt.clientX - drag.originClientX) * upp,
      y: drag.base.y - (evt.clientY - drag.originClientY) * upp
    };
    renderCanvas();
    return;
  }
  if (!drag || drag.adding || drag.index === undefined) return;
  const p = clientToUser(evt);
  drag.moved = true;
  state.items[drag.index].x = p.x;
  state.items[drag.index].y = p.y;
  repaintPoint(drag.index);
  syncRow(drag.index);
});

el.canvas.addEventListener('pointerup', (evt) => {
  if (!drag) return;

  if (drag.panning) {
    try { el.canvas.releasePointerCapture(evt.pointerId); } catch { /* not captured */ }
    drag = null;
    refreshChrome();
    return;
  }

  if (drag.adding) {
    const i = addPoint(drag.at.x, drag.at.y);
    log(`Added click ${i + 1} at (${drag.at.x}, ${drag.at.y})`);
  } else {
    if (!drag.moved) {
      state.undo.pop();          // a plain select shouldn't create an undo step
    } else {
      const it = state.items[drag.index];
      log(`Moved click ${drag.index + 1} to (${it.x}, ${it.y})`);
      renderCanvas();            // rebuild so z-order/labels stay tidy
    }
    refreshChrome();
  }
  try { el.canvas.releasePointerCapture(evt.pointerId); } catch { /* not captured */ }
  drag = null;
});

window.addEventListener('resize', () => { if (state.items || true) renderCanvas(); });

/* keyboard */

const isTyping = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
};

document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); if (!el.btnSave.disabled) save(); return; }
  if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); return; }

  if (isTyping() || state.mode !== 'idle') return;

  const i = state.selectedIndex;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (i !== null) { e.preventDefault(); deleteIndex(i); }
    return;
  }
  if (i === null) return;

  const step = e.shiftKey ? 10 : 1;
  if (e.key === 'ArrowLeft')  { e.preventDefault(); ctrl ? moveIndex(i, i - 1) : nudge(-step, 0); }
  if (e.key === 'ArrowRight') { e.preventDefault(); ctrl ? moveIndex(i, i + 1) : nudge(step, 0); }
  if (e.key === 'ArrowUp')    { e.preventDefault(); ctrl ? moveIndex(i, i - 1) : nudge(0, -step); }
  if (e.key === 'ArrowDown')  { e.preventDefault(); ctrl ? moveIndex(i, i + 1) : nudge(0, step); }
});

/* Hotkeys are system-wide, so they fire even when this window is in the
 * background. They stay off while the user is typing into a field here, and
 * can be disarmed entirely for when the app is just sitting open. */

function updateHotkeys() {
  window.api.setHotkeysEnabled(state.hotkeysArmed && !isTyping());
  el.btnHotkeys.classList.toggle('armed', state.hotkeysArmed && state.monitorReady);
  el.hotkeyLabel.textContent = state.hotkeysArmed ? 'Hotkeys on' : 'Hotkeys off';
}

el.btnHotkeys.addEventListener('click', () => {
  state.hotkeysArmed = !state.hotkeysArmed;
  updateHotkeys();
  log(state.hotkeysArmed
    ? 'Global hotkeys armed (R record · Space capture · S stop · P play)'
    : 'Global hotkeys disarmed — use the buttons instead', 'good');
});

document.addEventListener('focusin', updateHotkeys);
document.addEventListener('focusout', () => setTimeout(updateHotkeys, 0));

/* ------------------------------------------------------------ main events */

window.addEventListener('error', (e) => log(`Error: ${e.message}`, 'err'));
window.addEventListener('unhandledrejection', (e) =>
  log(`Error: ${(e.reason && e.reason.message) || e.reason}`, 'err'));

let hotkeysAnnounced = false;

function applyMonitorState(ready) {
  state.monitorReady = ready;
  el.monitorDot.classList.toggle('on', ready);
  updateHotkeys();
  if (ready && !hotkeysAnnounced) {
    hotkeysAnnounced = true;
    log('Global hotkeys active (R record · Space capture · S stop · P play)', 'good');
  }
  if (!ready) {
    // Only complain if it was working and then stopped — at boot the monitor
    // simply may not have signalled ready yet.
    if (hotkeysAnnounced) log('Global hotkeys stopped — the input monitor exited', 'err');
    hotkeysAnnounced = false;
  }
}

window.api.onMonitorState(({ ready }) => applyMonitorState(ready));

window.api.onMonitorInfo(({ line }) => log(line));
window.api.onError(({ message }) => log(message, 'err'));
window.api.onHotkeyPlay(() => { if (state.mode === 'idle') startPlayback(); });

window.api.onRecordState(async ({ active, events, finished }) => {
  if (active && state.mode !== 'recording') {
    if (isDirty() && !(await confirmDiscard())) { window.api.record.stop(); return; }
    state.mode = 'recording';
    newDraft([], `Recording ${new Date().toLocaleTimeString()}`);
    log('Recording started — press Space to capture a click', 'good');
  }

  if (active) {
    state.items = toItems(events);
    state.selectedIndex = state.items.length - 1;
    renderCanvas();
    renderEventList();
    if (events.length) {
      const last = events[events.length - 1];
      log(`Captured click ${events.length} at (${last.x}, ${last.y})`);
    }
  }

  if (finished) {
    state.mode = 'idle';
    state.items = toItems(events);
    log(`Recording stopped — ${events.length} click${events.length === 1 ? '' : 's'} captured. Save to keep it.`, 'good');
    renderAll();
    return;
  }

  refreshChrome();
});

window.api.onPlayEvent((evt) => {
  switch (evt.type) {
    case 'started':
      state.mode = 'playing';
      state.paused = false;
      log(`Playback started — ${evt.humanize ? `humanized (seed ${evt.seed}, ${evt.style})` : 'raw timing'}, up to ${evt.durationMin} min`, 'good');
      refreshChrome();
      break;

    case 'loop':
      log(`Loop ${evt.loop} — ${evt.name} (${evt.total} clicks)`);
      break;

    case 'click': {
      state.playingIndex = evt.index;
      for (const g of el.canvas.querySelectorAll('g.point')) {
        g.classList.toggle('playing', Number(g.dataset.index) === evt.index);
      }
      rowRefs.forEach((ref, k) => ref.li.classList.toggle('playing', k === evt.index));
      const extra = evt.fatigue !== undefined ? ` fatigue=${evt.fatigue}` : '';
      log(`  click ${evt.index + 1}/${evt.total} (${evt.x}, ${evt.y}) wait=${evt.waitMs}ms${extra}`);
      break;
    }

    case 'pause-break':
      log(`  ☕ ${evt.kind} pause ${(evt.durationMs / 1000).toFixed(1)}s`);
      break;

    case 'paused':
      state.paused = evt.paused;
      log(evt.paused ? 'Paused' : 'Resumed');
      refreshChrome();
      break;

    case 'stopped':
      state.mode = 'idle';
      state.paused = false;
      state.playingIndex = null;
      log(`Playback stopped after ${evt.loops} loop${evt.loops === 1 ? '' : 's'}${evt.reachedDeadline ? ' (time limit reached)' : ''}`, 'good');
      renderAll();
      break;

    case 'error':
      log(evt.message, 'err');
      break;

    default:
      break;
  }
});

/* -------------------------------------------------------------------- boot */

(async function boot() {
  // The monitor may have signalled ready before this script attached its
  // listener, so ask for the current state rather than only waiting for it.
  const monitor = await window.api.monitorStatus();
  if (monitor.ok) applyMonitorState(monitor.data.ready);

  const size = await window.api.screenSize();
  if (size.ok) state.screen = size.data;
  el.screenInfo.textContent = `screen ${state.screen.width}×${state.screen.height}`;

  await reloadRecordings();

  if (state.recordings.length) {
    const first = state.recordings[0];
    state.selectedId = first.id;
    state.name = first.name;
    state.items = toItems(first.events);
    el.recordingName.value = first.name;
    markClean();
  } else {
    newDraft([], 'New recording');
  }

  renderAll();
  log(`Loaded ${state.recordings.length} recording${state.recordings.length === 1 ? '' : 's'} from recordings.json`);
})();
