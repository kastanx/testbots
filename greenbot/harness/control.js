'use strict';

// Control the running clicker from outside the Electron panel.
//
// The repair skill runs as a separate process, so it needs a way to restart the
// clicker and then watch it long enough to know the restart actually took. That
// is what wait-healthy is for: "running" is not the same as "working".
//
//   node greenbot/harness/control.js status
//   node greenbot/harness/control.js start
//   node greenbot/harness/control.js stop
//   node greenbot/harness/control.js wait-healthy --timeout 180
//
// Communication is two files the panel owns: it writes status.json continuously
// and polls control.json for commands. No ports, no IPC to attach to, and it
// works whether the panel was started before or after this process.

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const STATUS_PATH = path.join(HERE, 'status.json');
const CONTROL_PATH = path.join(HERE, 'control.json');

// The panel refreshes status.json on a timer; older than this means it is not
// running, and a stale file must never be mistaken for a live harness.
const STALE_MS = 15000;

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
        return null;
    }
}

function readStatus() {
    const status = readJson(STATUS_PATH);
    if (!status) {
        return { ok: false, error: `no ${path.basename(STATUS_PATH)} - is the monitor panel running?` };
    }
    const age = Date.now() - Number(status.at || 0);
    if (age > STALE_MS) {
        return Object.assign({ ok: false, stale: true, ageMs: age,
            error: `status is ${Math.round(age / 1000)}s stale - the panel is probably closed` }, status);
    }
    return Object.assign({ ok: true, stale: false, ageMs: age }, status);
}

function sendCommand(action, extra = {}) {
    const command = Object.assign({ action, at: Date.now(), by: 'control.js' }, extra);
    fs.writeFileSync(CONTROL_PATH, `${JSON.stringify(command, null, 2)}\n`);
    return command;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the clicker is demonstrably working, not merely started.
 *
 * Requires BOTH more clicks and a changed location versus the moment the wait
 * began. A harness sitting on one obstacle clicking nothing would otherwise
 * look healthy right up until its own watchdog fires.
 */
async function waitHealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const first = readStatus();
    if (!first.ok) return { ok: false, reason: first.error };

    const baseClicks = Number(first.clicks) || 0;
    let baseLocation = first.location || null;
    let last = first;

    // A null baseline can never differ from a later value, so "location changed"
    // would be unreachable and this would always time out. Wait for a real one.
    if (!baseLocation) {
        const settle = Date.now() + Math.min(20000, timeoutMs / 2);
        while (Date.now() < settle && !baseLocation) {
            await sleep(1500);
            const now = readStatus();
            if (now.ok && now.location) baseLocation = now.location;
        }
    }

    while (Date.now() < deadline) {
        await sleep(3000);
        const now = readStatus();
        if (!now.ok) return { ok: false, reason: now.error };
        last = now;

        if (!now.running) {
            return { ok: false, reason: `the harness stopped: ${now.stopReason || 'unknown reason'}` };
        }
        const clicks = Number(now.clicks) || 0;
        const movedOn = now.location && baseLocation && now.location !== baseLocation;
        if (clicks > baseClicks && movedOn) {
            // In dry run nothing reaches the tablet, so the location only moves
            // because the player moved it - or did not, and the classifier
            // drifted. Either way this is NOT evidence the clicker works, and
            // reporting a bare ok would be a false pass.
            if (now.dryRun) {
                return { ok: false, dryRun: true,
                    reason: `the clicker is in DRY RUN - it decided ${clicks - baseClicks} `
                        + 'click(s) but sent none to the tablet, so this proves nothing. '
                        + 'Arm LIVE in the panel to test for real.' };
            }
            return { ok: true,
                reason: `${clicks - baseClicks} clicks, ${baseLocation} -> ${now.location}` };
        }
    }

    const clicks = Number(last.clicks) || 0;
    if (clicks <= baseClicks) {
        return { ok: false, reason: `no clicks in ${Math.round(timeoutMs / 1000)}s (still ${clicks})` };
    }
    return { ok: false, reason: `clicking but still at ${last.location || 'an unknown location'}` };
}

async function main() {
    const [action, ...rest] = process.argv.slice(2);
    const flag = (name, fallback) => {
        const i = rest.indexOf(`--${name}`);
        return i === -1 ? fallback : rest[i + 1];
    };

    if (!action || action === 'status') {
        const status = readStatus();
        console.log(JSON.stringify(status, null, 2));
        process.exit(status.ok ? 0 : 1);
    }

    if (action === 'start' || action === 'stop') {
        const before = readStatus();
        if (!before.ok && !before.stale) {
            console.log(JSON.stringify({ ok: false, error: before.error }, null, 2));
            process.exit(1);
        }
        sendCommand(action);
        // The panel polls; wait for it to actually take effect rather than
        // reporting success the instant the file is written.
        const want = action === 'start';
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            await sleep(1000);
            const now = readStatus();
            if (now.ok && Boolean(now.running) === want) {
                console.log(JSON.stringify({ ok: true, action, running: now.running,
                    dryRun: now.dryRun }, null, 2));
                process.exit(0);
            }
        }
        console.log(JSON.stringify({ ok: false, action,
            error: 'the panel did not act on the command within 20s' }, null, 2));
        process.exit(1);
    }

    if (action === 'wait-healthy') {
        const timeoutMs = Math.max(10, Number(flag('timeout', 180))) * 1000;
        const result = await waitHealthy(timeoutMs);
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.ok ? 0 : 1);
    }

    console.log('usage: control.js status | start | stop | wait-healthy [--timeout SECONDS]');
    process.exit(2);
}

if (require.main === module) {
    main().catch((err) => {
        console.log(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2));
        process.exit(1);
    });
}

module.exports = { readStatus, sendCommand, waitHealthy, STATUS_PATH, CONTROL_PATH };
