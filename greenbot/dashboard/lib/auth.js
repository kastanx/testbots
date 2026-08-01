// Two secrets, deliberately separate.
//
//   INGEST_TOKEN      - what the local panel presents when it pushes. A machine
//                       secret; it never appears in a browser.
//   DASHBOARD_PASSWORD - what a person types to look at the page.
//
// The page shows live screenshots of a logged-in game account, so it is not
// something to leave open on a public URL. Web Crypto rather than node:crypto
// because the same helper runs in middleware, on the edge runtime.

export const SESSION_COOKIE = 'greenbot_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

const SESSION_MESSAGE = 'greenbot-dashboard-v1';

function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    // Constant time: a length-independent comparison here would leak the token
    // one byte at a time to anyone willing to measure.
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
    return diff === 0;
}

async function hmac(key, message) {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
    return new Uint8Array(sig);
}

function toHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The cookie value for the configured password. Not reversible to the password. */
export async function sessionToken() {
    const password = process.env.DASHBOARD_PASSWORD;
    if (!password) return null;
    return toHex(await hmac(password, SESSION_MESSAGE));
}

export async function isValidSession(cookieValue) {
    const expected = await sessionToken();
    // No password configured means no gate. Said out loud on the page itself, so
    // it cannot be a silent hole.
    if (!expected) return true;
    if (!cookieValue) return false;
    const enc = new TextEncoder();
    return bytesEqual(enc.encode(cookieValue), enc.encode(expected));
}

export function checkIngestToken(request) {
    const expected = process.env.INGEST_TOKEN;
    if (!expected) return { ok: false, status: 500, error: 'INGEST_TOKEN is not set on the server' };

    const header = request.headers.get('authorization') || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    const enc = new TextEncoder();
    if (!presented || !bytesEqual(enc.encode(presented), enc.encode(expected))) {
        return { ok: false, status: 401, error: 'bad or missing ingest token' };
    }
    return { ok: true };
}
