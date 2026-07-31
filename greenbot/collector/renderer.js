const FPS = 3;
const MAXW = 1280;      // training runs at 224-320 px, so 1280 is plenty of headroom
const JPEG_Q = 0.85;

const el = {
    modeCapture: document.getElementById('mode-capture'),
    modeLabel: document.getElementById('mode-label'),
    sources: document.getElementById('sources'),
    start: document.getElementById('start'),
    capinfo: document.getElementById('capinfo'),
    label: document.getElementById('label'),
    rec: document.getElementById('rec'),
    rectext: document.getElementById('rectext'),
    session: document.getElementById('session'),
    total: document.getElementById('total'),
    counts: document.getElementById('counts'),
    preview: document.getElementById('preview'),
    keys: document.getElementById('keys'),
    hotkeys: document.getElementById('hotkeys'),
    open: document.getElementById('open')
};

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: false });

let stream = null;
let timer = null;
let inFlight = false;
let display = null;
let cells = new Map();

/* ------------------------------------------------------------------ render */

function buildCounts(labels) {
    el.counts.innerHTML = '';
    cells = new Map();
    for (const label of labels) {
        const div = document.createElement('div');
        div.className = 'cell empty';
        div.innerHTML = `<span>${label.replace('spot_', 's')}</span><span class="n">0</span>`;
        el.counts.appendChild(div);
        cells.set(label, div);
    }
}

function renderState(state) {
    display = state.display;

    if (cells.size !== state.labels.length) buildCounts(state.labels);

    el.label.textContent = state.label;
    el.session.textContent = state.session;
    el.total.textContent = state.total;
    el.rec.classList.toggle('on', state.recording);
    el.rectext.textContent = state.recording ? 'REC' : 'IDLE';

    for (const [label, cell] of cells) {
        const n = state.counts[label] || 0;
        cell.querySelector('.n').textContent = n;
        cell.classList.toggle('active', label === state.label);
        cell.classList.toggle('empty', n === 0);
    }

    const active = cells.get(state.label);
    if (active) active.scrollIntoView({ block: 'nearest' });

    // Primary line shows the first key that actually bound per action, so it
    // never advertises a hotkey the OS refused to give us.
    const first = (action) => (state.boundKeys.find((b) => b.action === action) || {}).key;
    const kbd = (k) => (k ? `<kbd>${k}</kbd>` : '<span class="warn">unbound</span>');
    el.hotkeys.innerHTML =
        `${kbd(first('prev'))}/${kbd(first('next'))} label · ${kbd(first('toggle'))} record`;

    const bound = state.boundKeys.map((b) => `${b.key}=${b.action}`).join('  ');
    el.keys.textContent = bound || 'no global hotkeys bound — see collector/hotkeys.json';

    updateCapInfo();
}

function updateCapInfo() {
    const w = el.preview.videoWidth;
    const h = el.preview.videoHeight;
    if (!w || !h) {
        el.capinfo.textContent = 'no capture';
        el.capinfo.className = 'muted';
        return;
    }
    let text = `capture ${w}×${h}`;
    let cls = '';
    if (display) {
        text += ` · display ${display.width}×${display.height}`;
        if (w !== display.width || h !== display.height) {
            text += ' — MISMATCH';
            cls = 'warn';
        } else {
            cls = 'ok';
        }
    }
    el.capinfo.textContent = text;
    el.capinfo.className = cls;
}

/* ----------------------------------------------------------------- capture */

async function openStream(sourceId) {
    await window.api.selectSource(sourceId);
    try {
        // Preferred path: main process resolves this to the selected screen.
        return await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: FPS, max: 10 } },
            audio: false
        });
    } catch (err) {
        console.warn('[collector] getDisplayMedia failed, using legacy constraints:', err);
        return await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId,
                    maxWidth: 7680,
                    maxHeight: 4320,
                    maxFrameRate: 10
                }
            }
        });
    }
}

async function grab() {
    // Skip rather than queue: a slow disk must not build a backlog of frames.
    if (inFlight) return;
    const video = el.preview;
    if (!video.videoWidth) return;

    inFlight = true;
    try {
        const scale = Math.min(1, MAXW / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', JPEG_Q));
        if (blob) await window.api.saveFrame(await blob.arrayBuffer());   // main drops it unless recording
    } catch (err) {
        console.error('[collector] grab failed:', err);
    } finally {
        inFlight = false;
    }
}

async function start() {
    const sourceId = el.sources.value;
    if (!sourceId) return;

    stop();
    el.start.disabled = true;
    try {
        stream = await openStream(sourceId);
        el.preview.srcObject = stream;
        await el.preview.play();
        await new Promise((r) => setTimeout(r, 250));   // let dimensions settle
        updateCapInfo();
        window.api.reportCapture({
            width: el.preview.videoWidth,
            height: el.preview.videoHeight
        });
        timer = setInterval(grab, 1000 / FPS);
        el.start.textContent = 'Restart';
    } catch (err) {
        console.error('[collector] capture failed:', err);
        el.capinfo.textContent = `capture failed: ${err.message}`;
        el.capinfo.className = 'warn';
    } finally {
        el.start.disabled = false;
    }
}

function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    el.preview.srcObject = null;
}

/* -------------------------------------------------------------------- mode */

// Main owns the mode: it is what unregisters the capture hotkeys and resizes
// the window, so it is asked first and the UI follows what it reports back.
async function setMode(mode) {
    const applied = await window.api.setMode(mode);
    document.body.classList.toggle('mode-capture', applied === 'capture');
    document.body.classList.toggle('mode-label', applied === 'label');
    el.modeCapture.classList.toggle('on', applied === 'capture');
    el.modeLabel.classList.toggle('on', applied === 'label');
    if (applied === 'label') window.labeler.activate();
    else window.labeler.deactivate();
}

// Hooks for --selftest. Defined at load time so main can poll for them instead
// of racing this file's async init.
window.__labelSelfTest = async (dir) => {
    await setMode('label');
    return window.labeler.selfTest(dir);
};
window.__labelSelfTestDraw = () => window.labeler.selfTestDraw();
window.__labelSelfTestClear = () => window.labeler.selfTestClear();

/* -------------------------------------------------------------------- boot */

(async function init() {
    const sources = await window.api.getSources();
    for (const s of sources) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        el.sources.appendChild(opt);
    }
    if (!sources.length) {
        el.capinfo.textContent = 'no screen sources found';
        el.capinfo.className = 'warn';
        console.error('no screen sources returned by desktopCapturer');
    }

    renderState(await window.api.getState());
    window.api.onState(renderState);

    el.start.addEventListener('click', start);
    el.open.addEventListener('click', () => window.api.openDataset());
    el.preview.addEventListener('loadedmetadata', updateCapInfo);
    el.modeCapture.addEventListener('click', () => setMode('capture'));
    el.modeLabel.addEventListener('click', () => setMode('label'));
    window.addEventListener('beforeunload', stop);

    // Pulled, never pushed - main cannot know when this init has finished.
    await setMode(await window.api.getMode());

    if (await window.api.isSelfTest()) {
        el.sources.selectedIndex = 0;
        await start();
    }
})();
