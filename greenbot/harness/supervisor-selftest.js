'use strict';

const { EventEmitter } = require('events');
const { Supervisor } = require('./supervisor.js');

const results = [];

async function check(name, fn) {
    try {
        const note = await fn();
        results.push({ name, ok: true });
        console.log(`PASS  ${name}${note ? `  ${note}` : ''}`);
    } catch (err) {
        results.push({ name, ok: false });
        console.log(`FAIL  ${name}  ${err.message}`);
    }
}

function assert(cond, message) {
    if (!cond) throw new Error(message);
}

/** A fake child process that emits scripted output then closes. */
function fakeChild(lines, code, { hang = false } = {}) {
    const child = new EventEmitter();
    child.pid = 4242;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    setImmediate(() => {
        for (const line of lines) child.stdout.emit('data', `${line}\n`);
        if (!hang) child.emit('close', code);
    });
    return child;
}

function fakeSpawn(script = {}) {
    const calls = [];
    const impl = (cmd, args) => {
        calls.push({ cmd, args: (args || []).join(' ') });
        if (String(cmd).includes('taskkill')) return fakeChild([], 0);
        return script.child ? script.child() : fakeChild(['done'], 0);
    };
    impl.calls = calls;
    return impl;
}

/** /analyze/screen responses, taken from a queue. */
function fakeFetch(queue) {
    let i = 0;
    return async () => {
        const payload = queue[Math.min(i, queue.length - 1)];
        i += 1;
        if (payload === null) throw new Error('ECONNREFUSED');
        return { ok: true, json: async () => payload };
    };
}

function screen(id, confidence) {
    return { location: { id, confidence, top3: [] }, target: null, clickables: [],
        image: { width: 2560, height: 1600 }, capture: {}, timing_ms: {} };
}

/**
 * Progress has to happen AFTER the resume snapshot, so it is driven by reads of
 * the state rather than set by the test beforehand - otherwise the snapshot
 * captures the "progress" and every health check trivially fails.
 *   healthy        clicks rise and the location moves
 *   no-clicks      resumed but nothing happens
 *   stuck-location clicking, but pinned to one obstacle
 */
function makeSup(overrides = {}, progress = 'healthy') {
    const events = [];
    const harness = { running: false, clicks: 0, location: 'spot_01', starts: 0, stops: [] };
    let reads = 0;

    const readState = () => {
        if (harness.running) {
            reads += 1;
            if (progress === 'healthy') {
                harness.clicks += 2;
                harness.location = `spot_0${(reads % 5) + 1}`;
            } else if (progress === 'stuck-location') {
                harness.clicks += 2;
            }
        }
        return { running: harness.running, clicks: harness.clicks, location: harness.location };
    };

    const sup = new Supervisor(Object.assign({
        config: {
            enabled: true, maxCyclesPerHour: 3, globalMaxCycles: 10,
            claudeTimeoutMs: 200, verifyPlayableMs: 300, verifyHealthyMs: 10,
            minConfidence: 0.7, consecutivePolls: 3, pollMs: 1
        },
        claudeCmd: __filename,          // exists, so the "missing" path is not taken
        spawnImpl: fakeSpawn(),
        fetchImpl: fakeFetch([screen('spot_02', 0.99)]),
        onEvent: (e) => events.push(e),
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
        startHarness: () => { harness.running = true; harness.starts += 1; return true; },
        stopHarness: (r) => { harness.running = false; harness.stops.push(r); },
        getHarnessState: readState
    }, overrides));
    sup.events = events;
    sup.harness = harness;
    sup.of = (type) => events.filter((e) => e.type === type);
    return sup;
}

(async () => {
    console.log('supervisor selftest - fake spawn, fake fetch, no CLI, no service\n');

    await check('normal finishes are not repaired', async () => {
        const sup = makeSup();
        for (const reason of ['watchdog: run click cap reached (2000)',
            'watchdog: run time cap reached (180 min)']) {
            const r = await sup.onHarnessStopped(reason);
            assert(r.ok === false, `"${reason}" started a cycle`);
            assert(/not a repairable/.test(r.reason), `reason was: ${r.reason}`);
        }
        assert(sup.of('auto:cycle-start').length === 0, 'a cycle started anyway');
        return 'click cap and time cap both ignored';
    });

    await check('user stops are not repaired', async () => {
        const sup = makeSup();
        for (const reason of ['stopped by request', 'F10 kill switch',
            'repair gave up: unknown screen']) {
            const r = await sup.onHarnessStopped(reason);
            assert(r.ok === false, `"${reason}" started a cycle`);
        }
        assert(sup.of('auto:cycle-start').length === 0, 'a cycle started anyway');
    });

    await check('a stalled-location watchdog does start a cycle', async () => {
        const sup = makeSup({}, 'healthy');
        const r = await sup.onHarnessStopped('watchdog: location "spot_03" unchanged for 300s');
        assert(r.ok === true, `cycle failed: ${r.reason}`);
        assert(sup.of('auto:cycle-start').length === 1, 'no cycle-start event');
        return 'cycle ran to completion';
    });

    await check('happy path event order', async () => {
        const sup = makeSup({}, 'healthy');
        await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        const order = sup.events.map((e) => e.type).filter((t) => t !== 'auto:claude-output');
        const want = ['auto:cycle-start', 'auto:claude-start', 'auto:claude-done',
            'auto:verify', 'auto:resumed', 'auto:verify'];
        assert(JSON.stringify(order) === JSON.stringify(want),
            `order was ${order.join(' > ')}`);
        return order.join(' > ');
    });

    await check('claude exiting non-zero blocks the resume', async () => {
        const sup = makeSup({ spawnImpl: fakeSpawn({ child: () => fakeChild(['boom'], 1) }) });
        const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(r.ok === false && /exited with code 1/.test(r.reason), `reason: ${r.reason}`);
        assert(sup.harness.starts === 0, 'the harness was restarted anyway');
    });

    await check('claude timing out is killed and blocks the resume', async () => {
        const spawnImpl = fakeSpawn({ child: () => fakeChild(['working'], 0, { hang: true }) });
        const sup = makeSup({ spawnImpl });
        const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(r.ok === false && /timed out/.test(r.reason), `reason: ${r.reason}`);
        assert(sup.harness.starts === 0, 'the harness was restarted anyway');
        const killed = spawnImpl.calls.some((c) => String(c.cmd).includes('taskkill'));
        assert(killed, 'no tree-kill was issued');
        return 'killed via taskkill, no resume';
    });

    await check('unauthenticated CLI disables the loop permanently', async () => {
        const sup = makeSup({ spawnImpl: fakeSpawn({
            child: () => fakeChild(['Not logged in \u00b7 Please run /login'], 1) }) });
        const first = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(first.ok === false, 'should not succeed');
        assert(sup.of('auto:disabled').length === 1, 'no auto:disabled event');
        const second = await sup.onHarnessStopped('watchdog: location "spot_02" unchanged for 300s');
        assert(/disabled/.test(second.reason), `second attempt: ${second.reason}`);
        assert(sup.of('auto:cycle-start').length === 1, 'a second cycle was started');
        return 'one cycle, then permanently disabled';
    });

    await check('missing CLI disables without spawning', async () => {
        const spawnImpl = fakeSpawn();
        const sup = makeSup({ claudeCmd: 'C:/definitely/not/here/claude.cmd', spawnImpl });
        const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(r.ok === false && /not found/.test(r.reason), `reason: ${r.reason}`);
        assert(spawnImpl.calls.length === 0, `spawned anyway: ${spawnImpl.calls.length}`);
    });

    await check('playable needs CONSECUTIVE good polls', async () => {
        // good, bad, good, bad... never three in a row.
        const sup = makeSup({ fetchImpl: fakeFetch([
            screen('spot_01', 0.99), screen('login', 0.20),
            screen('spot_01', 0.99), screen('login', 0.20),
            screen('spot_01', 0.99), screen('login', 0.20)
        ]) });
        const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(r.ok === false && /not playable/.test(r.reason), `reason: ${r.reason}`);
        assert(sup.harness.starts === 0, 'resumed on a flapping signal');
        return 'a single good poll amid noise did not count';
    });

    await check('low confidence is not playable', async () => {
        const sup = makeSup({ fetchImpl: fakeFetch([screen('spot_01', 0.30)]) });
        const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(r.ok === false, 'should not have resumed');
        assert(sup.harness.starts === 0, 'the harness was restarted anyway');
    });

    await check('service unreachable is not playable', async () => {
        const sup = makeSup({ fetchImpl: fakeFetch([null]) });
        const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(r.ok === false, 'should not have resumed');
        assert(sup.harness.starts === 0, 'the harness was restarted anyway');
    });

    await check('resumed but no clicks is unhealthy', async () => {
        const sup = makeSup({}, 'no-clicks');
        const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(r.ok === false && /not progressing/.test(r.reason), `reason: ${r.reason}`);
        assert(sup.harness.stops.length === 1, 'the stalled harness was left running');
        return r.reason;
    });

    await check('clicking but stuck on one location is unhealthy', async () => {
        const sup = makeSup({}, 'stuck-location');
        const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(r.ok === false && /still at spot_01/.test(r.reason), `reason: ${r.reason}`);
        assert(sup.harness.stops.length === 1, 'the stuck harness was left running');
        return r.reason;
    });

    await check('maxCyclesPerHour is a rolling window', async () => {
        let clock = 5000000;
        const sup = makeSup({ now: () => clock,
            config: { enabled: true, maxCyclesPerHour: 2, globalMaxCycles: 99,
                claudeTimeoutMs: 200, verifyPlayableMs: 300, verifyHealthyMs: 5,
                minConfidence: 0.7, consecutivePolls: 1, pollMs: 1 } });
        for (let i = 0; i < 2; i += 1) {
            await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
            clock += 60000;
        }
        const blocked = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(/last hour/.test(blocked.reason || ''), `3rd should be blocked: ${blocked.reason}`);

        clock += HOUR();
        const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(r.ok === true, `after the window it should run: ${r.reason}`);
        return 'blocked inside the window, allowed after it';
        function HOUR() { return 3600000; }
    });

    await check('globalMaxCycles never expires', async () => {
        let clock = 5000000;
        const sup = makeSup({ now: () => clock,
            config: { enabled: true, maxCyclesPerHour: 99, globalMaxCycles: 1,
                claudeTimeoutMs: 200, verifyPlayableMs: 300, verifyHealthyMs: 5,
                minConfidence: 0.7, consecutivePolls: 1, pollMs: 1 } });
        await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');

        clock += 7200000;   // two hours later
        const blocked = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(/lifetime/.test(blocked.reason || ''), `should be capped: ${blocked.reason}`);
        sup.resetStats();
        const after = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(after.ok === true, `resetStats should clear it: ${after.reason}`);
        return 'permanent until resetStats';
    });

    await check('abort mid-cycle kills the child and blocks the resume', async () => {
        const spawnImpl = fakeSpawn({ child: () => fakeChild(['working'], 0, { hang: true }) });
        const sup = makeSup({ spawnImpl, config: { enabled: true, maxCyclesPerHour: 3,
            globalMaxCycles: 10, claudeTimeoutMs: 5000, verifyPlayableMs: 300,
            verifyHealthyMs: 10, minConfidence: 0.7, consecutivePolls: 1, pollMs: 1 } });
        const running = sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        setTimeout(() => sup.abort('user pressed stop'), 20);
        const r = await running;
        assert(r.ok === false, 'should not have succeeded');
        assert(sup.harness.starts === 0, 'resumed despite the abort');
        assert(spawnImpl.calls.some((c) => String(c.cmd).includes('taskkill')),
            'the child was not killed');
        return 'child killed, no resume';
    });

    await check('a second cycle cannot run concurrently', async () => {
        const sup = makeSup({ spawnImpl: fakeSpawn({
            child: () => fakeChild(['slow'], 0, { hang: true }) }),
            config: { enabled: true, maxCyclesPerHour: 9, globalMaxCycles: 9,
                claudeTimeoutMs: 120, verifyPlayableMs: 100, verifyHealthyMs: 5,
                minConfidence: 0.7, consecutivePolls: 1, pollMs: 1 } });
        const first = sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        const second = await sup.onHarnessStopped('watchdog: location "spot_02" unchanged for 300s');
        assert(/already running/.test(second.reason || ''), `second: ${second.reason}`);
        await first;
    });

    await check('disabled config never starts a cycle', async () => {
        const sup = makeSup({ config: { enabled: false } });
        const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(r.ok === false && /off/.test(r.reason), `reason: ${r.reason}`);
        assert(sup.of('auto:cycle-start').length === 0, 'a cycle started while disabled');
    });

    await check('the harness is never started without a passed verification', async () => {
        const src = require('fs').readFileSync(require.resolve('./supervisor.js'), 'utf8');
        const idx = src.indexOf('this._startHarness()');
        assert(idx > 0, 'startHarness call not found');
        const before = src.slice(0, idx);
        const lastVerify = before.lastIndexOf('_verifyPlayable');
        const lastGuard = before.lastIndexOf('if (!playable.ok) return');
        assert(lastVerify > 0 && lastGuard > lastVerify,
            'startHarness is not guarded by a playable check');
        return 'guarded';
    });

    await check('globalMaxCycles 0 means unlimited', async () => {
        let clock = 9000000;
        const sup = makeSup({ now: () => clock,
            config: { enabled: true, maxCyclesPerHour: 99, globalMaxCycles: 0,
                claudeTimeoutMs: 200, verifyPlayableMs: 300, verifyHealthyMs: 5,
                minConfidence: 0.7, consecutivePolls: 1, pollMs: 1 } }, 'healthy');
        for (let i = 0; i < 25; i += 1) {
            const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
            assert(r.ok === true, `cycle ${i + 1} refused: ${r.reason}`);
            clock += 1000;
        }
        return '25 cycles, no lifetime cap';
    });

    await check('rate limit schedules a retry instead of stalling', async () => {
        let clock = 9000000;
        const sup = makeSup({ now: () => clock,
            config: { enabled: true, maxCyclesPerHour: 1, globalMaxCycles: 0,
                claudeTimeoutMs: 200, verifyPlayableMs: 300, verifyHealthyMs: 5,
                minConfidence: 0.7, consecutivePolls: 1, pollMs: 1 } }, 'healthy');
        await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        const blocked = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(/retrying in/.test(blocked.reason || ''), `reason: ${blocked.reason}`);
        // A pending timer is what makes the loop continuous rather than a dead end.
        assert(sup._retryTimer, 'no retry was scheduled - the loop would stall here');
        sup.abort('test cleanup');
        assert(!sup._retryTimer, 'abort left the retry armed');
        return blocked.reason;
    });

    await check('a skill-restarted clicker is not restarted again', async () => {
        const sup = makeSup({}, 'healthy');
        // Simulate the repair skill having already started it via control.js.
        sup.harness.running = true;
        const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(r.ok === true, `cycle failed: ${r.reason}`);
        assert(sup.harness.starts === 0, 'the supervisor restarted an already-running harness');
        const verify = sup.of('auto:verify').find((e) => e.stage === 'playable');
        assert(/already restarted/.test(verify.detail || ''), `detail: ${verify.detail}`);
        return verify.detail;
    });

    await check('a skill-restarted but stalled clicker still fails health', async () => {
        const sup = makeSup({}, 'no-clicks');
        sup.harness.running = true;
        const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(r.ok === false && /not progressing/.test(r.reason), `reason: ${r.reason}`);
        return 'health check still applies to a skill restart';
    });

    await check('a spawn failure is reported as a launch error, not an exit code', async () => {
        // Node refuses to spawn a .cmd with shell:false, which surfaced as the
        // useless "claude exited null". A launch failure and a non-zero exit are
        // different problems and must read differently.
        const spawnImpl = fakeSpawn({ child: () => {
            const child = fakeChild([], 0, { hang: true });
            setImmediate(() => child.emit('error', Object.assign(
                new Error('spawn EINVAL'), { code: 'EINVAL' })));
            return child;
        } });
        const sup = makeSup({ spawnImpl });
        const r = await sup.onHarnessStopped('watchdog: location "spot_01" unchanged for 300s');
        assert(r.ok === false, 'should have failed');
        assert(/could not launch/.test(r.reason), `reason was "${r.reason}"`);
        assert(!/exited null/.test(r.reason), 'still reporting a null exit code');
        assert(sup.harness.starts === 0, 'the harness was restarted anyway');
        return r.reason;
    });

    await check('a planned idle break is repaired, a finished cap is not', async () => {
        const sup = new Supervisor({});
        const cases = [
            ['idle break over after 8 min - the game logged out, log back in and resume', true],
            ['watchdog: location "spot_03" unchanged for 300s', true],
            ['watchdog: run time cap reached (180 min)', false],
            ['stopped by request', false]
        ];
        for (const [reason, want] of cases) {
            assert(sup.repairable(reason) === want,
                `repairable("${reason}") should be ${want}`);
        }
        // A break is not a fault, and a prompt that sends Claude hunting for one
        // wastes a cycle on a game that only needs logging in.
        const planned = sup._prompt(cases[0][0]);
        assert(/PLANNED/.test(planned), 'the break prompt does not say it was planned');
        assert(!/PLANNED/.test(sup._prompt(cases[1][0])),
            'a watchdog stop was described as planned');
        return 'break -> repair, cap -> finished';
    });

    await check('the resolved claude binary is directly spawnable', async () => {
        const { CLAUDE_CMD } = require('./supervisor.js');
        const fs = require('fs');
        if (!fs.existsSync(CLAUDE_CMD)) {
            return `not installed (${require('path').basename(CLAUDE_CMD)}) - skipped`;
        }
        // shell:false is what the supervisor uses; a .cmd would throw here.
        const { spawnSync } = require('child_process');
        const res = spawnSync(CLAUDE_CMD, ['--version'], { encoding: 'utf8', shell: false });
        assert(!res.error, `spawn failed: ${res.error && res.error.code}`);
        assert(res.status === 0, `--version exited ${res.status}`);
        return `${require('path').basename(CLAUDE_CMD)} -> ${(res.stdout || '').trim()}`;
    });

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) console.log(`failed: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(failed.length ? 1 : 0);
})();
