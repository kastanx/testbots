const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');

const { mouse, screen: nutScreen } = require('@nut-tree-fork/nut-js');
const { InputMonitor } = require('../input-monitor');
const store = require('../recordings-store');
const { ReplayEngine } = require('../replay-engine');

let win = null;
let monitor = null;
let replay = null;

// The monitor becomes ready ~700ms after launch, which can land before the
// renderer has attached its listeners. Keep the state so it can ask instead.
let monitorReady = false;

// Recording state lives in main so global hotkeys work with the window unfocused.
const recorder = {
    active: false,
    startTime: 0,
    events: []
};

function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
    win = new BrowserWindow({
        width: 1420,
        height: 900,
        minWidth: 1040,
        minHeight: 640,
        backgroundColor: '#12141a',
        title: 'Click Recorder',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    win.removeMenu();
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    win.on('closed', () => { win = null; });
}

/* ---------------------------------------------------------------- recording */

function startRecording() {
    if (recorder.active || (replay && replay.running)) return;
    recorder.active = true;
    recorder.events = [];
    recorder.startTime = Date.now();
    send('record:state', { active: true, events: [] });
}

async function captureClick() {
    if (!recorder.active) return;
    try {
        const pos = await mouse.getPosition();
        recorder.events.push({
            x: pos.x,
            y: pos.y,
            time: Date.now() - recorder.startTime,
            button: 0
        });
        send('record:state', { active: true, events: recorder.events });
    } catch (err) {
        send('app:error', { message: `Could not read cursor position: ${err.message}` });
    }
}

function stopRecording() {
    if (!recorder.active) return;
    recorder.active = false;
    send('record:state', { active: false, events: recorder.events, finished: true });
}

/* ----------------------------------------------------------------- playback */

function startPlayback(playlist, options) {
    if (recorder.active) return;
    if (replay && replay.running) return;

    replay = new ReplayEngine((event) => send('play:event', event));
    replay.start(playlist, options);
}

/* ------------------------------------------------------------ input monitor */

function setupMonitor() {
    monitor = new InputMonitor();

    monitor.on('ready', () => { monitorReady = true; send('monitor:state', { ready: true }); });
    monitor.on('info', (line) => send('monitor:info', { line }));
    monitor.on('error', (message) => send('app:error', { message: `Input monitor: ${message}` }));
    monitor.on('close', () => { monitorReady = false; send('monitor:state', { ready: false }); });

    monitor.on('key', (token) => {
        switch (token) {
            case 'r':
                startRecording();
                break;
            case 'space':
                captureClick();
                break;
            case 's':
                if (recorder.active) stopRecording();
                else if (replay && replay.running) replay.stop();
                break;
            case 'p':
                if (recorder.active) break;
                if (replay && replay.running) replay.togglePause();
                else send('hotkey:play', {});
                break;
            default:
                break; // q / l are UI actions in the app
        }
    });

    monitor.start();
}

/* --------------------------------------------------------------------- IPC */

function ok(data) { return { ok: true, data }; }
function fail(err) { return { ok: false, error: err.message || String(err) }; }

function handle(channel, fn) {
    ipcMain.handle(channel, async (_event, ...args) => {
        try {
            return ok(await fn(...args));
        } catch (err) {
            return fail(err);
        }
    });
}

handle('recordings:list', () => store.loadAll());
handle('recordings:create', (name, events) => store.create(name, events));
handle('recordings:update', (id, patch) => store.update(id, patch));
handle('recordings:delete', (id) => store.remove(id));
handle('recordings:duplicate', (id) => store.duplicate(id));
handle('recordings:reveal', () => shell.showItemInFolder(store.RECORDINGS_FILE));
handle('recordings:path', () => store.RECORDINGS_FILE);

handle('monitor:status', () => ({ ready: monitorReady }));

handle('screen:size', async () => ({
    width: await nutScreen.width(),
    height: await nutScreen.height()
}));

handle('cursor:get', async () => {
    const pos = await mouse.getPosition();
    return { x: pos.x, y: pos.y };
});

handle('record:start', () => { startRecording(); return true; });
handle('record:stop', () => { stopRecording(); return true; });

handle('play:start', (playlist, options) => { startPlayback(playlist, options); return true; });
handle('play:stop', () => { if (replay) replay.stop(); return true; });
handle('play:pause', (paused) => { if (replay) replay.setPaused(!!paused); return true; });

// Suppress global hotkeys while the user types into a field, so pressing "s"
// in a name box doesn't stop a recording.
handle('hotkeys:enabled', (enabled) => {
    if (monitor) monitor.enabled = !!enabled;
    return !!enabled;
});

handle('app:confirm', async (options) => {
    const result = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Cancel', options.confirmLabel || 'Delete'],
        defaultId: 1,
        cancelId: 0,
        title: options.title || 'Are you sure?',
        message: options.message || '',
        detail: options.detail || ''
    });
    return result.response === 1;
});

/* -------------------------------------------------------------- app wiring */

// A second instance would fight over recordings.json and the keyboard monitor.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });

    app.whenReady().then(() => {
        createWindow();
        setupMonitor();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

app.on('window-all-closed', () => {
    if (replay) replay.stop();
    if (monitor) monitor.stop();
    app.quit();
});

app.on('before-quit', () => {
    if (replay) replay.stop();
    if (monitor) monitor.stop();
});
