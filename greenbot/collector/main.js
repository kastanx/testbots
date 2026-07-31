const {
    app, BrowserWindow, ipcMain, globalShortcut,
    desktopCapturer, dialog, nativeImage, session, screen, shell
} = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const labels = require('./labels.json');

const ROOT = path.join(__dirname, '..');
const RAW_ROOT = path.join(ROOT, 'ml', 'dataset', 'raw');

// Frames written right after a label switch usually still show the previous
// spot, so they get dropped instead of poisoning the dataset.
const SWITCH_GUARD_MS = 400;

function sessionName(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `session_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// --selftest drives the whole capture->disk path unattended and exits with a
// status code. Its folder is prefixed so prepare_dataset.py never picks it up.
const SELFTEST = process.argv.includes('--selftest');
const SESSION = SELFTEST ? `_selftest_${Date.now()}` : sessionName();
const SESSION_DIR = path.join(RAW_ROOT, SESSION);

let win = null;
let labelIdx = 0;
let recording = false;
let labelChangedAt = 0;
let seq = 0;
let selectedSource = null;              // live desktopCapturer source object
let writeChain = Promise.resolve();     // serializes disk writes
let captureInfo = null;                 // { width, height } reported by the renderer
let mode = 'capture';                   // 'capture' | 'label'

const counts = Object.fromEntries(labels.map((l) => [l, 0]));
const boundKeys = [];

// The bbox editor must never write a .txt for a frame nobody looked at, so a
// save is only accepted for images that were actually handed to the renderer.
const openedImages = new Set();

const WINDOW_SIZE = {
    capture: { width: 440, height: 680, minWidth: 380, minHeight: 420 },
    label: { width: 1500, height: 950, minWidth: 900, minHeight: 600 }
};

/* ------------------------------------------------------------------- state */

function statePayload() {
    const display = screen.getPrimaryDisplay();
    return {
        session: SESSION,
        sessionDir: SESSION_DIR,
        labels,
        label: labels[labelIdx],
        labelIdx,
        recording,
        counts,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        boundKeys,
        display: {
            width: Math.round(display.size.width * display.scaleFactor),
            height: Math.round(display.size.height * display.scaleFactor),
            scaleFactor: display.scaleFactor
        }
    };
}

function sendState() {
    if (win && !win.isDestroyed()) win.webContents.send('state', statePayload());
}

function setLabel(idx) {
    labelIdx = ((idx % labels.length) + labels.length) % labels.length;
    labelChangedAt = Date.now();
    sendState();
}

/* -------------------------------------------------------------- global keys */

// F-keys first; the Ctrl+Alt variants are the fallback for games that swallow
// function keys. Whatever registers is reported to the UI.
const DEFAULT_BINDINGS = {
    prev: ['Alt+Q', 'F7'],
    toggle: ['Alt+W', 'F8'],
    next: ['Alt+E', 'F9']
};

// Edit collector/hotkeys.json to rebind. A missing or broken file must not stop
// a recording session, so fall back rather than throw.
function loadBindings() {
    const file = path.join(__dirname, 'hotkeys.json');
    let config = {};
    try {
        config = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn(`[collector] ${file} is unreadable (${err.message}); using defaults`);
        }
    }
    return Object.entries(DEFAULT_BINDINGS).map(([action, fallback]) => {
        const keys = config[action];
        const valid = Array.isArray(keys) && keys.every((k) => typeof k === 'string' && k);
        if (keys !== undefined && !valid) {
            console.warn(`[collector] hotkeys.json: "${action}" must be an array of `
                + `accelerator strings; using ${fallback.join(', ')}`);
        }
        return { action, keys: valid ? keys : fallback };
    });
}

const BINDINGS = loadBindings();

const ACTIONS = {
    toggle: () => {
        recording = !recording;
        // Treat a fresh start like a label switch so the first frames settle.
        if (recording) labelChangedAt = Date.now();
        sendState();
    },
    next: () => setLabel(labelIdx + 1),
    prev: () => setLabel(labelIdx - 1)
};

function registerHotkeys() {
    boundKeys.length = 0;
    for (const { action, keys } of BINDINGS) {
        for (const key of keys) {
            try {
                if (globalShortcut.register(key, ACTIONS[action])) {
                    boundKeys.push({ action, key });
                }
            } catch (err) {
                console.warn(`[collector] could not bind ${key}:`, err.message);
            }
        }
    }
    for (const { action, keys } of BINDINGS) {
        const got = boundKeys.filter((b) => b.action === action).map((b) => b.key);
        if (got.length) {
            console.log(`[collector] ${action}: ${got.join(', ')}`);
        } else {
            console.warn(`[collector] ${action}: NOTHING BOUND - ${keys.join(', ')} were all `
                + `refused, another app owns them. Edit collector/hotkeys.json.`);
        }
    }
}

function unregisterHotkeys() {
    globalShortcut.unregisterAll();
    boundKeys.length = 0;
}

/* ------------------------------------------------------------------- mode */

// F7/F8/F9 stay bound to the capture actions, so they have to be released
// before the bbox editor can use the keyboard; and the editor needs a window
// several times the size of the capture HUD.
function applyMode(next) {
    if (next !== 'capture' && next !== 'label') throw new Error(`unknown mode: ${next}`);
    if (next === mode) return mode;
    mode = next;

    if (mode === 'label') {
        unregisterHotkeys();
        recording = false;
    } else {
        registerHotkeys();
    }

    if (win && !win.isDestroyed()) {
        const size = WINDOW_SIZE[mode];
        const area = screen.getPrimaryDisplay().workAreaSize;
        win.setAlwaysOnTop(mode === 'capture', 'screen-saver');
        // Lower the floor before shrinking, or setSize is clamped by the old one.
        win.setMinimumSize(
            Math.min(size.minWidth, area.width),
            Math.min(size.minHeight, area.height)
        );
        win.setSize(
            Math.min(size.width, area.width - 20),
            Math.min(size.height, area.height - 20)
        );
        win.center();
    }

    sendState();
    return mode;
}

/* ------------------------------------------------------------ label files */

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);

// tools/propose_boxes.py writes "\n".join(lines): LF separators and NO trailing
// newline. The editor has to reproduce that byte for byte or an untouched
// proposal would show up as a diff the moment it is re-saved.
const LABEL_EOL = '\n';

function labelTxtPath(imagePath) {
    const ext = path.extname(imagePath);
    return path.join(path.dirname(imagePath), path.basename(imagePath, ext) + '.txt');
}

function parseBoxes(text) {
    const boxes = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;                 // an all-blank file is a valid negative
        const parts = trimmed.split(/\s+/);
        if (parts.length !== 5) throw new Error(`bad label line: "${trimmed}"`);
        const nums = parts.map(Number);
        if (nums.some((n) => !Number.isFinite(n))) throw new Error(`bad label line: "${trimmed}"`);
        boxes.push({ cls: Math.trunc(nums[0]), cx: nums[1], cy: nums[2], w: nums[3], h: nums[4] });
    }
    return boxes;
}

function serializeBoxes(boxes) {
    return boxes
        .map((b) => `${b.cls} ${b.cx.toFixed(6)} ${b.cy.toFixed(6)} ` +
            `${b.w.toFixed(6)} ${b.h.toFixed(6)}`)
        .join(LABEL_EOL);
}

function validateBoxes(boxes) {
    if (!Array.isArray(boxes)) throw new Error('boxes must be an array');
    return boxes.map((b, i) => {
        const cls = Number(b.cls);
        const v = [b.cx, b.cy, b.w, b.h].map(Number);
        if (!Number.isInteger(cls) || cls < 0) throw new Error(`box ${i}: bad class ${b.cls}`);
        if (v.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
            throw new Error(`box ${i}: coordinates outside 0-1: ${v.join(' ')}`);
        }
        if (v[2] <= 0 || v[3] <= 0) throw new Error(`box ${i}: zero-size box`);
        return { cls, cx: v[0], cy: v[1], w: v[2], h: v[3] };
    });
}

async function scanFolder(dir) {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) throw new Error(`not a directory: ${dir}`);

    const found = [];
    async function walk(current) {
        const entries = await fsp.readdir(current, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const p = path.join(current, entry.name);
            if (entry.isDirectory()) await walk(p);
            else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) found.push(p);
        }
    }
    await walk(dir);

    const images = [];
    for (const p of found) {
        let count = null;                       // null = no .txt yet, not "zero boxes"
        try {
            count = parseBoxes(await fsp.readFile(labelTxtPath(p), 'utf8')).length;
        } catch (err) {
            if (err.code !== 'ENOENT') throw new Error(`${labelTxtPath(p)}: ${err.message}`);
        }
        images.push({ path: p, name: path.relative(dir, p).replace(/\\/g, '/'), count });
    }
    return { dir, images };
}

async function readImage(imagePath) {
    const buf = await fsp.readFile(imagePath);
    const mime = path.extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    openedImages.add(path.resolve(imagePath));
    return { path: imagePath, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
}

async function readBoxes(imagePath) {
    const txt = labelTxtPath(imagePath);
    try {
        return { exists: true, boxes: parseBoxes(await fsp.readFile(txt, 'utf8')) };
    } catch (err) {
        if (err.code === 'ENOENT') return { exists: false, boxes: [] };
        throw new Error(`${txt}: ${err.message}`);
    }
}

async function writeBoxes(imagePath, boxes) {
    if (!openedImages.has(path.resolve(imagePath))) {
        return { saved: false, reason: 'not-opened' };
    }
    const clean = validateBoxes(boxes);
    const txt = labelTxtPath(imagePath);
    // Zero boxes writes a zero-byte file on purpose: that is a real negative
    // sample, not a missing label.
    await fsp.writeFile(txt, serializeBoxes(clean), 'utf8');
    return { saved: true, count: clean.length, path: txt };
}

/* -------------------------------------------------------------------- IPC */

function registerIpc() {
    ipcMain.handle('get-state', () => statePayload());

    ipcMain.handle('get-sources', async () => {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 0, height: 0 }
        });
        return sources.map((s) => ({ id: s.id, name: s.name, displayId: s.display_id }));
    });

    ipcMain.handle('select-source', async (_e, id) => {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 0, height: 0 }
        });
        selectedSource = sources.find((s) => s.id === id) || null;
        return Boolean(selectedSource);
    });

    ipcMain.handle('save-frame', async (_e, buf) => {
        if (!recording) return { saved: false, reason: 'idle' };
        if (Date.now() - labelChangedAt < SWITCH_GUARD_MS) return { saved: false, reason: 'guard' };

        const label = labels[labelIdx];
        const dir = path.join(SESSION_DIR, label);
        const file = path.join(dir, `frame_${Date.now()}_${String(seq++).padStart(6, '0')}.jpg`);

        const job = writeChain.then(async () => {
            await fsp.mkdir(dir, { recursive: true });
            await fsp.writeFile(file, Buffer.from(buf));
        });
        writeChain = job.catch(() => {});   // keep the chain alive past a failure

        try {
            await job;
        } catch (err) {
            console.error('[collector] write failed:', err);
            return { saved: false, reason: 'error' };
        }

        counts[label] += 1;
        sendState();
        return { saved: true };
    });

    ipcMain.handle('open-dataset', async () => {
        await fsp.mkdir(SESSION_DIR, { recursive: true });
        await shell.openPath(SESSION_DIR);
    });

    // Pulled by the renderer, not pushed: a push can be sent before the
    // renderer's async init has attached its listeners.
    ipcMain.handle('is-selftest', () => SELFTEST);

    ipcMain.handle('report-capture', (_e, info) => {
        captureInfo = info;
        const { width, height } = statePayload().display;
        const match = info.width === width && info.height === height;
        console.log(`[collector] capture ${info.width}x${info.height}, desktop ${width}x${height}` +
            (match ? '' : '  <-- MISMATCH, click coordinates will be off'));
    });

    ipcMain.handle('get-mode', () => mode);
    ipcMain.handle('set-mode', (_e, next) => applyMode(next));

    ipcMain.handle('label-pick-folder', async () => {
        const res = await dialog.showOpenDialog(win, {
            title: 'Folder of frames to label',
            defaultPath: RAW_ROOT,
            properties: ['openDirectory']
        });
        return res.canceled ? null : res.filePaths[0];
    });

    ipcMain.handle('label-scan-folder', (_e, dir) => scanFolder(dir));
    ipcMain.handle('label-read-image', (_e, p) => readImage(p));
    ipcMain.handle('label-read-boxes', (_e, p) => readBoxes(p));
    ipcMain.handle('label-write-boxes', (_e, p, boxes) => writeBoxes(p, boxes));
}

/* --------------------------------------------------------------- selftest */

async function selfTestCapture() {
    console.log('[selftest] capture: recording the first screen source for 6s ...');
    recording = true;
    labelChangedAt = 0;

    await new Promise((r) => setTimeout(r, 6000));
    recording = false;

    const dir = path.join(SESSION_DIR, labels[labelIdx]);
    let files = [];
    try {
        files = await fsp.readdir(dir);
    } catch { /* nothing was written */ }

    const ok = files.length > 0;
    console.log(`[selftest] capture: ${ok ? 'PASS' : 'FAIL'} - ${files.length} frames written`);
    if (!captureInfo) console.log('[selftest] capture: renderer never reported a capture size');

    // GREENBOT_KEEP_SELFTEST=1 leaves the frames on disk so you can confirm what
    // actually landed in them - notably that this window is absent from them.
    if (process.env.GREENBOT_KEEP_SELFTEST === '1') {
        console.log(`[selftest] keeping frames in ${SESSION_DIR}`);
    } else {
        await fsp.rm(SESSION_DIR, { recursive: true, force: true });
    }
    return ok;
}

// A synthetic frame at the real capture resolution, so the letterbox maths the
// editor does is exercised on the same aspect ratio the dataset uses.
function makeTestJpeg(width, height) {
    const bmp = Buffer.alloc(width * height * 4);
    for (let i = 0; i < bmp.length; i += 4) {
        bmp[i] = 40; bmp[i + 1] = 30; bmp[i + 2] = 25; bmp[i + 3] = 255;   // BGRA
    }
    for (const [bx, by, bw, bh] of [[496, 152, 80, 56], [944, 248, 40, 40]]) {
        for (let y = by; y < by + bh; y++) {
            for (let x = bx; x < bx + bw; x++) {
                const i = (y * width + x) * 4;
                bmp[i] = 60; bmp[i + 1] = 220; bmp[i + 2] = 60; bmp[i + 3] = 255;
            }
        }
    }
    const jpeg = nativeImage.createFromBitmap(bmp, { width, height }).toJPEG(90);
    if (!jpeg.length) throw new Error('nativeImage produced an empty JPEG');
    return jpeg;
}

async function waitForRendererHook(name, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ready = await win.webContents.executeJavaScript(`typeof window.${name} === 'function'`);
        if (ready) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return false;
}

async function selfTestLabel() {
    const dir = path.join(app.getPath('temp'), `greenbot_selftest_label_${Date.now()}`);
    const image = path.join(dir, 'frame_1785435874724_000000.jpg');
    const txt = labelTxtPath(image);

    let ok = true;
    const fail = (msg) => { ok = false; console.log(`[selftest] label: FAIL - ${msg}`); };
    const check = (cond, msg) => { if (!cond) fail(msg); };

    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(image, makeTestJpeg(1280, 536));

    // Pinned on-disk contract, spelled with a literal \n rather than LABEL_EOL:
    // building the fixture from the editor's own constant would only prove the
    // writer agrees with itself, which is how a CRLF mismatch with
    // tools/propose_boxes.py went unnoticed once already.
    const original = Buffer.from(
        '0 0.418750 0.335821 0.062500 0.104478\n' +
        '0 0.753125 0.500000 0.031250 0.074627', 'utf8');
    await fsp.writeFile(txt, original);

    try {
        check(LABEL_EOL === '\n', `LABEL_EOL is ${JSON.stringify(LABEL_EOL)}, must be "\\n"`);
        check(serializeBoxes(parseBoxes(original.toString('utf8'))) === original.toString('utf8'),
            'parse -> serialize is not byte-identical');

        // A file written by an older/other generator may still carry CRLF and a
        // trailing newline; reading must tolerate it and saving must canonicalise.
        const legacy = '0 0.418750 0.335821 0.062500 0.104478\r\n' +
            '0 0.753125 0.500000 0.031250 0.074627\r\n';
        const canonical = serializeBoxes(parseBoxes(legacy));
        check(!canonical.includes('\r'), 'serialized labels still contain CR');
        check(!canonical.endsWith('\n'), 'serialized labels have a trailing newline');
        check(canonical === original.toString('utf8'),
            'CRLF input does not canonicalise to the pinned byte form');

        if (!await waitForRendererHook('__labelSelfTest')) {
            fail('renderer never exposed __labelSelfTest');
            return ok;
        }

        const diag = await win.webContents.executeJavaScript(
            `window.__labelSelfTest(${JSON.stringify(dir)})`);
        console.log(`[selftest] label: ${JSON.stringify(diag)}`);

        check(mode === 'label', `mode is "${mode}" after the editor asked for label`);
        // Left bound, F7/F8/F9 would fight the editor for the keyboard.
        check(boundKeys.length === 0,
            `${boundKeys.length} capture hotkeys are still bound in label mode`);

        check(!diag.error, `editor reported: ${diag.error}`);
        check(diag.total === 1, `expected 1 image, editor found ${diag.total}`);
        check(diag.boxCount === 2, `expected 2 parsed boxes, got ${diag.boxCount}`);
        check(diag.imageWidth === 1280 && diag.imageHeight === 536,
            `image decoded as ${diag.imageWidth}x${diag.imageHeight}`);
        check(diag.canvasW > 200 && diag.canvasH > 200,
            `canvas is ${diag.canvasW}x${diag.canvasH}, too small to trust the mapping`);
        check(diag.mapMaxErrPx < 0.01,
            `canvas <-> image mapping drifts by ${diag.mapMaxErrPx} px`);
        check(diag.pointErrPx < 0.01,
            `a canvas point maps back ${diag.pointErrPx} px off`);
        check(diag.anchorErrPx < 0.01,
            `the drawn image and the box transform disagree by ${diag.anchorErrPx} px`);
        // Without a non-zero offset on both axes the letterbox maths is untested.
        check(diag.testedOffsetX > 1 && diag.testedOffsetY > 1,
            `letterbox offsets never exercised (x=${diag.testedOffsetX}, y=${diag.testedOffsetY})`);
        check(diag.zeroBoxes === 0, `expected 0 empty images, got ${diag.zeroBoxes}`);
        check(diag.saved === true, 'the editor could not save');

        const after = await fsp.readFile(txt);
        check(Buffer.compare(original, after) === 0,
            `save is not a byte-identical round trip:\n  before ${JSON.stringify(original.toString())}` +
            `\n  after  ${JSON.stringify(after.toString())}`);

        // Draw / move / resize / delete through synthetic mouse events.
        const drawn = await win.webContents.executeJavaScript('window.__labelSelfTestDraw()');
        console.log(`[selftest] label: ${JSON.stringify(drawn)}`);
        check(drawn.selected === true, 'clicking a box did not select it');
        check(drawn.dirtyAfterSelect === false,
            'merely selecting a box flagged the image as edited');
        check(drawn.drawnOk === true, 'dragging on empty space did not create a selected box');
        check(drawn.drawErrPx >= 0 && drawn.drawErrPx < 2,
            `a drawn box lands ${drawn.drawErrPx} px from where it was dragged`);
        check(drawn.moveErrPx >= 0 && drawn.moveErrPx < 2,
            `dragging a box body is off by ${drawn.moveErrPx} px`);
        check(drawn.resizeErrPx >= 0 && drawn.resizeErrPx < 2,
            `dragging a corner handle is off by ${drawn.resizeErrPx} px`);
        check(drawn.after === drawn.before, 'Delete did not remove the selected box');

        // Removing every box and saving must leave a real, empty negative.
        const cleared = await win.webContents.executeJavaScript('window.__labelSelfTestClear()');
        check(cleared.saved === true, 'clearing every box did not save');
        const emptied = await fsp.readFile(txt);
        check(emptied.length === 0, `empty label is ${emptied.length} bytes, expected 0`);
        check(cleared.zeroBoxes === 1, `0-box counter reads ${cleared.zeroBoxes}, expected 1`);

        // A frame nobody opened must never get a .txt written next to it.
        const never = path.join(dir, 'never_opened.jpg');
        const refused = await writeBoxes(never, []);
        check(refused.saved === false, 'wrote a label for an image that was never opened');
        check(!await fsp.access(labelTxtPath(never)).then(() => true, () => false),
            'a .txt appeared next to an image that was never opened');

        // Capture mode has to survive the round trip fully intact.
        applyMode('capture');
        check(boundKeys.length > 0, 'the capture hotkeys did not come back after label mode');
        check(Math.abs(win.getSize()[0] - WINDOW_SIZE.capture.width) < 60,
            `the window stayed ${win.getSize().join('x')} instead of shrinking back`);
    } catch (err) {
        fail(err.stack || err.message);
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }

    console.log(`[selftest] label: ${ok ? 'PASS' : 'FAIL'} - bbox editor round trip`);
    return ok;
}

async function runSelfTest() {
    let ok = false;
    try {
        const capture = await selfTestCapture();
        const label = await selfTestLabel();
        ok = capture && label;
    } catch (err) {
        console.log(`[selftest] FAIL - ${err.stack || err.message}`);
    }
    console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} - overall`);
    app.exit(ok ? 0 : 1);
}

/* ------------------------------------------------------------------- boot */

// Two collectors would fight over the global hotkeys.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (win && !win.isDestroyed()) win.focus();
    });

    app.whenReady().then(async () => {
        // Both must be in place before the page loads: renderer.js calls
        // getSources()/getState() as soon as its script runs, which happens
        // well before loadFile() resolves.
        registerIpc();
        registerHotkeys();

        // Route getDisplayMedia() straight to the source picked in the UI,
        // bypassing the system picker.
        session.defaultSession.setDisplayMediaRequestHandler(
            (_request, callback) => {
                if (selectedSource) callback({ video: selectedSource, audio: false });
                else callback({});
            },
            { useSystemPicker: false }
        );

        win = new BrowserWindow({
            width: WINDOW_SIZE.capture.width,
            height: WINDOW_SIZE.capture.height,
            minWidth: WINDOW_SIZE.capture.minWidth,
            minHeight: WINDOW_SIZE.capture.minHeight,
            alwaysOnTop: true,
            backgroundColor: '#10131a',
            title: 'Frame Collector',
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });

        win.removeMenu();
        // 'screen-saver' keeps it above borderless-fullscreen games.
        win.setAlwaysOnTop(true, 'screen-saver');

        // This window sits on the screen it is recording, and it displays the
        // current label and a per-label counter grid - i.e. the answer. Without
        // this, every saved frame contains a visual shortcut correlated with its
        // own label, which is exactly what a classifier will learn instead of
        // the scene. WDA_EXCLUDEFROMCAPTURE keeps it visible to you and invisible
        // to the capture.
        win.setContentProtection(process.env.GREENBOT_NO_CONTENT_PROTECTION !== '1');

        // The app is launched from a terminal, so surface renderer errors there
        // instead of hiding them in devtools. Electron moved this event to a
        // single details object, so accept both shapes.
        win.webContents.on('console-message', (...args) => {
            const d = args[0] && typeof args[0] === 'object' && 'message' in args[0]
                ? args[0]
                : { level: args[1], message: args[2] };
            if (d.level === 'error' || d.level === 3 || d.level === 'warning' || d.level === 2) {
                console.log(`[renderer] ${d.message}`);
            }
        });

        await win.loadFile(path.join(__dirname, 'index.html'));
        sendState();

        console.log(`[collector] session ${SESSION} -> ${SESSION_DIR}`);
        if (SELFTEST) runSelfTest();
    });

    app.on('will-quit', () => globalShortcut.unregisterAll());
    app.on('window-all-closed', () => app.quit());
}
