// The security-relevant parts of the dashboard, checked without a server or a
// database: token comparison, the ingest gate, and what happens when the
// secrets are simply missing.
//
//   node greenbot/dashboard/selftest.mjs

import { sessionToken, isValidSession, checkIngestToken } from './lib/auth.js';
import { ACTIONS, BREAK_KINDS } from './lib/commands.js';

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

function request(authorization) {
    return { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? authorization : null) } };
}

await check('the session cookie does not contain the password', async () => {
    process.env.DASHBOARD_PASSWORD = 'hunter2-correct-horse';
    const token = await sessionToken();
    assert(token && token.length === 64, `token looks wrong: ${token}`);
    assert(!token.includes('hunter2'), 'the password is in the cookie');
    const again = await sessionToken();
    assert(token === again, 'the token is not stable, so every request would log you out');
    return `${token.slice(0, 12)}... (${token.length} hex chars)`;
});

await check('a wrong or missing cookie does not get in', async () => {
    process.env.DASHBOARD_PASSWORD = 'hunter2-correct-horse';
    const good = await sessionToken();
    assert(await isValidSession(good), 'the correct cookie was rejected');
    assert(!(await isValidSession('')), 'an empty cookie got in');
    assert(!(await isValidSession(undefined)), 'a missing cookie got in');
    assert(!(await isValidSession(`${good.slice(0, -1)}0`)), 'a near-miss cookie got in');
    assert(!(await isValidSession(good.slice(0, 10))), 'a truncated cookie got in');

    // A different password must produce a different token, or changing it would
    // not log anyone out.
    process.env.DASHBOARD_PASSWORD = 'something-else';
    assert(!(await isValidSession(good)), 'the old cookie survived a password change');
    return 'exact match only';
});

await check('no password means the page says so rather than half-locking', async () => {
    delete process.env.DASHBOARD_PASSWORD;
    assert(await sessionToken() === null, 'produced a token with no password set');
    // Open on purpose, and the page prints a banner about it. The alternative -
    // an unopenable dashboard with no way to set a password - is worse.
    assert(await isValidSession(undefined), 'locked everyone out with no password set');
    return 'open, and the page warns about it';
});

await check('ingest refuses everything without the right bearer token', async () => {
    process.env.INGEST_TOKEN = 'a-long-random-ingest-token';
    assert(checkIngestToken(request('Bearer a-long-random-ingest-token')).ok, 'the right token failed');

    for (const [label, header] of [
        ['no header', null],
        ['empty', ''],
        ['no scheme', 'a-long-random-ingest-token'],
        ['wrong scheme', 'Basic a-long-random-ingest-token'],
        ['near miss', 'Bearer a-long-random-ingest-toke'],
        ['prefix', 'Bearer a-long'],
        ['other', 'Bearer nope']
    ]) {
        const res = checkIngestToken(request(header));
        assert(!res.ok, `${label} was accepted`);
        assert(res.status === 401, `${label} gave ${res.status}, want 401`);
    }
    return '7 bad headers, all 401';
});

await check('a server with no INGEST_TOKEN accepts nothing at all', async () => {
    delete process.env.INGEST_TOKEN;
    const res = checkIngestToken(request('Bearer anything'));
    assert(!res.ok, 'accepted a push with no token configured');
    assert(res.status === 500, `gave ${res.status}, want 500 - it is a server misconfiguration`);
    // The failure mode that matters: never fall open.
    assert(!checkIngestToken(request(null)).ok, 'an empty header got in');
    return 'closed, and reported as a server error';
});

await check('only known actions can be queued', async () => {
    // The whitelist is the security boundary for control: a command name that is
    // not on it must never reach the panel, whatever a form posts.
    for (const good of ['start', 'stop', 'mode', 'auto', 'test-repair',
        'abort-repair', 'test-break', 'route-patch']) {
        assert(ACTIONS.has(good), `${good} is missing from the whitelist`);
    }
    for (const bad of ['', 'shutdown', 'eval', 'START', 'start ', 'route_patch',
        '__proto__', 'drop-table']) {
        assert(!ACTIONS.has(bad), `"${bad}" is on the whitelist`);
    }
    assert(ACTIONS.size === 8, `the whitelist has grown to ${ACTIONS.size} - is that deliberate?`);
    return `${ACTIONS.size} actions, 8 impostors rejected`;
});

await check('the break kinds match the ones the engine has', async () => {
    // The page renders a row per kind and the panel refuses anything else, so a
    // drift between these two lists is a dead button.
    const { TIERS } = await import('../harness/breaks.js');
    const { EVENTS } = await import('../harness/daily.js');
    const engineKinds = [...TIERS, ...EVENTS].sort();
    assert(JSON.stringify(BREAK_KINDS.slice().sort()) === JSON.stringify(engineKinds),
        `dashboard has ${BREAK_KINDS} but the engine has ${engineKinds}`);
    return BREAK_KINDS.join(', ');
});

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
