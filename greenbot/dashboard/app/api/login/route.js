import { NextResponse } from 'next/server';
import { sessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from '../../../lib/auth.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Deliberately slow to hammer: one dashboard, one password, no user list. The
// delay is the whole rate limit - a serverless function has nowhere to keep a
// counter without another service.
const WRONG_PASSWORD_DELAY_MS = 700;

export async function POST(request) {
    const form = await request.formData();
    const password = String(form.get('password') || '');
    const expected = process.env.DASHBOARD_PASSWORD;
    const next = new URL('/', request.url);

    if (!expected) return NextResponse.redirect(next, { status: 303 });

    if (password !== expected) {
        await new Promise((r) => setTimeout(r, WRONG_PASSWORD_DELAY_MS));
        const back = new URL('/login?bad=1', request.url);
        return NextResponse.redirect(back, { status: 303 });
    }

    const res = NextResponse.redirect(next, { status: 303 });
    res.cookies.set(SESSION_COOKIE, await sessionToken(), {
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        path: '/',
        maxAge: SESSION_MAX_AGE
    });
    return res;
}
