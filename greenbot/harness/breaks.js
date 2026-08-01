'use strict';

// Human-scale breaks driven by elapsed play time, in two tiers.
//
//   short - stop clicking for twenty seconds to three minutes. Stretching,
//           reading a message, looking away. Stays under the game's five-minute
//           idle-logout timer on purpose, so the session survives it and
//           clicking simply resumes.
//
//   long  - the toilet break. Six to ten minutes, which is deliberately LONGER
//           than that timer, so the game logs the character out by itself. That
//           is the whole trick: the logout is produced by the same idle timer
//           that logs out a real person who walked away, so it looks like one.
//
// daily.js adds a third kind, anchored to the wall clock instead: lunch, dinner
// and sleep. All of them share BreakBase below.
//
// A break clicks nothing, ever. It does not press a logout button and it does
// not log back in. Coming back from a break that logged out is deliberately
// somebody else's job: the repair skill already knows how to get from a login
// screen to a playable course, and it verifies the result independently.
//
// The one hard rule, and it applies to every kind: a break never STARTS in
// `transit`. Going idle mid-traversal leaves the character somewhere the
// classifier cannot place. Only spot_01..spot_06 are safe.

const TRANSIT = 'transit';

// OSRS logs an idle character out after five minutes of no input. Everything
// below is measured against this one number.
const IDLE_LOGOUT_MS = 300000;

// Long breaks must clear it, with margin - the clock starts at the last click,
// not at the moment the break is declared, and the two are seconds apart.
const IDLE_MARGIN_MS = 60000;
const MIN_IDLE_MS = IDLE_LOGOUT_MS + IDLE_MARGIN_MS;

// Short breaks must stay under it, with the same margin, or they would log out
// too and quietly turn into long ones.
const SHORT_MAX_IDLE_MS = IDLE_LOGOUT_MS - IDLE_MARGIN_MS;

// Same bar the supervisor uses to call a frame a real course location. Below it,
// the classifier is not looking at the course - which is what a logout looks
// like from here.
const RECOGNISED_CONF = 0.7;

// Ticks during the idle, so the panel shows a countdown instead of freezing, and
// so status.json stays fresh for the repair skill.
const IDLE_TICK_MS = 5000;

const TIERS = ['short', 'long'];

// Which break wins when two come due in the same cycle. Sleep outranks a meal,
// a meal outranks a toilet break, and a stretch is bottom of the list.
const PRIORITY = { sleep: 0, dinner: 1, lunch: 2, long: 3, short: 4 };

function priorityOf(kind) {
    return PRIORITY[kind] === undefined ? 99 : PRIORITY[kind];
}

// How a configured range is read.
//
// A uniform draw over [15 min, 35 min] is a script's shape, not a person's:
// every interval equally likely, nothing ever outside, and after twenty breaks
// the histogram is a rectangle with hard edges at exactly the two numbers in the
// config. Real gaps between breaks are right-skewed - clustered around a typical
// value, with a tail of long uninterrupted stretches and the occasional short
// one where something interrupts you twice in a row.
//
// So min/max are read as the CENTRAL 80% of a log-normal rather than as walls:
// the median sits at their geometric mean, and roughly one interval in ten falls
// outside on each side. Hard rails still apply where they mean something (a
// short break must not cross the logout timer) - they just are not the shape.
const CENTRAL_80_Z = 1.2816;

// The play interval also shortens as the session wears on, because a person four
// hours in gets up more often than one who just sat down. FatigueEnvelope is
// calibrated for click delays - it only spans about 1.00 to 1.12 - so its effect
// on break frequency is amplified: at full fatigue, breaks come ~50% sooner.
const FATIGUE_GAIN = 4;

// Absolute rails on a sampled value, so a tail draw cannot turn a 30 min rhythm
// into a six-hour one.
const TAIL_RAIL = 2;

function gaussian(rng) {
    if (rng && typeof rng.gaussian === 'function') return rng.gaussian();
    // Box-Muller, for the tests and any caller that injects no rng.
    let u = 0;
    let v = 0;
    let sq = 0;
    do {
        u = Math.random() * 2 - 1;
        v = Math.random() * 2 - 1;
        sq = u * u + v * v;
    } while (sq >= 1 || sq === 0);
    return u * Math.sqrt(-2 * Math.log(sq) / sq);
}

/**
 * Draw from a log-normal whose central 80% is [lo, hi].
 *
 * lo === hi is a legitimate configuration ("exactly this"), and the maths would
 * give spread 0, so it is short-circuited rather than left to produce NaN.
 */
function skewedBetween(rng, lo, hi) {
    const a = Math.max(1, Number(lo) || 0);
    const b = Math.max(a, Number(hi) || 0);
    if (b === a) return a;
    const median = Math.sqrt(a * b);
    const spread = Math.log(b / a) / (2 * CENTRAL_80_Z);
    const draw = rng && typeof rng.skewedPositive === 'function'
        ? rng.skewedPositive(median, spread)
        : median * Math.exp(gaussian(rng) * spread);
    return Math.min(b * TAIL_RAIL, Math.max(a / TAIL_RAIL, draw));
}

function defaultBreaks() {
    return {
        short: {
            // Harmless: it never logs out, it just stops for a moment. On by
            // default, because a session with no pauses in it at all is the
            // least human thing the clicker does.
            enabled: true,
            minPlayMs: 900000,      // 15 min
            maxPlayMs: 2100000,     // 35 min
            minIdleMs: 20000,       // 20 s
            maxIdleMs: 180000       // 3 min
        },
        long: {
            // Ends the run on purpose and needs auto-repair to come back, so
            // this one is opted into.
            enabled: false,
            minPlayMs: 7200000,     // 2 h
            maxPlayMs: 14400000,    // 4 h
            minIdleMs: 360000,      // 6 min - must clear the logout timer
            maxIdleMs: 600000       // 10 min
        }
    };
}

/** A single idle duration, held on its tier's side of the logout timer. */
function clampIdleMs(kind, ms) {
    return kind === 'long'
        ? Math.max(MIN_IDLE_MS, ms)
        : Math.min(SHORT_MAX_IDLE_MS, Math.max(1000, ms));
}

/** The bounds that make a tier what it is, enforced here and in route.js. */
function clampIdle(kind, cfg) {
    const out = Object.assign({}, cfg);
    let lo = Math.round(Number(out.minIdleMs) || 0);
    let hi = Math.round(Number(out.maxIdleMs) || 0);
    if (kind === 'long') {
        lo = Math.max(MIN_IDLE_MS, lo);
        hi = Math.max(lo, hi);
    } else {
        hi = Math.min(SHORT_MAX_IDLE_MS, Math.max(1000, hi));
        lo = Math.min(hi, Math.max(1000, lo));
    }
    out.minIdleMs = lo;
    out.maxIdleMs = hi;
    return out;
}

/**
 * What every kind of break shares: emitting, watching the service, sitting out
 * an idle, and deciding afterwards whether the game is still there.
 *
 * Subclasses supply the "when" - elapsed play time here, wall clock in daily.js.
 */
class BreakBase {
    constructor(options = {}) {
        const {
            kind = 'long',
            rng = null,
            fetchImpl = null,
            url = 'http://127.0.0.1:8765',
            onEvent = () => {},
            now = () => Date.now(),
            sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        } = options;

        this._kind = kind;
        this._rng = rng;
        this._fetch = fetchImpl;
        this._url = String(url).replace(/\/+$/, '');
        this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};
        this._now = now;
        this._sleep = sleep;

        this._breaks = 0;
        this._deferred = 0;
        this._inBreak = false;
        this._forced = false;
    }

    get kind() {
        return this._kind;
    }

    get priority() {
        return priorityOf(this._kind);
    }

    _emit(event) {
        try {
            this._onEvent(Object.assign({ kind: this._kind }, event));
        } catch (err) { /* a listener must not break the run */ }
    }

    async _poll() {
        if (!this._fetch) return null;
        try {
            const res = await this._fetch(`${this._url}/analyze/screen`, {
                signal: AbortSignal.timeout(8000)
            });
            if (!res || res.ok === false) return null;
            return await res.json();
        } catch (err) {
            return null;
        }
    }

    /**
     * Two consecutive frames the classifier cannot confidently place mean the
     * course is no longer on screen - i.e. the idle timer fired and we are
     * sitting on the login screen.
     *
     * An unreachable service counts as logged out, on purpose. The state is then
     * unknown, and unknown belongs to repair, which verifies before it resumes
     * anything. Guessing "still logged in" here would resume clicking blind.
     */
    async _observeLogout() {
        let unrecognised = 0;
        let last = 'no response from the vision service';
        for (let i = 0; i < 3; i += 1) {
            const payload = await this._poll();
            const loc = payload && payload.location;
            const id = loc && typeof loc.id === 'string' ? loc.id : null;
            const conf = loc ? Number(loc.confidence) || 0 : 0;
            const known = id && (/^spot_\d+$/.test(id) || id === TRANSIT)
                && conf >= RECOGNISED_CONF;
            if (known) {
                // Still on the course. One confident frame is enough to say the
                // logout did not happen - the failure we care about is the other
                // direction.
                return { loggedOut: false, detail: `${id} at ${conf.toFixed(3)}` };
            }
            unrecognised += 1;
            last = id ? `${id} at ${conf.toFixed(3)}` : last;
            if (unrecognised >= 2) return { loggedOut: true, detail: last };
            await this._sleep(3000);
        }
        return { loggedOut: true, detail: last };
    }

    /**
     * Sit out `idleMs`, ticking as it goes, then report whether the game is
     * still up. `meta` is folded into the break:start event.
     *
     * Returns `{ ok, idleMs, loggedOut }`. `loggedOut: true` means the run should
     * stop and let auto-repair log back in; `false` means the game is still there
     * and playing on is both correct and cheaper than a repair cycle.
     */
    async _sitOut(idleMs, location, isAlive, meta = {}) {
        this._inBreak = true;
        const startedAt = this._now();
        this._breaks += 1;
        this._emit(Object.assign({
            type: 'break:start', at: startedAt, idleMs, location,
            forced: this._forced, expectsLogout: idleMs > IDLE_LOGOUT_MS,
            logoutAfterMs: IDLE_LOGOUT_MS
        }, meta));

        try {
            const until = startedAt + idleMs;
            while (this._now() < until) {
                if (!isAlive()) return { ok: false, idleMs, aborted: true };
                const left = until - this._now();
                this._emit({ type: 'break:idle', remainingMs: left, idleMs });
                await this._sleep(Math.min(IDLE_TICK_MS, left));
            }
            if (!isAlive()) return { ok: false, idleMs, aborted: true };

            const seen = await this._observeLogout();
            this._emit({ type: 'break:done', ms: this._now() - startedAt, idleMs,
                loggedOut: seen.loggedOut, detail: seen.detail });
            return { ok: true, idleMs, loggedOut: seen.loggedOut, detail: seen.detail };
        } finally {
            this._inBreak = false;
            this._forced = false;
        }
    }

    /**
     * The hard rule, shared by every kind: a break never starts in transit, and
     * never anywhere the classifier cannot place. Due-but-unsafe means keep
     * playing and ask again next cycle - deferring is correct, skipping is not.
     */
    _placeIsSafe(location) {
        if (!location || location === TRANSIT) {
            this._deferred += 1;
            return { due: true, safe: false, kind: this._kind,
                reason: `${this._kind} break is due but the character is in `
                    + `${location || 'an unknown location'} - waiting for a spot` };
        }
        if (!/^spot_\d+$/.test(location)) {
            this._deferred += 1;
            return { due: true, safe: false, kind: this._kind,
                reason: `${this._kind} break is due but "${location}" is not a known spot`
                    + ' - waiting' };
        }
        return { due: true, safe: true, kind: this._kind, location };
    }
}

/**
 * Decides when a break is due from elapsed play time, and sits out the break.
 *
 * One instance per tier. Injectable rng/fetch/sleep/now so the whole thing is
 * testable with no server and no waiting.
 */
class BreakScheduler extends BreakBase {
    constructor(options = {}) {
        const { kind = 'long', config = {}, fatigueAt = () => 1 } = options;

        super(Object.assign({}, options, { kind: kind === 'short' ? 'short' : 'long' }));
        this._cfg = this._normalise(config);
        this._fatigueAt = typeof fatigueAt === 'function' ? fatigueAt : () => 1;
        this._nextBreakAt = 0;
    }

    // route.js validates too, but this class is also constructed directly, and a
    // long idle below the logout timer - or a short one above it - would silently
    // turn each tier into the other.
    _normalise(config) {
        const base = defaultBreaks()[this._kind];
        return clampIdle(this._kind, Object.assign(base, config));
    }

    /** How much sooner the next break comes because the session is worn in. */
    _fatigueRate() {
        const f = Number(this._fatigueAt()) || 1;
        return Math.max(1, 1 + FATIGUE_GAIN * (f - 1));
    }

    /** Called when a run starts, and after any break that did not end the run. */
    schedule(from = null) {
        const base = from == null ? this._now() : from;
        const rate = this._fatigueRate();
        const wait = skewedBetween(this._rng, this._cfg.minPlayMs, this._cfg.maxPlayMs) / rate;
        this._nextBreakAt = base + wait;
        this._forced = false;
        return { kind: this._kind, at: this._nextBreakAt, inMs: Math.round(wait),
            fatigueRate: Number(rate.toFixed(3)) };
    }

    /**
     * Bring the next break forward to right now, for the panel's test button.
     *
     * It still has to wait for a safe location - forcing a break is not the same
     * as forcing it to happen on transit, and that rule has no override.
     */
    forceNow() {
        if (!this._cfg.enabled) {
            return { ok: false, reason: `${this._kind} breaks are turned off` };
        }
        if (this._inBreak) return { ok: false, reason: `already on a ${this._kind} break` };
        this._nextBreakAt = this._now();
        this._forced = true;
        this._emit({ type: 'break:armed', kind: this._kind });
        return { ok: true, kind: this._kind };
    }

    stats() {
        return {
            kind: this._kind,
            enabled: Boolean(this._cfg.enabled),
            nextBreakAt: this._nextBreakAt,
            breaks: this._breaks,
            deferred: this._deferred,
            inBreak: this._inBreak,
            forced: this._forced
        };
    }

    setConfig(config) {
        const wasEnabled = this._cfg.enabled;
        this._cfg = this._normalise(config);
        if (this._cfg.enabled && !wasEnabled) this.schedule();
        return this._cfg;
    }

    /** Is a break due, and may it start right now? */
    due(location) {
        if (!this._cfg.enabled || this._inBreak) return { due: false };
        if (!this._nextBreakAt) {
            this.schedule();
            return { due: false };
        }
        if (this._now() < this._nextBreakAt) return { due: false };
        return this._placeIsSafe(location);
    }

    async take(location, isAlive = () => true) {
        // Same skew for the duration - most breaks are on the short side, a few
        // run long - but clamped hard to the tier's own side of the logout timer,
        // because that bound is correctness, not style.
        const idleMs = Math.round(clampIdleMs(this._kind,
            skewedBetween(this._rng, this._cfg.minIdleMs, this._cfg.maxIdleMs)));
        const result = await this._sitOut(idleMs, location, isAlive);
        // Still playing: nothing to hand over, so line up the next one.
        if (result.ok && !result.loggedOut) this.schedule();
        return result;
    }
}

module.exports = {
    BreakBase, BreakScheduler, defaultBreaks, clampIdle, clampIdleMs, skewedBetween,
    gaussian, priorityOf, TIERS, TRANSIT, PRIORITY,
    IDLE_LOGOUT_MS, MIN_IDLE_MS, SHORT_MAX_IDLE_MS, RECOGNISED_CONF, IDLE_TICK_MS
};
