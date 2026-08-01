'use strict';

// Breaks anchored to the wall clock rather than to elapsed play: lunch, dinner,
// and sleep.
//
// These are what make a 24/7 clicker look like a person rather than a process.
// A human does not play for four hours, pause eleven minutes, and repeat; they
// stop at roughly the same times every day, for roughly the same reasons, and
// they are asleep for a third of it.
//
// "Roughly" is the whole design:
//
//   - The time is rolled fresh each day around the configured one. Meals drift
//     either side; bedtime only ever drifts LATER, because people put off going
//     to bed and almost never go early.
//   - The duration is log-normal around the configured range, so most dinners
//     run typical and the occasional one runs long.
//   - The plan is rolled ONCE per calendar day and persisted, so an auto-repair
//     restart in the afternoon does not re-roll lunch or take it twice.
//
// Every one of these is longer than the game's five-minute idle timer, so they
// all end with the character logged out and the run stopped - exactly like the
// `long` tier in breaks.js. Auto-repair logs back in afterwards.

const fs = require('fs');
const path = require('path');

const {
    BreakBase, skewedBetween, gaussian, MIN_IDLE_MS, IDLE_LOGOUT_MS
} = require('./breaks.js');

const PLAN_PATH = path.join(__dirname, 'daily.json');

const EVENTS = ['lunch', 'dinner', 'sleep'];

// Meals drift either side of the configured time; a person eats early as often
// as late. One sigma, then railed - a two-hour drift is a different meal.
const MEAL_JITTER_MS = 22 * 60000;
const MEAL_JITTER_RAIL_MS = 55 * 60000;

// Bedtime is one-sided. The configured time is the EARLIEST, and the draw is
// always later: nobody goes to bed before they meant to.
const BED_DRIFT_LO_MS = 8 * 60000;
const BED_DRIFT_HI_MS = 50 * 60000;

// A forced break from the panel uses this instead of its real length. Watching a
// seven-hour sleep is not a test, but it still has to outlast the idle-logout
// timer or it would not prove the part that matters.
const TEST_IDLE_MS = MIN_IDLE_MS;

function defaultDaily() {
    return {
        // Nobody sits down and immediately gets up to eat. An event landing
        // inside this window of the run starting is skipped for the day.
        minPlayBeforeMs: 2700000,       // 45 min
        lunch: { enabled: true, at: '12:30', minMs: 1800000, maxMs: 3000000 },
        dinner: { enabled: true, at: '18:30', minMs: 2700000, maxMs: 4500000 },
        // `at` is the EARLIEST bedtime; the roll only ever moves it later.
        sleep: { enabled: true, at: '23:30', minMs: 21600000, maxMs: 28800000 }
    };
}

/** "12:30" -> 750 minutes past midnight. Returns null on anything else. */
function parseClock(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null;
    return h * 60 + min;
}

function formatClock(minutes) {
    const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// A routine day runs 04:00 to 04:00, not midnight to midnight.
//
// Bedtime is 23:30 plus a drift that can cross midnight, and on a calendar-day
// boundary that pending sleep would be thrown away at 00:00 and replaced by a
// fresh plan for the new day - so roughly a third of nights were simply never
// slept. Four in the morning is the quiet point of a human routine: late enough
// that any believable bedtime is behind it, early enough that no meal is.
const PLAN_DAY_START_HOUR = 4;

/** Start of the routine day containing `ts` - 04:00 local, today or yesterday. */
function routineDayStart(ts) {
    const d = new Date(ts);
    if (d.getHours() < PLAN_DAY_START_HOUR) d.setDate(d.getDate() - 1);
    d.setHours(PLAN_DAY_START_HOUR, 0, 0, 0);
    return d.getTime();
}

/** Which routine day a timestamp belongs to, as YYYY-MM-DD. */
function dayKey(ts) {
    const d = new Date(routineDayStart(ts));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        + `-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Timestamp of a HH:MM clock time within the routine day containing `ts`.
 *
 * A time before 04:00 is the late-night side of the day, so it lands tomorrow -
 * which is what lets someone configure a 01:00 bedtime and get one.
 */
function atLocalMinutes(ts, minutes) {
    const start = routineDayStart(ts);
    const midnight = new Date(start);
    midnight.setHours(0, 0, 0, 0);
    const at = midnight.getTime() + minutes * 60000;
    return at < start ? at + 86400000 : at;
}

function fileStore(pathname = PLAN_PATH) {
    return {
        load() {
            try {
                return JSON.parse(fs.readFileSync(pathname, 'utf8').replace(/^﻿/, ''));
            } catch (err) {
                return null;
            }
        },
        save(plan) {
            try {
                fs.writeFileSync(pathname, `${JSON.stringify(plan, null, 2)}\n`);
            } catch (err) {
                // Losing a plan write costs at most one re-roll; it must never
                // take the run down.
            }
        }
    };
}

/** In-memory store, for tests and for a run that should leave no trace. */
function memoryStore(seed = null) {
    let held = seed;
    return {
        load: () => held,
        save: (plan) => { held = plan; }
    };
}

/**
 * The day's rolled plan, shared by all three schedulers.
 *
 * Rolled once per calendar day. Persisted, because the run stops at every one of
 * these events and auto-repair starts a fresh engine afterwards - without a file
 * the afternoon restart would roll a brand new lunch and eat twice.
 */
class DailyPlan {
    constructor(options = {}) {
        const {
            store = fileStore(),
            rng = null,
            now = () => Date.now(),
            onEvent = () => {}
        } = options;
        this._store = store;
        this._rng = rng;
        this._now = now;
        this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};
        this._plan = null;
    }

    _emit(event) {
        try {
            this._onEvent(event);
        } catch (err) { /* a listener must not break the run */ }
    }

    /**
     * Make sure a plan exists for today, rolling one if not.
     *
     * `runStartedAt` only matters for a plan rolled right now: it is what decides
     * whether an event is too close to the start to be believable. A plan carried
     * over from earlier today keeps the decisions it already made, which is what
     * stops an auto-repair restart from cancelling the afternoon's dinner.
     */
    ensure(config, runStartedAt) {
        const today = dayKey(this._now());
        if (this._plan && this._plan.date === today) return this._plan;

        const stored = this._store.load();
        if (stored && stored.date === today && stored.events) {
            this._plan = stored;
            this._reconcile(config);
            return this._plan;
        }
        return this._roll(config, runStartedAt);
    }

    /**
     * Catch up today's plan with a config change made after it was rolled.
     *
     * Turning lunch on at 09:00 should get you lunch today, not tomorrow, and
     * turning it off should cancel it. Anything already taken stays taken.
     */
    _reconcile(config) {
        const cfg = Object.assign(defaultDaily(), config);
        const now = this._now();
        let changed = false;

        for (const kind of EVENTS) {
            const wanted = Boolean(cfg[kind] && cfg[kind].enabled);
            const entry = this._plan.events[kind];
            if (!entry) continue;

            if (!wanted && entry.enabled && !entry.taken) {
                this._plan.events[kind] = { enabled: false, skipped: true,
                    reason: 'turned off' };
                changed = true;
            } else if (wanted && !entry.enabled) {
                // Scheduled late, so the grace window runs from now rather than
                // from a run start hours ago that knew nothing about it.
                const rolled = this._rollOne(kind, cfg, now);
                this._plan.events[kind] = rolled;
                changed = true;
            }
        }
        if (changed) {
            this._store.save(this._plan);
            this._emit({ type: 'daily:planned', date: this._plan.date, events: this.summary() });
        }
        return this._plan;
    }

    _roll(config, runStartedAt) {
        const now = this._now();
        const createdAt = Number(runStartedAt) || now;
        const cfg = Object.assign(defaultDaily(), config);
        const grace = Math.max(0, Number(cfg.minPlayBeforeMs) || 0);
        const plan = { date: dayKey(now), createdAt, events: {} };

        for (const kind of EVENTS) {
            plan.events[kind] = this._rollOne(kind, cfg, createdAt, grace);
        }

        this._plan = plan;
        this._store.save(plan);
        this._emit({ type: 'daily:planned', date: plan.date, events: this.summary() });
        return plan;
    }

    /**
     * Roll one event for today, and decide there and then whether it happens.
     *
     * `from` is the moment the decision is being made - the run start for a
     * fresh plan, or now for an event switched on mid-day. Both skip rules are
     * settled here and never revisited, so an auto-repair restart in the
     * afternoon cannot cancel the evening.
     */
    _rollOne(kind, cfg, from, graceMs = null) {
        const ev = cfg[kind] || {};
        if (!ev.enabled) return { enabled: false, skipped: true, reason: 'turned off' };

        const minutes = parseClock(ev.at);
        if (minutes == null) {
            return { enabled: false, skipped: true, reason: `"${ev.at}" is not a HH:MM time` };
        }
        const grace = graceMs == null
            ? Math.max(0, Number(cfg.minPlayBeforeMs) || 0)
            : graceMs;

        const startAt = atLocalMinutes(this._now(), minutes) + this._drift(kind);
        const durationMs = Math.round(Math.max(MIN_IDLE_MS,
            skewedBetween(this._rng, ev.minMs, ev.maxMs)));
        const entry = { enabled: true, startAt, durationMs, taken: false, skipped: false,
            reason: null };

        if (startAt < from) {
            entry.skipped = true;
            entry.reason = 'already past when the bot started';
        } else if (startAt < from + grace) {
            entry.skipped = true;
            entry.reason = `only ${Math.round((startAt - from) / 60000)} min after `
                + 'the bot started - nobody sits down and immediately gets up';
        }
        return entry;
    }

    /** How far today's roll moves this event off its configured time. */
    _drift(kind) {
        if (kind !== 'sleep') {
            const raw = gaussian(this._rng) * MEAL_JITTER_MS;
            return Math.max(-MEAL_JITTER_RAIL_MS, Math.min(MEAL_JITTER_RAIL_MS, raw));
        }
        // One-sided and skewed: the configured time is the earliest, and the
        // usual outcome is a bit after it, occasionally a lot after.
        return skewedBetween(this._rng, BED_DRIFT_LO_MS, BED_DRIFT_HI_MS);
    }

    get(kind) {
        return (this._plan && this._plan.events && this._plan.events[kind]) || null;
    }

    update(kind, patch) {
        const entry = this.get(kind);
        if (!entry) return null;
        Object.assign(entry, patch);
        this._store.save(this._plan);
        return entry;
    }

    /** Human-readable, for the log and the panel. */
    summary() {
        const out = {};
        for (const kind of EVENTS) {
            const e = this.get(kind);
            if (!e) continue;
            out[kind] = !e.enabled ? 'off'
                : e.skipped ? `skipped (${e.reason})`
                    : e.taken ? 'taken'
                        : `${formatClock(new Date(e.startAt).getHours() * 60
                            + new Date(e.startAt).getMinutes())} for `
                            + `${Math.round(e.durationMs / 60000)} min`;
        }
        return out;
    }
}

/**
 * One wall-clock break: lunch, dinner or sleep.
 *
 * Same interface as BreakScheduler, so the engine treats them all alike.
 */
class ClockBreakScheduler extends BreakBase {
    constructor(options = {}) {
        const { kind = 'lunch', config = {}, plan = null } = options;
        super(Object.assign({}, options, { kind }));
        this._cfg = Object.assign(defaultDaily(), config);
        this._plan = plan;
        this._testIdleMs = 0;
    }

    setConfig(config) {
        this._cfg = Object.assign(defaultDaily(), config);
        return this._cfg;
    }

    _entry() {
        return this._plan ? this._plan.get(this._kind) : null;
    }

    /** Called at run start. Rolls the day's plan if it has not been rolled yet. */
    schedule(from = null) {
        if (!this._plan) return { kind: this._kind, at: 0, inMs: 0 };
        this._plan.ensure(this._cfg, from == null ? this._now() : from);
        const entry = this._entry();
        const at = entry && !entry.skipped && !entry.taken ? entry.startAt : 0;
        return { kind: this._kind, at, inMs: at ? Math.max(0, at - this._now()) : 0,
            skipped: Boolean(entry && entry.skipped), reason: entry && entry.reason,
            durationMs: entry && entry.durationMs };
    }

    /**
     * Bring today's event forward to right now, for the panel's test button.
     *
     * Shortened deliberately: nobody wants to watch a seven-hour sleep to find
     * out whether the handover works. It still outlasts the idle-logout timer,
     * so the part being tested - logout, stop, auto-repair - is the real thing.
     */
    forceNow() {
        const ev = this._cfg[this._kind] || {};
        if (!ev.enabled) return { ok: false, reason: `${this._kind} is turned off` };
        if (this._inBreak) return { ok: false, reason: `already on ${this._kind}` };
        if (!this._plan) return { ok: false, reason: 'no daily plan' };
        this._plan.ensure(this._cfg, this._now());
        const entry = this._entry();
        if (!entry) return { ok: false, reason: `${this._kind} is not in today's plan` };

        this._plan.update(this._kind, { startAt: this._now(), taken: false, skipped: false,
            reason: 'forced from the panel' });
        this._testIdleMs = TEST_IDLE_MS;
        this._forced = true;
        this._emit({ type: 'break:armed', kind: this._kind, idleMs: TEST_IDLE_MS,
            shortened: true });
        return { ok: true, kind: this._kind, idleMs: TEST_IDLE_MS };
    }

    stats() {
        const entry = this._entry();
        const ev = this._cfg[this._kind] || {};
        return {
            kind: this._kind,
            enabled: Boolean(ev.enabled),
            nextBreakAt: entry && !entry.skipped && !entry.taken ? entry.startAt : 0,
            durationMs: entry ? entry.durationMs : 0,
            skipped: Boolean(entry && entry.skipped),
            taken: Boolean(entry && entry.taken),
            reason: entry ? entry.reason : null,
            breaks: this._breaks,
            deferred: this._deferred,
            inBreak: this._inBreak,
            forced: this._forced
        };
    }

    due(location) {
        const ev = this._cfg[this._kind] || {};
        if (!ev.enabled || this._inBreak || !this._plan) return { due: false };

        // A day can roll over mid-run; ensure() is idempotent within one.
        this._plan.ensure(this._cfg, this._now());
        const entry = this._entry();
        if (!entry || entry.skipped || entry.taken || !entry.startAt) return { due: false };
        if (this._now() < entry.startAt) return { due: false };

        // Long past it - the panel was closed through the whole window. Taking a
        // 40-minute lunch at 16:00 is worse than not taking it.
        if (!this._forced && this._now() > entry.startAt + entry.durationMs) {
            this._plan.update(this._kind, { skipped: true,
                reason: 'the window passed while the bot was not running' });
            this._emit({ type: 'daily:missed', kind: this._kind });
            return { due: false };
        }
        return this._placeIsSafe(location);
    }

    async take(location, isAlive = () => true) {
        const entry = this._entry();
        const planned = entry ? entry.durationMs : MIN_IDLE_MS;
        const idleMs = this._testIdleMs || planned;
        this._testIdleMs = 0;

        // Marked before the idle, not after: a panel that dies mid-sleep must not
        // come back and sleep another seven hours.
        if (this._plan) this._plan.update(this._kind, { taken: true, startedAt: this._now() });

        return this._sitOut(idleMs, location, isAlive, {
            plannedMs: planned, shortened: idleMs !== planned
        });
    }
}

module.exports = {
    ClockBreakScheduler, DailyPlan, defaultDaily, fileStore, memoryStore,
    parseClock, formatClock, dayKey, atLocalMinutes, routineDayStart, PLAN_DAY_START_HOUR,
    EVENTS, PLAN_PATH, TEST_IDLE_MS, IDLE_LOGOUT_MS
};
