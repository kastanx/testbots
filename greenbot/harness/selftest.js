'use strict';

/*
 * Headless harness tests: fake clicker, fake fetch, no server, no real clicks.
 * Run from REPO with:  node greenbot/harness/selftest.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { DailyPlan, memoryStore } = require('./daily.js');
const { SeededRNG, SessionProfile, FatigueEnvelope, HesitationMachine, PauseScheduler } =
    require('../../humanizer.js');
const { Harness, humanizeDelay } = require('./engine.js');
const { pointInBox } = require('./clicker.js');
const { defaultRoute, validateRoute, loadRoute, saveRoute, DEFAULTS } = require('./route.js');

const results = [];

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function check(name, fn) {
    let detail = '';
    try {
        detail = (await fn()) || '';
        results.push({ name, ok: true });
        console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
    } catch (err) {
        results.push({ name, ok: false });
        console.log(`FAIL  ${name}  ${err.message}`);
    }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fakes ──────────────────────────────────────────────────

function box(x, y, w, h) {
    return {
        x, y, w, h,
        cx: Math.round(x + w / 2),
        cy: Math.round(y + h / 2),
        class: 'clickable',
        confidence: 0.88
    };
}

function frame(id, options = {}) {
    const {
        confidence = 0.94, target = null, clickables = null,
        width = 1920, height = 1080
    } = options;
    return {
        location: { id, confidence, top3: [{ id, confidence }] },
        target,
        clickables: clickables || (target ? [target] : []),
        image: { width, height },
        capture: { monitor: 0, detect_width: 1280, scale: 0.6667 },
        timing_ms: { capture: 9, classify: 4, detect: 3, total: 16 }
    };
}

function fakeClicker(onClick) {
    const clicks = [];
    return {
        dryRun: true,
        clicks,
        async click(x, y) {
            clicks.push({ x, y, at: Date.now() });
            if (onClick) onClick(clicks);
        }
    };
}

function fakeFetch(supply) {
    return async () => {
        const payload = supply();
        return { ok: true, status: 200, json: async () => payload };
    };
}

function throwingFetch(message) {
    return async () => { throw new Error(message); };
}

/** Builds a harness whose events are recorded and whose run is awaitable. */
function makeHarness(options) {
    const events = [];
    const listener = options.onEvent;
    let finish = null;
    // Declared with a value first: route validation emits warnings from inside
    // the constructor, so the listener runs before the assignment lands.
    let harness = null;

    harness = new Harness(Object.assign({
        // Never the real harness/daily.json: a selftest must not roll - or
        // consume - the day's actual meal plan.
        dailyPlan: new DailyPlan({ store: memoryStore() })
    }, options, {
        url: 'http://127.0.0.1:0',
        onEvent: (event) => {
            events.push(event);
            if (listener && harness) listener(event, harness);
            if (event.type === 'stopped' && finish) finish();
        }
    }));

    harness.events = events;
    harness.of = (type) => events.filter((e) => e.type === type);
    harness.run = (timeoutMs) => new Promise((resolve) => {
        const guard = setTimeout(() => harness.stop('selftest budget reached'), timeoutMs);
        finish = () => { clearTimeout(guard); resolve(); };
        harness.start();
    });
    return harness;
}

function fastRoute(overrides = {}) {
    const route = defaultRoute();
    route.pollHz = 10;
    route.humanize = false;
    route.minClickIntervalMs = 250;
    route.watchdog = { sameLocationMs: 120000, maxClicksWithoutLocationChange: 100 };
    // Wall-clock breaks are on by default. A test that happens to run at 12:31
    // must not go to lunch, so every fixture route turns them off and the ones
    // that care about them switch them back on deliberately.
    route.daily = { lunch: { enabled: false }, dinner: { enabled: false },
        sleep: { enabled: false } };
    for (const id of Object.keys(route.locations)) route.locations[id].delayMs = 250;
    return Object.assign(route, overrides);
}

function stdev(values) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    return { mean, sd: Math.sqrt(variance) };
}

// ── tests ──────────────────────────────────────────────────

async function testSequence() {
    const order = ['spot_01', 'spot_02', 'spot_03', 'spot_04', 'spot_05', 'spot_06'];
    const clicker = fakeClicker();
    const harness = makeHarness({
        route: fastRoute(),
        clicker,
        humanizer: false,
        fetchImpl: fakeFetch(() => {
            const id = order[Math.min(clicker.clicks.length, order.length - 1)];
            return frame(id, { target: box(400, 300, 220, 140) });
        }),
        onEvent: (event, h) => {
            if (event.type === 'click' && clicker.clicks.length >= order.length) {
                h.stop('sequence complete');
            }
        }
    });

    await harness.run(8000);
    const clicked = harness.of('click').map((e) => e.location);
    assert(clicked.length === order.length, `expected ${order.length} clicks, got ${clicked.length}`);
    assert(clicked.join(',') === order.join(','), `click order was ${clicked.join(',')}`);
    assert(harness.of('click').every((e) => e.mode === 'target'), 'a click was not in target mode');
    return `${clicked.length} clicks, in order`;
}

async function testNoClickCases() {
    const cases = [
        {
            what: 'target is null',
            route: fastRoute(),
            fetchImpl: fakeFetch(() => frame('spot_01')),
            warn: null
        },
        {
            what: 'location has no route entry',
            route: fastRoute(),
            fetchImpl: fakeFetch(() => frame('spot_99', { target: box(10, 10, 90, 90) })),
            warn: /no route entry/
        },
        {
            what: 'location is disabled',
            route: fastRoute(),
            disable: 'spot_01',
            fetchImpl: fakeFetch(() => frame('spot_01', { target: box(10, 10, 90, 90) })),
            warn: /disabled/
        },
        {
            what: 'fetch throws',
            route: fastRoute(),
            fetchImpl: throwingFetch('ECONNREFUSED 127.0.0.1:8765'),
            warn: /service unreachable/
        },
        {
            what: 'fixed mode with no point',
            route: fastRoute(),
            fetchImpl: fakeFetch(() => frame('transit', { target: box(10, 10, 90, 90) })),
            warn: /no point set/
        }
    ];

    const notes = [];
    for (const testCase of cases) {
        const route = testCase.route;
        if (testCase.disable) route.locations[testCase.disable].enabled = false;
        const clicker = fakeClicker();
        const harness = makeHarness({ route, clicker, humanizer: false, fetchImpl: testCase.fetchImpl });

        await harness.run(400);
        assert(clicker.clicks.length === 0, `clicked ${clicker.clicks.length}x when ${testCase.what}`);
        if (testCase.warn) {
            const hit = harness.of('warn').some((e) => testCase.warn.test(e.message));
            assert(hit, `no warning matching ${testCase.warn} when ${testCase.what}`);
        }
        notes.push(testCase.what);
    }
    return `no clicks: ${notes.join('; ')}`;
}

async function testMinClickInterval() {
    const floor = 400;
    const clicker = fakeClicker();
    const route = fastRoute({ minClickIntervalMs: floor });
    for (const id of Object.keys(route.locations)) route.locations[id].delayMs = 0;

    const harness = makeHarness({
        route,
        clicker,
        humanizer: false,
        // The location alternates so the watchdog stays out of the way.
        fetchImpl: fakeFetch(() => frame(clicker.clicks.length % 2 ? 'spot_02' : 'spot_01', {
            target: box(500, 500, 200, 200)
        })),
        onEvent: (event, h) => {
            if (event.type === 'click' && clicker.clicks.length >= 4) h.stop('enough clicks');
        }
    });

    await harness.run(8000);
    assert(clicker.clicks.length === 4, `expected 4 clicks, got ${clicker.clicks.length}`);

    const gaps = [];
    for (let i = 1; i < clicker.clicks.length; i++) {
        gaps.push(clicker.clicks[i].at - clicker.clicks[i - 1].at);
    }
    for (const gap of gaps) assert(gap >= floor, `click gap ${gap} ms < floor ${floor} ms`);

    const waits = harness.of('wait');
    assert(waits.every((w) => w.appliedMs >= floor), 'a wait was scheduled below the floor');
    assert(waits.every((w) => w.baseMs === 250), 'delayMs 0 was not clamped to the 250 ms minimum');
    assert(harness.of('warn').some((e) => /delayMs 0 clamped to 250/.test(e.message)),
        'the delayMs clamp was never reported');
    return `gaps ${gaps.join(', ')} ms, floor ${floor} ms`;
}

async function testStopMidWait() {
    const clicker = fakeClicker();
    const route = fastRoute({ minClickIntervalMs: 250 });
    route.locations.spot_01.delayMs = 3000;

    const harness = makeHarness({
        route,
        clicker,
        humanizer: false,
        fetchImpl: fakeFetch(() => frame('spot_01', { target: box(100, 100, 300, 300) })),
        onEvent: (event, h) => {
            // Stop 30 ms into a 3 s wait: the pending timer must never fire.
            if (event.type === 'wait') setTimeout(() => h.stop('stopped mid-wait'), 30);
        }
    });

    await harness.run(4000);
    const atStop = clicker.clicks.length;
    assert(atStop === 1, `expected 1 click before stop, got ${atStop}`);
    assert(!harness.isRunning(), 'still running after stop()');

    await delay(600);
    assert(clicker.clicks.length === atStop, `click count moved after stop: ${clicker.clicks.length}`);

    // Idempotent: a second stop must not emit a second stopped event.
    const before = harness.of('stopped').length;
    harness.stop('again');
    assert(harness.of('stopped').length === before, 'stop() was not idempotent');
    return `frozen at ${atStop} click, ${harness.of('stopped').length} stopped event`;
}

async function testWatchdogStale() {
    const clicker = fakeClicker();
    const harness = makeHarness({
        route: fastRoute({ watchdog: { sameLocationMs: 1200, maxClicksWithoutLocationChange: 50 } }),
        clicker,
        humanizer: false,
        fetchImpl: fakeFetch(() => frame('spot_01'))
    });

    const started = Date.now();
    await harness.run(6000);
    const elapsed = Date.now() - started;
    const stopped = harness.of('stopped')[0];
    assert(stopped, 'never stopped');
    assert(/unchanged for/.test(stopped.reason), `wrong stop reason: ${stopped.reason}`);
    assert(clicker.clicks.length === 0, 'clicked while the target was null');
    return `stopped after ${elapsed} ms - "${stopped.reason}"`;
}

async function testWatchdogClicks(locationId, mode) {
    const clicker = fakeClicker();
    const route = fastRoute({ watchdog: { sameLocationMs: 120000, maxClicksWithoutLocationChange: 3 } });
    if (mode === 'fixed') route.locations[locationId].point = { x: 1097, y: 52 };

    const harness = makeHarness({
        route,
        clicker,
        humanizer: false,
        fetchImpl: fakeFetch(() => frame(locationId, { target: box(700, 400, 180, 120) }))
    });

    await harness.run(8000);
    const stopped = harness.of('stopped')[0];
    assert(stopped, 'never stopped');
    assert(/clicks with no location change/.test(stopped.reason), `wrong stop reason: ${stopped.reason}`);
    assert(clicker.clicks.length === 3, `expected 3 clicks, got ${clicker.clicks.length}`);
    return `${locationId} (${mode}) stopped after 3 clicks - "${stopped.reason}"`;
}

async function testTransitFixed() {
    const point = { x: 1097, y: 52 };
    const clicker = fakeClicker();
    const route = fastRoute({
        humanize: true, // on at the top level: transit must still opt out on its own
        minClickIntervalMs: 250,
        watchdog: { sameLocationMs: 120000, maxClicksWithoutLocationChange: 2 }
    });
    route.locations.transit.point = point;
    route.locations.transit.delayMs = 400;

    const harness = makeHarness({
        route,
        clicker,
        seed: 7,
        // A target is present on purpose - fixed mode must ignore it.
        fetchImpl: fakeFetch(() => frame('transit', { target: box(300, 300, 400, 400) }))
    });

    await harness.run(6000);
    assert(clicker.clicks.length === 2, `expected 2 clicks, got ${clicker.clicks.length}`);
    for (const click of clicker.clicks) {
        assert(click.x === point.x && click.y === point.y,
            `transit clicked ${click.x},${click.y} instead of ${point.x},${point.y}`);
    }
    assert(harness.of('click').every((e) => e.mode === 'fixed' && e.box === null),
        'transit click was not reported as fixed mode');

    const wait = harness.of('wait')[0];
    assert(wait.baseMs === 400 && wait.appliedMs === 400,
        `transit delay was warped: base ${wait.baseMs} -> applied ${wait.appliedMs}`);
    assert(wait.hesitationMs === 0 && wait.pauseMs === 0, 'transit picked up humanisation components');
    return `exact ${point.x},${point.y} x2, raw delay ${wait.appliedMs} ms`;
}

async function testHumanisedTargetClicks() {
    const target = box(600, 400, 200, 160);
    const clicker = fakeClicker();
    const route = fastRoute({
        humanize: true,
        watchdog: { sameLocationMs: 120000, maxClicksWithoutLocationChange: 4 }
    });

    const harness = makeHarness({
        route,
        clicker,
        seed: 4242,
        fetchImpl: fakeFetch(() => frame('spot_01', { target }))
    });

    await harness.run(8000);
    assert(clicker.clicks.length === 4, `expected 4 clicks, got ${clicker.clicks.length}`);
    for (const click of clicker.clicks) {
        assert(click.x > target.x && click.x < target.x + target.w
            && click.y > target.y && click.y < target.y + target.h,
            `click ${click.x},${click.y} landed outside the box`);
    }
    const distinct = new Set(clicker.clicks.map((c) => `${c.x},${c.y}`));
    assert(distinct.size > 1, 'every humanised click landed on the same pixel');
    const waits = harness.of('wait');
    assert(waits.some((w) => w.appliedMs !== w.baseMs), 'no wait was warped with humanisation on');
    return `${distinct.size} distinct points in a ${target.w}x${target.h} box`;
}

function testPointInBoxSpread() {
    const b = box(100, 200, 300, 160);
    const margin = 0.15;
    const rng = new SeededRNG(20260731);
    const xs = [];
    const ys = [];

    for (let i = 0; i < 10000; i++) {
        const p = pointInBox(b, rng, { marginFrac: margin });
        assert(p.x > b.x && p.x < b.x + b.w, `x ${p.x} outside the box`);
        assert(p.y > b.y && p.y < b.y + b.h, `y ${p.y} outside the box`);
        assert(p.x >= b.x + b.w * margin && p.x <= b.x + b.w * (1 - margin), `x ${p.x} inside the margin`);
        assert(p.y >= b.y + b.h * margin && p.y <= b.y + b.h * (1 - margin), `y ${p.y} inside the margin`);
        xs.push(p.x);
        ys.push(p.y);
    }

    const innerW = b.w * (1 - 2 * margin);
    const innerH = b.h * (1 - 2 * margin);
    const sx = stdev(xs);
    const sy = stdev(ys);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);

    assert(sx.sd > innerW * 0.10 && sy.sd > innerH * 0.10, 'distribution is degenerate (too narrow)');
    assert(spanX > innerW * 0.8 && spanY > innerH * 0.8, 'distribution does not cover the inset span');
    assert(Math.abs(sx.mean - (b.x + b.w / 2)) < innerW * 0.03, 'x is not centre-biased');
    assert(Math.abs(sy.mean - (b.y + b.h / 2)) < innerH * 0.03, 'y is not centre-biased');

    return `10000 samples: x mean ${sx.mean.toFixed(1)} sd ${sx.sd.toFixed(1)} span ${spanX.toFixed(1)}/${innerW}, `
        + `y mean ${sy.mean.toFixed(1)} sd ${sy.sd.toFixed(1)} span ${spanY.toFixed(1)}/${innerH}`;
}

function testPointInBoxTiny() {
    const rng = new SeededRNG(99);
    const tiny = box(40, 40, 4, 4);
    const xs = [];
    for (let i = 0; i < 2000; i++) {
        const p = pointInBox(tiny, rng);
        assert(Number.isFinite(p.x) && Number.isFinite(p.y), 'non-finite point from a 4x4 box');
        assert(p.x > 40 && p.x < 44 && p.y > 40 && p.y < 44, `4x4 sample ${p.x},${p.y} outside the box`);
        assert(p.x >= 40.6 && p.x <= 43.4, `4x4 sample ${p.x} inside the margin inset`);
        xs.push(p.x);
    }
    const zero = pointInBox({ x: 5, y: 5, w: 0, h: 0 }, rng);
    assert(Number.isFinite(zero.x) && Number.isFinite(zero.y), 'zero-size box produced NaN');

    const s = stdev(xs);
    assert(s.sd > 0.2, 'a 4x4 box collapsed to a single point');
    return `4x4: x in [${Math.min(...xs).toFixed(2)}, ${Math.max(...xs).toFixed(2)}] sd ${s.sd.toFixed(2)}; `
        + `0x0 -> ${zero.x},${zero.y}`;
}

function testHumanisedDelays() {
    const sample = (seed, n) => {
        const rng = new SeededRNG(seed);
        const profile = new SessionProfile(rng);
        const ctx = {
            rng,
            fatigue: new FatigueEnvelope(profile),
            hesitation: new HesitationMachine(profile, rng),
            pauses: new PauseScheduler(profile, rng),
            sessionMs: 0
        };
        const out = [];
        for (let i = 0; i < n; i++) {
            ctx.sessionMs = i * 12000;
            out.push(humanizeDelay(12334, ctx));
        }
        return out;
    };

    const a = sample(1, 200);
    const b = sample(2, 200);

    const ratios = a.map((d) => d.warpedMs / d.baseMs);
    const s = stdev(ratios);
    assert(new Set(a.map((d) => d.appliedMs)).size > 100, 'delays barely vary run to run');
    assert(a.map((d) => d.appliedMs).join() !== b.map((d) => d.appliedMs).join(),
        'two different seeds produced identical delays');
    assert(Math.min(...ratios) > 0.6 && Math.max(...ratios) < 1.9,
        `warped delay left the sane band: ${Math.min(...ratios)}..${Math.max(...ratios)}`);
    assert(s.sd > 0.02, 'warped delays are effectively constant');

    const hesitated = a.filter((d) => d.hesitationMs > 0).length;
    const paused = a.filter((d) => d.pauseMs > 0).length;
    return `200 samples of 12334 ms: ratio ${Math.min(...ratios).toFixed(3)}..${Math.max(...ratios).toFixed(3)} `
        + `(mean ${s.mean.toFixed(3)} sd ${s.sd.toFixed(3)}), ${hesitated} hesitations, ${paused} pauses`;
}

function testRouteDefaults() {
    const route = defaultRoute();
    const expected = [12334, 6630, 9546, 11610, 6069, 11332];
    expected.forEach((ms, i) => {
        const id = `spot_0${i + 1}`;
        assert(route.locations[id].delayMs === ms, `${id} delay is ${route.locations[id].delayMs}, expected ${ms}`);
        assert(route.locations[id].mode === 'target', `${id} is not target mode`);
    });
    assert(route.locations.transit.delayMs === 7045, 'transit delay is not deltas[7]');
    assert(route.locations.transit.mode === 'fixed' && route.locations.transit.point === null,
        'transit is not fixed/point-null by default');
    assert(route.locations.transit.humanize === false, 'transit is not opted out of humanisation');
    assert(route.watchdog.sameLocationMs === 300000 && route.watchdog.maxClicksWithoutLocationChange === 6,
        'watchdog defaults drifted');
    assert(Object.isFrozen(DEFAULTS) && route !== DEFAULTS, 'defaultRoute() handed out the frozen original');
    route.pollHz = 99;
    assert(DEFAULTS.pollHz === 3, 'mutating a copy changed the exported defaults');
    return 'delays map deltas[1..7] onto spot_01..spot_06, transit';
}

function testRouteValidation() {
    const { route, warnings } = validateRoute({
        pollHz: 999,
        humanize: 'yes',
        minClickIntervalMs: 5,
        nonsense: true,
        watchdog: { sameLocationMs: 10, bogus: 1 },
        locations: {
            spot_01: { mode: 'sideways', delayMs: 5, enabled: 'true', junk: 1 },
            transit: { mode: 'fixed', point: { x: '400', y: 250.6 }, delayMs: 900 }
        }
    });

    assert(route.pollHz === 10, `pollHz not clamped: ${route.pollHz}`);
    assert(route.humanize === true, 'bad humanize did not fall back to the default');
    assert(route.minClickIntervalMs === 250, `minClickIntervalMs not clamped: ${route.minClickIntervalMs}`);
    assert(route.watchdog.sameLocationMs === 1000, 'sameLocationMs not clamped');
    assert(route.locations.spot_01.mode === 'target', 'bad mode did not fall back');
    assert(route.locations.spot_01.delayMs === 250, 'delayMs not clamped to 250');
    assert(route.locations.spot_01.enabled === true, 'bad enabled did not fall back');
    assert(route.locations.transit.point.x === 400 && route.locations.transit.point.y === 251,
        'point was not coerced to integers');
    assert(route.locations.spot_04.delayMs === 11610, 'a missing location was not restored from defaults');
    for (const needle of ['nonsense', 'watchdog.bogus', 'locations.spot_01.junk']) {
        assert(warnings.some((w) => w.includes(needle)), `no warning for unknown key ${needle}`);
    }
    assert(validateRoute(null).route.pollHz === 3, 'null route did not fall back to defaults');
    return `${warnings.length} warnings, all bad values clamped or defaulted`;
}

function testRouteFile() {
    const file = path.join(os.tmpdir(), `greenbot-route-selftest-${process.pid}.json`);
    try {
        fs.rmSync(file, { force: true });
        const created = loadRoute(file);
        assert(created.created === true && fs.existsSync(file), 'route.json was not created when absent');
        assert(created.route.locations.spot_02.delayMs === 6630, 'created file does not carry the defaults');

        created.route.locations.spot_02.delayMs = 3000;
        saveRoute(created.route, file);
        const reloaded = loadRoute(file);
        assert(reloaded.created === false, 'existing file was recreated');
        assert(reloaded.route.locations.spot_02.delayMs === 3000, 'edit did not survive the round trip');

        fs.writeFileSync(file, '{ this is not json', 'utf8');
        const broken = loadRoute(file);
        assert(broken.route.locations.spot_02.delayMs === 6630, 'broken JSON did not fall back to defaults');
        assert(broken.warnings.length > 0, 'broken JSON produced no warning');
        return 'create, save, reload, and survive a corrupt file';
    } finally {
        fs.rmSync(file, { force: true });
    }
}

// ── runner ─────────────────────────────────────────────────

(async function main() {
    console.log('greenbot harness selftest - fake clicker, fake fetch, no server\n');

    await check('route defaults match the recorded timings', testRouteDefaults);
    await check('route validation clamps and warns', testRouteValidation);
    await check('route.json create / save / reload / recover', testRouteFile);
    await check('pointInBox: 10000 samples inside box and inset', testPointInBoxSpread);
    await check('pointInBox: 4x4 and 0x0 boxes stay valid', testPointInBoxTiny);
    await check('humanised delays vary but stay in band', testHumanisedDelays);
    await check('one click per location, in order', testSequence);
    await check('never clicks when it must not', testNoClickCases);
    await check('minClickIntervalMs is a hard floor', testMinClickInterval);
    await check('stop() mid-wait fires no further clicks', testStopMidWait);
    await check('watchdog: location unchanged', testWatchdogStale);
    await check('watchdog: clicks with no location change', () => testWatchdogClicks('spot_01', 'target'));
    await check('watchdog: applies to transit too', () => testWatchdogClicks('transit', 'fixed'));
    await check('transit clicks the exact point with a raw delay', testTransitFixed);
    await check('humanised target clicks stay inside the box', testHumanisedTargetClicks);

    // --- regressions for defects the safety audit found, none of which had
    // --- any coverage when they shipped.

    await check('restart cannot bypass the click floor', async () => {
        // Stop the instant a click lands, then start again immediately. Before
        // the fix, each fresh run reset the last-click stamp to 0 and skipped
        // the floor entirely - measured at 37 clicks/sec across restarts.
        const clicker = fakeClicker();
        const route = fastRoute({ minClickIntervalMs: 700 });
        for (const id of Object.keys(route.locations)) route.locations[id].delayMs = 700;

        for (let i = 0; i < 4; i += 1) {
            const before = clicker.clicks.length;
            const h = new Harness({
                url: 'http://127.0.0.1:0',
                route,
                dryRun: true,
                clicker,
                dailyPlan: new DailyPlan({ store: memoryStore() }),
                humanizer: false,
                fetchImpl: fakeFetch(() => frame('spot_01', { target: box(10, 10, 90, 90) })),
                onEvent: (ev) => { if (ev.type === 'click') h.stop('restart test'); }
            });
            h.start();
            // Wait for this run's click rather than a fixed window: too short a
            // window means no clicks at all, and the assertion below passes
            // vacuously whether or not the floor is enforced.
            const deadline = Date.now() + 2500;
            while (clicker.clicks.length === before && Date.now() < deadline) await delay(25);
            h.stop('restart test');
        }

        if (clicker.clicks.length < 3) {
            throw new Error(`only ${clicker.clicks.length} clicks - the test proves nothing`);
        }
        const gaps = clicker.clicks.slice(1).map((c, i) => c.at - clicker.clicks[i].at);
        const worst = Math.min(...gaps);
        if (worst < 700) throw new Error(`min gap ${worst} ms across restarts, floor is 700 ms`);
        return `${clicker.clicks.length} clicks over 4 runs, min gap ${worst} ms (floor 700 ms)`;
    });

    await check('refuses to click a box that is off-screen', async () => {
        // Box sits entirely right of the 1920px screen, so no point is both
        // inside the box and on-screen. Clamping to the screen edge would click
        // whatever window is there; the only safe move is not to click.
        const clicker = fakeClicker();
        const harness = makeHarness({
            route: fastRoute(),
            clicker,
            humanizer: false,
            fetchImpl: fakeFetch(() => frame('spot_01', { target: box(4000, 500, 200, 100) }))
        });
        await harness.run(700);

        if (clicker.clicks.length) {
            const c = clicker.clicks[0];
            throw new Error(`clicked ${c.x},${c.y} - outside the target box`);
        }
        const warned = harness.of('warn').some((e) => /refusing to click/.test(e.message));
        if (!warned) throw new Error('no warning explaining the refusal');
        return 'no click, warned that the box is off-screen';
    });

    await check('no click event is emitted after stopped', async () => {
        const seen = [];
        const clicker = fakeClicker();
        const harness = makeHarness({
            route: fastRoute(),
            clicker,
            humanizer: false,
            fetchImpl: fakeFetch(() => frame('spot_01', { target: box(10, 10, 90, 90) })),
            onEvent: (event, h) => {
                seen.push(event.type);
                if (event.type === 'click') h.stop('stopped from the click handler');
            }
        });
        await harness.run(1200);

        const stoppedAt = seen.indexOf('stopped');
        if (stoppedAt === -1) throw new Error('never stopped');
        const after = seen.slice(stoppedAt + 1).filter((t) => t === 'click');
        if (after.length) throw new Error(`${after.length} click event(s) after stopped`);
        return `order ok: ${seen.join(' > ')}`;
    });

    await check('flapping location cannot defeat the watchdog', async () => {
        // Alternating ids reset both id-based watchdogs every cycle, so the
        // cumulative cap is the only thing that can stop this.
        const clicker = fakeClicker();
        const route = fastRoute();
        route.watchdog = {
            sameLocationMs: 3600000,
            maxClicksWithoutLocationChange: 1000,
            maxClicksPerRun: 5,
            maxRunMs: 3600000
        };
        let flip = 0;
        const harness = makeHarness({
            route,
            clicker,
            humanizer: false,
            fetchImpl: fakeFetch(() => frame((flip++ % 2) ? 'spot_02' : 'spot_01', {
                target: box(10, 10, 90, 90)
            }))
        });
        await harness.run(8000);

        const stop = harness.of('stopped')[0];
        if (!/click cap/.test(stop.reason || '')) {
            throw new Error(`stopped for "${stop.reason}", expected the run click cap`);
        }
        if (clicker.clicks.length > 6) throw new Error(`${clicker.clicks.length} clicks, cap was 5`);
        return `capped at ${clicker.clicks.length} clicks - "${stop.reason}"`;
    });

    await check('fallback fires once when the markers reset', async () => {
        // No target ever, but the service still reports the learned position.
        const clicker = fakeClicker();
        const harness = makeHarness({
            route: fastRoute(),
            clicker,
            humanizer: false,
            fetchImpl: fakeFetch(() => Object.assign(frame('spot_01', { confidence: 0.99 }), {
                fallback: { cx: 640, cy: 400, source: 'targets.spot_01.point' }
            }))
        });
        await harness.run(2500);

        const clicks = harness.of('click');
        if (clicks.length !== 1) {
            const trail = harness.events.map((e) => e.type + (e.message ? `(${e.message})` : ''));
            throw new Error(`${clicks.length} fallback clicks - must fire exactly once per `
                + `episode. events: ${trail.join(' > ')}`);
        }
        if (clicks[0].mode !== 'fallback') throw new Error(`mode was "${clicks[0].mode}"`);
        if (clicks[0].at.x !== 640 || clicks[0].at.y !== 400) {
            throw new Error(`clicked ${clicks[0].at.x},${clicks[0].at.y}, expected 640,400`);
        }
        return `1 click at 640,400 over ${harness.of('tick').length} ticks, mode=fallback`;
    });

    await check('fallback is held back by every guard', async () => {
        const cases = [
            {
                what: 'fewer empty polls than required',
                route: () => { const r = fastRoute(); r.fallback.afterEmptyPolls = 50; return r; },
                payload: () => Object.assign(frame('spot_01', { confidence: 0.99 }),
                    { fallback: { cx: 640, cy: 400 } })
            },
            {
                what: 'location confidence too low',
                route: fastRoute,
                payload: () => Object.assign(frame('spot_01', { confidence: 0.55 }),
                    { fallback: { cx: 640, cy: 400 } })
            },
            {
                what: 'disabled in config',
                route: () => { const r = fastRoute(); r.fallback.enabled = false; return r; },
                payload: () => Object.assign(frame('spot_01', { confidence: 0.99 }),
                    { fallback: { cx: 640, cy: 400 } })
            },
            {
                what: 'transit never guesses',
                route: fastRoute,
                payload: () => Object.assign(frame('transit', { confidence: 0.99 }),
                    { fallback: { cx: 640, cy: 400 } })
            },
            {
                what: 'service reports no fallback',
                route: fastRoute,
                payload: () => frame('spot_01', { confidence: 0.99 })
            }
        ];

        const notes = [];
        for (const c of cases) {
            const clicker = fakeClicker();
            const harness = makeHarness({
                route: c.route(),
                clicker,
                humanizer: false,
                fetchImpl: fakeFetch(c.payload)
            });
            await harness.run(1200);
            if (clicker.clicks.length) {
                throw new Error(`clicked despite: ${c.what} (${clicker.clicks.length} clicks)`);
            }
            notes.push(c.what);
        }
        return `no clicks: ${notes.join('; ')}`;
    });

    await check('a real detection re-arms the fallback', async () => {
        // Empty -> fallback fires -> a real box appears -> empty again -> it may
        // fire once more. Without the re-arm it would be stuck at one forever.
        const clicker = fakeClicker();
        let n = 0;
        const harness = makeHarness({
            route: fastRoute(),
            clicker,
            humanizer: false,
            fetchImpl: fakeFetch(() => {
                n += 1;
                const withTarget = n > 6 && n <= 9;
                return Object.assign(frame('spot_01', {
                    confidence: 0.99,
                    target: withTarget ? box(10, 10, 90, 90) : null
                }), { fallback: { cx: 640, cy: 400 } });
            })
        });
        await harness.run(4000);

        const modes = harness.of('click').map((c) => c.mode);
        const fallbacks = modes.filter((m) => m === 'fallback').length;
        if (fallbacks < 2) throw new Error(`only ${fallbacks} fallback clicks - never re-armed`);
        if (!modes.includes('target')) throw new Error('never clicked the real target');
        return `modes: ${modes.join(' > ')}`;
    });

    await check('lifetime caps of 0 mean unlimited', async () => {
        // A 3-hour cap silently ended an overnight session, and because a cap is
        // a "normal finish" auto-repair correctly refused to restart it - so it
        // just sat there. 0 must genuinely disable the check, not clamp to 1.
        const { route } = validateRoute(Object.assign(defaultRoute(), {
            watchdog: { sameLocationMs: 300000, maxClicksWithoutLocationChange: 6,
                maxRunMs: 0, maxClicksPerRun: 0 }
        }));
        if (route.watchdog.maxRunMs !== 0) throw new Error(`maxRunMs clamped to ${route.watchdog.maxRunMs}`);
        if (route.watchdog.maxClicksPerRun !== 0) {
            throw new Error(`maxClicksPerRun clamped to ${route.watchdog.maxClicksPerRun}`);
        }

        // And the engine must not stop on them. Run past what the old defaults
        // would have tripped.
        const clicker = fakeClicker();
        const r = fastRoute();
        r.watchdog = { sameLocationMs: 3600000, maxClicksWithoutLocationChange: 1000,
            maxRunMs: 0, maxClicksPerRun: 0 };
        for (const id of Object.keys(r.locations)) r.locations[id].delayMs = 0;
        r.minClickIntervalMs = 0;
        let flip = 0;
        const harness = makeHarness({
            route: r,
            clicker,
            humanizer: false,
            fetchImpl: fakeFetch(() => frame((flip++ % 2) ? 'spot_02' : 'spot_01', {
                target: box(10, 10, 90, 90)
            }))
        });
        await harness.run(2500);
        const stop = harness.of('stopped')[0];
        if (/cap reached/.test(stop.reason || '')) {
            throw new Error(`stopped on a cap that should be disabled: ${stop.reason}`);
        }
        return `${clicker.clicks.length} clicks, no cap fired ("${stop.reason}")`;
    });

    await check('no break of either tier starts on transit', async () => {
        const { BreakScheduler, TIERS } = require('./breaks.js');
        const out = [];
        for (const kind of TIERS) {
            let clock = 1000000;
            const s = new BreakScheduler({
                kind,
                config: { enabled: true, minPlayMs: 60000, maxPlayMs: 60000 },
                now: () => clock
            });
            s.schedule(clock);
            clock += 120000;   // well past due

            const onTransit = s.due('transit');
            if (!onTransit.due) throw new Error(`${kind}: should be due`);
            if (onTransit.safe) throw new Error(`${kind}: a break started on transit`);
            if (s.due(null).safe) throw new Error(`${kind}: started on an unknown location`);

            const onSpot = s.due('spot_04');
            if (!onSpot.safe) throw new Error(`${kind}: spot_04 should be safe: ${onSpot.reason}`);
            out.push(`${kind} deferred ${s.stats().deferred}x`);
        }
        return `${out.join(', ')}, both allowed on spot_04`;
    });

    await check('a deferred break is not skipped, only postponed', async () => {
        const { BreakScheduler } = require('./breaks.js');
        let clock = 1000000;
        const s = new BreakScheduler({
            kind: 'long',
            config: { enabled: true, minPlayMs: 60000, maxPlayMs: 60000 },
            now: () => clock
        });
        s.schedule(clock);
        clock += 120000;
        for (let i = 0; i < 5; i += 1) {
            if (s.due('transit').safe) throw new Error('started on transit');
            clock += 5000;
        }
        // Still due once a spot finally comes round.
        if (!s.due('spot_02').safe) throw new Error('the break was lost, not deferred');
        return '5 transit cycles deferred, still due at the next spot';
    });

    await check('each tier is held on its own side of the logout timer', async () => {
        const { BreakScheduler, IDLE_LOGOUT_MS } = require('./breaks.js');
        const { validateRoute } = require('./route.js');

        // A long idle under the timer produces no logout, so the break would do
        // nothing; a short idle over it logs out, which is the other tier's job.
        const { route } = validateRoute({ breaks: {
            long: { minIdleMs: 60000, maxIdleMs: 120000 },
            short: { minIdleMs: 400000, maxIdleMs: 600000 }
        } });
        if (!(route.breaks.long.minIdleMs > IDLE_LOGOUT_MS)) {
            throw new Error(`route allowed a ${route.breaks.long.minIdleMs}ms long idle`);
        }
        if (!(route.breaks.short.maxIdleMs < IDLE_LOGOUT_MS)) {
            throw new Error(`route allowed a ${route.breaks.short.maxIdleMs}ms short idle`);
        }

        // And again at the scheduler, which is also constructed directly.
        const sampled = {};
        for (const [kind, cfg] of [['long', { minIdleMs: 1000, maxIdleMs: 2000 }],
            ['short', { minIdleMs: 900000, maxIdleMs: 900000 }]]) {
            let clock = 1000000;
            const s = new BreakScheduler({
                kind,
                config: Object.assign({ enabled: true, minPlayMs: 60000, maxPlayMs: 60000 }, cfg),
                fetchImpl: async () => ({ ok: true, json: async () => ({
                    location: { id: 'spot_01', confidence: 0.99 } }) }),
                now: () => clock,
                sleep: async (ms) => { clock += ms; }
            });
            s.schedule(clock);
            clock += 120000;
            const r = await s.take('spot_01');
            sampled[kind] = r.idleMs;
        }
        if (!(sampled.long > IDLE_LOGOUT_MS)) throw new Error(`long idled ${sampled.long}ms`);
        if (!(sampled.short < IDLE_LOGOUT_MS)) throw new Error(`short idled ${sampled.short}ms`);
        return `long ${Math.round(sampled.long / 1000)}s > ${IDLE_LOGOUT_MS / 1000}s > `
            + `short ${Math.round(sampled.short / 1000)}s`;
    });

    await check('a long break logs out and stops the run for auto-repair', async () => {
        const { BreakScheduler } = require('./breaks.js');
        const { Supervisor } = require('./supervisor.js');
        // Same era as the engine's own clock: it seeds schedule() with the real
        // run start, so a fake clock at t=1000000 would never come due.
        let clock = Date.now();
        const clicker = fakeClicker();
        const seen = [];

        const breaks = new BreakScheduler({
            kind: 'long',
            config: { enabled: true, minPlayMs: 1, maxPlayMs: 1 },
            onEvent: (e) => seen.push(e),
            // The login screen: nothing the classifier can place.
            fetchImpl: async () => ({ ok: true, json: async () => ({
                location: { id: 'spot_01', confidence: 0.11 } }) }),
            // Advances on every read, so the six-minute idle passes in no real
            // time at all and the break is due on the first cycle.
            now: () => (clock += 10),
            sleep: async (ms) => { clock += ms; }
        });

        const harness = makeHarness({
            route: fastRoute(),
            clicker,
            breakSchedulers: [breaks],
            fetchImpl: fakeFetch(() => frame('spot_01', { target: box(10, 10, 90, 90) }))
        });
        await harness.run(1500);

        const stop = harness.of('stopped')[0];
        if (!stop) throw new Error('the run did not stop after the break');
        if (!/idle break/.test(stop.reason)) throw new Error(`stop reason: ${stop.reason}`);

        // The handoff only works if the supervisor agrees this is its problem.
        if (!new Supervisor({}).repairable(stop.reason)) {
            throw new Error(`the supervisor would ignore "${stop.reason}"`);
        }
        const started = seen.find((e) => e.type === 'break:start');
        if (!started) throw new Error('no break:start event');
        if (started.location === 'transit') throw new Error('the break started on transit');
        if (!started.expectsLogout) throw new Error('a long break did not expect a logout');
        // The panel has to see the break coming, not just its aftermath.
        if (!harness.of('break:scheduled').length) throw new Error('no break:scheduled event');
        return `"${stop.reason}" - repairable`;
    });

    await check('a short break pauses and keeps playing', async () => {
        const { BreakScheduler } = require('./breaks.js');
        let clock = Date.now();
        const clicker = fakeClicker();
        const seen = [];

        const breaks = new BreakScheduler({
            kind: 'short',
            config: { enabled: true, minPlayMs: 1, maxPlayMs: 1 },
            onEvent: (e) => {
                seen.push(e);
                // One break is the whole point here. Widen the play window while
                // it runs, so the reschedule at the end of take() lands far out
                // and the rest of the run is ordinary clicking.
                if (e.type === 'break:start') {
                    breaks.setConfig({ enabled: true,
                        minPlayMs: 3600000, maxPlayMs: 3600000 });
                }
            },
            // Still confidently on the course: the idle timer never fired.
            fetchImpl: async () => ({ ok: true, json: async () => ({
                location: { id: 'spot_02', confidence: 0.99 } }) }),
            now: () => (clock += 10),
            sleep: async (ms) => { clock += ms; }
        });

        const harness = makeHarness({
            route: fastRoute(),
            clicker,
            breakSchedulers: [breaks],
            fetchImpl: fakeFetch(() => frame('spot_01', { target: box(10, 10, 90, 90) }))
        });
        await harness.run(1500);

        const stop = harness.of('stopped')[0];
        if (stop && /idle break/.test(stop.reason)) {
            throw new Error('stopped for repair even though the game was still up');
        }
        const done = seen.find((e) => e.type === 'break:done');
        if (!done) throw new Error('no break:done event');
        if (done.loggedOut) throw new Error('claimed a logout that did not happen');
        const started = seen.find((e) => e.type === 'break:start');
        if (started.expectsLogout) throw new Error('a short break expected a logout');
        if (!clicker.clicks.length) throw new Error('never resumed clicking');
        return `paused ${Math.round(done.idleMs / 1000)}s, then ${clicker.clicks.length} clicks`;
    });

    await check('the panel can force a break, but not onto transit', async () => {
        const { BreakScheduler } = require('./breaks.js');
        const seen = [];
        const breaks = new BreakScheduler({
            kind: 'short',
            // Hours away on its own - only the force can bring it forward.
            config: { enabled: true, minPlayMs: 86400000, maxPlayMs: 86400000 },
            onEvent: (e) => seen.push(e),
            fetchImpl: async () => ({ ok: true, json: async () => ({
                location: { id: 'transit', confidence: 0.99 } }) }),
            sleep: async () => {}
        });

        const harness = makeHarness({
            route: fastRoute(),
            clicker: fakeClicker(),
            breakSchedulers: [breaks],
            // Parked in transit for the whole run.
            fetchImpl: fakeFetch(() => frame('transit'))
        });

        if (harness.requestBreak('short').ok) throw new Error('armed a stopped clicker');

        const run = harness.run(1200);
        const armed = harness.requestBreak('short');
        if (!armed.ok) throw new Error(`could not arm: ${armed.reason}`);
        await run;

        if (seen.some((e) => e.type === 'break:start')) {
            throw new Error('a forced break started on transit');
        }
        if (!seen.some((e) => e.type === 'break:armed')) throw new Error('no break:armed event');
        const deferrals = harness.of('warn').filter((w) => /break is due/.test(w.message));
        if (!deferrals.length) throw new Error('the forced break was never even considered');
        return `armed, deferred ${deferrals.length}x on transit, never started`;
    });

    await check('break intervals are skewed, not uniform', async () => {
        const { BreakScheduler } = require('./breaks.js');
        const lo = 900000;      // 15 min
        const hi = 2100000;     // 35 min
        const s = new BreakScheduler({
            kind: 'short',
            config: { enabled: true, minPlayMs: lo, maxPlayMs: hi },
            rng: new SeededRNG(20240607),
            now: () => 0
        });
        const N = 6000;
        const xs = Array.from({ length: N }, () => s.schedule(0).inMs).sort((a, b) => a - b);
        const mean = xs.reduce((a, b) => a + b, 0) / N;
        const median = xs[N >> 1];

        // Right skew: a uniform draw has mean === median, a log-normal does not.
        if (!(mean > median * 1.01)) {
            throw new Error(`mean ${Math.round(mean)} is not above median ${median} - looks uniform`);
        }
        // The configured range is the central 80%, so the tails must exist. A
        // rectangle clipped at exactly 15 and 35 is the signature being avoided.
        const below = xs.filter((x) => x < lo).length / N;
        const above = xs.filter((x) => x > hi).length / N;
        if (!(below > 0.03 && above > 0.03)) {
            throw new Error(`tails missing: ${(below * 100).toFixed(1)}% low, `
                + `${(above * 100).toFixed(1)}% high`);
        }
        // ...but still bounded. An unbounded tail would idle for hours.
        if (xs[0] < lo / 2 || xs[N - 1] > hi * 2) {
            throw new Error(`tail escaped the rail: ${xs[0]}..${xs[N - 1]}`);
        }
        // The sharpest uniform test available: a uniform draw puts exactly half
        // its mass below the midpoint of the range, by construction. A
        // right-skewed one bunches below it, because its median sits lower.
        const midpoint = (lo + hi) / 2;
        const under = xs.filter((x) => x < midpoint).length / N;
        if (!(under > 0.55)) {
            throw new Error(`${(under * 100).toFixed(0)}% below the midpoint `
                + '- a uniform draw gives 50%, so this is flat');
        }
        return `median ${(median / 60000).toFixed(1)}m, mean ${(mean / 60000).toFixed(1)}m, `
            + `${((below + above) * 100).toFixed(0)}% outside the range, `
            + `${(under * 100).toFixed(0)}% below the midpoint (uniform: 50%)`;
    });

    await check('breaks come sooner as the session wears on', async () => {
        const { BreakScheduler } = require('./breaks.js');
        const sample = (fatigue) => {
            const s = new BreakScheduler({
                kind: 'short',
                config: { enabled: true, minPlayMs: 900000, maxPlayMs: 2100000 },
                rng: new SeededRNG(99),
                fatigueAt: () => fatigue,
                now: () => 0
            });
            const xs = Array.from({ length: 3000 }, () => s.schedule(0).inMs).sort((a, b) => a - b);
            return xs[1500];
        };
        const fresh = sample(1);
        const worn = sample(1.12);      // the envelope's own maximum
        if (!(worn < fresh * 0.85)) {
            throw new Error(`fatigue barely moved the interval: ${fresh} -> ${worn}`);
        }
        return `median ${(fresh / 60000).toFixed(1)}m fresh -> `
            + `${(worn / 60000).toFixed(1)}m worn in`;
    });

    await check('a skewed idle never crosses its tier boundary', async () => {
        const { BreakScheduler, IDLE_LOGOUT_MS } = require('./breaks.js');
        // Deliberately hostile config: each tier is asked for a range that sits
        // right against the timer, so a fat tail would cross it if unclamped.
        const cases = [
            ['short', { minIdleMs: 60000, maxIdleMs: 240000 }, (ms) => ms < IDLE_LOGOUT_MS],
            ['long', { minIdleMs: 360000, maxIdleMs: 420000 }, (ms) => ms > IDLE_LOGOUT_MS]
        ];
        const out = [];
        for (const [kind, cfg, ok] of cases) {
            let clock = 0;
            const s = new BreakScheduler({
                kind,
                config: Object.assign({ enabled: true, minPlayMs: 60000, maxPlayMs: 60000 }, cfg),
                rng: new SeededRNG(5150),
                fetchImpl: async () => ({ ok: true, json: async () => ({
                    location: { id: 'spot_01', confidence: 0.99 } }) }),
                now: () => clock,
                sleep: async (ms) => { clock += ms; }
            });
            let lo = Infinity;
            let hi = 0;
            for (let i = 0; i < 400; i += 1) {
                const r = await s.take('spot_01');
                if (!ok(r.idleMs)) {
                    throw new Error(`${kind} idled ${r.idleMs}ms - wrong side of the timer`);
                }
                lo = Math.min(lo, r.idleMs);
                hi = Math.max(hi, r.idleMs);
            }
            out.push(`${kind} ${Math.round(lo / 1000)}-${Math.round(hi / 1000)}s`);
        }
        return `${out.join(', ')}, timer at ${IDLE_LOGOUT_MS / 1000}s`;
    });

    // ── wall-clock breaks: lunch, dinner, sleep ────────────

    // Local noon on a fixed day, so these never depend on when they are run.
    const dayAt = (h, m = 0) => {
        const d = new Date(2026, 5, 15, h, m, 0, 0);
        return d.getTime();
    };

    const dailyCfg = (over = {}) => Object.assign({
        minPlayBeforeMs: 2700000,
        lunch: { enabled: true, at: '12:30', minMs: 1800000, maxMs: 3000000 },
        dinner: { enabled: true, at: '18:30', minMs: 2700000, maxMs: 4500000 },
        sleep: { enabled: true, at: '23:30', minMs: 21600000, maxMs: 28800000 }
    }, over);

    await check('a break starting right after the bot does is skipped', async () => {
        const { DailyPlan, memoryStore } = require('./daily.js');

        // Bedtime drift is one-sided - the roll can only push it later - so with
        // a grace window wider than the drift can reach, this is exact rather
        // than seed-luck. (The default 45 min does not cover a 100 min drift,
        // and should not: a bedtime an hour and a half out is not "right after
        // starting".)
        for (const seed of [1, 2, 3, 17, 99]) {
            const plan = new DailyPlan({ store: memoryStore(), rng: new SeededRNG(seed),
                now: () => dayAt(23, 20) });
            plan.ensure(dailyCfg({ minPlayBeforeMs: 10800000 }), dayAt(23, 20));
            const bed = plan.get('sleep');
            if (!bed.skipped) throw new Error(`seed ${seed}: went to bed 10 min after starting`);
            if (!/immediately/.test(bed.reason)) throw new Error(`seed ${seed}: ${bed.reason}`);
        }

        // Lunch from a 12:10 start, across many rolls. Its drift is two-sided,
        // so a roll lands just before the start, or inside the grace window, or
        // - occasionally, on a big late drift - genuinely far enough out to be
        // believable. The rule is the boundary, not "always skip".
        const grace = 2700000;
        let tooSoon = 0;
        let past = 0;
        let kept = 0;
        for (let seed = 0; seed < 60; seed += 1) {
            const plan = new DailyPlan({ store: memoryStore(), rng: new SeededRNG(seed),
                now: () => dayAt(12, 10) });
            plan.ensure(dailyCfg(), dayAt(12, 10));
            const lunch = plan.get('lunch');
            if (!lunch.skipped) {
                const away = lunch.startAt - dayAt(12, 10);
                if (away < grace) {
                    throw new Error(`seed ${seed}: kept a lunch only `
                        + `${Math.round(away / 60000)} min after the start`);
                }
                kept += 1;
            } else if (/immediately/.test(lunch.reason)) tooSoon += 1;
            else if (/already past/.test(lunch.reason)) past += 1;
            else throw new Error(`seed ${seed}: unexpected reason ${lunch.reason}`);
        }
        if (!(tooSoon > 0)) throw new Error('the grace window never fired for lunch');

        // Started at 08:00, the same lunch is four hours out and stands.
        const early = new DailyPlan({ store: memoryStore(), rng: new SeededRNG(3),
            now: () => dayAt(8, 0) });
        early.ensure(dailyCfg(), dayAt(8, 0));
        if (early.get('lunch').skipped) {
            throw new Error(`lunch skipped from an 08:00 start: ${early.get('lunch').reason}`);
        }
        if (early.get('sleep').skipped) throw new Error('bedtime skipped from an 08:00 start');

        // Started at 20:00, lunch is long gone.
        const evening = new DailyPlan({ store: memoryStore(), rng: new SeededRNG(3),
            now: () => dayAt(20, 0) });
        evening.ensure(dailyCfg(), dayAt(20, 0));
        if (!/already past/.test(evening.get('lunch').reason || '')) {
            throw new Error(`20:00 start: ${evening.get('lunch').reason}`);
        }
        return `bedtime skipped from 23:20 on every seed (3 h grace); lunch from 12:10: `
            + `${tooSoon} too-soon, ${past} already-past, ${kept} far enough out; `
            + 'both kept from 08:00';
    });

    await check('the day is planned once and survives a restart', async () => {
        const { DailyPlan, memoryStore } = require('./daily.js');
        const store = memoryStore();

        const morning = new DailyPlan({ store, rng: new SeededRNG(11),
            now: () => dayAt(9, 0) });
        morning.ensure(dailyCfg(), dayAt(9, 0));
        const planned = morning.get('dinner').startAt;

        // Auto-repair restarts the engine at 18:20, ten minutes before dinner.
        // A fresh roll would apply the grace window and cancel it; reading the
        // stored plan keeps the evening intact.
        const afterRepair = new DailyPlan({ store, rng: new SeededRNG(77),
            now: () => dayAt(18, 20) });
        afterRepair.ensure(dailyCfg(), dayAt(18, 20));
        const kept = afterRepair.get('dinner');
        if (kept.skipped) throw new Error(`dinner cancelled by a restart: ${kept.reason}`);
        if (kept.startAt !== planned) throw new Error('dinner was re-rolled to a new time');

        // A new calendar day does roll fresh.
        const tomorrow = new DailyPlan({ store, rng: new SeededRNG(77),
            now: () => dayAt(9, 0) + 86400000 });
        tomorrow.ensure(dailyCfg(), dayAt(9, 0) + 86400000);
        if (tomorrow.get('dinner').startAt === planned) throw new Error('the plan never rolled over');
        return 'same plan across a restart, fresh plan the next day';
    });

    await check('switching a meal on mid-day schedules it for today', async () => {
        const { DailyPlan, memoryStore } = require('./daily.js');
        const store = memoryStore();
        const off = dailyCfg({ lunch: { enabled: false, at: '12:30',
            minMs: 1800000, maxMs: 3000000 } });

        // Rolled at 08:00 with lunch off.
        const morning = new DailyPlan({ store, rng: new SeededRNG(31), now: () => dayAt(8, 0) });
        morning.ensure(off, dayAt(8, 0));
        if (morning.get('lunch').enabled) throw new Error('lunch was planned while off');

        // Switched on at 09:00. Waiting until tomorrow would be a bug you would
        // only notice tomorrow.
        const later = new DailyPlan({ store, rng: new SeededRNG(31), now: () => dayAt(9, 0) });
        later.ensure(dailyCfg(), dayAt(9, 0));
        const lunch = later.get('lunch');
        if (!lunch.enabled || lunch.skipped) {
            throw new Error(`lunch still not planned: ${lunch.reason}`);
        }

        // ...and switching it back off cancels it rather than leaving it armed.
        const cancelled = new DailyPlan({ store, rng: new SeededRNG(31), now: () => dayAt(10, 0) });
        cancelled.ensure(off, dayAt(10, 0));
        if (!cancelled.get('lunch').skipped) throw new Error('lunch survived being turned off');
        return 'off at 08:00, on at 09:00 lands today, off again cancels it';
    });

    await check('meal and bedtime drift like a person, not a cron job', async () => {
        const { DailyPlan, memoryStore } = require('./daily.js');
        const N = 500;
        const lunches = [];
        const beds = [];
        for (let i = 0; i < N; i += 1) {
            const plan = new DailyPlan({ store: memoryStore(), rng: new SeededRNG(1000 + i),
                now: () => dayAt(6, 0) });
            plan.ensure(dailyCfg(), dayAt(6, 0));
            lunches.push(plan.get('lunch').startAt - dayAt(12, 30));
            beds.push(plan.get('sleep').startAt - dayAt(23, 30));
        }
        const distinct = new Set(lunches.map((x) => Math.round(x / 60000))).size;
        if (distinct < 30) throw new Error(`only ${distinct} distinct lunch times in ${N} days`);

        // Meals drift both ways...
        const early = lunches.filter((x) => x < 0).length / N;
        if (!(early > 0.3 && early < 0.7)) {
            throw new Error(`${(early * 100).toFixed(0)}% of lunches were early - not symmetric`);
        }
        // ...bedtime only ever slips later. Nobody goes to bed before they meant to.
        if (beds.some((x) => x < 0)) throw new Error('went to bed before the earliest time');
        const bedMed = beds.slice().sort((a, b) => a - b)[N >> 1] / 60000;
        if (!(bedMed > 5 && bedMed < 45)) throw new Error(`bedtime drift median ${bedMed} min`);
        return `${distinct} distinct lunch times, ${(early * 100).toFixed(0)}% early, `
            + `bedtime +${bedMed.toFixed(0)} min median, never before 23:30`;
    });

    await check('a bedtime past midnight is not lost at 00:00', async () => {
        const { DailyPlan, memoryStore, dayKey, atLocalMinutes } = require('./daily.js');

        // The routine day runs 04:00 to 04:00. On a calendar boundary the plan
        // would roll over at midnight and throw away a pending 00:15 bedtime -
        // which silently cost about a third of all nights.
        if (dayKey(dayAt(0, 5)) === dayKey(dayAt(12, 0))) {
            throw new Error('00:05 and noon are the same routine day');
        }
        // 23:55 and the 00:05 ten minutes later must share a routine day.
        if (dayKey(dayAt(23, 55)) !== dayKey(dayAt(23, 55) + 600000)) {
            throw new Error('23:55 and 00:05 fell into different routine days');
        }
        // A configured 01:00 bedtime lands tonight, not this morning.
        const oneAm = atLocalMinutes(dayAt(20, 0), 60);
        if (!(oneAm > dayAt(20, 0))) throw new Error('a 01:00 bedtime was scheduled in the past');

        // And the plan carries a past-midnight bedtime across the boundary.
        const store = memoryStore();
        const evening = new DailyPlan({ store, rng: new SeededRNG(8),
            now: () => dayAt(20, 0) });
        evening.ensure(dailyCfg({ sleep: { enabled: true, at: '23:55',
            minMs: 21600000, maxMs: 28800000 } }), dayAt(20, 0));
        const bed = evening.get('sleep').startAt;
        if (!(bed > dayAt(23, 55))) throw new Error('bedtime did not drift later');

        const afterMidnight = new DailyPlan({ store, rng: new SeededRNG(8),
            now: () => dayAt(24, 10) });
        afterMidnight.ensure(dailyCfg(), dayAt(24, 10));
        if (afterMidnight.get('sleep').startAt !== bed) {
            throw new Error('the pending bedtime was discarded at midnight');
        }
        return `bedtime ${new Date(bed).toTimeString().slice(0, 5)} survives the `
            + 'midnight rollover; a 01:00 bedtime schedules for tonight';
    });

    await check('a wall-clock break fires once, then not again', async () => {
        const { ClockBreakScheduler, DailyPlan, memoryStore } = require('./daily.js');
        let clock = dayAt(12, 0);
        const store = memoryStore();
        const plan = new DailyPlan({ store, rng: new SeededRNG(4242), now: () => clock });
        const lunch = new ClockBreakScheduler({
            kind: 'lunch',
            config: dailyCfg(),
            plan,
            rng: new SeededRNG(4242),
            fetchImpl: async () => ({ ok: true, json: async () => ({
                location: { id: 'spot_01', confidence: 0.12 } }) }),
            now: () => clock,
            sleep: async (ms) => { clock += ms; }
        });

        const info = lunch.schedule(dayAt(8, 0));
        if (!info.at) throw new Error('lunch was not scheduled');
        if (lunch.due('spot_01').due) throw new Error('due before its time');

        clock = info.at + 1000;
        if (lunch.due('transit').safe) throw new Error('lunch started on transit');
        const verdict = lunch.due('spot_02');
        if (!verdict.safe) throw new Error(`not due at its time: ${verdict.reason}`);

        const r = await lunch.take('spot_02');
        if (!r.loggedOut) throw new Error('a meal did not log out');
        if (!(r.idleMs > 300000)) throw new Error(`lunch was only ${r.idleMs}ms`);
        // Taken is taken - a restart an hour later must not eat a second lunch.
        if (lunch.due('spot_02').due) throw new Error('lunch came due a second time');
        if (!store.load().events.lunch.taken) throw new Error('the plan was not persisted');
        return `${Math.round(r.idleMs / 60000)} min, logged out, not repeated`;
    });

    await check('a missed window is dropped, not taken hours late', async () => {
        const { ClockBreakScheduler, DailyPlan, memoryStore } = require('./daily.js');
        let clock = dayAt(8, 0);
        const plan = new DailyPlan({ store: memoryStore(), rng: new SeededRNG(9),
            now: () => clock });
        const lunch = new ClockBreakScheduler({
            kind: 'lunch', config: dailyCfg(), plan, rng: new SeededRNG(9),
            now: () => clock, sleep: async (ms) => { clock += ms; }
        });
        lunch.schedule(dayAt(8, 0));

        // The panel was closed all afternoon. Eating lunch at 16:00 is worse
        // than not eating it.
        clock = dayAt(16, 0);
        if (lunch.due('spot_01').due) throw new Error('lunch fired at 16:00');
        if (!/window passed/.test(lunch.stats().reason || '')) {
            throw new Error(`reason: ${lunch.stats().reason}`);
        }
        return lunch.stats().reason;
    });

    await check('a forced wall-clock break is shortened but still logs out', async () => {
        const { ClockBreakScheduler, DailyPlan, memoryStore, TEST_IDLE_MS,
            IDLE_LOGOUT_MS } = require('./daily.js');
        let clock = dayAt(9, 0);
        const plan = new DailyPlan({ store: memoryStore(), rng: new SeededRNG(21),
            now: () => clock });
        const seen = [];
        const sleep = new ClockBreakScheduler({
            kind: 'sleep', config: dailyCfg(), plan, rng: new SeededRNG(21),
            onEvent: (e) => seen.push(e),
            fetchImpl: async () => ({ ok: true, json: async () => ({
                location: { id: 'spot_01', confidence: 0.1 } }) }),
            now: () => clock, sleep: async (ms) => { clock += ms; }
        });
        sleep.schedule(dayAt(9, 0));
        const planned = sleep.stats().durationMs;

        const armed = sleep.forceNow();
        if (!armed.ok) throw new Error(`could not arm: ${armed.reason}`);
        if (!sleep.due('spot_03').safe) throw new Error('a forced sleep was not due');
        if (sleep.due('transit').safe) throw new Error('a forced sleep started on transit');

        const r = await sleep.take('spot_03');
        if (r.idleMs !== TEST_IDLE_MS) throw new Error(`test slept ${r.idleMs}ms`);
        if (!(r.idleMs > IDLE_LOGOUT_MS)) throw new Error('the test did not outlast the timer');
        if (!r.loggedOut) throw new Error('the test did not log out');
        const start = seen.find((e) => e.type === 'break:start');
        if (!start.shortened) throw new Error('the shortened test was not flagged');
        return `${Math.round(planned / 3600000)}h planned, `
            + `${Math.round(r.idleMs / 60000)} min for the test, logged out`;
    });

    await check('sleep outranks a meal outranks a stretch', async () => {
        const { PRIORITY, priorityOf } = require('./breaks.js');
        const order = ['sleep', 'dinner', 'lunch', 'long', 'short'];
        for (let i = 1; i < order.length; i += 1) {
            if (!(priorityOf(order[i - 1]) < priorityOf(order[i]))) {
                throw new Error(`${order[i - 1]} does not outrank ${order[i]}`);
            }
        }
        // The engine sorts on this, so an unknown kind must not jump the queue.
        if (!(priorityOf('mystery') > PRIORITY.short)) throw new Error('unknown kind outranks short');
        return order.join(' > ');
    });

    await check('micro-imperfections are wired and bounded', async () => {
        const clicker = fakeClicker();
        const harness = makeHarness({
            route: fastRoute(),
            clicker,
            fetchImpl: fakeFetch(() => frame('spot_01', { target: box(10, 10, 90, 90) }))
        });
        await harness.run(2500);
        const clicks = harness.of('click');
        if (!clicks.length) throw new Error('no clicks to inspect');
        if (!clicks.every((c) => 'imperfection' in c)) {
            throw new Error('click events carry no imperfection field');
        }
        const fired = clicks.filter((c) => c.imperfection);
        for (const c of fired) {
            const ms = c.imperfection.delayMs;
            if (!(ms >= 0 && ms < 400)) throw new Error(`imperfection of ${ms}ms is out of band`);
            if (!['delayed-commit', 'pre-hesitation'].includes(c.imperfection.type)) {
                throw new Error(`unknown imperfection type ${c.imperfection.type}`);
            }
        }
        return `${fired.length}/${clicks.length} clicks carried one, all under 400ms`;
    });

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) console.log(`failed: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(failed.length ? 1 : 0);
})();
