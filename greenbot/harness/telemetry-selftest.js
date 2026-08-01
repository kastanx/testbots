'use strict';

// The one thing telemetry must never do is affect the run, so most of this is
// about failure: a dashboard that is down, slow, or misconfigured.
//
//   node greenbot/harness/telemetry-selftest.js

const { Telemetry, describe, QUEUE_CAP } = require('./telemetry.js');

const results = [];

async function check(name, fn) {
    try {
        const detail = await fn();
        results.push({ name, ok: true });
        console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
    } catch (err) {
        results.push({ name, ok: false });
        console.log(`FAIL  ${name}  ${err.message}`);
    }
}

function assert(cond, message) {
    if (!cond) throw new Error(message);
}

// record() kicks off a flush of its own for a break or a repair, so a batch can
// still be in flight when the test looks at the queue. Let it land first.
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A server that records what it was sent, hands back commands, and can fail. */
function fakeServer() {
    const calls = [];
    let fail = null;
    let outbox = [];
    return {
        calls,
        breakWith: (err) => { fail = err; },
        heal: () => { fail = null; },
        /** What the next response will carry, exactly once - like claimPending. */
        send: (...commands) => { outbox = commands; },
        acks: () => calls.flatMap((c) => JSON.parse(c.body).acks || []),
        fetch: async (url, opts) => {
            if (fail) throw new Error(fail);
            calls.push({ url, opts, body: opts.body });
            const commands = outbox;
            outbox = [];
            return { ok: true, status: 200, json: async () => ({ ok: true, commands }) };
        }
    };
}

function make(server, over = {}) {
    return new Telemetry(Object.assign({
        url: 'https://example.invalid/',
        token: 'secret',
        fetchImpl: server.fetch,
        getStatus: () => ({ running: true, phase: 'clicking', clicks: 7, sessionMs: 1000 })
    }, over));
}

(async () => {
    await check('nothing is sent until it is configured', async () => {
        const server = fakeServer();
        const t = new Telemetry({ url: '', token: '', fetchImpl: server.fetch });
        assert(!t.configured, 'reported itself configured with no url');
        assert(t.start() === false, 'started with no url');
        t.record({ type: 'break:start', kind: 'long', ts: 1 });
        const res = await t.flush();
        assert(res.ok !== true, 'flushed with no url');
        assert(server.calls.length === 0, `posted ${server.calls.length} times with no url`);
        return 'no url, no token, no traffic';
    });

    await check('a heartbeat and its events go in one post', async () => {
        const server = fakeServer();
        const t = make(server);
        t.record({ type: 'break:start', kind: 'lunch', ts: 5, idleMs: 1800000,
            location: 'spot_02', expectsLogout: true });
        await t.flush();

        const last = server.calls[server.calls.length - 1];
        const body = JSON.parse(last.body);
        assert(last.url.endsWith('/api/ingest'), `posted to ${last.url}`);
        assert(last.opts.headers.authorization === 'Bearer secret', 'no bearer token');
        assert(body.heartbeat.clicks === 7, 'heartbeat did not carry the state');
        assert(body.events.length === 1, `sent ${body.events.length} events`);
        assert(body.events[0].category === 'break', 'lunch was not filed as a break');
        assert(/logs? out|log out|will log out/.test(body.events[0].message),
            `message: ${body.events[0].message}`);
        return `1 post, ${body.events.length} event, url ${last.url.replace(/^https?:\/\//, '')}`;
    });

    await check('clicks and ticks are dropped, not shipped', async () => {
        const server = fakeServer();
        const t = make(server);
        for (let i = 0; i < 5000; i += 1) {
            t.record({ type: 'tick', ts: i, phase: 'clicking' });
            t.record({ type: 'click', ts: i, location: 'spot_01' });
            t.record({ type: 'wait', ts: i, appliedMs: 5000 });
        }
        await t.flush();
        const body = JSON.parse(server.calls[server.calls.length - 1].body);
        assert(body.events.length === 0, `${body.events.length} of 15000 noise events got through`);
        assert(t.stats().queued === 0, 'noise was queued');
        return '15000 ticks/clicks/waits -> 0 rows';
    });

    await check('an unreachable dashboard loses nothing and throws nothing', async () => {
        const server = fakeServer();
        const t = make(server);
        server.breakWith('ENOTFOUND');

        for (let i = 0; i < 4; i += 1) {
            t.record({ type: 'break:done', kind: 'short', ts: i, ms: 60000, loggedOut: false });
        }
        // record() flushes for a break, so the failures have already happened.
        await settle();
        const failed = await t.flush();
        assert(failed.ok === false, 'reported success while the server was down');
        assert(t.stats().queued === 4, `queued ${t.stats().queued} of 4`);
        assert(server.calls.length === 0, 'a broken fetch still recorded a call');

        server.heal();
        const ok = await t.flush();
        assert(ok.ok === true, `still failing: ${ok.reason}`);
        const body = JSON.parse(server.calls[server.calls.length - 1].body);
        assert(body.events.length === 4, `replayed ${body.events.length} of 4`);
        assert(t.stats().queued === 0, 'queue not drained after recovery');
        return '4 events held through an outage, all 4 replayed';
    });

    await check('the queue is capped, oldest first', async () => {
        const server = fakeServer();
        const t = make(server);
        server.breakWith('ECONNREFUSED');
        for (let i = 0; i < QUEUE_CAP + 250; i += 1) {
            t.record({ type: 'break:done', kind: 'short', ts: i, ms: 1000, loggedOut: false });
        }
        await settle();
        const stats = t.stats();
        assert(stats.queued === QUEUE_CAP, `queued ${stats.queued}, cap ${QUEUE_CAP}`);
        assert(stats.dropped >= 250, `dropped ${stats.dropped}`);

        server.heal();
        await t.flush();
        const body = JSON.parse(server.calls[server.calls.length - 1].body);
        // The survivors are the newest: an hour-old break matters less than the
        // one that just happened.
        const first = body.events[0];
        assert(first.at >= 250, `oldest survivor is ts ${first.at} - kept the wrong end`);
        return `capped at ${QUEUE_CAP}, ${stats.dropped} dropped from the front`;
    });

    await check('a failing dashboard is logged once, not every cycle', async () => {
        const server = fakeServer();
        const lines = [];
        const t = make(server, { log: (m) => lines.push(m) });
        server.breakWith('ETIMEDOUT');
        for (let i = 0; i < 20; i += 1) await t.flush();
        assert(lines.length === 1, `logged ${lines.length} times for one dead server`);
        server.heal();
        await t.flush();
        server.breakWith('ETIMEDOUT');
        await t.flush();
        assert(lines.length === 2, `did not log the failure again after recovery`);
        return `20 identical failures -> 1 line`;
    });

    await check('a command comes back on the heartbeat and is applied', async () => {
        const server = fakeServer();
        const done = [];
        const t = make(server, {
            onCommand: async (cmd) => {
                done.push(cmd);
                return { ok: true, result: 'stopped' };
            }
        });
        server.send({ id: 11, action: 'stop', args: null });
        await t.flush();
        await settle();

        assert(done.length === 1, `applied ${done.length} commands`);
        assert(done[0].action === 'stop', `applied ${done[0].action}`);
        const acks = server.acks();
        assert(acks.length === 1, `sent ${acks.length} acks`);
        assert(acks[0].id === 11 && acks[0].ok === true, `ack: ${JSON.stringify(acks[0])}`);
        assert(acks[0].result === 'stopped', `ack result: ${acks[0].result}`);
        return 'stop -> applied -> acked in the next post';
    });

    await check('the same command is never applied twice', async () => {
        const server = fakeServer();
        let applied = 0;
        const t = make(server, {
            onCommand: async () => { applied += 1; return { ok: true }; }
        });
        // A response that arrives after a client-side timeout gets retried by the
        // server; pressing START twice because of it would be unforgivable.
        for (let i = 0; i < 5; i += 1) {
            server.send({ id: 42, action: 'start' });
            await t.flush();
            await settle();
        }
        assert(applied === 1, `START was applied ${applied} times`);
        return '5 deliveries of id 42 -> 1 START';
    });

    await check('a command that cannot be applied is reported, not swallowed', async () => {
        const server = fakeServer();
        const t = make(server, {
            onCommand: async () => ({ ok: false, result: 'the clicker is not running' })
        });
        server.send({ id: 7, action: 'test-break', args: { kind: 'lunch' } });
        await t.flush();
        await settle();
        const ack = server.acks().find((a) => a.id === 7);
        assert(ack, 'no ack for the refused command');
        assert(ack.ok === false, 'a refusal was acked as success');
        assert(/not running/.test(ack.result), `result: ${ack.result}`);
        return `refusal reached the dashboard: "${ack.result}"`;
    });

    await check('a handler that throws is a failed command, not a dead client', async () => {
        const server = fakeServer();
        const t = make(server, {
            onCommand: async () => { throw new Error('engine exploded'); }
        });
        server.send({ id: 9, action: 'start' });
        const res = await t.flush();
        assert(res.ok === true, 'the flush itself failed');
        await settle();
        const ack = server.acks().find((a) => a.id === 9);
        assert(ack && ack.ok === false, 'the throw was not acked as a failure');
        assert(/engine exploded/.test(ack.result), `result: ${ack.result}`);

        // And the client keeps working afterwards.
        server.send({ id: 10, action: 'stop' });
        await t.flush();
        await settle();
        assert(server.acks().some((a) => a.id === 10), 'stopped processing after a throw');
        return 'throw -> failed ack, client still alive';
    });

    await check('an unreachable dashboard sends no commands at all', async () => {
        const server = fakeServer();
        let applied = 0;
        const t = make(server, { onCommand: async () => { applied += 1; return { ok: true }; } });
        server.breakWith('ENOTFOUND');
        server.send({ id: 1, action: 'start' });
        await t.flush();
        await settle();
        assert(applied === 0, 'applied a command that never arrived');
        return 'no response, no action';
    });

    await check('every kind of break and repair reads as something', async () => {
        const cases = [
            { type: 'break:start', kind: 'sleep', ts: 1, idleMs: 25200000,
                location: 'spot_01', expectsLogout: true },
            { type: 'break:done', kind: 'sleep', ts: 2, ms: 25200000, loggedOut: true },
            { type: 'break:armed', kind: 'dinner', ts: 3 },
            { type: 'daily:missed', kind: 'lunch', ts: 4 },
            { type: 'auto:cycle-start', ts: 5, reason: 'sleep idle break over' },
            { type: 'auto:verify', ts: 6, stage: 'healthy', ok: true, detail: '9 clicks' },
            { type: 'auto:resumed', ts: 7 },
            { type: 'auto:give-up', ts: 8, reason: 'still not playable' },
            { type: 'started', ts: 9, dryRun: false },
            { type: 'stopped', ts: 10, reason: 'sleep idle break over after 420 min' },
            { type: 'control', ts: 11, action: 'stop', ok: true, detail: 'stopped' },
            { type: 'control', ts: 12, action: 'test-break', ok: false, detail: 'not running' }
        ];
        const seen = [];
        for (const ev of cases) {
            const row = describe(ev);
            assert(row, `${ev.type} produced no row`);
            assert(row.message && row.message.length > 3,
                `${ev.type} produced an empty message`);
            assert(['break', 'repair', 'run'].includes(row.category),
                `${ev.type} -> category ${row.category}`);
            seen.push(row.category);
        }
        assert(describe({ type: 'tick' }) === null, 'a tick produced a row');
        assert(describe(null) === null, 'null produced a row');
        assert(describe({}) === null, 'an empty object produced a row');
        return `${cases.length} kinds, categories ${[...new Set(seen)].join('/')}`;
    });

    await check('two flushes cannot send the same event twice', async () => {
        const server = fakeServer();
        let release;
        const gate = new Promise((r) => { release = r; });
        const t = make(server, {
            fetchImpl: async (url, opts) => {
                await gate;
                return server.fetch(url, opts);
            }
        });
        t.record({ type: 'break:done', kind: 'long', ts: 1, ms: 400000, loggedOut: true });
        const a = t.flush();
        const b = t.flush();          // must be refused while the first is in flight
        release();
        await Promise.all([a, b]);
        await t.flush();

        const sent = server.calls
            .map((c) => JSON.parse(c.body).events.length)
            .reduce((x, y) => x + y, 0);
        assert(sent === 1, `the same event was sent ${sent} times`);
        return '1 event, 1 delivery';
    });

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) console.log(`failed: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(failed.length ? 1 : 0);
})();
