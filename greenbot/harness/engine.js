'use strict';

const {
    SeededRNG, SessionProfile, FatigueEnvelope,
    HesitationMachine, PauseScheduler, PositionHumanizer, MicroImperfections
} = require('../../humanizer.js');
const { createClicker, pointInBox, DEFAULT_MARGIN_FRAC } = require('./clicker.js');
const { defaultRoute, validateRoute } = require('./route.js');
const { BreakScheduler, TIERS } = require('./breaks.js');
const { ClockBreakScheduler, DailyPlan, EVENTS } = require('./daily.js');

const DEFAULT_URL = 'http://127.0.0.1:8765';
const REQUEST_TIMEOUT_MS = 4000;

// A frame that took longer than this to come back describes a screen that has
// probably already moved on - report it, never click on it.
const STALE_RESPONSE_MS = 2000;

// The floor below which no config, humanisation or bug may push a click.
const ABSOLUTE_MIN_CLICK_MS = 250;

// Module-level, deliberately NOT per-instance. The panel builds a fresh Harness
// on every Start, so an instance field would let a Stop/Start toggle issue an
// unthrottled click each time - measured at 37 clicks/sec before this existed.
// The floor has to outlive the object that enforces it.
let lastClickAtGlobal = 0;

const DELAY_JITTER_STD = 0.06;
// Guards against a gaussian tail turning a 12 s wait into 40 s or 2 s.
const DELAY_WARP_MIN = 0.6;
const DELAY_WARP_MAX = 1.8;

function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
}

/**
 * baseMs * fatigue * gaussian(1, 0.06), plus hesitation, plus a scheduled pause.
 * Exported so the distribution can be sampled in tests without a running loop.
 *
 * @param {number} baseMs
 * @param {{rng, fatigue, hesitation, pauses, sessionMs?: number}} ctx
 */
function humanizeDelay(baseMs, ctx) {
    const sessionMs = ctx.sessionMs || 0;
    const fatigue = ctx.fatigue.at(sessionMs);
    const warp = clamp(ctx.rng.gaussianMS(1, DELAY_JITTER_STD), DELAY_WARP_MIN, DELAY_WARP_MAX);
    const hesitation = ctx.hesitation.evaluate(fatigue);
    const pause = ctx.pauses.evaluate();

    const warpedMs = Math.round(baseMs * fatigue * warp);
    const hesitationMs = Math.max(0, Math.round(hesitation.extraDelay));
    const pauseMs = pause.shouldPause ? Math.max(0, Math.round(pause.durationMs)) : 0;

    return {
        baseMs,
        warpedMs,
        hesitationMs,
        pauseMs,
        pauseType: pause.shouldPause ? pause.type : null,
        appliedMs: warpedMs + hesitationMs + pauseMs,
        fatigue
    };
}

/**
 * assess spot -> get clickables -> click ONCE -> wait timer -> assess again.
 *
 * Dry run is the default. `clicker` and `fetchImpl` are injectable so the whole
 * machine can be exercised with no server and no real mouse.
 */
class Harness {
    constructor(options = {}) {
        const {
            url = DEFAULT_URL,
            route = null,
            dryRun = true,
            clicker = null,
            fetchImpl = null,
            humanizer = true,
            seed = null,
            // Injectable, so a break can be exercised on a fake clock. A real
            // run never passes them - a six-minute idle is not a unit test.
            breakSchedulers = null,
            dailyPlan = null,
            onEvent = () => {}
        } = options;

        this._url = String(url).replace(/\/+$/, '');
        this._dryRun = dryRun !== false;
        this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};
        this._fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
        this._clicker = clicker || createClicker({ dryRun: this._dryRun });
        this._humanizerOn = humanizer !== false;
        this._seed = seed == null ? ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0) : (seed >>> 0);

        this._rng = new SeededRNG(this._seed);
        this._profile = new SessionProfile(this._rng);
        this._fatigue = new FatigueEnvelope(this._profile);
        this._hesitation = new HesitationMachine(this._profile, this._rng);
        this._pauses = new PauseScheduler(this._profile, this._rng);
        this._position = new PositionHumanizer(this._profile, this._rng);
        // pre-hesitation freezes before a click; delayed-commit lands it late.
        // Both are per-action, so unlike TimeWarper they fit a reactive loop.
        this._imperfections = new MicroImperfections(this._profile, this._rng);

        this._running = false;
        this._generation = 0;
        this._timers = new Set();
        this._phase = 'stopped';
        this._startedAt = 0;
        this._clicks = 0;
        this._lastClickAt = 0;
        this._lastLocation = null;
        this._lastLocationChangeAt = 0;
        this._clicksSinceChange = 0;
        this._clicksThisRun = 0;
        this._emptyPolls = 0;
        this._fallbackUsed = false;
        this._fallbacks = 0;
        this._nextAssessAt = 0;
        this._lastTick = null;
        this._lastWarn = null;

        this._route = defaultRoute();
        this.setRoute(route == null ? defaultRoute() : route);

        // No clicker: a break clicks nothing. A short one just pauses; everything
        // longer idles past the game's own logout timer and auto-repair brings
        // the session back.
        const shared = {
            rng: this._rng,
            fetchImpl: this._fetch,
            url: this._url,
            onEvent: (e) => this._emit(e),
            sleep: (ms) => this._sleep(ms)
        };

        this._dailyPlan = dailyPlan || new DailyPlan({
            rng: this._rng,
            onEvent: (e) => this._emit(e)
        });

        this._breaks = breakSchedulers || [
            ...TIERS.map((kind) => new BreakScheduler(Object.assign({
                kind,
                config: (this._route.breaks || {})[kind] || {},
                // Four hours in, a person gets up more often than one who just
                // sat down. Same envelope that stretches the click delays.
                fatigueAt: () => this._fatigue.at(
                    this._startedAt ? Date.now() - this._startedAt : 0)
            }, shared))),
            ...EVENTS.map((kind) => new ClockBreakScheduler(Object.assign({
                kind,
                config: this._route.daily || {},
                plan: this._dailyPlan
            }, shared)))
        ];
        // Sleep outranks dinner outranks lunch outranks a toilet break outranks
        // a stretch, so two coming due in the same cycle resolve the human way.
        this._breaks.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Bring a break forward to the next safe moment - the panel's test button.
     *
     * "As soon as allowed" is the operative word: it cannot start on transit, so
     * this arms the break and the loop takes it at the next spot.
     */
    requestBreak(kind = 'long') {
        if (!this._running) return { ok: false, reason: 'the clicker is not running' };
        const tier = (this._breaks || []).find((b) => b.kind === kind);
        if (!tier) return { ok: false, reason: `no "${kind}" break tier` };
        return tier.forceNow();
    }

    start() {
        if (this._running) return false;

        const now = Date.now();
        this._running = true;
        this._generation += 1;
        this._startedAt = now;
        this._clicks = 0;
        // Inherit the process-wide last click. Resetting to 0 here let every
        // Stop/Start toggle fire one unthrottled click.
        this._lastClickAt = lastClickAtGlobal;
        this._lastLocation = null;
        this._lastLocationChangeAt = now;
        this._clicksSinceChange = 0;
        this._clicksThisRun = 0;
        this._emptyPolls = 0;
        this._fallbackUsed = false;
        this._fallbacks = 0;
        this._lastWarn = null;
        this._phase = 'polling';
        for (const tier of this._breaks || []) {
            // The run start is what decides whether a meal is too close to it to
            // be believable, so it has to be passed in rather than assumed.
            const next = tier.schedule(now);
            // A disabled tier is still scheduled, so turning it on mid-run has a
            // sane baseline - but announcing a break that cannot happen would be
            // a lie in the log.
            if (tier.stats().enabled) {
                this._emit({ type: 'break:scheduled', kind: next.kind,
                    inMs: next.inMs, at: next.at });
            }
        }

        this._emit({ type: 'started', at: now });
        this._loop(this._generation);
        return true;
    }

    /** Immediate and idempotent: nothing scheduled survives this call. */
    stop(reason = 'stopped by request') {
        if (!this._running) {
            this._clearTimers();
            this._phase = 'stopped';
            return false;
        }
        // Order matters: kill the generation before waking the sleepers, so a
        // sleep that resolves inside _clearTimers cannot continue its cycle.
        this._running = false;
        this._generation += 1;
        this._clearTimers();
        this._phase = 'stopped';
        this._nextAssessAt = 0;
        this._emit({ type: 'stopped', reason: String(reason) });
        return true;
    }

    isRunning() {
        return this._running;
    }

    getState() {
        const tick = this._lastTick;
        return {
            running: this._running,
            phase: this._phase,
            dryRun: this._dryRunFlag(),
            url: this._url,
            seed: this._seed,
            location: tick ? tick.location : null,
            confidence: tick ? tick.confidence : 0,
            hasTarget: tick ? tick.hasTarget : false,
            clicks: this._clicks,
            clicksSinceLocationChange: this._clicksSinceChange,
            lastClickAt: this._lastClickAt,
            lastLocationChangeAt: this._lastLocationChangeAt,
            nextAssessAt: this._nextAssessAt,
            sessionMs: this._running ? Date.now() - this._startedAt : 0,
            route: this._route
        };
    }

    /** Takes effect on the next cycle; never interrupts a wait in progress. */
    setRoute(route) {
        const { route: validated, warnings } = validateRoute(route);
        this._route = validated;
        // Breaks are edited from the same panel as everything else, so they have
        // to follow the same rule: an edit lands on the next cycle. Without this
        // a tier toggled on mid-run would stay off until the next START.
        for (const tier of this._breaks || []) {
            tier.setConfig(EVENTS.includes(tier.kind)
                ? (this._route.daily || {})
                : ((this._route.breaks || {})[tier.kind] || {}));
        }
        for (const message of warnings) this._emit({ type: 'warn', message });
        return this._route;
    }

    // ── cycle ──────────────────────────────────────────────

    async _loop(gen) {
        while (this._alive(gen)) {
            const cycleStart = Date.now();
            let payload = null;
            let error = null;

            this._phase = 'polling';
            try {
                payload = await this._poll();
            } catch (err) {
                error = err;
            }
            if (!this._alive(gen)) return;

            if (error || !payload || !payload.location || typeof payload.location.id !== 'string') {
                this._warn(error
                    ? `service unreachable: ${error.message || error}`
                    : 'malformed response from the service');
                this._emitTick(null, 'polling');
                const dead = this._watchdogReason(Date.now());
                if (dead) return this.stop(dead);
                await this._sleep(this._pollGapMs(cycleStart));
                continue;
            }

            const now = Date.now();
            this._trackLocation(payload.location.id, now);

            // Breaks are checked after the location is known, because whether one
            // may start at all depends on where the character is standing.
            const tier = this._dueBreak(payload.location.id);
            if (tier) {
                this._phase = 'break';
                this._emitTick(payload, 'break');
                const result = await tier.take(payload.location.id, () => this._alive(gen));
                if (!this._alive(gen)) return;

                if (result.loggedOut) {
                    // A long break did exactly what it is for; a short one that
                    // gets here lost the game some other way. Either way, getting
                    // back in is auto-repair's job - it knows the login screen
                    // and it verifies before clicking resumes, which this loop
                    // cannot do for itself.
                    return this.stop(`${tier.kind} idle break over after `
                        + `${Math.round(result.idleMs / 60000)} min - the game logged `
                        + 'out, log back in and resume');
                }

                // Still logged in, which is the normal end of a short break. The
                // world moved on while we were away, so re-assess from scratch.
                this._lastLocationChangeAt = Date.now();
                this._clicksSinceChange = 0;
                continue;
            }

            // Checked before the click decision: a watchdog stop must always
            // win over a click that is otherwise ready to fire.
            const reason = this._watchdogReason(now);
            if (reason) {
                this._emitTick(payload, 'stopped');
                return this.stop(reason);
            }

            const decision = this._decide(payload, now - cycleStart);
            this._emitTick(payload, decision.ok ? 'clicking' : 'polling');

            if (!decision.ok) {
                if (decision.warn) this._warn(decision.warn);
                await this._sleep(this._pollGapMs(cycleStart));
                continue;
            }

            // Hard floor, enforced regardless of config or humanisation.
            const floorMs = this._floorMs();
            // No `if (this._lastClickAt)` short-circuit: a zero would skip the
            // floor entirely, which is exactly how the runaway happened.
            const sinceClick = Date.now() - Math.max(this._lastClickAt, lastClickAtGlobal);
            if (sinceClick < floorMs) {
                await this._sleep(floorMs - sinceClick);
                continue;
            }

            this._phase = 'clicking';
            if (!this._alive(gen)) return;

            // A real hand does not commit the instant it decides. pre-hesitation
            // is a freeze before the click; delayed-commit lands it slightly
            // late. Both are sub-200ms and deliberately rare.
            let imperfection = null;
            if (this._humanizeFor(decision.locCfg)) {
                imperfection = this._imperfections.evaluate(
                    this._fatigue.at(Date.now() - this._startedAt));
                if (imperfection && imperfection.delayMs > 0) {
                    await this._sleep(Math.round(imperfection.delayMs));
                    if (!this._alive(gen)) return;
                }
            }

            this._lastClickAt = Date.now();
            lastClickAtGlobal = this._lastClickAt;
            try {
                await this._clicker.click(decision.at.x, decision.at.y);
            } catch (err) {
                this._warn(`click backend failed: ${err.message || err}`);
                return this.stop('click backend failed');
            }

            // stop() may have landed while the click was in flight. Bail before
            // touching counters or emitting, or the UI sees 'click' after 'stopped'.
            if (!this._alive(gen)) return;

            const clickIndex = this._clicks;
            this._clicks += 1;
            this._clicksSinceChange += 1;
            this._clicksThisRun += 1;
            if (decision.mode === 'fallback') {
                this._fallbackUsed = true;
                this._fallbacks += 1;
            }
            this._lastWarn = null;
            this._emit({
                type: 'click',
                location: decision.location,
                mode: decision.mode,
                at: decision.at,
                box: decision.box,
                dryRun: this._dryRunFlag(),
                clickIndex,
                imperfection: imperfection
                    ? { type: imperfection.type, delayMs: Math.round(imperfection.delayMs) }
                    : null
            });
            // A listener may have called stop() from that event.
            if (!this._alive(gen)) return;

            const spent = this._watchdogReason(Date.now());
            if (spent) return this.stop(spent);

            const wait = this._computeWait(decision.locCfg);
            this._emit({
                type: 'wait',
                location: decision.location,
                baseMs: wait.baseMs,
                appliedMs: wait.appliedMs,
                hesitationMs: wait.hesitationMs,
                pauseMs: wait.pauseMs
            });
            this._phase = wait.pauseMs > 0 ? 'paused' : 'waiting';
            this._nextAssessAt = Date.now() + wait.appliedMs;
            this._emitTick(payload, this._phase);
            await this._sleep(wait.appliedMs);
        }
    }

    /**
     * The first break tier that is due AND allowed here, or null.
     *
     * A tier that is due but standing in transit is warned about and left due -
     * deferring is correct, skipping would not be.
     */
    _dueBreak(locationId) {
        for (const tier of this._breaks || []) {
            const verdict = tier.due(locationId);
            if (!verdict.due) continue;
            if (!verdict.safe) {
                this._warn(verdict.reason);
                continue;
            }
            return tier;
        }
        return null;
    }

    async _poll() {
        const res = await this._fetch(`${this._url}/analyze/screen`, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!res) throw new Error('no response');
        if (res.ok === false) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    /**
     * Decide whether this frame may be clicked, and where.
     * @returns {{ok: boolean, warn?: string|null, ...}}
     */
    _decide(payload, ageMs) {
        const id = payload.location.id;
        const locCfg = this._route.locations[id];

        if (!locCfg) return { ok: false, warn: `no route entry for location "${id}" - not clicking` };
        if (!locCfg.enabled) return { ok: false, warn: `location "${id}" is disabled` };
        if (ageMs > STALE_RESPONSE_MS) {
            return { ok: false, warn: `response took ${ageMs} ms - too stale to click` };
        }

        const image = payload.image || {};
        const screenW = Number(image.width);
        const screenH = Number(image.height);
        if (!(screenW > 0) || !(screenH > 0)) {
            return { ok: false, warn: 'response carries no image size - cannot bound the click' };
        }

        if (locCfg.mode === 'fixed') {
            const point = locCfg.point;
            if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
                return { ok: false, warn: `location "${id}" is fixed mode with no point set` };
            }
            // Explicitly not humanised: the user picked this pixel by clicking it.
            const at = this._clampToScreen(Number(point.x), Number(point.y), screenW, screenH, id);
            return { ok: true, location: id, locCfg, mode: 'fixed', at, box: null };
        }

        const box = payload.target;
        if (!box || !Number.isFinite(Number(box.x)) || !Number.isFinite(Number(box.y))
            || !(Number(box.w) > 0) || !(Number(box.h) > 0)) {
            // No target is usually just "nothing to click here yet" - mid-
            // animation, between frames. But the green markers also reset at
            // random and only return once an obstacle is completed, so waiting
            // forever deadlocks. See _fallbackDecision for when we act on that.
            this._emptyPolls += 1;
            return this._fallbackDecision(payload, id, locCfg, screenW, screenH);
        }
        // A real detection ends the stuck episode and re-arms the fallback.
        this._emptyPolls = 0;
        this._fallbackUsed = false;

        let point;
        if (this._humanizeFor(locCfg)) {
            // The box sampling supplies the spread; perturb only adds the +-2px
            // correlated micro-structure it was written for.
            const sampled = pointInBox(box, this._rng, { marginFrac: DEFAULT_MARGIN_FRAC });
            point = this._position.perturb(sampled.x, sampled.y, Date.now() - this._startedAt);
        } else {
            point = { x: Number(box.cx), y: Number(box.cy) };
            if (!Number.isFinite(point.x)) point.x = Number(box.x) + Number(box.w) / 2;
            if (!Number.isFinite(point.y)) point.y = Number(box.y) + Number(box.h) / 2;
        }

        const at = this._clampToBox(point, box, screenW, screenH, id);
        if (!at) return { ok: false, location: id, locCfg, reason: 'target box is off-screen' };

        return {
            ok: true,
            location: id,
            locCfg,
            mode: 'target',
            at,
            box: { x: Number(box.x), y: Number(box.y), w: Number(box.w), h: Number(box.h) }
        };
    }

    _computeWait(locCfg) {
        const baseMs = Number(locCfg.delayMs) || 0;
        const floorMs = this._floorMs();

        if (!this._humanizeFor(locCfg)) {
            return { baseMs, appliedMs: Math.max(baseMs, floorMs), hesitationMs: 0, pauseMs: 0 };
        }

        const d = humanizeDelay(baseMs, {
            rng: this._rng,
            fatigue: this._fatigue,
            hesitation: this._hesitation,
            pauses: this._pauses,
            sessionMs: Date.now() - this._startedAt
        });
        return {
            baseMs,
            appliedMs: Math.max(d.appliedMs, floorMs),
            hesitationMs: d.hesitationMs,
            pauseMs: d.pauseMs
        };
    }

    // ── watchdog ───────────────────────────────────────────

    _trackLocation(id, now) {
        if (id !== this._lastLocation) {
            this._lastLocation = id;
            this._lastLocationChangeAt = now;
            this._clicksSinceChange = 0;
        }
    }

    /** Applies to transit exactly as it applies to a spot. */
    _watchdogReason(now) {
        const wd = this._route.watchdog;
        const still = now - this._lastLocationChangeAt;
        if (still >= wd.sameLocationMs) {
            const where = this._lastLocation ? `location "${this._lastLocation}"` : 'no location';
            return `watchdog: ${where} unchanged for ${Math.round(still / 1000)}s`;
        }
        if (this._clicksSinceChange >= wd.maxClicksWithoutLocationChange) {
            return `watchdog: ${this._clicksSinceChange} clicks with no location change`;
        }

        // Both checks above reset whenever the reported id changes, so a
        // classifier flapping between two locations makes them unreachable and
        // leaves total clicks unbounded. These two do not reset on a change.
        if (wd.maxClicksPerRun && this._clicksThisRun >= wd.maxClicksPerRun) {
            return `watchdog: run click cap reached (${this._clicksThisRun})`;
        }
        if (wd.maxRunMs && now - this._startedAt >= wd.maxRunMs) {
            const mins = Math.round((now - this._startedAt) / 60000);
            return `watchdog: run time cap reached (${mins} min)`;
        }
        return null;
    }

    // ── helpers ────────────────────────────────────────────

    _alive(gen) {
        return this._running && gen === this._generation;
    }

    _dryRunFlag() {
        return this._clicker && this._clicker.dryRun !== undefined
            ? Boolean(this._clicker.dryRun)
            : this._dryRun;
    }

    _humanizeFor(locCfg) {
        if (!this._humanizerOn) return false;
        if (this._route.humanize === false) return false;
        if (locCfg && locCfg.humanize === false) return false;
        return true;
    }

    _floorMs() {
        return Math.max(ABSOLUTE_MIN_CLICK_MS, Number(this._route.minClickIntervalMs) || 0);
    }

    _pollGapMs(cycleStart) {
        const interval = 1000 / (Number(this._route.pollHz) || 3);
        return Math.max(0, Math.round(interval - (Date.now() - cycleStart)));
    }

    /**
     * The recovery click for when the markers have reset and nothing is detected.
     *
     * `fallback` is the service's median position for this location, learned from
     * hand-labelled frames - not a guess. It is still a click with no detection
     * behind it, so every guard below has to hold before it fires.
     */
    _fallbackDecision(payload, id, locCfg, screenW, screenH) {
        const fb = this._route.fallback;
        const point = payload.fallback;

        if (!fb || fb.enabled === false) return { ok: false, warn: null };
        // transit has its own explicit fixed point; never guess there.
        if (locCfg.mode !== 'target') return { ok: false, warn: null };
        if (!point || !Number.isFinite(Number(point.cx)) || !Number.isFinite(Number(point.cy))) {
            return { ok: false, warn: null };
        }
        // One empty poll is almost always mid-animation. Acting on it would
        // double-click an obstacle already in progress.
        if (this._emptyPolls < fb.afterEmptyPolls) return { ok: false, warn: null };
        // With the markers gone the scene looks different; if the classifier is
        // also unsure, two uncertainties are not a reason to click.
        if (Number(payload.location.confidence) < fb.minConfidence) {
            return { ok: false, warn: `no target at "${id}" and confidence is too low `
                + 'for the learned fallback' };
        }
        // Once per stuck episode. Without this a genuinely stuck run would
        // machine-gun one coordinate, which is the worst failure available here.
        if (this._fallbackUsed) return { ok: false, warn: null };

        // Deliberately NOT marked used here. The click can still be deferred by
        // the min-interval floor, which restarts the cycle - consuming the flag
        // at decision time spent it without ever clicking, and the fallback then
        // never fired again. It is consumed where the click actually lands.
        const at = this._clampToScreen(Number(point.cx), Number(point.cy), screenW, screenH, id);
        return {
            ok: true,
            location: id,
            locCfg,
            mode: 'fallback',
            at,
            box: null,
            source: point.source || null
        };
    }

    _clampToScreen(x, y, screenW, screenH, id) {
        const cx = clamp(Math.round(x), 0, screenW - 1);
        const cy = clamp(Math.round(y), 0, screenH - 1);
        if (cx !== Math.round(x) || cy !== Math.round(y)) {
            this._warn(`click point for "${id}" fell outside the screen - clamped to ${cx},${cy}`);
        }
        return { x: cx, y: cy };
    }

    _clampToBox(point, box, screenW, screenH, id) {
        const bx = Number(box.x);
        const by = Number(box.y);
        const lox = Math.ceil(bx);
        const loy = Math.ceil(by);
        const hix = Math.max(lox, Math.floor(bx + Number(box.w)) - 1);
        const hiy = Math.max(loy, Math.floor(by + Number(box.h)) - 1);

        // If the box does not intersect the screen there is no point that is both
        // inside the box and on-screen. Clamping to the screen would silently
        // click whatever window happens to sit at the edge, so refuse instead -
        // "inside the target box" is the promise, and a click is not recoverable.
        if (hix < 0 || hiy < 0 || lox > screenW - 1 || loy > screenH - 1) {
            this._warn(`target box for "${id}" (${lox},${loy}..${hix},${hiy}) lies outside the `
                + `${screenW}x${screenH} screen - refusing to click`);
            return null;
        }

        const rx = Math.round(point.x);
        const ry = Math.round(point.y);
        // Intersect box with screen first, so the clamp cannot leave the box.
        const cx = clamp(rx, Math.max(lox, 0), Math.min(hix, screenW - 1));
        const cy = clamp(ry, Math.max(loy, 0), Math.min(hiy, screenH - 1));
        if (cx !== rx || cy !== ry) {
            this._warn(`click point for "${id}" fell outside its target box - clamped to ${cx},${cy}`);
        }
        return { x: cx, y: cy };
    }

    _sleep(ms) {
        if (!(ms > 0)) return Promise.resolve();
        return new Promise((resolve) => {
            const entry = { id: null, resolve };
            entry.id = setTimeout(() => {
                this._timers.delete(entry);
                resolve();
            }, ms);
            this._timers.add(entry);
        });
    }

    /** No orphan timer may survive to resurrect a click. */
    _clearTimers() {
        for (const entry of this._timers) {
            clearTimeout(entry.id);
            entry.resolve();
        }
        this._timers.clear();
    }

    _emit(event) {
        try {
            this._onEvent(event);
        } catch (err) {
            // A throwing listener must never leave the loop clicking blind.
            console.error(`[harness] event listener threw: ${err && err.message}`);
        }
    }

    _emitTick(payload, phase) {
        const tick = payload
            ? {
                location: payload.location.id,
                confidence: Number(payload.location.confidence) || 0,
                hasTarget: Boolean(payload.target),
                clickables: Array.isArray(payload.clickables) ? payload.clickables : []
            }
            : { location: null, confidence: 0, hasTarget: false, clickables: [] };

        this._lastTick = tick;
        this._emit({
            type: 'tick',
            location: tick.location,
            confidence: tick.confidence,
            hasTarget: tick.hasTarget,
            clickables: tick.clickables,
            phase
        });
    }

    /** Deduped: a dead service must not emit three warnings a second. */
    _warn(message) {
        if (!message || message === this._lastWarn) return;
        this._lastWarn = message;
        this._emit({ type: 'warn', message });
    }
}

module.exports = {
    Harness,
    humanizeDelay,
    ABSOLUTE_MIN_CLICK_MS,
    STALE_RESPONSE_MS,
    DEFAULT_URL
};
