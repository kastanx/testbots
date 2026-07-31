const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

// Polling lives in main, not the renderer: no CSP connect-src to widen and no
// CORS preflight, and the window keeps rendering even if a request hangs.
const DEFAULT_URL = 'http://127.0.0.1:8765';
const DEFAULT_HZ = 3;
const REQUEST_TIMEOUT_MS = 4000;

function argValue(name, fallback) {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
}

const SERVER = String(argValue('url', DEFAULT_URL)).replace(/\/$/, '');
const HZ = Math.max(0.2, Number(argValue('hz', DEFAULT_HZ)) || DEFAULT_HZ);
const SELFTEST = process.argv.includes('--selftest');

let win = null;
let timer = null;
let stopping = false;

async function poll() {
    const started = Date.now();
    try {
        const res = await fetch(`${SERVER}/analyze/screen?preview=1`, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        payload.roundTripMs = Date.now() - started;
        send('tick', { ok: true, payload });
    } catch (err) {
        send('tick', {
            ok: false,
            error: err.name === 'TimeoutError'
                ? `no response in ${REQUEST_TIMEOUT_MS} ms`
                : String(err.message || err),
            url: SERVER
        });
    }
}

function send(channel, value) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

function schedule() {
    clearInterval(timer);
    timer = setInterval(poll, 1000 / HZ);
    poll();
}

app.whenReady().then(async () => {
    ipcMain.handle('get-config', () => ({ url: SERVER, hz: HZ, selftest: SELFTEST }));
    ipcMain.handle('set-hz', (_e, hz) => {
        const value = Math.max(0.2, Math.min(10, Number(hz) || DEFAULT_HZ));
        clearInterval(timer);
        timer = setInterval(poll, 1000 / value);
        return value;
    });

    // Park it against the right edge by default - out of the way of the game.
    const work = screen.getPrimaryDisplay().workArea;
    // Wide enough that an ultrawide capture is still legible in the preview.
    const width = 540;
    const height = Math.min(720, work.height - 60);

    win = new BrowserWindow({
        width,
        height,
        x: work.x + work.width - width - 24,
        y: work.y + 24,
        alwaysOnTop: true,
        skipTaskbar: false,
        backgroundColor: '#10131a',
        title: 'Greenbot Monitor',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    win.removeMenu();
    win.setAlwaysOnTop(true, 'screen-saver');

    // Critical: this panel sits on the screen the service is capturing. Without
    // this it would appear inside its own preview and inside the frames the
    // classifier sees - an infinite mirror, and contaminated input.
    // GREENBOT_NO_CONTENT_PROTECTION=1 only to screenshot the panel itself.
    win.setContentProtection(process.env.GREENBOT_NO_CONTENT_PROTECTION !== '1');

    win.webContents.on('console-message', (...args) => {
        const d = args[0] && typeof args[0] === 'object' && 'message' in args[0]
            ? args[0]
            : { level: args[1], message: args[2] };
        if (d.level === 'error' || d.level === 3) console.log(`[renderer] ${d.message}`);
    });

    await win.loadFile(path.join(__dirname, 'index.html'));
    schedule();

    console.log(`[monitor] polling ${SERVER} at ${HZ} Hz`);

    if (SELFTEST) {
        // Unattended check: the panel must render a real tick, not just boot.
        const deadline = Date.now() + 20000;
        let diag = null;
        while (Date.now() < deadline && !diag) {
            await new Promise((r) => setTimeout(r, 500));
            diag = await win.webContents
                .executeJavaScript('window.__diag || null')
                .catch(() => null);
        }
        const ok = Boolean(diag && diag.ticks > 0 && diag.rendered);
        console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} - ${JSON.stringify(diag)}`);
        stopping = true;
        clearInterval(timer);
        app.exit(ok ? 0 : 1);
    }
});

app.on('window-all-closed', () => {
    if (!stopping) app.quit();
});
app.on('will-quit', () => clearInterval(timer));
