'use strict';

const DEFAULT_MARGIN_FRAC = 0.15;
// Anything past this and the inset would swallow the box entirely.
const MAX_MARGIN_FRAC = 0.45;

function randomFn(rng) {
    if (typeof rng === 'function') return rng;
    if (rng && typeof rng.next === 'function') return () => rng.next();
    return Math.random;
}

/**
 * Sample one axis of the box.
 *
 * Distribution: the mean of two uniforms over the inset span - a symmetric
 * triangular distribution. Density peaks at the centre and falls linearly to
 * zero at the inset edges, so points cluster where a human aims without ever
 * crowding the border. std = span / sqrt(24), i.e. ~20% of the span.
 */
function sampleAxis(origin, size, marginFrac, rand) {
    if (!Number.isFinite(origin) || !Number.isFinite(size) || size <= 0) return origin;

    const pad = size * marginFrac;
    let lo = origin + pad;
    let hi = origin + size - pad;
    if (!(hi > lo)) {
        // A box so small the inset ate it: the centre is the only sane answer.
        lo = hi = origin + size / 2;
    }

    const t = (rand() + rand()) / 2;
    const value = lo + t * (hi - lo);

    // Never land exactly on an edge - the boundary pixel belongs as much to
    // whatever is behind the box as to the box itself.
    const eps = Math.min(1e-3, (hi - lo) * 1e-3);
    return Math.min(hi - eps, Math.max(lo + eps, value));
}

/**
 * Pick a click point inside a detected box.
 *
 * Pure and deterministic for a given rng, so it can be sampled in tests.
 * Always returns a point strictly inside the original box, including for
 * degenerate boxes (4x4, or w/h of 0).
 *
 * @param {{x:number,y:number,w:number,h:number,cx?:number,cy?:number}} box
 * @param {object|Function} [rng]  SeededRNG, a () => [0,1) function, or null
 * @param {{marginFrac?: number}} [options]
 * @returns {{x:number, y:number}}
 */
function pointInBox(box, rng, options = {}) {
    const rand = randomFn(rng);
    const raw = Number(options.marginFrac);
    const marginFrac = Number.isFinite(raw)
        ? Math.min(MAX_MARGIN_FRAC, Math.max(0, raw))
        : DEFAULT_MARGIN_FRAC;

    const b = box || {};
    const x = Number.isFinite(Number(b.x)) ? Number(b.x) : Number(b.cx) || 0;
    const y = Number.isFinite(Number(b.y)) ? Number(b.y) : Number(b.cy) || 0;
    const w = Number(b.w);
    const h = Number(b.h);

    return {
        x: sampleAxis(x, w, marginFrac, rand),
        y: sampleAxis(y, h, marginFrac, rand)
    };
}

/**
 * nut-js click backend. The only click backend there is.
 *
 * @param {{dryRun?: boolean}} [options]
 * @returns {{ click: (x:number, y:number) => Promise<object>, dryRun: boolean }}
 */
function createClicker(options = {}) {
    const dryRun = options.dryRun !== false;
    let nut = null;

    async function click(x, y) {
        const point = { x: Math.round(x), y: Math.round(y) };
        if (dryRun) return { x: point.x, y: point.y, dryRun: true };

        // Required lazily so a dry run works on a machine with no native addon.
        if (!nut) nut = require('@nut-tree-fork/nut-js');
        await nut.mouse.setPosition(new nut.Point(point.x, point.y));
        await nut.mouse.leftClick();
        return { x: point.x, y: point.y, dryRun: false };
    }

    return { click, dryRun };
}

module.exports = {
    DEFAULT_MARGIN_FRAC,
    createClicker,
    pointInBox
};
