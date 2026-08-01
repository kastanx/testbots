'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { queue, BREAK_KINDS } from '../lib/commands.js';
import { isValidSession, SESSION_COOKIE } from '../lib/auth.js';

// Server actions rather than client fetch calls, so the control panel works with
// JavaScript switched off - the page has none, and adding some just to press a
// button would be a strange trade.
//
// The proxy already gates this route, but a server action is its own entry
// point: it is callable by anyone who can guess the action id. So the session is
// checked here too, every time.

async function requireSession() {
    const jar = await cookies();
    if (!(await isValidSession(jar.get(SESSION_COOKIE)?.value))) {
        throw new Error('not signed in');
    }
}

async function send(action, args = null) {
    await requireSession();
    await queue(action, args);
    revalidatePath('/');
}

export async function startClicker() {
    await send('start');
}

export async function stopClicker() {
    await send('stop');
}

/**
 * Arming LIVE from a browser moves a real mouse on a real desk.
 *
 * It is deliberately a separate action from START - the same two steps the local
 * panel asks for, just spelled with two buttons instead of a confirm bar.
 */
export async function setMode(formData) {
    const mode = String(formData.get('mode')) === 'live' ? 'live' : 'dry';
    await send('mode', { mode });
}

export async function setAutoRepair(formData) {
    await send('auto', { enabled: String(formData.get('enabled')) === '1' });
}

export async function testRepair() {
    await send('test-repair');
}

export async function abortRepair() {
    await send('abort-repair');
}

export async function testBreak(formData) {
    const kind = String(formData.get('kind'));
    if (!BREAK_KINDS.includes(kind)) throw new Error(`"${kind}" is not a kind of break`);
    await send('test-break', { kind });
}

/**
 * Turn a break tier on or off.
 *
 * Sent as a route patch rather than a bespoke command, so it lands through the
 * same validator the local editor writes through - one code path that decides
 * what a legal route is, not two.
 */
export async function setBreakEnabled(formData) {
    const kind = String(formData.get('kind'));
    const enabled = String(formData.get('enabled')) === '1';
    if (!BREAK_KINDS.includes(kind)) throw new Error(`"${kind}" is not a kind of break`);

    const patch = ['short', 'long'].includes(kind)
        ? { breaks: { [kind]: { enabled } } }
        : { daily: { [kind]: { enabled } } };
    await send('route-patch', patch);
}
