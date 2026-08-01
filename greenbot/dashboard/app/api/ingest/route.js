import { NextResponse } from 'next/server';
import { sql, ensureSchema, prune } from '../../../lib/db.js';
import { claimPending, ack } from '../../../lib/commands.js';
import { checkIngestToken } from '../../../lib/auth.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One endpoint, three jobs, because the panel has one thing to say every ten
// seconds and splitting it would triple the round trips:
//
//   in   { heartbeat: {...}, events: [...], acks: [...] }
//   out  { commands: [...] }
//
// The commands ride back on the heartbeat's response rather than being polled
// separately - that is what makes a button press land within one interval
// without a second function invocation per interval.
//
// Events queue on the panel and are replayed, so a laptop that loses wifi for
// ten minutes catches up rather than losing the record.

const CATEGORIES = new Set(['break', 'repair', 'run']);
const MAX_EVENTS = 200;

// Pruning every request would be a delete on every heartbeat. Once in a while is
// enough for a table that grows by six rows a minute.
const PRUNE_CHANCE = 0.005;

function clampText(value, max = 500) {
    if (value === null || value === undefined) return null;
    return String(value).slice(0, max);
}

export async function POST(request) {
    const auth = checkIngestToken(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let body;
    try {
        body = await request.json();
    } catch (err) {
        return NextResponse.json({ error: 'body is not JSON' }, { status: 400 });
    }

    try {
        await ensureSchema();
        const db = sql();
        let storedEvents = 0;

        const hb = body.heartbeat;
        if (hb && typeof hb === 'object') {
            await db`
                INSERT INTO heartbeats
                    (at, running, dry_run, phase, location, clicks, session_ms,
                     stop_reason, auto, breaks)
                VALUES (
                    ${hb.at ? new Date(Number(hb.at)).toISOString() : new Date().toISOString()},
                    ${Boolean(hb.running)},
                    ${hb.dryRun === undefined ? true : Boolean(hb.dryRun)},
                    ${clampText(hb.phase, 40) || 'unknown'},
                    ${clampText(hb.location, 40)},
                    ${Math.max(0, Math.round(Number(hb.clicks) || 0))},
                    ${Math.max(0, Math.round(Number(hb.sessionMs) || 0))},
                    ${clampText(hb.stopReason)},
                    ${hb.auto ? JSON.stringify(hb.auto) : null},
                    ${hb.breaks ? JSON.stringify(hb.breaks) : null}
                )`;
        }

        const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
        for (const ev of events) {
            if (!ev || !CATEGORIES.has(ev.category)) continue;
            await db`
                INSERT INTO events (at, category, type, kind, message, meta)
                VALUES (
                    ${ev.at ? new Date(Number(ev.at)).toISOString() : new Date().toISOString()},
                    ${ev.category},
                    ${clampText(ev.type, 60) || 'event'},
                    ${clampText(ev.kind, 40)},
                    ${clampText(ev.message, 1000)},
                    ${ev.meta ? JSON.stringify(ev.meta).slice(0, 4000) : null}
                )`;
            storedEvents += 1;
        }

        // Acked before new ones are claimed, so a command applied this cycle is
        // already resolved by the time the page next renders.
        const acks = Array.isArray(body.acks) ? body.acks.slice(0, 50) : [];
        for (const a of acks) {
            if (!a || !Number.isFinite(Number(a.id))) continue;
            await ack(a.id, Boolean(a.ok), a.result);
        }

        const commands = await claimPending();

        if (Math.random() < PRUNE_CHANCE) await prune();

        return NextResponse.json({ ok: true, events: storedEvents, commands });
    } catch (err) {
        return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
    }
}
