'use strict';

// Put the OSRS camera into the state the harness was trained and calibrated for:
// facing north, pitched as far up as it goes, zoomed as far out as it goes.
//
// This matters because everything downstream assumes it. The location classifier
// learned one camera framing, and the per-spot target rules are fixed screen
// positions - both drift the moment the camera does. Running this before every
// start removes a whole class of "why is it clicking the wrong platform".
//
//   node greenbot/repair/camera.js            apply, then report
//   node greenbot/repair/camera.js --check    report only, change nothing
//
// Field findings this encodes:
//   * Arrow keys drive the camera. DPAD_UP pitches up, DPAD_LEFT/RIGHT rotate.
//   * Tapping the compass snaps the view to north.
//   * Zoom is NOT reachable over adb - see zoomOut() for what was tried.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PACKAGE = 'com.jagex.oldscape.android';

// Screencap space, which is 1:1 with input tap on this device (display 0
// logicalFrame is 0,0-2560,1600). Verified, not assumed.
const SCREEN = { width: 2560, height: 1600 };

// Compass centre, measured off a real screenshot by cropping and inspecting the
// needle. The first guess (2372,186) was ~110px high and left of this - it hit
// empty world, so north silently never snapped while every tap "succeeded".
// Re-measure if the game's interface scale changes.
const COMPASS = { x: 2458, y: 300 };

const PITCH_PRESSES = 30;   // more than the range needs; extra presses are no-ops
const KEY_DELAY_MS = 40;

function adb(args, timeoutMs = 10000) {
    return new Promise((resolve) => {
        execFile('adb', args, { timeout: timeoutMs, encoding: 'buffer',
            maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                stdout: stdout || Buffer.alloc(0),
                stderr: stderr ? stderr.toString('utf8') : '',
                error: err ? String(err.message || err) : null
            });
        });
    });
}

const shell = (cmd, timeoutMs) => adb(['shell', cmd], timeoutMs);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wake and unlock in ONE adb invocation.
 *
 * The tablet used to sleep every 60 seconds, and a sequence of separate calls
 * would have it re-lock between steps. Chaining them removes that window even
 * now that the timeout is raised, because the cost is nil and the failure was
 * genuinely confusing to diagnose.
 */
async function wakeAndUnlock() {
    const res = await shell('input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; sleep 0.4');
    return { ok: res.ok, error: res.error };
}

async function isGameForeground() {
    // Every mCurrentFocus line, not just the first. This tablet still has a
    // stale scrcpy virtual display registered, and it reports
    // 'mCurrentFocus=null' - taking -m1 read that one and concluded the game was
    // not running while it was plainly rendering on display 0.
    //
    // 'mCurrentFocus=' anchored, because a loose match also hits
    // mCurrentFocusedWindow, which reports something different again.
    const res = await shell('dumpsys window | grep "mCurrentFocus="');
    const text = res.stdout.toString('utf8');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const hit = lines.find((l) => l.includes(PACKAGE));

    if (hit) return { ok: res.ok, focus: hit, isGame: true, displays: lines.length };

    // No display has the game focused. Fall back to the activity manager, which
    // knows what is actually resumed regardless of how many displays exist.
    const resumed = await shell('dumpsys activity activities | grep -m1 ResumedActivity');
    const resumedText = resumed.stdout.toString('utf8');
    return {
        ok: res.ok,
        focus: lines.join(' | ') || 'none',
        isGame: resumedText.includes(PACKAGE),
        viaResumedActivity: resumedText.includes(PACKAGE),
        displays: lines.length
    };
}

async function faceNorth() {
    const res = await shell(`input tap ${COMPASS.x} ${COMPASS.y}`);
    return { ok: res.ok, did: `tap compass at ${COMPASS.x},${COMPASS.y}`, error: res.error };
}

/**
 * Pitch the camera fully up.
 *
 * Sent as one shell command rather than 30 round trips: 30 separate adb calls
 * take several seconds, and each is a window for something else to happen.
 */
async function maxPitch(presses = PITCH_PRESSES) {
    const keys = Array.from({ length: presses }, () => 'input keyevent 19').join('; ');
    const res = await shell(keys, 30000);
    return { ok: res.ok, did: `DPAD_UP x${presses}`, error: res.error };
}

/**
 * Zoom fully out, the same way a hand does it: a real wheel over the scrcpy
 * window.
 *
 * Every adb route fails on this client - sendevent pinch is blocked by SELinux,
 * `input mouse scroll` exits 0 but the client ignores it, KEYCODE_ZOOM_OUT does
 * nothing. The client appears to filter on the event's source device, and
 * injected events have no backing InputDevice.
 *
 * But the harness already clicks through nut-js into the scrcpy window, and
 * scrcpy forwards a genuine wheel event. So the path that works for the user's
 * hand works here too - it just is not adb.
 *
 * @param {{x:number,y:number}} anchor  PC-screen point inside the scrcpy window
 * @param {number} ticks                wheel notches; more than the range is fine
 */
async function zoomOut(anchor, ticks = 25) {
    let nut;
    try {
        nut = require('@nut-tree-fork/nut-js');
    } catch (err) {
        return { ok: false, error: 'nut-js unavailable - cannot send a wheel event' };
    }

    const { mouse, Point } = nut;
    const width = await nut.screen.width();
    const height = await nut.screen.height();
    const at = anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
        ? anchor
        : { x: Math.round(width / 2), y: Math.round(height / 2) };

    if (at.x < 0 || at.y < 0 || at.x > width - 1 || at.y > height - 1) {
        return { ok: false, error: `zoom anchor ${at.x},${at.y} is off the ${width}x${height} screen` };
    }

    mouse.config.mouseSpeed = 2000;
    await mouse.setPosition(new Point(Math.round(at.x), Math.round(at.y)));
    // One call with a large amount can be swallowed; separate notches read like
    // a hand turning the wheel and are what the client actually responds to.
    for (let i = 0; i < ticks; i += 1) {
        await mouse.scrollDown(1);
        await sleep(25);
    }

    return { ok: true, at, ticks, via: 'nut-js wheel over scrcpy' };
}

/**
 * A PC-screen point that is inside the scrcpy window.
 *
 * The per-spot target rules are normalized positions of platforms the user
 * clicked, so they are provably inside the game view - their centroid is a safe
 * place to park the cursor. Falls back to screen centre if the config cannot be
 * read.
 */
async function zoomAnchor() {
    try {
        const yaml = require(path.join(__dirname, '..', 'node_modules', 'yaml'));
        void yaml;
    } catch (err) { /* no yaml dependency - parse the few lines we need instead */ }

    try {
        const nut = require('@nut-tree-fork/nut-js');
        const width = await nut.screen.width();
        const height = await nut.screen.height();
        const text = fs.readFileSync(
            path.join(__dirname, '..', 'server', 'config.yaml'), 'utf8');
        const points = [...text.matchAll(/point:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g)]
            .map((m) => [Number(m[1]), Number(m[2])])
            .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
        if (!points.length) return null;
        const avg = points.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0])
            .map((v) => v / points.length);
        return { x: Math.round(avg[0] * width), y: Math.round(avg[1] * height),
            from: `${points.length} target points` };
    } catch (err) {
        return null;
    }
}

async function apply({ check = false } = {}) {
    const steps = [];
    const record = (name, result) => {
        steps.push(Object.assign({ step: name }, result));
        return result;
    };

    record('wake', await wakeAndUnlock());
    const focus = record('foreground', await isGameForeground());
    if (!focus.isGame) {
        return { ok: false, steps,
            reason: `the game is not in the foreground (focus: ${focus.focus || 'unknown'})` };
    }
    if (check) return { ok: true, steps, checkedOnly: true };

    // Zoom first: it moves the mouse, and doing it after the compass tap would
    // leave the cursor parked over the game where a stray click could land.
    const anchor = await zoomAnchor();
    const zoom = record('zoom', await zoomOut(anchor));
    await sleep(KEY_DELAY_MS * 4);
    record('north', await faceNorth());
    await sleep(KEY_DELAY_MS * 4);
    record('pitch', await maxPitch());

    return {
        ok: true,
        steps,
        zoomSet: Boolean(zoom.ok),
        warning: zoom.ok ? null : `zoom not set: ${zoom.error}`
    };
}

async function main() {
    const check = process.argv.includes('--check');
    const result = await apply({ check });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
    main().catch((err) => {
        console.log(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2));
        process.exit(1);
    });
}

module.exports = { apply, wakeAndUnlock, faceNorth, maxPitch, zoomOut, zoomAnchor,
    isGameForeground, SCREEN, COMPASS };
