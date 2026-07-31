// Replay engine used by the Electron app.
//
// Same behaviour as the CLI: either raw playback (exact recorded timing) or
// humanised playback via ReplayHumanizer, looping until stopped. Unlike the
// CLI this is controllable from outside (stop/pause) and reports progress.

const { mouse, Point, Button } = require('@nut-tree-fork/nut-js');
const { ReplayHumanizer } = require('./humanizer');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ReplayEngine {
    /**
     * @param {(event: object) => void} onEvent progress/state callback
     */
    constructor(onEvent) {
        this.onEvent = onEvent || (() => {});
        this.running = false;
        this.paused = false;
        this.stopRequested = false;
    }

    emit(type, payload = {}) {
        this.onEvent({ type, ...payload });
    }

    stop() {
        if (!this.running) return;
        this.stopRequested = true;
        this.paused = false;
    }

    setPaused(paused) {
        if (!this.running) return;
        this.paused = paused;
        this.emit('paused', { paused });
    }

    togglePause() {
        this.setPaused(!this.paused);
    }

    /** Sleep in slices so stop/pause stay responsive during long waits. */
    async interruptibleSleep(ms) {
        const SLICE = 50;
        let remaining = ms;
        while (remaining > 0) {
            if (this.stopRequested) return;
            while (this.paused && !this.stopRequested) await sleep(SLICE);
            const chunk = Math.min(SLICE, remaining);
            await sleep(chunk);
            remaining -= chunk;
        }
    }

    /**
     * @param {Array}  playlist  recordings [{name, events}] – picked at random each loop
     * @param {object} options   { humanize, durationMin }
     */
    async start(playlist, options = {}) {
        if (this.running) return;
        const clips = (playlist || []).filter((c) => c.events && c.events.length);
        if (!clips.length) {
            this.emit('error', { message: 'Nothing to play: no clicks in the selection.' });
            return;
        }

        const humanize = options.humanize !== false;
        const durationMin = Number(options.durationMin) > 0 ? Number(options.durationMin) : 120;

        this.running = true;
        this.paused = false;
        this.stopRequested = false;

        const deadline = Date.now() + durationMin * 60_000;
        let humanizer = null;

        if (humanize) {
            humanizer = new ReplayHumanizer({
                profileOverrides: { plannedDurationMinutes: durationMin }
            });
        }

        this.emit('started', {
            humanize,
            durationMin,
            clips: clips.length,
            seed: humanizer ? humanizer.seed : null,
            style: humanizer ? humanizer.profile.tempoStyle : null
        });

        let loop = 0;

        try {
            while (!this.stopRequested && Date.now() < deadline) {
                loop++;
                const clip = clips[Math.floor(Math.random() * clips.length)];

                this.emit('loop', {
                    loop,
                    name: clip.name,
                    total: clip.events.length,
                    elapsedMin: humanizer ? +(humanizer.sessionElapsed / 60000).toFixed(1) : null
                });

                if (humanize) {
                    await this.runPlan(humanizer.plan(clip.events), clip.events.length, humanizer);
                } else {
                    await this.runRaw(clip.events);
                }

                if (this.stopRequested) break;
                await this.interruptibleSleep(800 + Math.random() * 400);
            }
        } catch (err) {
            this.emit('error', { message: err.message });
        }

        const reachedDeadline = Date.now() >= deadline;
        this.running = false;
        this.paused = false;
        this.emit('stopped', { loops: loop, reachedDeadline });
    }

    async runRaw(events) {
        for (let i = 0; i < events.length; i++) {
            if (this.stopRequested) return;

            const event = events[i];
            const previous = i > 0 ? events[i - 1].time : 0;
            const wait = event.time - previous;

            if (wait > 0) await this.interruptibleSleep(wait);
            while (this.paused && !this.stopRequested) await sleep(50);
            if (this.stopRequested) return;

            await this.clickAt(event.x, event.y);
            this.emit('click', {
                index: i,
                total: events.length,
                x: event.x,
                y: event.y,
                waitMs: wait
            });
        }
    }

    async runPlan(plan, total, humanizer) {
        for (let i = 0; i < plan.length; i++) {
            if (this.stopRequested) return;

            const action = plan[i];

            if (action.waitMs > 0) await this.interruptibleSleep(Math.round(action.waitMs));
            while (this.paused && !this.stopRequested) await sleep(50);
            if (this.stopRequested) return;

            if (action.imperfection && action.imperfection.type === 'pre-hesitation') {
                await this.interruptibleSleep(Math.round(action.imperfection.delayMs));
            }

            await mouse.setPosition(new Point(Math.round(action.x), Math.round(action.y)));

            if (action.imperfection && action.imperfection.type === 'delayed-commit') {
                await this.interruptibleSleep(Math.round(action.imperfection.delayMs));
            }
            if (this.stopRequested) return;

            await mouse.click(Button.LEFT);

            this.emit('click', {
                index: i,
                total,
                x: Math.round(action.x),
                y: Math.round(action.y),
                waitMs: Math.round(action.waitMs),
                fatigue: +action.meta.fatigue.toFixed(2),
                hesitating: !!action.meta.hesitating,
                imperfection: action.imperfection ? action.imperfection.type : null
            });

            const pause = humanizer.checkPause();
            if (pause.shouldPause) {
                this.emit('pause-break', {
                    kind: pause.type,
                    durationMs: Math.round(pause.durationMs),
                    afterClick: i + 1
                });
                await this.interruptibleSleep(Math.round(pause.durationMs));
            }
        }
    }

    async clickAt(x, y) {
        await mouse.setPosition(new Point(Math.round(x), Math.round(y)));
        await mouse.click(Button.LEFT);
    }
}

module.exports = { ReplayEngine };
