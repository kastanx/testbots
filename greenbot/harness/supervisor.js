'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOUR_MS = 3600000;

// npm installs three shims; .cmd is the one a Node child_process can execute.
// Bare 'claude' resolves to the extensionless shell script and 'claude.ps1'
// needs a PowerShell host.
//
// The repo-local install is preferred over the global one. A global install can
// land somewhere the user's own shell cannot see (sandboxed %APPDATA%), and a
// binary only this process can reach is worse than useless - the supervisor
// would work while the user could never test the same command by hand.
function resolveClaude() {
    const repo = path.join(__dirname, '..', '..');
    const candidates = [
        // The real executable, first by a long way. Node refuses to spawn a .cmd
        // with shell:false (the CVE-2024-27980 fix), and spawning it WITH a shell
        // would push a multi-line prompt through cmd.exe quoting. The .exe takes
        // argv directly and sidesteps both.
        path.join(repo, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
        path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
        path.join(repo, 'node_modules', '.bin', 'claude.cmd'),
        path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch (err) { /* keep looking */ }
    }
    return candidates[0];   // report the expected path in the "missing" message
}

const CLAUDE_CMD = resolveClaude();

// The CLI prints this when it has never been authenticated. Spawning it again
// cannot help, so it disables the loop rather than burning every cycle.
const NOT_LOGGED_IN = /not logged in|please run \/login/i;

// A run that hit its own click or time budget finished normally. Repairing that
// would restart a session the user deliberately bounded.
const NORMAL_FINISH = /click cap reached|time cap reached/i;

// Stops that came from a person, or from an escalation that already gave up.
const NOT_REPAIRABLE = /stopped by request|kill switch|window closed|repair gave up|F10/i;

// A planned break: the harness went idle until the game logged itself out, and
// stopped. Nothing is broken - the session just needs logging back in, which is
// the one thing a repair cycle is already good at.
const IDLE_BREAK = /idle break/i;

function defaultConfig() {
    return {
        enabled: false,
        maxCyclesPerHour: 3,
        globalMaxCycles: 10,
        claudeTimeoutMs: 600000,
        verifyPlayableMs: 90000,
        verifyHealthyMs: 180000,
        minConfidence: 0.7,
        consecutivePolls: 3,
        pollMs: 3000
    };
}

/**
 * Watches the harness, and when a stop looks like a broken game rather than a
 * finished run, hands the problem to Claude Code and then decides for itself
 * whether clicking may resume.
 *
 * It never resumes on Claude's say-so. A self-reported success that is wrong
 * would restart an auto-clicker into a dead game, so the supervisor verifies
 * against the vision service independently, twice: once that the game is
 * playable, and again later that clicking is actually progressing.
 */
class Supervisor {
    constructor(options = {}) {
        const {
            config = {},
            url = 'http://127.0.0.1:8765',
            spawnImpl = null,
            fetchImpl = null,
            onEvent = () => {},
            now = () => Date.now(),
            sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
            startHarness = () => false,
            stopHarness = () => {},
            getHarnessState = () => null,
            claudeCmd = CLAUDE_CMD,
            cwd = path.join(__dirname, '..', '..')
        } = options;

        this._cfg = Object.assign(defaultConfig(), config);
        this._url = String(url).replace(/\/+$/, '');
        this._spawn = spawnImpl || spawn;
        this._fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
        this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};
        this._now = now;
        this._sleep = sleep;
        this._startHarness = startHarness;
        this._stopHarness = stopHarness;
        this._getHarnessState = getHarnessState;
        this._claudeCmd = claudeCmd;
        this._cwd = cwd;

        this._active = false;
        this._aborted = false;
        this._disabled = null;        // reason string once permanently off
        this._child = null;
        this._cycleTimes = [];
        this._lifetime = 0;
        this._cycle = 0;
        this._retryTimer = null;
        this._stage = 'idle';
        this._lastGiveUp = null;
    }

    isActive() {
        return this._active;
    }

    stats() {
        return {
            active: this._active,
            stage: this._stage,
            cyclesThisHour: this._recent().length,
            lifetimeCycles: this._lifetime,
            lastGiveUp: this._lastGiveUp,
            disabled: this._disabled
        };
    }

    resetStats() {
        this._cycleTimes = [];
        this._lifetime = 0;
        this._lastGiveUp = null;
        this._disabled = null;
    }

    /** Kills any running child and blocks the resume that would have followed. */
    abort(reason = 'aborted') {
        this._aborted = true;
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
        this._killChild();
        if (this._active) this._emit({ type: 'auto:give-up', cycle: this._cycle, reason });
        this._stage = 'idle';
        return true;
    }

    // Rolling by timestamp: three cycles at 13:59 must not be joined by three
    // more at 14:01.
    _recent() {
        const cutoff = this._now() - HOUR_MS;
        this._cycleTimes = this._cycleTimes.filter((t) => t > cutoff);
        return this._cycleTimes;
    }

    _emit(event) {
        try {
            this._onEvent(event);
        } catch (err) {
            // A listener must never break the loop.
        }
    }

    /** Re-enter the loop once the rate-limit window has moved on. */
    _scheduleRetry(waitMs, reason) {
        clearTimeout(this._retryTimer);
        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            if (this._disabled || this._aborted || !this._cfg.enabled) return;
            this._emit({ type: 'auto:progress',
                message: 'rate-limit window cleared - retrying' });
            Promise.resolve(this.onHarnessStopped(reason)).catch(() => {});
        }, waitMs);
        if (this._retryTimer.unref) this._retryTimer.unref();
    }

    _giveUp(reason) {
        this._lastGiveUp = reason;
        this._stage = 'idle';
        this._emit({ type: 'auto:give-up', cycle: this._cycle, reason });
        return { ok: false, reason };
    }

    _disable(reason) {
        this._disabled = reason;
        this._stage = 'idle';
        this._emit({ type: 'auto:disabled', reason });
        return { ok: false, reason };
    }

    /** Whether this stop reason describes something a repair could fix. */
    repairable(reason) {
        const text = String(reason || '');
        if (!text) return false;
        if (NORMAL_FINISH.test(text)) return false;
        if (NOT_REPAIRABLE.test(text)) return false;
        if (IDLE_BREAK.test(text)) return true;
        return /watchdog|unreachable|disconnect|stale/i.test(text);
    }

    /**
     * Run a cycle on demand so the whole loop can be watched live.
     *
     * Skips only the repairable() filter - every cap, the concurrency guard and
     * both verifications still apply, so what you watch is what runs at 3am.
     */
    async testCycle(reason = 'manual test from the panel') {
        if (this._disabled) return { ok: false, reason: `auto-repair disabled: ${this._disabled}` };
        if (this._active) return { ok: false, reason: 'a cycle is already running' };
        this._aborted = false;
        return this._runCycle(reason);
    }

    async onHarnessStopped(reason) {
        if (this._disabled) return { ok: false, reason: `auto-repair disabled: ${this._disabled}` };
        if (!this._cfg.enabled) return { ok: false, reason: 'auto-repair is off' };
        if (this._active) return { ok: false, reason: 'a cycle is already running' };
        if (!this.repairable(reason)) {
            return { ok: false, reason: `"${reason}" is not a repairable stop` };
        }
        // 0 means unlimited. The hourly rate limit is what stops a runaway; a
        // lifetime cap would just end an overnight session for no good reason.
        if (this._cfg.globalMaxCycles > 0 && this._lifetime >= this._cfg.globalMaxCycles) {
            return this._giveUp(`lifetime repair cap reached (${this._cfg.globalMaxCycles})`);
        }
        const recent = this._recent();
        if (recent.length >= this._cfg.maxCyclesPerHour) {
            // Rate-limited, not finished. Nothing else will fire a 'stopped'
            // event while the harness sits idle, so without this the loop would
            // simply stall here and never come back.
            const waitMs = Math.max(1000, recent[0] + HOUR_MS - this._now() + 1000);
            const mins = Math.ceil(waitMs / 60000);
            this._scheduleRetry(waitMs, reason);
            return this._giveUp(`${recent.length} repairs in the last hour `
                + `(cap ${this._cfg.maxCyclesPerHour}) - retrying in ~${mins} min`);
        }
        return this._runCycle(reason);
    }

    async _runCycle(reason) {
        this._active = true;
        this._aborted = false;
        this._cycle += 1;
        this._lifetime += 1;
        this._cycleTimes.push(this._now());
        this._emit({ type: 'auto:cycle-start', cycle: this._cycle, reason, at: this._now() });

        try {
            this._stage = 'repairing';
            const claude = await this._runClaude(reason);
            if (this._aborted) return this._giveUp('aborted during repair');
            if (claude.notLoggedIn) {
                return this._disable('the claude CLI is not authenticated - '
                    + 'run `claude` once and use /login, then re-enable auto-repair');
            }
            if (claude.missing) {
                return this._disable(`claude CLI not found at ${this._claudeCmd} - `
                    + 'install it with: npm install -g @anthropic-ai/claude-code');
            }
            if (!claude.ok) {
                // "exited null" told me nothing when the spawn itself failed.
                // Surface the real cause: a launch error is a different problem
                // from a non-zero exit, and they need different fixes.
                if (claude.error) {
                    return this._giveUp(`could not launch ${path.basename(this._claudeCmd)}: `
                        + claude.error);
                }
                if (claude.timedOut) {
                    return this._giveUp(`claude timed out after `
                        + `${Math.round(this._cfg.claudeTimeoutMs / 1000)}s and was killed`);
                }
                return this._giveUp(`claude exited with code ${claude.code}`);
            }

            this._stage = 'verifying';

            // The skill restarts the clicker itself and watches it. If it already
            // did, do not fight it - just confirm independently below. Only start
            // it here when the skill did not.
            const alreadyRunning = Boolean((this._getHarnessState() || {}).running);

            if (!alreadyRunning) {
                const playable = await this._verifyPlayable();
                this._emit({ type: 'auto:verify', cycle: this._cycle, stage: 'playable',
                    ok: playable.ok, detail: playable.detail });
                if (!playable.ok) return this._giveUp(`still not playable: ${playable.detail}`);
                if (this._aborted) return this._giveUp('aborted before resuming');
            } else {
                this._emit({ type: 'auto:verify', cycle: this._cycle, stage: 'playable',
                    ok: true, detail: 'the repair skill already restarted the clicker' });
            }

            // Snapshot BEFORE resuming, so health is measured against the state
            // clicking started from rather than whatever it drifts to.
            const started = alreadyRunning || this._startHarness();
            if (!started) return this._giveUp('the harness refused to restart');
            const snapshot = this._snapshot();
            this._stage = 'resumed';
            this._emit({ type: 'auto:resumed', cycle: this._cycle, at: this._now() });

            await this._sleep(this._cfg.verifyHealthyMs);
            if (this._aborted) return { ok: false, reason: 'aborted after resuming' };

            const healthy = this._verifyHealthy(snapshot);
            this._emit({ type: 'auto:verify', cycle: this._cycle, stage: 'healthy',
                ok: healthy.ok, detail: healthy.detail });
            if (!healthy.ok) {
                this._stopHarness('auto-repair: resumed but not progressing');
                return this._giveUp(`resumed but not progressing: ${healthy.detail}`);
            }

            this._stage = 'idle';
            return { ok: true, cycle: this._cycle };
        } finally {
            this._active = false;
            this._child = null;
            if (this._stage !== 'idle') this._stage = 'idle';
        }
    }

    _prompt(reason) {
        const planned = IDLE_BREAK.test(String(reason || ''));
        return 'The greenbot OSRS clicker stopped on its own with this reason:\n'
            + `  "${reason}"\n\n`
            + (planned
                ? 'This one was PLANNED, not a failure. The bot took a human-style '
                    + 'break: it sat idle until the game logged the character out, '
                    + 'then stopped on purpose. Nothing is broken. Do not go hunting '
                    + 'for a fault - log back in (tap the buttons, never type '
                    + 'credentials) and get it playing again.\n\n'
                : '')
            + 'Use the "repair" skill. Follow it all the way through: get the game '
            + 'playable on the tablet over adb, set the camera to the canonical state, '
            + 'restart the clicker with harness/control.js start, and then confirm it '
            + 'is genuinely working with harness/control.js wait-healthy.\n\n'
            + 'Finish with a plain-text report: what was wrong, what you did, and '
            + 'whether the clicker is running and confirmed healthy. Be honest if you '
            + 'could not get there - a supervisor double-checks and will call you '
            + 'again, so a wrong "it is fine" is worse than an accurate failure.';
    }

    _runClaude(reason) {
        return new Promise((resolve) => {
            if (!fs.existsSync(this._claudeCmd)) {
                resolve({ ok: false, missing: true, code: null });
                return;
            }

            // stream-json, not plain -p: plain print mode buffers everything and
            // emits it only at the end, so a repair that takes minutes shows
            // nothing at all until it finishes. Watching it work is the whole
            // point of the test button.
            const args = ['-p', this._prompt(reason),
                '--output-format', 'stream-json', '--verbose',
                '--allowedTools', 'Bash', 'Read', 'Glob', 'Grep'];
            this._emit({ type: 'auto:claude-start', cycle: this._cycle,
                cmd: `${path.basename(this._claudeCmd)} -p ...` });

            const startedAt = this._now();
            let child;
            try {
                child = this._spawn(this._claudeCmd, args, {
                    cwd: this._cwd,
                    windowsHide: true,
                    shell: false,
                    // stdin closed: the CLI otherwise waits 3s for piped input
                    // before proceeding, and an unattended run has none to give.
                    stdio: ['ignore', 'pipe', 'pipe']
                });
            } catch (err) {
                resolve({ ok: false, code: null, error: String(err.message || err) });
                return;
            }
            this._child = child;

            let notLoggedIn = false;
            let settled = false;
            let lastResult = null;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this._child = null;
                this._emit({ type: 'auto:claude-done', cycle: this._cycle,
                    code: result.code, ms: this._now() - startedAt,
                    report: lastResult });
                resolve(result);
            };

            const say = (line) => {
                const text = String(line).trim();
                if (!text) return;
                this._emit({ type: 'auto:claude-output', cycle: this._cycle,
                    line: text.length > 300 ? `${text.slice(0, 300)}...` : text });
            };

            // stream-json emits one JSON object per line. Render it as readable
            // progress rather than dumping the raw protocol into the log.
            const onLine = (raw) => {
                const text = String(raw).trim();
                if (!text) return;
                if (NOT_LOGGED_IN.test(text)) notLoggedIn = true;

                let event;
                try {
                    event = JSON.parse(text);
                } catch (err) {
                    say(text);          // not JSON - a plain warning or error
                    return;
                }

                if (event.type === 'system' && event.subtype === 'init') {
                    say(`session started (model ${event.model || '?'})`);
                    return;
                }
                if (event.type === 'assistant' && event.message) {
                    for (const part of event.message.content || []) {
                        if (part.type === 'text' && part.text.trim()) {
                            say(part.text.trim().split('\n')[0]);
                        } else if (part.type === 'tool_use') {
                            const input = part.input || {};
                            const detail = input.command || input.file_path || input.pattern || '';
                            say(`> ${part.name}${detail ? `: ${String(detail).split('\n')[0]}` : ''}`);
                        }
                    }
                    return;
                }
                if (event.type === 'result') {
                    lastResult = String(event.result || '').trim();
                    say(`finished: ${event.subtype || 'done'} in `
                        + `${Math.round((event.duration_ms || 0) / 1000)}s, `
                        + `${event.num_turns || '?'} turns`);
                }
            };

            const pump = (stream) => {
                if (!stream) return;
                let buffer = '';
                stream.setEncoding('utf8');
                stream.on('data', (chunk) => {
                    buffer += chunk;
                    const lines = buffer.split(/\r?\n/);
                    buffer = lines.pop();
                    lines.forEach(onLine);
                });
                stream.on('end', () => onLine(buffer));
            };
            pump(child.stdout);
            pump(child.stderr);

            const timer = setTimeout(() => {
                this._killChild();
                finish({ ok: false, code: null, timedOut: true, notLoggedIn });
            }, this._cfg.claudeTimeoutMs);

            child.on('error', (err) => finish({ ok: false, code: null,
                error: String(err.message || err), notLoggedIn }));
            child.on('close', (code) => finish({ ok: code === 0, code, notLoggedIn, report: lastResult }));
        });
    }

    // A bare kill() orphans the tree on Windows; the CLI spawns helpers that
    // would keep running and keep holding the model session.
    _killChild() {
        const child = this._child;
        if (!child || child.killed) return;
        try {
            if (process.platform === 'win32' && child.pid) {
                this._spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'],
                    { windowsHide: true });
            } else {
                child.kill('SIGKILL');
            }
        } catch (err) {
            // Best effort - the timeout path still resolves either way.
        }
    }

    async _poll() {
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
     * Playable means the classifier recognises a real course location, several
     * polls in a row. One good frame amid noise is a coincidence, and resuming
     * on a coincidence is how a clicker ends up hammering a login screen.
     */
    async _verifyPlayable() {
        const deadline = this._now() + this._cfg.verifyPlayableMs;
        const need = Math.max(1, this._cfg.consecutivePolls);
        let streak = 0;
        let last = 'no response from the vision service';

        while (this._now() < deadline) {
            if (this._aborted) return { ok: false, detail: 'aborted' };
            const payload = await this._poll();
            if (payload && payload.location && typeof payload.location.id === 'string') {
                const id = payload.location.id;
                const conf = Number(payload.location.confidence) || 0;
                const known = /^spot_\d+$/.test(id) || id === 'transit';
                if (known && conf >= this._cfg.minConfidence) {
                    streak += 1;
                    last = `${id} at ${conf.toFixed(3)} (${streak}/${need})`;
                    if (streak >= need) return { ok: true, detail: last };
                } else {
                    streak = 0;
                    last = `${id} at ${conf.toFixed(3)} - not a confident course location`;
                }
            } else {
                streak = 0;
            }
            await this._sleep(this._cfg.pollMs);
        }
        return { ok: false, detail: last };
    }

    _snapshot() {
        const state = this._getHarnessState() || {};
        return { clicks: Number(state.clicks) || 0, location: state.location || null };
    }

    /**
     * Running is not the same as working. A harness that resumed but is stuck on
     * one obstacle will sit there clicking nothing until its own watchdog fires,
     * so require real progress: more clicks AND a different location.
     */
    _verifyHealthy(before) {
        const state = this._getHarnessState();
        if (!state) return { ok: false, detail: 'no harness state' };
        if (!state.running) return { ok: false, detail: 'the harness is not running' };

        const clicks = Number(state.clicks) || 0;
        if (clicks <= before.clicks) {
            return { ok: false, detail: `no clicks since resume (still ${clicks})` };
        }
        if (state.location && before.location && state.location === before.location) {
            return { ok: false, detail: `clicking but still at ${state.location}` };
        }
        return { ok: true, detail: `${clicks - before.clicks} clicks, `
            + `${before.location || '?'} -> ${state.location || '?'}` };
    }
}

module.exports = { Supervisor, HOUR_MS, CLAUDE_CMD, defaultConfig };
