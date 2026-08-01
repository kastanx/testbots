'use strict';

// Talks to the Vercel dashboard: pushes what the panel knows, and brings back
// what the dashboard has been asked to do.
//
// Control is a mailbox, not a connection. Vercel cannot reach a PC behind a
// router, so the dashboard writes a command row and this picks it up on the next
// heartbeat and reports back what happened. That is why the heartbeat is ten
// seconds rather than thirty: it is also the control latency.
//
// Three rules, all of them the same rule: telemetry is never allowed to affect
// the run.
//
//   - Every failure is swallowed. A dashboard that is down, slow, or misconfigured
//     must not stop the clicker or slow a click.
//   - Events queue in memory and are replayed on the next tick, so a laptop that
//     drops off wifi for ten minutes catches up instead of losing the record.
//     The queue is capped; the oldest go first, because a break from an hour ago
//     matters less than the one that just happened.
//   - Nothing is sent unless both the URL and the token are configured.
//
// Configured through the environment rather than route.json, because the token
// is a secret and route.json is a config file people paste into chat windows:
//
//   GREENBOT_DASH_URL=https://your-app.vercel.app
//   GREENBOT_DASH_TOKEN=<the same value as INGEST_TOKEN on Vercel>

// Also the control latency: a button pressed on the dashboard lands within one
// of these. Overridable for anyone who would rather have fewer requests than a
// responsive STOP button.
const HEARTBEAT_MS = Math.max(2000,
    Number(process.env.GREENBOT_DASH_HEARTBEAT_MS) || 10000);
const REQUEST_TIMEOUT_MS = 8000;
const QUEUE_CAP = 500;

// Which engine and supervisor events are worth a row. Everything else - ticks,
// clicks, waits - is noise at this distance, and there are millions of them.
const BREAK_EVENTS = new Set(['break:start', 'break:done', 'break:armed', 'daily:missed']);
const REPAIR_EVENTS = new Set([
    'auto:cycle-start', 'auto:resumed', 'auto:give-up', 'auto:disabled', 'auto:verify'
]);
const RUN_EVENTS = new Set(['started', 'stopped']);

function fmtMs(ms) {
    const n = Number(ms) || 0;
    if (n >= 3600000) return `${(n / 3600000).toFixed(1)}h`;
    if (n >= 60000) return `${Math.round(n / 60000)} min`;
    return `${Math.round(n / 1000)}s`;
}

/**
 * Turn an engine event into a dashboard row, or null to drop it.
 *
 * Exported so the mapping can be tested without a server: the thing most likely
 * to be wrong here is which events matter and how they read.
 */
function describe(ev) {
    if (!ev || typeof ev.type !== 'string') return null;
    const at = Number(ev.ts) || Date.now();

    if (BREAK_EVENTS.has(ev.type)) {
        const kind = ev.kind || 'break';
        if (ev.type === 'break:armed') {
            return { at, category: 'break', type: 'armed', kind,
                message: `${kind} armed from the panel` };
        }
        if (ev.type === 'daily:missed') {
            return { at, category: 'break', type: 'missed', kind,
                message: `${kind} was missed - the window passed while the bot was not running` };
        }
        if (ev.type === 'break:start') {
            return { at, category: 'break', type: 'start', kind,
                message: `${kind} started at ${ev.location || '?'} - `
                    + `${fmtMs(ev.idleMs)}${ev.expectsLogout ? ', will log out' : ''}`
                    + `${ev.forced ? ' (test)' : ''}`,
                meta: { idleMs: ev.idleMs, location: ev.location, forced: Boolean(ev.forced) } };
        }
        return { at, category: 'break', type: 'done', kind,
            message: `${kind} over after ${fmtMs(ev.ms)} - `
                + (ev.loggedOut ? 'logged out, handing over to auto-repair' : 'still logged in'),
            meta: { ms: ev.ms, loggedOut: Boolean(ev.loggedOut) } };
    }

    if (REPAIR_EVENTS.has(ev.type)) {
        const type = ev.type.slice('auto:'.length);
        if (type === 'verify') {
            return { at, category: 'repair', type: 'verify', kind: 'repair',
                message: `${ev.stage}: ${ev.ok ? 'ok' : 'FAILED'} - ${ev.detail || ''}` };
        }
        const messages = {
            'cycle-start': `repair started - ${ev.reason || 'no reason given'}`,
            resumed: 'clicker resumed by the repair',
            'give-up': `repair gave up - ${ev.reason || ''}`,
            disabled: `auto-repair disabled - ${ev.reason || ''}`
        };
        return { at, category: 'repair', type, kind: 'repair',
            message: messages[type] || type };
    }

    if (RUN_EVENTS.has(ev.type)) {
        return { at, category: 'run', type: ev.type, kind: 'run',
            message: ev.type === 'started'
                ? `clicker started${ev.dryRun ? ' (dry run)' : ''}`
                : `clicker stopped - ${ev.reason || 'no reason given'}` };
    }

    // Something pressed on the dashboard. Worth a row: otherwise a run that
    // stopped at 3am looks spontaneous when in fact someone stopped it.
    if (ev.type === 'control') {
        return { at, category: 'run', type: 'control', kind: 'remote',
            message: `${ev.action} from the dashboard - `
                + `${ev.ok ? 'applied' : 'refused'}${ev.detail ? `: ${ev.detail}` : ''}` };
    }

    return null;
}

class Telemetry {
    constructor(options = {}) {
        const {
            url = process.env.GREENBOT_DASH_URL || '',
            token = process.env.GREENBOT_DASH_TOKEN || '',
            fetchImpl = null,
            getStatus = () => null,
            // Given a { action, args } it does the thing and says what happened.
            // Everything it can do is something a button on the local panel can
            // do; the executor lives there, not here.
            onCommand = async () => ({ ok: false, result: 'no command handler' }),
            now = () => Date.now(),
            log = () => {}
        } = options;

        this._url = String(url).replace(/\/+$/, '');
        this._token = String(token);
        this._fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
        this._getStatus = getStatus;
        this._onCommand = onCommand;
        this._now = now;
        this._log = log;

        this._queue = [];
        this._acks = [];
        this._dropped = 0;
        this._timer = null;
        this._sending = false;
        this._lastOkAt = 0;
        this._lastError = null;
        this._posts = 0;
        this._applied = 0;
        this._ackPending = false;
        this._seen = new Set();
    }

    get configured() {
        return Boolean(this._url && this._token);
    }

    stats() {
        return {
            configured: this.configured,
            url: this._url || null,
            queued: this._queue.length,
            dropped: this._dropped,
            posts: this._posts,
            applied: this._applied,
            heartbeatMs: HEARTBEAT_MS,
            lastOkAt: this._lastOkAt,
            lastError: this._lastError
        };
    }

    start() {
        if (!this.configured || this._timer) return false;
        this._timer = setInterval(() => this.flush(), HEARTBEAT_MS);
        if (this._timer.unref) this._timer.unref();
        this._log(`telemetry -> ${this._url} (every ${Math.round(HEARTBEAT_MS / 1000)}s)`);
        this.flush();
        return true;
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    /** Feed it every engine and supervisor event; it decides what is worth sending. */
    record(ev) {
        if (!this.configured) return false;
        const row = describe(ev);
        if (!row) return false;
        this._queue.push(row);
        if (this._queue.length > QUEUE_CAP) {
            this._dropped += this._queue.length - QUEUE_CAP;
            this._queue.splice(0, this._queue.length - QUEUE_CAP);
        }
        // A break or a repair is worth knowing about now rather than in 30 s.
        if (row.category !== 'run') this.flush();
        return true;
    }

    async _post(path, body, headers = {}) {
        const res = await this._fetch(`${this._url}${path}`, {
            method: 'POST',
            headers: Object.assign({ authorization: `Bearer ${this._token}` }, headers),
            body,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!res || res.ok === false) {
            const status = res ? res.status : '?';
            throw new Error(`HTTP ${status}`);
        }
        return res;
    }

    /**
     * Send the heartbeat and whatever has queued up.
     *
     * Events are taken out of the queue and put back on failure, so nothing is
     * lost to a dropped connection - and a second flush cannot send them twice
     * because `_sending` holds the door.
     */
    async flush() {
        if (!this.configured || this._sending) return { ok: false, reason: 'busy' };
        this._sending = true;
        const batch = this._queue.splice(0, this._queue.length);
        try {
            const status = this._getStatus();
            const acks = this._acks.splice(0, this._acks.length);
            const res = await this._post('/api/ingest', JSON.stringify({
                heartbeat: status ? Object.assign({ at: this._now() }, status) : null,
                events: batch,
                acks
            }), { 'content-type': 'application/json' });
            this._lastOkAt = this._now();
            this._lastError = null;
            this._posts += 1;

            let reply = null;
            try {
                reply = await res.json();
            } catch (err) {
                reply = null;
            }
            const applied = await this._apply(reply && reply.commands);
            return { ok: true, events: batch.length, commands: applied };
        } catch (err) {
            // Front of the queue: these are older than anything recorded since.
            this._queue.unshift(...batch);
            if (this._queue.length > QUEUE_CAP) {
                this._dropped += this._queue.length - QUEUE_CAP;
                this._queue.splice(0, this._queue.length - QUEUE_CAP);
            }
            const message = String(err.message || err);
            // Only the first of a run of identical failures is logged; a dead
            // dashboard would otherwise fill the panel's log by morning.
            if (message !== this._lastError) this._log(`telemetry: ${message}`);
            this._lastError = message;
            return { ok: false, reason: message };
        } finally {
            this._sending = false;
            if (this._ackPending) {
                this._ackPending = false;
                // A microtask rather than a timer: nothing is being waited for,
                // the door just had to be let go of first.
                queueMicrotask(() => this.flush());
            }
        }
    }

    /**
     * Run whatever the dashboard asked for, and remember what to report back.
     *
     * Each command is applied at most once even if the server hands it over
     * twice - a retried response after a timeout must not press START again. The
     * ack rides the next heartbeat, so a failure to apply is visible on the page
     * rather than silently swallowed.
     */
    async _apply(commands) {
        if (!Array.isArray(commands) || !commands.length) return 0;
        let applied = 0;
        for (const cmd of commands) {
            if (!cmd || cmd.id === undefined) continue;
            const id = Number(cmd.id);
            if (this._seen.has(id)) continue;
            this._seen.add(id);
            // Ids only ever climb, so the set only needs to remember the recent
            // past; anything older cannot come round again.
            if (this._seen.size > 200) {
                const keep = [...this._seen].sort((a, b) => b - a).slice(0, 100);
                this._seen = new Set(keep);
            }

            let verdict;
            try {
                verdict = await this._onCommand(cmd);
            } catch (err) {
                verdict = { ok: false, result: String(err.message || err) };
            }
            const ok = Boolean(verdict && verdict.ok);
            this._acks.push({ id, ok, result: (verdict && verdict.result) || null });
            if (ok) this._applied += 1;
            applied += 1;
            this._log(`command ${cmd.action}: ${ok ? 'applied' : 'refused'}`
                + `${verdict && verdict.result ? ` (${verdict.result})` : ''}`);
        }
        // The acks cannot ride the request that is still in flight around this
        // call, so ask for one more as soon as it lands. The page shows "sent"
        // until they arrive; waiting out a ten-second interval to say "done"
        // would make every button feel broken.
        if (applied) this._ackPending = true;
        return applied;
    }
}

module.exports = { Telemetry, describe, HEARTBEAT_MS, QUEUE_CAP };
