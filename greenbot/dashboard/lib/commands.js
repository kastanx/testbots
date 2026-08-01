import { sql, ensureSchema } from './db.js';

// The command mailbox.
//
// Everything the local panel's buttons do, expressed as a row. The page writes
// one; the panel picks it up on its next heartbeat and writes back what
// happened. Nothing is pushed - Vercel has no route into the house.

export const BREAK_KINDS = ['short', 'long', 'lunch', 'dinner', 'sleep'];

// The whitelist IS the security boundary for control. `route-patch` is the one
// with a payload, and the panel validates that payload again on arrival: it goes
// through the same validator the local editor uses.
export const ACTIONS = new Set([
    'start', 'stop', 'mode', 'auto', 'test-repair', 'abort-repair',
    'test-break', 'route-patch'
]);

// A command nobody collected is a command whose moment has passed. Starting the
// clicker because of a button pressed while the PC was off overnight is not
// helpful, it is a surprise. Written into the SQL below as a literal - these are
// constants for the UI to quote, not parameters.
export const EXPIRE_AFTER = '10 minutes';

// If the panel takes a command and never reports back, it died holding it. Long
// enough to cover a slow start, short enough that the page stops saying "sent".
export const ACK_TIMEOUT = '2 minutes';

export async function queue(action, args = null) {
    if (!ACTIONS.has(action)) throw new Error(`"${action}" is not a command`);
    await ensureSchema();
    const db = sql();
    const [row] = await db`
        INSERT INTO commands (action, args)
        VALUES (${action}, ${args ? JSON.stringify(args) : null})
        RETURNING id, at, action, args, status`;
    return row;
}

/**
 * Hand the panel everything waiting, and mark it as gone out.
 *
 * Expiry and the ack timeout are settled in the same call: it is the only moment
 * anything is known to be looking, and it saves a cron job.
 */
export async function claimPending() {
    await ensureSchema();
    const db = sql();

    await db`
        UPDATE commands
        SET status = 'expired', result = 'nobody collected it in time', done_at = now()
        WHERE status = 'pending' AND at < now() - interval '10 minutes'`;

    await db`
        UPDATE commands
        SET status = 'failed', result = 'the panel took it but never reported back',
            done_at = now()
        WHERE status = 'sent' AND sent_at < now() - interval '2 minutes'`;

    return db`
        UPDATE commands SET status = 'sent', sent_at = now()
        WHERE id IN (SELECT id FROM commands WHERE status = 'pending' ORDER BY at LIMIT 20)
        RETURNING id, action, args`;
}

export async function ack(id, ok, result) {
    const db = sql();
    await db`
        UPDATE commands
        SET status = ${ok ? 'done' : 'failed'},
            done_at = now(),
            result = ${result ? String(result).slice(0, 500) : null}
        WHERE id = ${Number(id)}`;
}

export async function recent(limit = 8) {
    await ensureSchema();
    const db = sql();
    return db`SELECT * FROM commands ORDER BY at DESC LIMIT ${limit}`;
}
