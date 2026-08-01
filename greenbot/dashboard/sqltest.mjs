// Runs the dashboard's real SQL against a real Postgres — an embedded one, so it
// needs no database and no network.
//
// The queries are otherwise completely unexercised until a deploy, and the way
// they fail is a blank page with a Postgres error on it. A window function, a
// named-argument interval and an UPDATE ... RETURNING are all easy to get subtly
// wrong and impossible to eyeball.
//
//   node greenbot/dashboard/sqltest.mjs

import { PGlite } from '@electric-sql/pglite';
import { __useSql, ensureSchema, resetSchemaCache, playingMs, prune, sql } from './lib/db.js';
import { queue, claimPending, ack, recent } from './lib/commands.js';

const results = [];

async function check(name, fn) {
    try {
        const detail = await fn();
        results.push(true);
        console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
    } catch (err) {
        results.push(false);
        console.log(`FAIL  ${name}  ${err.message}`);
    }
}

function assert(cond, message) {
    if (!cond) throw new Error(message);
}

// Neon's driver is a tagged template that returns rows; PGlite's query() takes
// $1-style placeholders. This is the whole adapter.
function adapt(pg) {
    return async (strings, ...values) => {
        const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');
        const res = await pg.query(text, values);
        return res.rows;
    };
}

const pg = await new PGlite();
__useSql(adapt(pg));
resetSchemaCache();

await check('the schema builds, twice', async () => {
    await ensureSchema();
    // Idempotent by design - every warm instance runs it, and a second deploy
    // over an existing database must not fail.
    resetSchemaCache();
    await ensureSchema();
    const db = sql();
    const tables = await db`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`;
    const names = tables.map((t) => t.table_name);
    for (const want of ['commands', 'events', 'heartbeats']) {
        assert(names.includes(want), `no ${want} table (got ${names.join(', ')})`);
    }
    return names.join(', ');
});

await check('a heartbeat round-trips with its JSON', async () => {
    const db = sql();
    await db`
        INSERT INTO heartbeats (running, dry_run, phase, location, clicks, session_ms, auto, breaks)
        VALUES (true, false, 'clicking', 'spot_03', 42, 90000,
                ${JSON.stringify({ enabled: true, stage: 'idle' })},
                ${JSON.stringify({ short: { enabled: true }, sleep: { enabled: false } })})`;
    const [row] = await db`SELECT * FROM heartbeats ORDER BY at DESC LIMIT 1`;
    assert(row.clicks === 42, `clicks came back as ${row.clicks}`);
    assert(row.auto.stage === 'idle', 'auto JSON did not survive');
    assert(row.breaks.short.enabled === true, 'breaks JSON did not survive');
    assert(row.dry_run === false, 'dry_run flipped');
    return `clicks ${row.clicks}, phase ${row.phase}, breaks ${Object.keys(row.breaks).join('/')}`;
});

await check('playing time sums the gaps and ignores the holes', async () => {
    const db = sql();
    await db`DELETE FROM heartbeats`;

    // A trail with three distinct shapes in it: ten minutes of steady clicking,
    // a five-minute break, and a two-hour hole where the PC was off.
    const t0 = Date.now() - 6 * 3600000;
    const rows = [];
    for (let i = 0; i < 60; i += 1) rows.push([t0 + i * 10000, true, 'clicking']);          // 10 min
    const t1 = t0 + 600000;
    for (let i = 0; i < 30; i += 1) rows.push([t1 + i * 10000, true, 'break']);             // 5 min
    const t2 = t1 + 300000;
    rows.push([t2, true, 'clicking']);
    rows.push([t2 + 7200000, true, 'clicking']);                                            // 2 h hole
    for (let i = 1; i < 30; i += 1) rows.push([t2 + 7200000 + i * 10000, true, 'clicking']); // 5 min

    for (const [at, running, phase] of rows) {
        await db`
            INSERT INTO heartbeats (at, running, phase)
            VALUES (${new Date(at).toISOString()}, ${running}, ${phase})`;
    }

    const ms = await playingMs(24);
    const minutes = ms / 60000;
    // 10 min of clicking + 5 min after the hole, give or take one interval on
    // each boundary. The break and the two-hour hole must contribute nothing.
    assert(minutes > 14 && minutes < 16.5, `got ${minutes.toFixed(2)} min, expected about 15`);

    // And the window really is a window.
    const empty = await playingMs(1);
    assert(empty < ms, `a 1 h window (${empty}) was not smaller than a 24 h one (${ms})`);
    return `${minutes.toFixed(1)} min counted; 5 min break and 2 h outage excluded`;
});

await check('a command is queued, claimed once, and acked', async () => {
    const first = await queue('test-break', { kind: 'lunch' });
    assert(first.status === 'pending', `queued as ${first.status}`);

    const claimed = await claimPending();
    assert(claimed.length === 1, `claimed ${claimed.length}`);
    assert(claimed[0].action === 'test-break', `claimed ${claimed[0].action}`);
    assert(claimed[0].args.kind === 'lunch', 'args did not survive the round trip');

    // The second poll must come back empty, or the panel would apply it twice.
    const again = await claimPending();
    assert(again.length === 0, `claimed the same command ${again.length} more times`);

    await ack(first.id, true, 'lunch armed');
    const [row] = await recent(1);
    assert(row.status === 'done', `status is ${row.status}`);
    assert(row.result === 'lunch armed', `result is ${row.result}`);
    assert(row.done_at, 'done_at was not stamped');
    return 'pending -> sent -> done, claimed exactly once';
});

await check('an uncollected command expires instead of firing hours late', async () => {
    const db = sql();
    await db`DELETE FROM commands`;
    const stale = await queue('start');
    // Backdate it: the PC was off when the button was pressed.
    await db`UPDATE commands SET at = now() - interval '30 minutes' WHERE id = ${stale.id}`;

    const claimed = await claimPending();
    assert(claimed.length === 0, 'a half-hour-old START was handed over');
    const [row] = await recent(1);
    assert(row.status === 'expired', `status is ${row.status}`);
    assert(/nobody collected/.test(row.result), `result is ${row.result}`);
    return `"${row.result}"`;
});

await check('a command taken but never acked is not left saying "sent"', async () => {
    const db = sql();
    await db`DELETE FROM commands`;
    const cmd = await queue('stop');
    await claimPending();
    await db`UPDATE commands SET sent_at = now() - interval '5 minutes' WHERE id = ${cmd.id}`;

    await claimPending();
    const [row] = await recent(1);
    assert(row.status === 'failed', `status is ${row.status}`);
    assert(/never reported back/.test(row.result), `result is ${row.result}`);
    return `"${row.result}"`;
});

await check('a rejected action never reaches the table', async () => {
    let threw = null;
    try {
        await queue('rm -rf');
    } catch (err) {
        threw = err;
    }
    assert(threw, 'an unknown action was queued');
    const db = sql();
    const [{ count }] = await db`SELECT count(*)::int AS count FROM commands WHERE action = 'rm -rf'`;
    assert(count === 0, `${count} rows of an unknown action landed`);
    return threw.message;
});

await check('pruning runs and keeps what is recent', async () => {
    const db = sql();
    await db`DELETE FROM events`;
    await db`INSERT INTO events (at, category, type, message)
             VALUES (now() - interval '60 days', 'break', 'done', 'ancient')`;
    await db`INSERT INTO events (category, type, message) VALUES ('break', 'done', 'today')`;
    await prune();
    const rows = await db`SELECT message FROM events`;
    assert(rows.length === 1, `${rows.length} rows survived`);
    assert(rows[0].message === 'today', `kept "${rows[0].message}"`);
    return '60-day-old event pruned, today kept';
});

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await pg.close();
process.exit(failed ? 1 : 0);
