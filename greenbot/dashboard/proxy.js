import { NextResponse } from 'next/server';
import { isValidSession, SESSION_COOKIE } from './lib/auth.js';

// Next 16 renamed this convention from `middleware` to `proxy`; same job.
//
// The page carries live screenshots of a signed-in game account, so it is gated
// by default. The ingest routes are not: they carry their own bearer token, and
// the local panel has no cookie jar.
export const config = {
    matcher: ['/((?!api/ingest|api/screenshot|api/login|login|_next/static|_next/image|favicon.ico).*)']
};

export async function proxy(request) {
    if (await isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) {
        return NextResponse.next();
    }
    const login = new URL('/login', request.url);
    return NextResponse.redirect(login);
}
