/**
 * Humanization layer for replay-based click/tap automation.
 *
 * A "session" is the entire time replaying is active — potentially hours of
 * looping the same short recording.  All components are created once per
 * session and accumulate state continuously across every loop.
 *
 * Architecture:
 *   SeededRNG           – reproducible PRNG (xoshiro128**)
 *   SessionProfile      – per-session fingerprint controlling all behaviour
 *   TimeWarper          – continuous, open-ended time-warp over the session
 *   HesitationMachine   – state machine producing clustered pauses
 *   FatigueEnvelope     – long-term tempo/jitter envelope (absolute minutes)
 *   PositionHumanizer   – drifting bias + correlated jitter on click coords
 *   MicroImperfections  – rare, harmless glitches (delayed commit, dup tap)
 *   PauseScheduler      – natural breaks between loops (glance, short, long)
 *   ReplayHumanizer     – orchestrator: created once, plan() called per loop
 */

'use strict';

// ─────────────────────────────────────────────
//  1. Seeded PRNG  (xoshiro128** — 32-bit, fast, good quality)
// ─────────────────────────────────────────────

class SeededRNG {
    constructor(seed) {
        // Derive four 32-bit state words from an integer seed via splitmix32
        let s = seed >>> 0;
        const sm = () => {
            s = (s + 0x9e3779b9) >>> 0;
            let z = s;
            z = (z ^ (z >>> 16)) >>> 0;
            z = Math.imul(z, 0x85ebca6b);
            z = (z ^ (z >>> 13)) >>> 0;
            z = Math.imul(z, 0xc2b2ae35);
            z = (z ^ (z >>> 16)) >>> 0;
            return z;
        };
        this._s = [sm(), sm(), sm(), sm()];
    }

    /** Returns a float in [0, 1) */
    next() {
        const s = this._s;
        const result = Math.imul(s[1] * 5, 1 << 7 | 1) >>> 0;
        const t = (s[1] << 9) >>> 0;
        s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
        s[2] ^= t;
        s[3] = (s[3] << 11 | s[3] >>> 21) >>> 0;
        return (result >>> 0) / 0x100000000;
    }

    /** Gaussian via Box–Muller (mean 0, std 1) */
    gaussian() {
        let u, v, s;
        do { u = this.next() * 2 - 1; v = this.next() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
        return u * Math.sqrt(-2 * Math.log(s) / s);
    }

    /** Gaussian with given mean & std */
    gaussianMS(mean, std) {
        return mean + this.gaussian() * std;
    }

    /** Right-skewed positive value (log-normal-ish) */
    skewedPositive(median, spread) {
        return median * Math.exp(this.gaussian() * spread);
    }

    /** Uniform in [lo, hi) */
    uniform(lo, hi) {
        return lo + this.next() * (hi - lo);
    }

    /** Boolean with given probability */
    chance(p) {
        return this.next() < p;
    }

    /** Pick one element from array */
    pick(arr) {
        return arr[Math.floor(this.next() * arr.length)];
    }
}

// ─────────────────────────────────────────────
//  2. Session Profile
// ─────────────────────────────────────────────

class SessionProfile {
    /**
     * @param {SeededRNG} rng
     * @param {object}    [overrides] – partial overrides for tuning
     * @param {number}    [overrides.plannedDurationMinutes] – how long the session will run (drives fatigue calibration)
     */
    constructor(rng, overrides = {}) {
        // ── Planned session duration (the key input for fatigue scaling) ──
        const dur = overrides.plannedDurationMinutes || 120;

        // Timing drift: slow clock-rate offset  (e.g. 0.97 – 1.03)
        this.timingDriftRate = rng.uniform(0.97, 1.03);

        // Jitter strength multiplier (scales local timing noise)
        this.jitterStrength = rng.uniform(0.4, 1.6);

        // Hesitation likelihood baseline (0–1, higher = more pauses)
        this.hesitationLikelihood = rng.uniform(0.03, 0.15);

        // Click bias – a directional tendency for position offsets
        // Kept small so bias + jitter stays within the 2px hard radius
        this.clickBiasAngle = rng.uniform(0, Math.PI * 2);
        this.clickBiasStrength = rng.uniform(0.2, 0.8); // pixels

        // Tempo envelope style
        this.tempoStyle = rng.pick(['ramp', 'plateau', 'slow-start']);

        // Wobble parameters (low-frequency sinusoidal time modulation)
        this.wobbleFreq = rng.uniform(0.0003, 0.0012);   // cycles per ms
        this.wobbleAmp = rng.uniform(0.005, 0.025);       // fractional amplitude

        // Micro-imperfection base probability
        this.imperfectionRate = rng.uniform(0.005, 0.03);

        // ── Fatigue calibration (derived from planned duration) ──
        // Max fatigue: 5–12% slowdown at session end — subtle but perceptible
        this.maxFatigue = rng.uniform(1.05, 1.12);

        // Phase durations proportional to planned session length
        this.warmupMinutes = Math.max(1, Math.min(10, dur * rng.uniform(0.02, 0.06)));
        this.stableMinutes = dur * rng.uniform(0.40, 0.60);

        // Degradation fills the remaining time
        const degradeMinutes = Math.max(1, dur - this.warmupMinutes - this.stableMinutes);

        // Calibrate degradation rate so we reach 80–95% of maxFatigue by session end
        const targetReach = rng.uniform(0.80, 0.95);
        this.degradationK = -Math.log(1 - targetReach) / degradeMinutes;

        // Warm-up penalty peak: proportional to the max fatigue deviation
        this.warmupPeak = (this.maxFatigue - 1) * rng.uniform(0.3, 0.6);

        // Store for logging
        this.plannedDurationMinutes = dur;

        // Apply any user overrides (except plannedDurationMinutes which is consumed above)
        const { plannedDurationMinutes: _ignored, ...rest } = overrides;
        Object.assign(this, rest);
    }
}

// ─────────────────────────────────────────────
//  3. Continuous Time Warping  (per-loop relative, evolving across loops)
// ─────────────────────────────────────────────

class TimeWarper {
    /**
     * Warps *relative* recording time (0 … recordingDuration) so the
     * rhythm of each loop is preserved but subtly different.
     *
     * Between loops the RNG advances, so noise knots and drift evolve.
     *
     * @param {SessionProfile} profile
     * @param {SeededRNG}      rng
     */
    constructor(profile, rng) {
        this._profile = profile;
        this._rng = rng;

        // Slowly evolving drift offset — random-walks between loops
        this._driftOffset = 0;
    }

    /**
     * Generate a fresh set of noise knots for one loop.
     * Called once per plan() invocation so each loop is different
     * but internally smooth.
     *
     * @param {number} recordingDuration – ms length of the recording
     * @returns {number[]} knot values
     */
    _generateLoopKnots(recordingDuration) {
        const numKnots = Math.max(4, Math.ceil(recordingDuration / 5000));
        const knots = [];
        let val = 0;
        for (let i = 0; i <= numKnots; i++) {
            val += this._rng.gaussian() * 0.006;
            val *= 0.95; // mean-revert
            knots.push(val);
        }
        return knots;
    }

    /**
     * Warp a full loop of events (relative times 0…duration).
     *
     * Returns an array of warped relative times.
     * Guarantees monotonicity.
     *
     * @param {number[]} relativeTimes – event times relative to recording start
     * @param {number}   recordingDuration – total recording length (ms)
     * @returns {number[]} warped relative times
     */
    warpLoop(relativeTimes, recordingDuration) {
        const p = this._profile;
        const dur = recordingDuration || 1;

        // Evolve the per-loop drift offset (slow random walk)
        this._driftOffset += this._rng.gaussian() * 0.003;
        this._driftOffset *= 0.92; // mean-revert gently
        const loopDrift = p.timingDriftRate + this._driftOffset;

        // Fresh noise knots for this loop
        const knots = this._generateLoopKnots(recordingDuration);
        const knotCount = knots.length - 1;

        const warped = relativeTimes.map(t => {
            // Clock drift (linear scale, slightly different each loop)
            let w = t * loopDrift;

            // Low-frequency wobble (sinusoidal)
            w += Math.sin(t * p.wobbleFreq * Math.PI * 2) * p.wobbleAmp * dur;

            // Smooth correlated noise (interpolated from knots)
            const frac = t / dur;
            const knotIdx = frac * knotCount;
            const lo = Math.floor(knotIdx);
            const hi = Math.min(lo + 1, knotCount);
            const blend = knotIdx - lo;
            const smooth = blend * blend * (3 - 2 * blend);
            const noise = knots[lo] * (1 - smooth) + knots[hi] * smooth;
            w += noise * dur;

            return Math.max(0, w);
        });

        // Enforce strict monotonicity
        for (let i = 1; i < warped.length; i++) {
            if (warped[i] <= warped[i - 1]) {
                warped[i] = warped[i - 1] + 1;
            }
        }

        return warped;
    }
}

// ─────────────────────────────────────────────
//  4. Hesitation State Machine
// ─────────────────────────────────────────────

const HESITATION_STATE = { NORMAL: 0, HESITATING: 1 };

class HesitationMachine {
    /**
     * @param {SessionProfile} profile
     * @param {SeededRNG}      rng
     */
    constructor(profile, rng) {
        this._profile = profile;
        this._rng = rng;
        this._state = HESITATION_STATE.NORMAL;
        this._remainingHesitationEvents = 0;
    }

    /**
     * Evaluate hesitation for the next event.
     *
     * @param {number} fatigueFactor  – current fatigue multiplier (≥1)
     * @returns {{ extraDelay: number, isHesitating: boolean }}
     */
    evaluate(fatigueFactor) {
        const rng = this._rng;
        const baseLikelihood = this._profile.hesitationLikelihood;

        if (this._state === HESITATION_STATE.NORMAL) {
            // Probability of entering hesitation rises with fatigue
            const enterP = baseLikelihood * fatigueFactor;
            if (rng.chance(enterP)) {
                this._state = HESITATION_STATE.HESITATING;
                this._remainingHesitationEvents = Math.ceil(rng.skewedPositive(2, 0.5));
            }
        }

        if (this._state === HESITATION_STATE.HESITATING) {
            this._remainingHesitationEvents--;
            if (this._remainingHesitationEvents <= 0) {
                this._state = HESITATION_STATE.NORMAL;
            }
            // Right-skewed pause (log-normal): median ~120ms, long tail
            const pause = rng.skewedPositive(120, 0.7) * fatigueFactor;
            return { extraDelay: pause, isHesitating: true };
        }

        return { extraDelay: 0, isHesitating: false };
    }
}

// ─────────────────────────────────────────────
//  5. Fatigue & Tempo Envelope  (absolute elapsed time)
// ─────────────────────────────────────────────

class FatigueEnvelope {
    /**
     * @param {SessionProfile} profile
     */
    constructor(profile) {
        this._profile = profile;

        // Convert phase boundaries to ms
        this._warmupEnd = profile.warmupMinutes * 60_000;
        this._stableEnd = this._warmupEnd + profile.stableMinutes * 60_000;
    }

    /**
     * Returns a multiplier ≥ 1 representing how "fatigued" the session is
     * at absolute elapsed session time t.
     *
     * Calibrated so the maximum slowdown at the planned session end is
     * only 5–12% (profile.maxFatigue = 1.05–1.12).
     *
     * Phases (absolute time):
     *   [0 … warmupEnd)         – warm-up: slight penalty, tapering to 1.0
     *   [warmupEnd … stableEnd) – stable: ≈ 1.0 with tiny creep
     *   [stableEnd … ∞)         – degradation: slowly rising, asymptotic to maxFatigue
     *
     * @param {number} t – absolute session elapsed time (ms)
     * @returns {number} fatigue multiplier (1 = fresh, higher = fatigued)
     */
    at(t) {
        const p = this._profile;
        const maxDev = p.maxFatigue - 1; // e.g. 0.08 for 8% max slowdown

        if (t < this._warmupEnd) {
            // Warm-up: starts at 1 + warmupPeak, tapers toward 1.0
            const frac = t / this._warmupEnd;
            const penalty = this._warmupShape(frac);
            return 1 + penalty;
        }

        if (t < this._stableEnd) {
            // Stable: ≈ 1.0 with a tiny linear creep (at most 5% of maxDev)
            const frac = (t - this._warmupEnd) / (this._stableEnd - this._warmupEnd);
            return 1 + maxDev * 0.05 * frac;
        }

        // Degradation: saturating curve toward maxFatigue
        const degradeMinutes = (t - this._stableEnd) / 60_000;
        const degradation = maxDev * (1 - Math.exp(-p.degradationK * degradeMinutes));
        // Include the tiny stable-phase creep at its endpoint
        return 1 + maxDev * 0.05 + degradation;
    }

    /**
     * Warm-up penalty shape (returns value to add to 1.0, tapering to 0).
     * @param {number} frac – 0 at start, 1 at end of warm-up
     * @returns {number} penalty (starts at warmupPeak, ends ~0)
     */
    _warmupShape(frac) {
        const peak = this._profile.warmupPeak;

        switch (this._profile.tempoStyle) {
            case 'ramp':
                return peak * (1 - frac);
            case 'plateau':
                if (frac < 0.6) return peak;
                return peak * (1 - (frac - 0.6) / 0.4);
            case 'slow-start':
            default:
                return peak * Math.exp(-3 * frac);
        }
    }

    /**
     * Jitter scale at time t (fatigue increases jitter).
     * @param {number} t – absolute session time (ms)
     * @returns {number}
     */
    jitterScale(t) {
        return 1 + (this.at(t) - 1) * 0.6;
    }
}

// ─────────────────────────────────────────────
//  6. Click Position Humanizer
// ─────────────────────────────────────────────

class PositionHumanizer {
    /**
     * @param {SessionProfile} profile
     * @param {SeededRNG}      rng
     */
    constructor(profile, rng) {
        this._profile = profile;
        this._rng = rng;

        // Slowly drifting bias vector (initialised from profile)
        this._biasX = Math.cos(profile.clickBiasAngle) * profile.clickBiasStrength;
        this._biasY = Math.sin(profile.clickBiasAngle) * profile.clickBiasStrength;

        // Last offset (for correlation between consecutive clicks)
        this._lastOffsetX = 0;
        this._lastOffsetY = 0;
    }

    /**
     * Perturb a recorded click position.
     *
     * @param {number} x – original x
     * @param {number} y – original y
     * @param {number} sessionTime – absolute session time (ms) for drift evolution
     * @returns {{ x: number, y: number }}
     */
    perturb(x, y, sessionTime) {
        const rng = this._rng;
        const p = this._profile;

        // Evolve bias slowly (random walk with mean-reversion)
        this._biasX += rng.gaussian() * 0.15;
        this._biasY += rng.gaussian() * 0.15;
        // Mean-revert toward the session's preferred direction
        const targetBiasX = Math.cos(p.clickBiasAngle) * p.clickBiasStrength;
        const targetBiasY = Math.sin(p.clickBiasAngle) * p.clickBiasStrength;
        this._biasX += (targetBiasX - this._biasX) * 0.08;
        this._biasY += (targetBiasY - this._biasY) * 0.08;

        // Local jitter (correlated with previous offset for clustering)
        const correlation = 0.35;
        const rawJitterX = rng.gaussian() * 1.2;
        const rawJitterY = rng.gaussian() * 1.2;
        const jitterX = rawJitterX * (1 - correlation) + this._lastOffsetX * correlation;
        const jitterY = rawJitterY * (1 - correlation) + this._lastOffsetY * correlation;

        let totalOffsetX = this._biasX + jitterX;
        let totalOffsetY = this._biasY + jitterY;

        // Hard clamp: offset must stay within maxRadius (2px) of original position
        const maxRadius = 2;
        const dist = Math.sqrt(totalOffsetX * totalOffsetX + totalOffsetY * totalOffsetY);
        if (dist > maxRadius) {
            const scale = maxRadius / dist;
            totalOffsetX *= scale;
            totalOffsetY *= scale;
        }

        this._lastOffsetX = totalOffsetX;
        this._lastOffsetY = totalOffsetY;

        return {
            x: x + totalOffsetX,
            y: y + totalOffsetY
        };
    }
}

// ─────────────────────────────────────────────
//  7. Rare Micro-Imperfections
// ─────────────────────────────────────────────

/**
 * Imperfection types:
 *   'delayed-commit'  – click happens but slightly late (extra 30-90ms)
 *   'pre-hesitation'  – a brief freeze before an obvious action (40-150ms)
 */
class MicroImperfections {
    /**
     * @param {SessionProfile} profile
     * @param {SeededRNG}      rng
     */
    constructor(profile, rng) {
        this._profile = profile;
        this._rng = rng;
        this._cooldown = 0;
        this._clusterRemaining = 0;
    }

    /**
     * Decide if an imperfection should occur for the current event.
     *
     * @param {number} fatigueFactor
     * @returns {null | { type: string, delayMs: number, duplicate: boolean }}
     */
    evaluate(fatigueFactor) {
        const rng = this._rng;

        if (this._cooldown > 0) {
            this._cooldown--;
            if (this._clusterRemaining <= 0) return null;
        }

        // Clustering: if we're mid-cluster, continue
        if (this._clusterRemaining > 0) {
            this._clusterRemaining--;
            return this._generateImperfection(fatigueFactor);
        }

        // Decide whether to trigger
        const rate = this._profile.imperfectionRate * fatigueFactor;
        if (!rng.chance(rate)) return null;

        // Possibly start a cluster (2-3 imperfections in a row, rarely)
        if (rng.chance(0.2)) {
            this._clusterRemaining = Math.floor(rng.uniform(1, 3));
        }

        this._cooldown = Math.ceil(rng.uniform(5, 15));
        return this._generateImperfection(fatigueFactor);
    }

    _generateImperfection(fatigueFactor) {
        const rng = this._rng;
        const roll = rng.next();

        if (roll < 0.55) {
            return {
                type: 'delayed-commit',
                delayMs: rng.uniform(30, 90) * fatigueFactor,
            };
        } else {
            return {
                type: 'pre-hesitation',
                delayMs: rng.uniform(40, 150) * fatigueFactor,
            };
        }
    }
}

// ─────────────────────────────────────────────
//  8. Pause Scheduler  (restroom, distractions, breaks)
// ─────────────────────────────────────────────

/**
 * Pause types (between loops, not mid-sequence):
 *
 *   'glance'     – 3–8s    – looked away briefly, checked phone
 *   'short'      – 20–90s  – stretch, sip water, read a message
 *   'long'       – 30–120s – restroom, coffee, walked away
 *
 * Intervals are calibrated from planned session duration so that
 * a 1-hour session gets fewer pauses than a 10-hour session, but
 * the density per hour stays roughly constant.
 */
class PauseScheduler {
    /**
     * Counts individual clicks (not loops) so pauses can trigger
     * between any two clicks — mid-loop or at loop boundaries.
     *
     * @param {SessionProfile} profile
     * @param {SeededRNG}      rng
     */
    constructor(profile, rng) {
        this._profile = profile;
        this._rng = rng;

        const dur = profile.plannedDurationMinutes;

        // Intervals in clicks (a 7-click recording ≈ 1 min, so ×7).
        // Glance: every 15–30 min → 105–210 clicks
        this._glanceInterval = Math.round(rng.uniform(15, 30) * 7);
        // Short break: every 40–80 min → 280–560 clicks
        this._shortInterval = Math.round(rng.uniform(40, 80) * 7);
        // Long break: every 90–150 min → 630–1050 clicks (only for >60 min sessions)
        this._longInterval = dur > 60 ? Math.round(rng.uniform(90, 150) * 7) : Infinity;

        // Stagger initial counters so first pause isn't predictably at the start
        this._sinceGlance = Math.floor(rng.uniform(0, this._glanceInterval * 0.5));
        this._sinceShort = Math.floor(rng.uniform(0, this._shortInterval * 0.3));
        this._sinceLong = Math.floor(rng.uniform(0, this._longInterval * 0.2));

        // Cooldown in clicks after a pause
        this._cooldown = 0;
    }

    /**
     * Call once per click to decide whether to pause before the next action.
     *
     * @returns {{ shouldPause: boolean, type: string|null, durationMs: number }}
     */
    evaluate() {
        const rng = this._rng;

        this._sinceGlance++;
        this._sinceShort++;
        this._sinceLong++;

        if (this._cooldown > 0) {
            this._cooldown--;
            return { shouldPause: false, type: null, durationMs: 0 };
        }

        // Check long break first (rarest, highest priority)
        if (this._sinceLong >= this._longInterval) {
            const overdue = (this._sinceLong - this._longInterval) / this._longInterval;
            if (rng.chance(0.15 + overdue * 0.3)) {
                this._sinceLong = 0;
                this._sinceGlance = 0;
                this._sinceShort = 0;
                this._cooldown = Math.ceil(rng.uniform(30, 80)); // ~5–12 loops worth
                const dur = rng.skewedPositive(60_000, 0.4);
                const clamped = Math.min(Math.max(dur, 30_000), 120_000);
                return { shouldPause: true, type: 'long', durationMs: clamped };
            }
        }

        // Short break
        if (this._sinceShort >= this._shortInterval) {
            const overdue = (this._sinceShort - this._shortInterval) / this._shortInterval;
            if (rng.chance(0.20 + overdue * 0.3)) {
                this._sinceShort = 0;
                this._sinceGlance = 0;
                this._cooldown = Math.ceil(rng.uniform(14, 35)); // ~2–5 loops
                const dur = rng.skewedPositive(45_000, 0.5);
                const clamped = Math.min(Math.max(dur, 20_000), 90_000);
                return { shouldPause: true, type: 'short', durationMs: clamped };
            }
        }

        // Glance
        if (this._sinceGlance >= this._glanceInterval) {
            const overdue = (this._sinceGlance - this._glanceInterval) / this._glanceInterval;
            if (rng.chance(0.30 + overdue * 0.4)) {
                this._sinceGlance = 0;
                const dur = rng.uniform(3_000, 8_000);
                return { shouldPause: true, type: 'glance', durationMs: dur };
            }
        }

        return { shouldPause: false, type: null, durationMs: 0 };
    }
}

// ─────────────────────────────────────────────
//  9. ReplayHumanizer  (session-scoped orchestrator)
// ─────────────────────────────────────────────

class ReplayHumanizer {
    /**
     * Create once per session (the entire replay run, across all loops).
     *
     * @param {object} [options]
     * @param {number} [options.seed]              – integer seed; omit for random
     * @param {object} [options.profileOverrides]   – partial SessionProfile overrides
     */
    constructor(options = {}) {
        const seed = options.seed != null
            ? options.seed
            : (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;

        this._rng = new SeededRNG(seed);
        this._seed = seed;

        // Build all components once — they persist for the entire session
        this._profile = new SessionProfile(this._rng, options.profileOverrides || {});
        this._timeWarper = new TimeWarper(this._profile, this._rng);
        this._hesitation = new HesitationMachine(this._profile, this._rng);
        this._fatigue = new FatigueEnvelope(this._profile);
        this._posHumanizer = new PositionHumanizer(this._profile, this._rng);
        this._imperfections = new MicroImperfections(this._profile, this._rng);
        this._pauseScheduler = new PauseScheduler(this._profile, this._rng);

        // Session clock: absolute elapsed time (ms) across all loops
        this._sessionElapsed = 0;

        // Track the previous warped time for delta computation across loops
        this._prevWarpedTime = 0;

        // Loop counter (for logging)
        this._loopCount = 0;
    }

    /**
     * Plan the next loop of a recording.
     *
     * Call this once per loop iteration.  Session state (fatigue, hesitation,
     * position drift, time warping, imperfections) carries over from
     * previous calls.
     *
     * @param {Array<{x: number, y: number, time: number, button: number}>} events
     * @returns {Array<{
     *   originalIndex: number,
     *   x: number,
     *   y: number,
     *   button: number,
     *   waitMs: number,
     *   imperfection: null|object,
     *   meta: object
     * }>}
     */
    plan(events) {
        if (!events || events.length === 0) return [];

        this._loopCount++;
        const rng = this._rng;
        const profile = this._profile;
        const baseTime = events[0].time;
        const recordingDuration = events[events.length - 1].time - baseTime;

        // --- Time warp: applied to relative recording times (0…duration) ---
        // Each loop gets slightly different warping because the RNG evolves,
        // but the rhythm (relative structure) is always preserved.
        const relativeTimes = events.map(e => e.time - baseTime);
        const warpedRelative = this._timeWarper.warpLoop(relativeTimes, recordingDuration);

        // --- Build action plan ---
        const plan = [];
        let prevWarpedRel = 0;

        for (let i = 0; i < events.length; i++) {
            const event = events[i];

            // Original delta from the recording — this is the absolute minimum
            const originalDelta = i > 0 ? relativeTimes[i] - relativeTimes[i - 1] : relativeTimes[0];

            // Absolute session time for this event (for fatigue / position)
            const eventSessionTime = this._sessionElapsed + relativeTimes[i];

            const fatigueFactor = this._fatigue.at(eventSessionTime);
            const jitterScale = this._fatigue.jitterScale(eventSessionTime) * profile.jitterStrength;

            // Delta from warped relative times
            let delta = warpedRelative[i] - prevWarpedRel;

            // Tempo envelope scaling (fatigue slows things down)
            delta *= fatigueFactor;

            // Correlated jitter on delta
            const jitterMs = rng.gaussian() * 8 * jitterScale;
            delta = Math.max(originalDelta, delta + jitterMs);

            // Hesitation (stateful — carries across loops)
            const hesResult = this._hesitation.evaluate(fatigueFactor);
            if (hesResult.isHesitating) {
                delta += hesResult.extraDelay;
            }

            // Position (drift carries across loops)
            // If the event has randomize: false, use exact original coordinates
            const pos = event.randomize === false
                ? { x: event.x, y: event.y }
                : this._posHumanizer.perturb(event.x, event.y, eventSessionTime);

            // Micro-imperfection (cooldown/cluster state carries across loops)
            const imp = this._imperfections.evaluate(fatigueFactor);

            plan.push({
                originalIndex: i,
                x: pos.x,
                y: pos.y,
                button: event.button,
                waitMs: delta,
                imperfection: imp,
                meta: {
                    fatigue: fatigueFactor,
                    hesitating: hesResult.isHesitating,
                    warpedRelTime: warpedRelative[i],
                    sessionTime: eventSessionTime,
                    loop: this._loopCount
                }
            });

            prevWarpedRel = warpedRelative[i];
        }

        // Advance the session clock by the recording's duration
        this._sessionElapsed += recordingDuration;

        return plan;
    }

    /**
     * Check if a pause should happen between loops.
     * Call this after each loop completes.
     *
     * @returns {{ shouldPause: boolean, type: string|null, durationMs: number }}
     */
    checkPause() {
        return this._pauseScheduler.evaluate();
    }

    /** Expose the seed used (for logging / reproducibility) */
    get seed() {
        return this._seed;
    }

    /** Current session elapsed time in ms */
    get sessionElapsed() {
        return this._sessionElapsed;
    }

    /** Number of loops planned so far */
    get loopCount() {
        return this._loopCount;
    }

    /** The session profile (for inspection / logging) */
    get profile() {
        return this._profile;
    }
}

// ─────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────

module.exports = {
    SeededRNG,
    SessionProfile,
    TimeWarper,
    HesitationMachine,
    FatigueEnvelope,
    PositionHumanizer,
    MicroImperfections,
    PauseScheduler,
    ReplayHumanizer
};
