'use strict';

// How many hours does the clicker actually play in a day?
//
// Not an estimate - this drives the REAL schedulers (breaks.js, daily.js) on a
// fake clock and adds up the time they take away. If the shape of a break
// changes, this number changes with it.
//
//   node greenbot/harness/simulate-day.js [--days 60] [--seed 1] [--all]
//
// It runs CONTINUOUSLY across days rather than simulating one day in isolation,
// because sleep straddles midnight: a day that begins wide awake at 00:01 would
// quietly hand back the seven hours it should have started in the middle of.
// The first and last days are partial and are dropped from the average.
//
// What it does not model: disconnects, watchdog stops, failed obstacles, or the
// tablet going to sleep. All of those make the real number lower, never higher.

const { BreakScheduler, TIERS, IDLE_LOGOUT_MS } = require('./breaks.js');
const { ClockBreakScheduler, DailyPlan, memoryStore, dayKey, EVENTS } = require('./daily.js');
const { loadRoute, defaultRoute } = require('./route.js');
const { SeededRNG, SessionProfile, FatigueEnvelope } = require('../../humanizer.js');

// Every break that logs out is followed by a repair cycle: Claude wakes the
// tablet, taps through the login, sets the camera and restarts the clicker.
// Observed cycles run two to four minutes.
const REPAIR_MS = 180000;

// Granularity of the simulated loop. The engine assesses several times a second;
// a lap of the course is tens of seconds, so this is finer than what is measured.
const STEP_MS = 10000;

// Roughly the share of cycles spent in transit, where no break may start. One of
// the seven locations, with a middling delay.
const TRANSIT_SHARE = 1 / 7;

const DAY_MS = 86400000;

function argValue(name, fallback) {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')
        ? process.argv[idx + 1] : fallback;
}

function fmtHM(ms) {
    const total = Math.round(Math.abs(ms) / 60000);
    return `${ms < 0 ? '-' : ''}${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/**
 * Charge a stretch of not-playing to the calendar days it actually covers.
 *
 * A seven-hour sleep beginning at 23:50 is ten minutes of one day and six and a
 * half hours of the next, and counting it all against either one is how a
 * simulation ends up claiming eighteen playable hours.
 */
function charge(ledger, kind, from, to) {
    let cursor = from;
    while (cursor < to) {
        const day = dayKey(cursor);
        const dayEnd = startOfDay(cursor) + DAY_MS;
        const slice = Math.min(to, dayEnd) - cursor;
        if (!ledger[day]) ledger[day] = { short: 0, long: 0, lunch: 0, dinner: 0, sleep: 0, repair: 0 };
        ledger[day][kind] += slice;
        cursor += slice;
    }
}

async function simulate(route, days, seed) {
    const rng = new SeededRNG(seed);
    const profile = new SessionProfile(rng);
    const fatigue = new FatigueEnvelope(profile);

    const base = startOfDay(Date.now()) + 60000;        // 00:01 on day 0
    let clock = base;
    const now = () => clock;

    // The break being sat out right now, so the fake vision service can answer
    // the question the real one would: is the course still on screen? It is,
    // until the idle passes the game's own logout timer.
    let breakStartedAt = 0;
    const fetchImpl = async () => ({
        ok: true,
        json: async () => (clock - breakStartedAt > IDLE_LOGOUT_MS
            ? { location: { id: 'login', confidence: 0.1 } }
            : { location: { id: 'spot_03', confidence: 0.98 } })
    });

    // Reset at every restart, exactly like the engine: a repair cycle builds a
    // fresh Harness, so the interval tiers start counting from zero again.
    let runStartedAt = clock;

    const plan = new DailyPlan({ store: memoryStore(), rng, now });
    const shared = { rng, now, fetchImpl, sleep: async (ms) => { clock += ms; } };

    const intervals = TIERS.map((kind) => new BreakScheduler(Object.assign({
        kind,
        config: route.breaks[kind],
        fatigueAt: () => fatigue.at(clock - runStartedAt)
    }, shared)));
    const clocks = EVENTS.map((kind) => new ClockBreakScheduler(Object.assign({
        kind, config: route.daily, plan
    }, shared)));

    const tiers = [...intervals, ...clocks].sort((a, b) => a.priority - b.priority);
    for (const tier of tiers) tier.schedule(runStartedAt);

    const ledger = {};
    const counts = { short: 0, long: 0, lunch: 0, dinner: 0, sleep: 0, repair: 0 };
    const end = base + days * DAY_MS;

    while (clock < end) {
        // A break may only start at a spot, so part of the time it comes due the
        // character is mid-traversal and it waits a cycle.
        const where = rng.next() < TRANSIT_SHARE ? 'transit' : 'spot_03';
        let took = null;
        for (const tier of tiers) {
            const verdict = tier.due(where);
            if (verdict.due && verdict.safe) { took = tier; break; }
        }
        if (!took) {
            clock += STEP_MS;
            continue;
        }

        const kind = took.kind;
        const from = clock;
        breakStartedAt = clock;
        const result = await took.take('spot_03', () => true);
        charge(ledger, kind, from, clock);
        counts[kind] += 1;

        if (result.loggedOut) {
            const repairFrom = clock;
            clock += REPAIR_MS;
            charge(ledger, 'repair', repairFrom, clock);
            counts.repair += 1;
            runStartedAt = clock;
            for (const tier of intervals) tier.schedule(runStartedAt);
        }
    }

    // Drop the first and last days: both are partial by construction.
    const keys = Object.keys(ledger).sort();
    const full = keys.slice(1, -1);
    return { ledger, counts, full, days: full.length };
}

async function main() {
    const days = Math.max(3, Number(argValue('days', 60)) || 60);
    const seed = Number(argValue('seed', 1)) || 1;
    const forceAll = process.argv.includes('--all');

    let route;
    let source = 'route.json';
    try {
        route = loadRoute().route;
    } catch (err) {
        route = defaultRoute();
        source = 'defaults';
    }
    if (forceAll) {
        for (const kind of TIERS) route.breaks[kind].enabled = true;
        for (const kind of EVENTS) route.daily[kind].enabled = true;
    }

    const on = [];
    const off = [];
    for (const kind of TIERS) (route.breaks[kind].enabled ? on : off).push(`${kind} breaks`);
    for (const kind of EVENTS) (route.daily[kind].enabled ? on : off).push(kind);

    const { ledger, counts, full } = await simulate(route, days, seed);

    const totals = { short: 0, long: 0, lunch: 0, dinner: 0, sleep: 0, repair: 0 };
    const perDay = [];
    for (const day of full) {
        let lost = 0;
        for (const kind of Object.keys(totals)) {
            totals[kind] += ledger[day][kind];
            lost += ledger[day][kind];
        }
        perDay.push(DAY_MS - lost);
    }
    perDay.sort((a, b) => a - b);

    const n = full.length;
    const mean = perDay.reduce((a, b) => a + b, 0) / n;

    console.log(`\n  ${n} full simulated days (continuous run), route from ${source}`);
    console.log(`  on:  ${on.join(', ') || 'nothing'}`);
    if (off.length) console.log(`  off: ${off.join(', ')}`);
    console.log('');
    console.log('  away from the game     per day     times/day');
    const rows = [['sleep', 'sleep'], ['dinner', 'dinner'], ['lunch', 'lunch'],
        ['long breaks', 'long'], ['short breaks', 'short'], ['logging back in', 'repair']];
    for (const [label, key] of rows) {
        console.log(`    ${label.padEnd(20)} ${fmtHM(totals[key] / n).padStart(8)}    `
            + `${(counts[key] / n).toFixed(1)}`);
    }
    const lost = Object.values(totals).reduce((a, b) => a + b, 0) / n;
    console.log('');
    console.log(`    ${'not playing'.padEnd(20)} ${fmtHM(lost).padStart(8)}`);
    console.log(`    ${'PLAYING'.padEnd(20)} ${fmtHM(mean).padStart(8)}    `
        + `${(mean / DAY_MS * 100).toFixed(0)}% of 24 h`);
    console.log('');
    console.log(`  day to day: ${fmtHM(perDay[0])} worst, `
        + `${fmtHM(perDay[Math.floor(n / 2)])} median, `
        + `${fmtHM(perDay[n - 1])} best`);
    console.log('');
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { simulate, REPAIR_MS };
