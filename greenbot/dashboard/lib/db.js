import { neon } from '@neondatabase/serverless';

// Plain SQL over Neon's HTTP driver. No ORM and no migration tool: this is three
// tables that only ever get appended to, and a serverless function that has to
// cold-start fast.

let cached = null;
let override = null;

/**
 * Point every query at something other than Neon. Used by selftest.mjs, which
 * runs the real SQL against an embedded Postgres.
 *
 * There is no other way to exercise these queries before a deploy, and "the
 * dashboard is blank because of a typo in a window function" is not something to
 * find out from production.
 */
export function __useSql(fn) {
    override = fn;
    cached = null;
}

export function sql() {
    if (override) return override;
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is not set - add a Neon Postgres database to the project');
    }
    if (!cached) cached = neon(process.env.DATABASE_URL);
    return cached;
}

// Bootstrapped on first use rather than by a migration step, so deploying is
// only ever "push". CREATE IF NOT EXISTS is idempotent and cheap once the
// promise below is resolved - it runs once per warm instance, not per request.
let schemaReady = null;

export function resetSchemaCache() {
    schemaReady = null;
}

export function ensureSchema() {
    if (schemaReady) return schemaReady;
    const db = sql();
    schemaReady = (async () => {
        await db`
            CREATE TABLE IF NOT EXISTS heartbeats (
                id          BIGSERIAL PRIMARY KEY,
                at          TIMESTAMPTZ NOT NULL DEFAULT now(),
                running     BOOLEAN     NOT NULL,
                dry_run     BOOLEAN     NOT NULL DEFAULT true,
                phase       TEXT        NOT NULL,
                location    TEXT,
                clicks      INTEGER     NOT NULL DEFAULT 0,
                session_ms  BIGINT      NOT NULL DEFAULT 0,
                stop_reason TEXT,
                auto        JSONB,
                breaks      JSONB
            )`;
        await db`CREATE INDEX IF NOT EXISTS heartbeats_at ON heartbeats (at DESC)`;
        // Added after the first version shipped; a deploy over an existing
        // database has the table but not the column.
        await db`ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS breaks JSONB`;

        await db`
            CREATE TABLE IF NOT EXISTS events (
                id       BIGSERIAL PRIMARY KEY,
                at       TIMESTAMPTZ NOT NULL DEFAULT now(),
                -- 'break' | 'repair' | 'run'
                category TEXT        NOT NULL,
                type     TEXT        NOT NULL,
                kind     TEXT,
                message  TEXT,
                meta     JSONB
            )`;
        await db`CREATE INDEX IF NOT EXISTS events_at ON events (at DESC)`;

        // Vercel cannot reach into the house, so control is a mailbox: the page
        // drops a command here and the local panel picks it up on its next
        // heartbeat, then writes back what happened.
        await db`
            CREATE TABLE IF NOT EXISTS commands (
                id      BIGSERIAL   PRIMARY KEY,
                at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                action  TEXT        NOT NULL,
                args    JSONB,
                -- 'pending' | 'sent' | 'done' | 'failed' | 'expired'
                status  TEXT        NOT NULL DEFAULT 'pending',
                sent_at TIMESTAMPTZ,
                done_at TIMESTAMPTZ,
                result  TEXT
            )`;
        await db`CREATE INDEX IF NOT EXISTS commands_pending ON commands (status, at)`;
    })();
    // A transient failure here - Neon still waking up, say - must not be cached
    // forever, or every later request on this warm instance fails with it.
    schemaReady.catch(() => { schemaReady = null; });
    return schemaReady;
}

// A bot that runs day and night writes ~8600 heartbeats a day. Kept to a week,
// which is all the dashboard ever reads, and pruned on ingest rather than by a
// cron job so there is one less thing to configure.
export async function prune() {
    const db = sql();
    await db`DELETE FROM heartbeats WHERE at < now() - interval '7 days'`;
    await db`DELETE FROM events WHERE at < now() - interval '30 days'`;
    await db`DELETE FROM commands WHERE at < now() - interval '7 days'`;
}

/**
 * Time actually spent clicking, integrated over the heartbeat trail.
 *
 * Summing gaps rather than counting rows is what makes this survive the PC being
 * switched off: a gap longer than `maxGap` is a hole in the record, not time the
 * bot spent playing, so it contributes nothing. A break is not clicking either.
 */
export async function playingMs(sinceHours, maxGapSeconds = 120) {
    const db = sql();
    const rows = await db`
        WITH trail AS (
            SELECT at, phase, running,
                   LEAD(at) OVER (ORDER BY at) - at AS gap
            FROM heartbeats
            WHERE at > now() - make_interval(hours => ${sinceHours}::int)
        )
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM gap)), 0) AS seconds
        FROM trail
        WHERE running
          AND phase NOT IN ('break', 'stopped')
          AND gap IS NOT NULL
          AND gap < make_interval(secs => ${maxGapSeconds}::double precision)`;
    return Math.round(Number(rows[0]?.seconds || 0) * 1000);
}
