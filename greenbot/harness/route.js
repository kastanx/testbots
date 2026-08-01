'use strict';

const fs = require('fs');
const path = require('path');

// The break bounds live with the code that knows why they exist.
const { defaultBreaks, MIN_IDLE_MS, SHORT_MAX_IDLE_MS, TIERS } = require('./breaks.js');
const { defaultDaily, parseClock, EVENTS } = require('./daily.js');

const ROUTE_PATH = path.join(__dirname, 'route.json');

/*
 * Default delays are the inter-click deltas of the "releka android" recording in
 * REPO/recordings.json: 2544, 12334, 6630, 9546, 11610, 6069, 11332, 7045 ms.
 *
 * delayMs is the wait AFTER a location has been clicked, so a location takes the
 * delta that FOLLOWS its own click - spot_01 -> deltas[1], spot_02 -> deltas[2],
 * ... spot_06 -> deltas[6], transit -> deltas[7]. deltas[0] is the lead-in
 * before the recording's first click: it belongs to no location and is dropped.
 */
const DEFAULTS = deepFreeze({
    pollHz: 3,
    humanize: true,
    minClickIntervalMs: 1200,
    // The green markers reset at random and only come back once an obstacle is
    // completed, so a run that only ever waits deadlocks. When nothing is
    // detected, fall back to the service's learned median position for the spot.
    // Guarded hard, because it is a click with no detection behind it.
    fallback: {
        enabled: true,
        afterEmptyPolls: 3,     // one empty poll is usually just mid-animation
        minConfidence: 0.9      // markers gone AND unsure where we are -> don't
    },

    // Two tiers of human-scale break: `short` pauses without logging out,
    // `long` idles past the game's own 5 min timer so it logs out and hands the
    // session to auto-repair. See breaks.js for the reasoning behind the bounds.
    breaks: defaultBreaks(),

    // Wall-clock breaks: lunch, dinner, sleep. What turns a clicker that runs
    // for 24 hours into one that looks like a person with a routine.
    daily: defaultDaily(),

    // Hands a watchdog stop to Claude Code, then decides for ITSELF whether
    // clicking may resume. Off by default: enabling it lets the machine restart
    // an auto-clicker unattended, which is a decision the user makes once.
    autoRepair: {
        enabled: false,
        // The rate limit is what prevents a runaway; the lifetime cap is what
        // would stop an overnight session. 0 means unlimited - start it once and
        // it keeps recovering until the panel is closed.
        maxCyclesPerHour: 6,
        globalMaxCycles: 0,
        claudeTimeoutMs: 600000,
        verifyPlayableMs: 90000,
        verifyHealthyMs: 180000,
        minConfidence: 0.7,
        consecutivePolls: 3,
        pollMs: 3000
    },

    // The first two reset whenever the location id changes; the last two never
    // do, so a flapping classifier cannot leave total clicks unbounded.
    watchdog: {
        sameLocationMs: 300000,
        maxClicksWithoutLocationChange: 6,
        // 0 = unlimited, and that is the default. These exist only as a backstop
        // for a classifier that flaps between two locations and so never trips
        // the two id-based watchdogs above. For a bot meant to run overnight,
        // stopping a healthy session at an arbitrary hour count is worse than
        // the thing they guard against - set them if you want a bounded session.
        maxClicksPerRun: 0,
        maxRunMs: 0
    },
    locations: {
        spot_01: { mode: 'target', delayMs: 12334, enabled: true },
        spot_02: { mode: 'target', delayMs: 6630, enabled: true },
        spot_03: { mode: 'target', delayMs: 9546, enabled: true },
        spot_04: { mode: 'target', delayMs: 11610, enabled: true },
        spot_05: { mode: 'target', delayMs: 6069, enabled: true },
        spot_06: { mode: 'target', delayMs: 11332, enabled: true },
        transit: { mode: 'fixed', point: null, delayMs: 7045, humanize: false, enabled: true }
    }
});

// Bounds exist to catch a typo, not to second-guess the user. The 1 s floor on
// sameLocationMs is deliberate - it is what makes the watchdog testable.
const LIMITS = {
    pollHz: [0.5, 10],
    delayMs: [250, 600000],
    minClickIntervalMs: [250, 60000],
    sameLocationMs: [1000, 21600000],
    maxClicksWithoutLocationChange: [1, 1000],
    // 0 is a legal value meaning "no cap", so the floor is 0 rather than 1.
    maxClicksPerRun: [0, 1000000],
    maxRunMs: [0, 604800000],
    // Never below 2: acting on a single empty poll would double-click an
    // obstacle that is merely mid-animation.
    afterEmptyPolls: [2, 100],
    minConfidence: [0.5, 1],

    minPlayMs: [60000, 86400000],
    maxPlayMs: [60000, 86400000],

    maxCyclesPerHour: [1, 60],
    globalMaxCycles: [0, 100000],   // 0 = unlimited
    claudeTimeoutMs: [30000, 3600000],
    verifyPlayableMs: [10000, 600000],
    verifyHealthyMs: [10000, 1800000],
    // Never 1: a single lucky frame must not be enough to resume an auto-clicker.
    consecutivePolls: [2, 20],
    autoPollMs: [500, 30000],
    autoMinConfidence: [0.5, 1]
};

// Meals and sleep must all outlast the idle-logout timer, so they end with the
// character logged out and auto-repair brings it back.
const DAILY_LIMITS = {
    minPlayBeforeMs: [0, 21600000],
    lunch: [MIN_IDLE_MS, 14400000],
    dinner: [MIN_IDLE_MS, 14400000],
    sleep: [MIN_IDLE_MS, 57600000]
};

const IDLE_LIMITS = {
    long: [MIN_IDLE_MS, 21600000],
    short: [1000, SHORT_MAX_IDLE_MS]
};

const MODES = ['target', 'fixed'];
const TOP_LEVEL_KEYS = Object.keys(DEFAULTS);
const WATCHDOG_KEYS = Object.keys(DEFAULTS.watchdog);
const FALLBACK_KEYS = Object.keys(DEFAULTS.fallback);
const AUTOREPAIR_KEYS = Object.keys(DEFAULTS.autoRepair);
const BREAK_KEYS = Object.keys(DEFAULTS.breaks.short);
const DAILY_EVENT_KEYS = ['enabled', 'at', 'minMs', 'maxMs'];
const LOCATION_KEYS = ['mode', 'point', 'delayMs', 'humanize', 'enabled'];

// Used when the file names a location the pinned defaults never heard of.
const UNKNOWN_LOCATION_DEFAULT = { mode: 'target', delayMs: 5000, enabled: true };

function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) deepFreeze(value[key]);
        Object.freeze(value);
    }
    return value;
}

/** A fresh, mutable copy of the pinned defaults - the UI's "reset to recorded timings". */
function defaultRoute() {
    return structuredClone(DEFAULTS);
}

function clampNumber(value, limits, fallback, label, warnings) {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) {
        warnings.push(`${label} is not a number - using ${fallback}`);
        return fallback;
    }
    const clamped = Math.min(limits[1], Math.max(limits[0], n));
    if (clamped !== n) warnings.push(`${label} ${n} clamped to ${clamped}`);
    return clamped;
}

function asBoolean(value, fallback, label, warnings) {
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    warnings.push(`${label} is not a boolean - using ${fallback}`);
    return fallback;
}

function asPoint(value, label, warnings) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object' && !Array.isArray(value)
        && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))) {
        return { x: Math.round(Number(value.x)), y: Math.round(Number(value.y)) };
    }
    warnings.push(`${label} is not {x, y} - using null`);
    return null;
}

function validateLocation(id, raw, warnings) {
    const base = DEFAULTS.locations[id]
        ? structuredClone(DEFAULTS.locations[id])
        : structuredClone(UNKNOWN_LOCATION_DEFAULT);

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.push(`locations.${id} is not an object - using defaults`);
        return base;
    }

    for (const key of Object.keys(raw)) {
        if (!LOCATION_KEYS.includes(key)) warnings.push(`unknown key "locations.${id}.${key}" ignored`);
    }

    if (raw.mode !== undefined) {
        if (MODES.includes(raw.mode)) base.mode = raw.mode;
        else warnings.push(`locations.${id}.mode "${raw.mode}" is not target|fixed - using "${base.mode}"`);
    }
    base.delayMs = clampNumber(raw.delayMs, LIMITS.delayMs, base.delayMs, `locations.${id}.delayMs`, warnings);
    base.enabled = asBoolean(raw.enabled, base.enabled, `locations.${id}.enabled`, warnings);

    if (raw.humanize !== undefined) {
        base.humanize = asBoolean(raw.humanize, base.humanize !== false, `locations.${id}.humanize`, warnings);
    }
    if (raw.point !== undefined) {
        base.point = asPoint(raw.point, `locations.${id}.point`, warnings);
    }
    // fixed mode always carries the key so the UI has something to bind to.
    if (base.mode === 'fixed' && base.point === undefined) base.point = null;

    return base;
}

/**
 * Fold an arbitrary object onto the pinned shape.
 * Unknown keys warn and are dropped, bad types fall back to the default with a
 * warning, numbers are clamped. Never throws - a broken file must still boot.
 *
 * @returns {{ route: object, warnings: string[] }}
 */
function validateRoute(raw) {
    const warnings = [];
    const route = defaultRoute();

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        if (raw !== undefined) warnings.push('route is not an object - using defaults');
        return { route, warnings };
    }

    for (const key of Object.keys(raw)) {
        if (!TOP_LEVEL_KEYS.includes(key)) warnings.push(`unknown key "${key}" ignored`);
    }

    route.pollHz = clampNumber(raw.pollHz, LIMITS.pollHz, DEFAULTS.pollHz, 'pollHz', warnings);
    route.humanize = asBoolean(raw.humanize, DEFAULTS.humanize, 'humanize', warnings);
    route.minClickIntervalMs = clampNumber(raw.minClickIntervalMs, LIMITS.minClickIntervalMs,
        DEFAULTS.minClickIntervalMs, 'minClickIntervalMs', warnings);

    const wd = raw.watchdog;
    if (wd !== undefined) {
        if (wd === null || typeof wd !== 'object' || Array.isArray(wd)) {
            warnings.push('watchdog is not an object - using defaults');
        } else {
            for (const key of Object.keys(wd)) {
                if (!WATCHDOG_KEYS.includes(key)) warnings.push(`unknown key "watchdog.${key}" ignored`);
            }
            route.watchdog.sameLocationMs = clampNumber(wd.sameLocationMs, LIMITS.sameLocationMs,
                DEFAULTS.watchdog.sameLocationMs, 'watchdog.sameLocationMs', warnings);
            route.watchdog.maxClicksWithoutLocationChange = Math.round(clampNumber(
                wd.maxClicksWithoutLocationChange, LIMITS.maxClicksWithoutLocationChange,
                DEFAULTS.watchdog.maxClicksWithoutLocationChange,
                'watchdog.maxClicksWithoutLocationChange', warnings));
            route.watchdog.maxClicksPerRun = Math.round(clampNumber(
                wd.maxClicksPerRun, LIMITS.maxClicksPerRun,
                DEFAULTS.watchdog.maxClicksPerRun, 'watchdog.maxClicksPerRun', warnings));
            route.watchdog.maxRunMs = clampNumber(wd.maxRunMs, LIMITS.maxRunMs,
                DEFAULTS.watchdog.maxRunMs, 'watchdog.maxRunMs', warnings);
        }
    }

    const fb = raw.fallback;
    if (fb !== undefined) {
        if (fb === null || typeof fb !== 'object' || Array.isArray(fb)) {
            warnings.push('fallback is not an object - using defaults');
        } else {
            for (const key of Object.keys(fb)) {
                if (!FALLBACK_KEYS.includes(key)) warnings.push(`unknown key "fallback.${key}" ignored`);
            }
            route.fallback.enabled = asBoolean(fb.enabled, DEFAULTS.fallback.enabled,
                'fallback.enabled', warnings);
            route.fallback.afterEmptyPolls = Math.round(clampNumber(fb.afterEmptyPolls,
                LIMITS.afterEmptyPolls, DEFAULTS.fallback.afterEmptyPolls,
                'fallback.afterEmptyPolls', warnings));
            route.fallback.minConfidence = clampNumber(fb.minConfidence, LIMITS.minConfidence,
                DEFAULTS.fallback.minConfidence, 'fallback.minConfidence', warnings);
        }
    }

    const br = raw.breaks;
    if (br !== undefined) {
        if (br === null || typeof br !== 'object' || Array.isArray(br)) {
            warnings.push('breaks is not an object - using defaults');
        } else {
            // Files written before breaks were split into tiers hold one flat
            // block, and that block was the long break. Read it as one rather
            // than warning about every key and silently dropping the config.
            const tiers = TIERS.some((t) => br[t] !== undefined)
                ? br
                : { long: br };
            if (tiers !== br) warnings.push('breaks used the old flat shape - read as breaks.long');

            for (const key of Object.keys(tiers)) {
                if (!TIERS.includes(key)) warnings.push(`unknown key "breaks.${key}" ignored`);
            }

            for (const tier of TIERS) {
                const raw2 = tiers[tier];
                if (raw2 === undefined) continue;
                if (raw2 === null || typeof raw2 !== 'object' || Array.isArray(raw2)) {
                    warnings.push(`breaks.${tier} is not an object - using defaults`);
                    continue;
                }
                const out = route.breaks[tier];
                const defs = DEFAULTS.breaks[tier];
                for (const key of Object.keys(raw2)) {
                    if (!BREAK_KEYS.includes(key)) {
                        warnings.push(`unknown key "breaks.${tier}.${key}" ignored`);
                    }
                }
                out.enabled = asBoolean(raw2.enabled, defs.enabled,
                    `breaks.${tier}.enabled`, warnings);
                for (const key of ['minPlayMs', 'maxPlayMs']) {
                    out[key] = Math.round(clampNumber(raw2[key], LIMITS[key], defs[key],
                        `breaks.${tier}.${key}`, warnings));
                }
                for (const key of ['minIdleMs', 'maxIdleMs']) {
                    out[key] = Math.round(clampNumber(raw2[key], IDLE_LIMITS[tier], defs[key],
                        `breaks.${tier}.${key}`, warnings));
                }
                // A min above its max would make the range empty and the sampler
                // would return nonsense, so swap rather than silently misbehave.
                for (const [lo, hi] of [['minPlayMs', 'maxPlayMs'], ['minIdleMs', 'maxIdleMs']]) {
                    if (out[lo] > out[hi]) {
                        warnings.push(`breaks.${tier}.${lo} was above ${hi} - swapped`);
                        const t = out[lo];
                        out[lo] = out[hi];
                        out[hi] = t;
                    }
                }
            }
        }
    }

    const dy = raw.daily;
    if (dy !== undefined) {
        if (dy === null || typeof dy !== 'object' || Array.isArray(dy)) {
            warnings.push('daily is not an object - using defaults');
        } else {
            for (const key of Object.keys(dy)) {
                if (key !== 'minPlayBeforeMs' && !EVENTS.includes(key)) {
                    warnings.push(`unknown key "daily.${key}" ignored`);
                }
            }
            route.daily.minPlayBeforeMs = Math.round(clampNumber(dy.minPlayBeforeMs,
                DAILY_LIMITS.minPlayBeforeMs, DEFAULTS.daily.minPlayBeforeMs,
                'daily.minPlayBeforeMs', warnings));

            for (const kind of EVENTS) {
                const rawEv = dy[kind];
                if (rawEv === undefined) continue;
                if (rawEv === null || typeof rawEv !== 'object' || Array.isArray(rawEv)) {
                    warnings.push(`daily.${kind} is not an object - using defaults`);
                    continue;
                }
                const out = route.daily[kind];
                const defs = DEFAULTS.daily[kind];
                for (const key of Object.keys(rawEv)) {
                    if (!DAILY_EVENT_KEYS.includes(key)) {
                        warnings.push(`unknown key "daily.${kind}.${key}" ignored`);
                    }
                }
                out.enabled = asBoolean(rawEv.enabled, defs.enabled,
                    `daily.${kind}.enabled`, warnings);
                if (rawEv.at !== undefined) {
                    if (parseClock(rawEv.at) == null) {
                        warnings.push(`daily.${kind}.at "${rawEv.at}" is not HH:MM - `
                            + `using ${defs.at}`);
                    } else {
                        out.at = String(rawEv.at).trim();
                    }
                }
                for (const key of ['minMs', 'maxMs']) {
                    out[key] = Math.round(clampNumber(rawEv[key], DAILY_LIMITS[kind],
                        defs[key], `daily.${kind}.${key}`, warnings));
                }
                if (out.minMs > out.maxMs) {
                    warnings.push(`daily.${kind}.minMs was above maxMs - swapped`);
                    const t = out.minMs;
                    out.minMs = out.maxMs;
                    out.maxMs = t;
                }
            }
        }
    }

    const ar = raw.autoRepair;
    if (ar !== undefined) {
        if (ar === null || typeof ar !== 'object' || Array.isArray(ar)) {
            warnings.push('autoRepair is not an object - using defaults');
        } else {
            for (const key of Object.keys(ar)) {
                if (!AUTOREPAIR_KEYS.includes(key)) {
                    warnings.push(`unknown key "autoRepair.${key}" ignored`);
                }
            }
            route.autoRepair.enabled = asBoolean(ar.enabled, DEFAULTS.autoRepair.enabled,
                'autoRepair.enabled', warnings);
            for (const [key, limit] of [
                ['maxCyclesPerHour', LIMITS.maxCyclesPerHour],
                ['globalMaxCycles', LIMITS.globalMaxCycles],
                ['claudeTimeoutMs', LIMITS.claudeTimeoutMs],
                ['verifyPlayableMs', LIMITS.verifyPlayableMs],
                ['verifyHealthyMs', LIMITS.verifyHealthyMs],
                ['consecutivePolls', LIMITS.consecutivePolls],
                ['pollMs', LIMITS.autoPollMs]
            ]) {
                route.autoRepair[key] = Math.round(clampNumber(ar[key], limit,
                    DEFAULTS.autoRepair[key], `autoRepair.${key}`, warnings));
            }
            route.autoRepair.minConfidence = clampNumber(ar.minConfidence,
                LIMITS.autoMinConfidence, DEFAULTS.autoRepair.minConfidence,
                'autoRepair.minConfidence', warnings);
        }
    }

    const locations = raw.locations;
    if (locations !== undefined) {
        if (locations === null || typeof locations !== 'object' || Array.isArray(locations)) {
            warnings.push('locations is not an object - using defaults');
        } else {
            // A default location missing from the file is restored, not dropped:
            // the way to switch a spot off is enabled:false, not deletion.
            for (const id of Object.keys(locations)) {
                route.locations[id] = validateLocation(id, locations[id], warnings);
            }
        }
    }

    return { route, warnings };
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
}

/**
 * Read route.json, creating it from the pinned defaults when absent.
 * @returns {{ route: object, warnings: string[], path: string, created: boolean }}
 */
function loadRoute(filePath = ROUTE_PATH) {
    if (!fs.existsSync(filePath)) {
        const route = defaultRoute();
        writeJson(filePath, route);
        return { route, warnings: [], path: filePath, created: true };
    }

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        return {
            route: defaultRoute(),
            warnings: [`${path.basename(filePath)} is not valid JSON (${err.message}) - using defaults`],
            path: filePath,
            created: false
        };
    }

    const { route, warnings } = validateRoute(raw);
    return { route, warnings, path: filePath, created: false };
}

/** Validate then persist. Returns what was actually written. */
function saveRoute(route, filePath = ROUTE_PATH) {
    const validated = validateRoute(route);
    writeJson(filePath, validated.route);
    return { route: validated.route, warnings: validated.warnings, path: filePath };
}

module.exports = {
    DEFAULTS,
    LIMITS,
    ROUTE_PATH,
    defaultRoute,
    validateRoute,
    loadRoute,
    saveRoute
};
