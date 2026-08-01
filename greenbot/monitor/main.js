const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// Polling lives in main, not the renderer: no CSP connect-src to widen and no
// CORS preflight, and the window keeps rendering even if a request hangs.
const DEFAULT_URL = 'http://127.0.0.1:8765';
const DEFAULT_HZ = 3;
const REQUEST_TIMEOUT_MS = 4000;

// The run loop lives in the harness and is driven from here. The renderer never
// touches it - it only sees forwarded events, same as it only sees ticks.
const ROUTE_MODULE_PATH = path.join(__dirname, '..', 'harness', 'route.js');
const ENGINE_PATH = path.join(__dirname, '..', 'harness', 'engine.js');
const SUPERVISOR_PATH = path.join(__dirname, '..', 'harness', 'supervisor.js');
const TELEMETRY_PATH = path.join(__dirname, '..', 'harness', 'telemetry.js');
const PICK_ACCELERATOR = 'CommandOrControl+Alt+P';
const KILL_ACCELERATOR = 'F10';
const EVENT_CAP = 400;

/* ------------------------------------------------- capture visibility */

// setContentProtection sets WDA_EXCLUDEFROMCAPTURE, which hides the window from
// EVERY screen capture - including Remote Desktop, where the panel then appears
// to be missing entirely. Protected is the right default (see applyContentProtection)
// but it has to be switchable, and the choice has to survive a restart: you
// cannot click a toggle in a window you cannot see.
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

function loadSettings() {
    try {
        // Strip a UTF-8 BOM: JSON.parse throws on it, and anything on Windows
        // that edits this file with a default encoding will write one.
        return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
        if (err.code !== 'ENOENT') console.log(`[settings] unreadable: ${err.message}`);
        return {};
    }
}

function saveSettings(next) {
    try {
        fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`);
    } catch (err) {
        console.log(`[settings] could not save: ${err.message}`);
    }
}

function initialContentProtection() {
    if (process.argv.includes('--visible-in-capture')) return false;
    if (process.argv.includes('--hidden-in-capture')) return true;
    if (process.env.GREENBOT_NO_CONTENT_PROTECTION === '1') return false;
    const saved = loadSettings().contentProtection;
    return typeof saved === 'boolean' ? saved : true;
}

let contentProtected = true;

function applyContentProtection(on) {
    contentProtected = Boolean(on);
    if (win && !win.isDestroyed()) win.setContentProtection(contentProtected);
    console.log(`[monitor] content protection ${contentProtected ? 'ON' : 'OFF'}`
        + (contentProtected ? ' (hidden from screen capture and Remote Desktop)' : ''));
    return contentProtected;
}

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

let routeApi = null;
let route = null;
let routeError = null;
let engine = null;
let stopFallback = null;
let killRegistered = false;
let pickArmed = false;
let eventSeq = 0;
const events = [];
const run = {
    running: false,
    dryRun: true,
    phase: 'stopped',
    location: null,
    confidence: 0,
    clicks: 0,
    startedAt: null,
    stopReason: null
};

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

// route.json is the harness's file, so its module owns reading, validating and
// writing it. The panel only edits the values the Run tab exposes.
function routeModule() {
    if (routeApi) return routeApi;
    try {
        routeApi = require(ROUTE_MODULE_PATH);
        routeError = null;
    } catch (err) {
        routeApi = null;
        routeError = `harness/route.js unavailable: ${err.message}`;
        console.log(`[route] ${routeError}`);
    }
    return routeApi;
}

function loadRoute() {
    const api = routeModule();
    if (!api) return null;
    const res = api.loadRoute();
    for (const w of res.warnings) console.log(`[route] ${w}`);
    route = res.route;
    return route;
}

function saveRoute(next) {
    const api = routeModule();
    if (!api) return null;
    const res = api.saveRoute(next);
    for (const w of res.warnings) console.log(`[route] ${w}`);
    route = res.route;
    return route;
}

function routePath() {
    return (routeApi && routeApi.ROUTE_PATH) || path.join(__dirname, '..', 'harness', 'route.json');
}

// A live run picks edits up on its next cycle; it never interrupts a wait.
function pushRouteToEngine() {
    if (engine && typeof engine.setRoute === 'function') {
        try {
            engine.setRoute(route);
            return true;
        } catch (err) {
            console.log(`[route] engine.setRoute threw: ${err.message}`);
        }
    }
    return false;
}

function applyRoutePatch(patch) {
    if (!route) return { route: null, error: routeError };
    const next = structuredClone(route);

    if (patch && typeof patch.humanize === 'boolean') next.humanize = patch.humanize;

    // 0 is meaningful here (no limit), so a falsy check would silently drop it.
    for (const [key, value] of Object.entries((patch && patch.watchdog) || {})) {
        if (value === undefined || !(key in next.watchdog)) continue;
        const n = Number(value);
        if (Number.isFinite(n)) next.watchdog[key] = Math.max(0, Math.round(n));
    }

    // Wall-clock breaks. `at` is a HH:MM string; route.js rejects anything else.
    for (const [kind, edit] of Object.entries((patch && patch.daily) || {})) {
        if (kind === 'minPlayBeforeMs') {
            const n = Number(edit);
            if (Number.isFinite(n)) next.daily.minPlayBeforeMs = Math.max(0, Math.round(n));
            continue;
        }
        if (!edit || !next.daily[kind]) continue;
        for (const [key, value] of Object.entries(edit)) {
            if (value === undefined || !(key in next.daily[kind])) continue;
            if (key === 'enabled') next.daily[kind].enabled = Boolean(value);
            else if (key === 'at') next.daily[kind].at = String(value);
            else {
                const n = Number(value);
                if (Number.isFinite(n)) next.daily[kind][key] = Math.max(0, Math.round(n));
            }
        }
    }

    for (const [tier, edit] of Object.entries((patch && patch.breaks) || {})) {
        if (!edit || !next.breaks[tier]) continue;
        for (const [key, value] of Object.entries(edit)) {
            if (value === undefined || !(key in next.breaks[tier])) continue;
            if (key === 'enabled') {
                next.breaks[tier].enabled = Boolean(value);
                continue;
            }
            const n = Number(value);
            if (Number.isFinite(n)) next.breaks[tier][key] = Math.max(0, Math.round(n));
        }
    }

    for (const [id, edit] of Object.entries((patch && patch.locations) || {})) {
        const entry = next.locations[id];
        if (!entry || !edit) continue;
        if (edit.delayMs !== undefined) entry.delayMs = Math.round(Number(edit.delayMs));
        if (edit.enabled !== undefined) entry.enabled = Boolean(edit.enabled);
    }

    // saveRoute validates and clamps, and hands back what actually landed on
    // disk - which is what the editor rebinds to.
    saveRoute(next);
    return { route, appliedToRun: pushRouteToEngine() };
}

function resetTimings() {
    if (!route) return { route: null, error: routeError };
    const recorded = routeApi.defaultRoute().locations;
    const next = structuredClone(route);
    for (const [id, entry] of Object.entries(next.locations)) {
        if (recorded[id]) entry.delayMs = recorded[id].delayMs;
    }
    saveRoute(next);
    return { route, appliedToRun: pushRouteToEngine() };
}

function engineAvailable() {
    return fs.existsSync(ENGINE_PATH);
}

/* ------------------------------------------------- autonomous repair */

let supervisor = null;

// Distinguishes "the engine stopped by itself" from "a person stopped it".
// Without this, pressing STOP during a watchdog storm would be followed by an
// auto-resume seconds later, which is the opposite of what STOP means.
let userStopped = false;

function ensureSupervisor() {
    if (supervisor) return supervisor;
    if (!fs.existsSync(SUPERVISOR_PATH)) {
        console.log('[auto] harness/supervisor.js missing - auto-repair unavailable');
        return null;
    }
    try {
        const { Supervisor } = require(SUPERVISOR_PATH);
        supervisor = new Supervisor({
            config: route.autoRepair,
            url: SERVER,
            onEvent: pushEvent,
            startHarness: () => {
                // A person pressing STOP mid-cycle outranks any verification the
                // supervisor did before it.
                if (userStopped) return false;
                const res = startRun({ live: !run.dryRun, confirm: !run.dryRun });
                return Boolean(res && res.ok);
            },
            stopHarness: (reason) => stopRun(reason, { byUser: false }),
            getHarnessState: () => {
                const state = engine && typeof engine.getState === 'function'
                    ? engine.getState() : null;
                return state ? {
                    running: Boolean(state.running),
                    clicks: Number(state.clicks) || 0,
                    location: state.location || null
                } : { running: false, clicks: run.clicks, location: run.location };
            }
        });
    } catch (err) {
        console.log(`[auto] could not load the supervisor: ${err.message}`);
        return null;
    }
    return supervisor;
}

/* ------------------------------------------------- remote dashboard */

let telemetry = null;

const BREAK_KINDS = ['short', 'long', 'lunch', 'dinner', 'sleep'];

/**
 * What every break tier is doing, for the dashboard's toggles.
 *
 * Merged from two places on purpose: `enabled` comes from route.json so the page
 * renders correctly with the clicker stopped, and everything else comes from the
 * live schedulers, which only exist while it is running.
 */
function breakStats() {
    const out = {};
    for (const kind of BREAK_KINDS) {
        const cfg = ['short', 'long'].includes(kind)
            ? (route && route.breaks && route.breaks[kind])
            : (route && route.daily && route.daily[kind]);
        out[kind] = { enabled: Boolean(cfg && cfg.enabled) };
    }
    const tiers = engine && engine._breaks ? engine._breaks : [];
    for (const tier of tiers) {
        if (!out[tier.kind]) continue;
        try {
            Object.assign(out[tier.kind], tier.stats(), { enabled: out[tier.kind].enabled });
        } catch (err) {
            // A tier that cannot describe itself is not worth a broken heartbeat.
        }
    }
    return out;
}

/**
 * Do what the dashboard asked.
 *
 * Every branch is the same code path the local button uses - this is a second
 * way in, not a second implementation. Anything it cannot do comes back as
 * `ok: false` with a reason, which the page shows next to the command.
 */
async function runCommand(cmd) {
    const action = String(cmd && cmd.action);
    const args = (cmd && cmd.args) || {};

    const say = (ok, detail) => {
        pushEvent({ type: 'control', action, ok, detail });
        return { ok, result: detail };
    };

    switch (action) {
        case 'start': {
            // Honours the panel's own mode. A dashboard cannot promote a dry run
            // to live clicking in one press - that takes two, same as locally.
            const res = startRun({ live: !run.dryRun, confirm: !run.dryRun });
            return say(Boolean(res && res.ok),
                res && res.ok ? (run.dryRun ? 'started (dry run)' : 'started LIVE')
                    : (res && res.error) || 'refused');
        }
        case 'stop': {
            if (!run.running) return say(false, 'it was not running');
            stopRun('stopped from the dashboard');
            return say(true, 'stopped');
        }
        case 'mode': {
            if (run.running) return say(false, 'cannot change mode mid-run');
            run.dryRun = args.mode !== 'live';
            send('mode', { dryRun: run.dryRun });
            return say(true, run.dryRun ? 'dry run' : 'LIVE armed');
        }
        case 'auto': {
            route.autoRepair.enabled = Boolean(args.enabled);
            saveRoute(route);
            if (supervisor) supervisor._cfg = Object.assign(supervisor._cfg, route.autoRepair);
            return say(true, `auto-repair ${route.autoRepair.enabled ? 'ON' : 'OFF'}`);
        }
        case 'test-repair': {
            const sup = ensureSupervisor();
            if (!sup) return say(false, 'harness/supervisor.js is missing');
            sup._cfg = Object.assign(sup._cfg, route.autoRepair);
            // Deliberately not awaited: a repair cycle runs for minutes and the
            // ack has to go back on this heartbeat, not the one after it lands.
            Promise.resolve(sup.testCycle('requested from the dashboard')).catch(() => {});
            return say(true, 'repair cycle started');
        }
        case 'abort-repair': {
            if (!supervisor) return say(false, 'no repair has ever run');
            supervisor.abort('cancelled from the dashboard');
            return say(true, 'cancelled');
        }
        case 'test-break': {
            const kind = String(args.kind);
            if (!BREAK_KINDS.includes(kind)) return say(false, `"${kind}" is not a kind of break`);
            if (!engine || typeof engine.requestBreak !== 'function') {
                return say(false, 'the clicker is not running');
            }
            const res = engine.requestBreak(kind);
            return say(Boolean(res && res.ok),
                res && res.ok ? `${kind} armed` : (res && res.reason) || 'refused');
        }
        case 'route-patch': {
            // Straight through the validator the local editor writes through, so
            // a patch from a browser cannot put route.json into a state the panel
            // could not have produced itself.
            const res = applyRoutePatch(args);
            if (!res || !res.route) return say(false, (res && res.error) || 'route unavailable');
            return say(true, `applied${res.appliedToRun ? ' to the running clicker' : ''}`);
        }
        default:
            return say(false, `"${action}" is not a command`);
    }
}

// Off unless both GREENBOT_DASH_URL and GREENBOT_DASH_TOKEN are in the
// environment. Nothing leaves this machine until they are.
function startTelemetry() {
    if (telemetry || SELFTEST) return telemetry;
    let Telemetry;
    try {
        ({ Telemetry } = require(TELEMETRY_PATH));
    } catch (err) {
        console.log(`[telemetry] unavailable: ${err.message}`);
        return null;
    }

    telemetry = new Telemetry({
        log: (message) => console.log(`[telemetry] ${message}`),
        onCommand: (cmd) => runCommand(cmd),
        getStatus: () => {
            const state = engine && typeof engine.getState === 'function' ? engine.getState() : null;
            return {
                running: state ? Boolean(state.running) : Boolean(run.running),
                dryRun: run.dryRun,
                phase: run.phase,
                location: state ? state.location : run.location,
                clicks: state ? Number(state.clicks) || 0 : run.clicks,
                sessionMs: state ? Number(state.sessionMs) || 0 : 0,
                stopReason: run.stopReason,
                auto: autoStats(),
                breaks: breakStats()
            };
        }
    });

    if (!telemetry.configured) {
        console.log('[telemetry] off - set GREENBOT_DASH_URL and GREENBOT_DASH_TOKEN to enable');
        return telemetry;
    }
    telemetry.start();
    return telemetry;
}

/* ------------------------------------------- outside control (repair skill) */

const STATUS_PATH = path.join(__dirname, '..', 'harness', 'status.json');
const CONTROL_PATH = path.join(__dirname, '..', 'harness', 'control.json');
let lastCommandAt = 0;
let controlTimer = null;

// The repair skill runs in its own process and has no IPC to attach to, so the
// panel publishes what it is doing and watches for commands. A timestamp rather
// than a flag: a stale status file must never read as a live harness.
function publishStatus() {
    const state = engine && typeof engine.getState === 'function' ? engine.getState() : null;
    const payload = {
        at: Date.now(),
        running: state ? Boolean(state.running) : Boolean(run.running),
        phase: run.phase,
        dryRun: run.dryRun,
        clicks: state ? Number(state.clicks) || 0 : run.clicks,
        location: state ? state.location : run.location,
        confidence: state ? state.confidence : run.confidence,
        stopReason: run.stopReason,
        auto: autoStats(),
        telemetry: telemetryStats()
    };
    try {
        fs.writeFileSync(STATUS_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    } catch (err) {
        // Losing a status write is not worth killing the run over.
    }
}

function pollControl() {
    let command = null;
    try {
        command = JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
        return;
    }
    const at = Number(command && command.at) || 0;
    if (!at || at <= lastCommandAt) return;
    lastCommandAt = at;

    if (command.action === 'start') {
        console.log(`[control] start requested by ${command.by || 'unknown'}`);
        // Honours the panel's current mode: an outside caller cannot promote a
        // dry run to live clicking.
        const res = startRun({ live: !run.dryRun, confirm: !run.dryRun });
        pushEvent({ type: 'warn',
            message: `external start: ${res && res.ok ? 'ok' : (res && res.error) || 'refused'}` });
    } else if (command.action === 'stop') {
        console.log(`[control] stop requested by ${command.by || 'unknown'}`);
        stopRun(`external stop from ${command.by || 'control.js'}`);
    }
}

function startControlLoop() {
    clearInterval(controlTimer);
    publishStatus();
    controlTimer = setInterval(() => {
        publishStatus();
        pollControl();
    }, 2000);
}

function telemetryStats() {
    return telemetry ? telemetry.stats() : { configured: false };
}

function autoStats() {
    const cfg = route.autoRepair || {};
    const stats = supervisor ? supervisor.stats() : {};
    return Object.assign({
        enabled: Boolean(cfg.enabled),
        available: fs.existsSync(SUPERVISOR_PATH),
        stage: 'idle',
        cyclesThisHour: 0,
        lifetimeCycles: 0,
        maxCyclesPerHour: cfg.maxCyclesPerHour,
        globalMaxCycles: cfg.globalMaxCycles,
        lastGiveUp: null,
        disabled: null
    }, stats, { enabled: Boolean(cfg.enabled) });
}

function maybeAutoRepair(reason) {
    if (!route.autoRepair || !route.autoRepair.enabled) return;
    if (userStopped) return;
    const sup = ensureSupervisor();
    if (!sup) return;
    sup._cfg = Object.assign(sup._cfg, route.autoRepair);
    Promise.resolve(sup.onHarnessStopped(reason)).catch((err) => {
        pushEvent({ type: 'warn', message: `auto-repair failed: ${err.message}` });
    });
}

// Re-required per run, so an edit to the engine lands on the next START rather
// than needing the panel restarted.
function engineConstructor() {
    let resolved;
    try {
        resolved = require.resolve(ENGINE_PATH);
    } catch (err) {
        throw new Error(`harness engine not found at ${ENGINE_PATH}`);
    }
    delete require.cache[resolved];
    const mod = require(resolved);
    const Ctor = typeof mod === 'function' ? mod : mod.Harness;
    if (typeof Ctor !== 'function') throw new Error('harness/engine.js exports no Harness class');
    return Ctor;
}

function pushEvent(ev) {
    if (!ev || typeof ev !== 'object') return;

    // seq lets the renderer merge a pulled backlog with live pushes; ts is
    // separate from `at` because 'click' already uses `at` for a coordinate.
    const out = Object.assign({}, ev, { seq: ++eventSeq, ts: Date.now() });
    // The engine emits 'started' synchronously inside the ipcMain handler, so it
    // reaches the renderer BEFORE the invoke reply carrying dryRun. Stamp the
    // authoritative value on the event or the log banner announces the wrong mode.
    if (out.type === 'started') out.dryRun = run.dryRun;
    applyEvent(out);
    // Telemetry sees exactly what the panel's own log sees, and decides for
    // itself which handful of those are worth a row on the dashboard.
    if (telemetry) telemetry.record(out);
    events.push(out);
    if (events.length > EVENT_CAP) events.splice(0, events.length - EVENT_CAP);
    send('engine', out);
}

function applyEvent(ev) {
    switch (ev.type) {
        case 'started':
            run.running = true;
            run.startedAt = ev.at || ev.ts;
            run.clicks = 0;
            run.phase = 'polling';
            run.stopReason = null;
            break;
        case 'tick':
            run.phase = ev.phase || run.phase;
            run.location = ev.location;
            run.confidence = ev.confidence;
            break;
        case 'click':
            run.clicks += 1;
            run.phase = 'clicking';
            break;
        case 'wait':
            run.phase = 'waiting';
            break;
        case 'stopped':
            clearTimeout(stopFallback);
            run.running = false;
            run.phase = 'stopped';
            run.stopReason = ev.reason || null;
            unregisterKill();
            // A watchdog or backend-failure stop comes from the engine, not from
            // stopRun(). Without releasing the reference here, startRun()'s
            // `run.running || engine` guard refuses forever and the panel is
            // bricked until it is restarted.
            engine = null;
            // Must come AFTER the reset above: the supervisor's resume calls
            // startRun(), which refuses while `engine` is still set.
            maybeAutoRepair(run.stopReason);
            break;
        default:
            break;
    }
}

function registerKill() {
    if (killRegistered) return;
    killRegistered = globalShortcut.register(KILL_ACCELERATOR, () => {
        stopRun(`${KILL_ACCELERATOR} kill switch`);
    });
    if (!killRegistered) {
        pushEvent({
            type: 'warn',
            message: `${KILL_ACCELERATOR} is held by another app - kill switch unavailable`
        });
    }
}

function unregisterKill() {
    if (!killRegistered) return;
    globalShortcut.unregister(KILL_ACCELERATOR);
    killRegistered = false;
}

// Isolated, in-memory, so --selftest leaves no daily.json behind.
function selftestPlan() {
    try {
        const { DailyPlan, memoryStore } = require(path.join(__dirname, '..', 'harness', 'daily.js'));
        return new DailyPlan({ store: memoryStore(), onEvent: pushEvent });
    } catch (err) {
        return null;
    }
}

function startRun(opts) {
    if (run.running || engine) return { ok: false, error: 'already running' };

    // Clear the "a person stopped this" latch. Only a deliberate start does this,
    // so a supervisor resume cannot clear it on its own - startHarness() checks
    // the flag and refuses before ever reaching here.
    userStopped = false;

    // Two independent flags, both set only by the renderer's confirm step. Dry
    // run is what you get for anything less.
    const live = Boolean(opts && opts.live === true && opts.confirm === true);

    let Ctor;
    try {
        Ctor = engineConstructor();
    } catch (err) {
        const message = String(err.message || err);
        pushEvent({ type: 'warn', message });
        return { ok: false, error: message };
    }

    // Re-read rather than trust the cached copy: the file is the contract, and
    // the user may have edited it by hand since the panel opened.
    if (!loadRoute()) {
        pushEvent({ type: 'warn', message: routeError });
        return { ok: false, error: routeError };
    }

    try {
        engine = new Ctor({ url: SERVER, route, dryRun: !live, onEvent: pushEvent,
            // A selftest must not roll - or consume - the real day's meal plan.
            // Its two-second run would otherwise write harness/daily.json with a
            // grace window measured from the test, cancelling the user's lunch.
            dailyPlan: SELFTEST ? selftestPlan() : null });
    } catch (err) {
        engine = null;
        const message = `engine construction failed: ${err.message}`;
        pushEvent({ type: 'warn', message });
        return { ok: false, error: message };
    }

    // The classifier learned one camera framing and the per-spot target rules are
    // fixed screen positions, so both drift the moment the camera does. Reset it
    // on every start rather than hoping it survived. Fire-and-forget: a camera
    // that cannot be set is not a reason to refuse to click, and the watchdog
    // catches it if the framing really is wrong.
    try {
        const camera = require(path.join(__dirname, '..', 'repair', 'camera.js'));
        camera.apply().then((res) => {
            pushEvent({ type: 'warn', message: res.ok
                ? `camera: north + max pitch set${res.warning ? ` (${res.warning})` : ''}`
                : `camera not set: ${res.reason}` });
        }).catch((err) => {
            pushEvent({ type: 'warn', message: `camera setup failed: ${err.message}` });
        });
    } catch (err) {
        console.log(`[run] camera module unavailable: ${err.message}`);
    }

    registerKill();
    // A live run with no working kill switch is the one situation where there is
    // no way to stop the mouse except closing the window. Refuse it. A dry run
    // touches nothing, so it may proceed with a warning.
    if (live && !killRegistered) {
        engine = null;
        const message = `refusing to start LIVE: ${KILL_ACCELERATOR} kill switch could not be `
            + 'registered, another app is holding it';
        pushEvent({ type: 'warn', message });
        return { ok: false, error: message };
    }

    const endsRun = [];
    if (route.breaks && route.breaks.long && route.breaks.long.enabled) endsRun.push('long breaks');
    for (const kind of ['lunch', 'dinner', 'sleep']) {
        if (route.daily && route.daily[kind] && route.daily[kind].enabled) endsRun.push(kind);
    }
    if (endsRun.length && !(route.autoRepair && route.autoRepair.enabled)) {
        pushEvent({ type: 'warn', message: `${endsRun.join(', ')} will log out, but `
            + 'auto-repair is OFF - nothing will log back in afterwards' });
    }

    run.running = true;
    run.dryRun = !live;
    run.phase = 'polling';
    run.clicks = 0;
    run.startedAt = Date.now();
    run.stopReason = null;
    console.log(`[run] start ${live ? 'LIVE' : 'dry run'}`);

    try {
        const pending = engine.start();
        if (pending && typeof pending.catch === 'function') {
            pending.catch((err) => {
                pushEvent({ type: 'warn', message: `engine failed: ${err.message}` });
                stopRun('engine failed');
            });
        }
    } catch (err) {
        const message = `engine failed to start: ${err.message}`;
        pushEvent({ type: 'warn', message });
        stopRun('engine failed to start');
        return { ok: false, error: message };
    }

    return { ok: true, dryRun: !live };
}

function stopRun(reason, { byUser = true } = {}) {
    // A person stopping the run must not be undone by an auto-resume seconds
    // later. The supervisor stopping a stalled harness is different - that is
    // part of a retry, so it must not latch or the loop ends after one failure.
    if (byUser) userStopped = true;
    if (supervisor && supervisor.isActive()) supervisor.abort(`harness stopped: ${reason}`);
    unregisterKill();
    const inst = engine;
    engine = null;
    if (inst) {
        try {
            inst.stop(reason);
        } catch (err) {
            console.log(`[run] engine.stop threw: ${err.message}`);
        }
    }

    if (run.running) {
        run.phase = 'stopped';
        clearTimeout(stopFallback);
        // The engine reports its own 'stopped'. This only covers one that died
        // without saying so, so the panel can never sit there claiming to run.
        stopFallback = setTimeout(() => {
            if (run.running) pushEvent({ type: 'stopped', reason: reason || 'stopped' });
        }, 250);
    }
    return { ok: true, reason: reason || null };
}

function capturePoint() {
    // getCursorScreenPoint is in DIP; the service and the click backend both
    // talk screen pixels, and those diverge the moment scaling is not 100%.
    const dip = screen.getCursorScreenPoint();
    const px = typeof screen.dipToScreenPoint === 'function' ? screen.dipToScreenPoint(dip) : dip;
    const point = { x: Math.round(px.x), y: Math.round(px.y) };

    disarmPick();
    if (!route || !route.locations.transit) return;

    const next = structuredClone(route);
    next.locations.transit.point = point;
    saveRoute(next);
    pushRouteToEngine();
    send('pick', { armed: false, point, accelerator: PICK_ACCELERATOR });
}

function armPick() {
    if (!pickArmed) {
        pickArmed = globalShortcut.register(PICK_ACCELERATOR, capturePoint);
        if (!pickArmed) {
            return {
                armed: false,
                accelerator: PICK_ACCELERATOR,
                error: `${PICK_ACCELERATOR} is held by another app`
            };
        }
    }
    return { armed: true, accelerator: PICK_ACCELERATOR };
}

function disarmPick() {
    if (pickArmed) {
        globalShortcut.unregister(PICK_ACCELERATOR);
        pickArmed = false;
    }
    return { armed: false, accelerator: PICK_ACCELERATOR };
}

function runState() {
    return {
        run: Object.assign({}, run),
        route,
        routeError,
        routePath: routePath(),
        engineAvailable: engineAvailable(),
        pick: { armed: pickArmed, accelerator: PICK_ACCELERATOR },
        killAccelerator: KILL_ACCELERATOR,
        events: events.slice()
    };
}

app.whenReady().then(async () => {
    loadRoute();

    // Every handler is registered before loadFile - a renderer that invokes
    // during its own init must not race the main process into "no handler".
    ipcMain.handle('get-config', () => ({
        url: SERVER, hz: HZ, selftest: SELFTEST, contentProtected
    }));

    ipcMain.handle('set-content-protection', (_e, on) => {
        const applied = applyContentProtection(on);
        // Persisted deliberately: over Remote Desktop the window is invisible
        // while protected, so the setting must survive without needing a click.
        saveSettings(Object.assign(loadSettings(), { contentProtection: applied }));
        return applied;
    });
    ipcMain.handle('set-hz', (_e, hz) => {
        const value = Math.max(0.2, Math.min(10, Number(hz) || DEFAULT_HZ));
        clearInterval(timer);
        timer = setInterval(poll, 1000 / value);
        return value;
    });
    ipcMain.handle('run:state', () => runState());
    ipcMain.handle('run:start', (_e, opts) => startRun(opts));
    ipcMain.handle('run:stop', () => stopRun('stopped from the panel'));
    ipcMain.handle('route:save', (_e, patch) => applyRoutePatch(patch));
    ipcMain.handle('route:reset-timings', () => resetTimings());
    ipcMain.handle('pick:arm', () => armPick());
    ipcMain.handle('pick:disarm', () => disarmPick());

    ipcMain.handle('auto:set', (_e, on) => {
        route.autoRepair.enabled = Boolean(on);
        saveRoute(route);
        if (supervisor) supervisor._cfg = Object.assign(supervisor._cfg, route.autoRepair);
        return autoStats();
    });
    // Armed mode has to live in main, not only in the renderer: control.js and
    // the repair skill start runs without going through the START button, and
    // they read run.dryRun.
    // "As soon as allowed", not "now": the engine still refuses to start a break
    // on transit, so this arms it and it lands at the next spot.
    const BREAK_KINDS = ['short', 'long', 'lunch', 'dinner', 'sleep'];
    ipcMain.handle('run:test-break', (_e, kind) => {
        const want = BREAK_KINDS.includes(kind) ? kind : null;
        if (!want) return { ok: false, reason: `"${kind}" is not a kind of break` };
        if (!engine || typeof engine.requestBreak !== 'function') {
            return { ok: false, reason: 'the clicker is not running' };
        }
        const res = engine.requestBreak(want);
        pushEvent({ type: 'warn', message: res.ok
            ? `${want} break armed from the panel - it will start at the next spot`
            : `${want} break not armed: ${res.reason}` });
        return res;
    });

    // What today actually rolled to, so the panel can show real times rather
    // than the configured ones - they are never quite the same.
    ipcMain.handle('run:daily-plan', () => {
        if (engine && engine._dailyPlan) {
            try {
                return { ok: true, events: engine._dailyPlan.summary() };
            } catch (err) {
                return { ok: false, reason: String(err.message || err) };
            }
        }
        try {
            const raw = fs.readFileSync(path.join(__dirname, '..', 'harness', 'daily.json'), 'utf8');
            const plan = JSON.parse(raw.replace(/^\ufeff/, ''));
            return { ok: true, date: plan.date, events: plan.events, stale: true };
        } catch (err) {
            return { ok: false, reason: 'nothing planned yet - start the clicker' };
        }
    });

    ipcMain.handle('run:set-mode', (_e, mode) => {
        if (run.running) return { ok: false, error: 'cannot change mode mid-run' };
        run.dryRun = mode !== 'live';
        send('mode', { dryRun: run.dryRun });
        console.log(`[run] mode armed: ${run.dryRun ? 'dry run' : 'LIVE'}`);
        pushEvent({ type: 'warn', message: run.dryRun
            ? 'mode set to dry run'
            : 'mode set to LIVE - any start, including an automatic one, will click for real' });
        publishStatus();
        return { ok: true, dryRun: run.dryRun };
    });

    ipcMain.handle('auto:stats', () => autoStats());

    ipcMain.handle('telemetry:stats', () => telemetryStats());

    ipcMain.handle('auto:test', async () => {
        const sup = ensureSupervisor();
        if (!sup) return { ok: false, reason: 'harness/supervisor.js is missing' };
        sup._cfg = Object.assign(sup._cfg, route.autoRepair);
        // A test must be able to run with the toggle off - that is the point of
        // trying it before trusting it.
        userStopped = false;
        pushEvent({ type: 'warn', message: 'manual repair test starting - watch the log' });
        try {
            return await sup.testCycle();
        } catch (err) {
            return { ok: false, reason: String(err.message || err) };
        }
    });

    ipcMain.handle('auto:abort', () => {
        if (supervisor) supervisor.abort('cancelled from the panel');
        return autoStats();
    });

    // Park it against the right edge by default - out of the way of the game.
    const work = screen.getPrimaryDisplay().workArea;
    // Wide enough that an ultrawide capture is still legible in the preview.
    const width = 540;
    const height = Math.min(760, work.height - 60);

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

    applyContentProtection(initialContentProtection());

    // Closing the panel is a stop. Nothing may keep clicking with no window to
    // watch it, and nothing may outlive the shortcuts that stop it.
    win.on('close', () => {
        stopRun('panel closed');
        disarmPick();
    });

    win.webContents.on('console-message', (...args) => {
        const d = args[0] && typeof args[0] === 'object' && 'message' in args[0]
            ? args[0]
            : { level: args[1], message: args[2] };
        if (d.level === 'error' || d.level === 3) console.log(`[renderer] ${d.message}`);
    });

    await win.loadFile(path.join(__dirname, 'index.html'));
    schedule();
    startControlLoop();
    startTelemetry();

    console.log(`[monitor] polling ${SERVER} at ${HZ} Hz`);

    if (SELFTEST) {
        const ok = await selftest();
        stopping = true;
        stopRun('selftest done');
        clearInterval(timer);
        clearTimeout(stopFallback);
        globalShortcut.unregisterAll();
        app.exit(ok ? 0 : 1);
    }
});

function exec(js) {
    return win.webContents.executeJavaScript(js).catch((err) => ({
        __error: String((err && err.message) || err)
    }));
}

async function until(js, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let value = await exec(js);
    while (!predicate(value) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        value = await exec(js);
    }
    return value;
}

// Unattended check: the panel must render a real tick and the Run tab must
// drive the harness end to end, not just boot.
async function selftest() {
    const fails = [];

    const diag = await until('window.__diag || null', (d) => d && d.ticks > 0 && d.rendered, 20000);
    if (!(diag && diag.ticks > 0 && diag.rendered)) {
        fails.push(`monitor never rendered a tick: ${JSON.stringify(diag)}`);
    }
    console.log(`[selftest] monitor  ${JSON.stringify(diag)}`);

    const ready = await until('Boolean(window.__run && window.__run.ready)', (v) => v === true, 10000);
    if (ready !== true) {
        fails.push('run tab never finished its init');
        console.log('[selftest] FAIL - run tab did not initialise');
        return false;
    }

    await exec("window.__run.selectTab('run')");
    if (!route) {
        console.log(`[selftest] FAIL - ${routeError}`);
        return false;
    }
    const want = Object.keys(route.locations).length;
    const tab = await exec('window.__run.diag()');
    if (!tab || tab.tab !== 'run') fails.push(`run tab did not activate: ${JSON.stringify(tab)}`);
    if (!tab || tab.rows !== want) fails.push(`timings editor rendered ${tab && tab.rows} rows, want ${want}`);
    if (!tab || tab.dryRun !== true || tab.mode !== 'dry') fails.push('dry run is not the default');
    console.log(`[selftest] run tab  tab=${tab && tab.tab} rows=${tab && tab.rows}/${want} mode=${tab && tab.mode}`);

    // Breaks: both tiers must render, the toggles must persist, and turning the
    // long one on without auto-repair must be called out - it silently ends the
    // session hours later otherwise.
    const brkWant = 10;      // 2 tiers x (1 header + 4 fields)
    const wasLong = Boolean(route.breaks.long && route.breaks.long.enabled);
    const autoOn = Boolean(route.autoRepair && route.autoRepair.enabled);
    const brk = await exec("window.__run.setBreaks('long', true)");
    const brkDiag = await exec('window.__run.diag()');
    if (!brk || brk.long.enabled !== true) fails.push('the long break did not turn on');
    if (!brkDiag || brkDiag.breakRows !== brkWant) {
        fails.push(`breaks editor rendered ${brkDiag && brkDiag.breakRows} rows, want ${brkWant}`);
    }
    if (brkDiag && brkDiag.breakWarn !== !autoOn) {
        fails.push(`breaks warning is ${brkDiag.breakWarn} with auto-repair ${autoOn}`);
    }
    // Each tier on its own side of the 5 min idle-logout timer.
    if (brk && !(brk.long.minIdleMs > 300000)) {
        fails.push(`long idle ${brk && brk.long.minIdleMs}ms does not clear the logout timer`);
    }
    if (brk && !(brk.short.maxIdleMs < 300000)) {
        fails.push(`short idle ${brk && brk.short.maxIdleMs}ms would log out`);
    }
    // A break can only be forced into a running clicker, so the buttons are dead
    // until START. They come alive further down, once the run is up.
    if (brkDiag && brkDiag.breakTests !== 0) {
        fails.push(`${brkDiag.breakTests} test-break buttons live while stopped`);
    }
    const earlyForce = await exec("window.__run.testBreak('short')");
    if (!earlyForce || earlyForce.ok !== false) {
        fails.push('a break was armed with the clicker stopped');
    }
    await exec(`window.__run.setBreaks('long', ${wasLong})`);
    console.log(`[selftest] breaks   rows=${brkDiag && brkDiag.breakRows}/${brkWant} `
        + `short=${Math.round((brk && brk.short.minIdleMs) / 1000)}-`
        + `${Math.round((brk && brk.short.maxIdleMs) / 1000)}s long=`
        + `${Math.round((brk && brk.long.minIdleMs) / 60000)}-`
        + `${Math.round((brk && brk.long.maxIdleMs) / 60000)}min warn=${brkDiag && brkDiag.breakWarn}`);

    // The daily routine: three rows, and its own test buttons under the same
    // "only while running" rule as the interval breaks.
    const dayDiag = await exec('window.__run.diag()');
    if (!dayDiag || dayDiag.dayRows !== 3) {
        fails.push(`daily editor rendered ${dayDiag && dayDiag.dayRows} rows, want 3`);
    }
    if (dayDiag && dayDiag.dayTests !== 0) {
        fails.push(`${dayDiag.dayTests} daily test buttons live while stopped`);
    }
    const wasLunch = Boolean(route.daily.lunch && route.daily.lunch.enabled);
    const daily = await exec("window.__run.setDaily('lunch', true)");
    if (!daily || daily.lunch.enabled !== true) fails.push('lunch did not turn on');
    if (daily && !/^\d{1,2}:\d{2}$/.test(String(daily.lunch.at))) {
        fails.push(`lunch time is not HH:MM: ${daily && daily.lunch.at}`);
    }
    await exec(`window.__run.setDaily('lunch', ${wasLunch})`);
    console.log(`[selftest] daily    rows=${dayDiag && dayDiag.dayRows}/3 `
        + `lunch=${daily && daily.lunch.at} dinner=${daily && daily.dinner.at} `
        + `sleep=${daily && daily.sleep.at}`);

    const started = await exec('window.__run.start()');
    if (!started || started.ok !== true) {
        fails.push(`start refused: ${JSON.stringify(started)}`);
    } else {
        const seen = await until(
            'window.__run.diag()',
            (d) => d && d.events >= 2 && d.types.indexOf('started') >= 0,
            20000
        );
        if (!(seen && seen.events >= 2 && seen.types.indexOf('started') >= 0)) {
            fails.push(`engine events did not reach the renderer: ${JSON.stringify(seen)}`);
        }
        if (seen && seen.dryRun !== true) fails.push('run reported itself as live');
        console.log(`[selftest] engine   events=${seen && seen.events} types=${seen && seen.types}`);
    }

    const force = await exec("window.__run.testBreak('short')");
    if (!force || force.ok !== true) {
        fails.push(`test-break refused while running: ${JSON.stringify(force)}`);
    }
    const live = (await exec('window.__run.diag()')) || {};
    if (!(live.breakTests > 0)) fails.push('test-break buttons stayed disabled during a run');
    if (!(live.dayTests > 0)) fails.push('daily test buttons stayed disabled during a run');
    const forceMeal = await exec("window.__run.testBreak('lunch')");
    if (!forceMeal || forceMeal.ok !== true) {
        fails.push(`test-break lunch refused: ${JSON.stringify(forceMeal)}`);
    }
    console.log(`[selftest] break fx armed=${force && force.ok} `
        + `lunch=${forceMeal && forceMeal.ok} buttons=${live.breakTests}+${live.dayTests}`);

    await exec('window.__run.stop()');
    const done = await until('window.__run.diag()', (d) => d && d.running === false && d.phase === 'stopped', 8000);
    if (!(done && done.running === false && done.phase === 'stopped')) {
        fails.push(`run did not stop: ${JSON.stringify(done)}`);
    }
    console.log(`[selftest] stop     phase=${done && done.phase} running=${done && done.running} clicks=${done && done.clicks}`);

    for (const f of fails) console.log(`[selftest] fail: ${f}`);
    console.log(`[selftest] ${fails.length ? 'FAIL' : 'PASS'}`);
    return fails.length === 0;
}

app.on('window-all-closed', () => {
    if (!stopping) app.quit();
});
app.on('will-quit', () => {
    stopRun('quitting');
    clearInterval(timer);
    clearInterval(controlTimer);
    clearTimeout(stopFallback);
    globalShortcut.unregisterAll();
    // Leave a status the outside world can read as "panel gone" rather than a
    // stale file that still claims the harness is running.
    try {
        fs.writeFileSync(STATUS_PATH, `${JSON.stringify({ at: Date.now(), running: false,
            phase: 'stopped', stopReason: 'panel closed' }, null, 2)}\n`);
    } catch (err) { /* nothing useful to do while quitting */ }
});
