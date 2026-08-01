import { sql, ensureSchema, playingMs } from '../lib/db.js';
import { recent, BREAK_KINDS } from '../lib/commands.js';
import {
    startClicker, stopClicker, setMode, setAutoRepair,
    testRepair, abortRepair, testBreak, setBreakEnabled
} from './actions.js';

// Everything on this page comes from the database on each request; the local
// panel is the only writer of state, and the only reader of commands. Refreshed
// by a meta tag rather than polling JS, because there is nothing here worth a
// websocket.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// A heartbeat every 10 s, so three missed ones is the machine being off rather
// than the bot being stopped. The distinction matters: "stopped" is something to
// look at, "offline" usually means the PC is asleep.
const HEARTBEAT_MS = 10000;
const STALE_MS = HEARTBEAT_MS * 3;

function fmtDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m) return `${m}m ${String(total % 60).padStart(2, '0')}s`;
    return `${total}s`;
}

function fmtAgo(date) {
    const ms = Date.now() - new Date(date).getTime();
    if (ms < 60000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
    return `${fmtDuration(ms)} ago`;
}

function fmtClock(date) {
    return new Date(date).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

async function load() {
    await ensureSchema();
    const db = sql();
    const [latest] = await db`SELECT * FROM heartbeats ORDER BY at DESC LIMIT 1`;
    const events = await db`SELECT * FROM events ORDER BY at DESC LIMIT 60`;
    const [today] = await db`
        SELECT count(*) FILTER (WHERE category = 'break')  AS breaks,
               count(*) FILTER (WHERE category = 'repair' AND type = 'cycle-start') AS repairs
        FROM events WHERE at > now() - interval '24 hours'`;

    return {
        latest: latest || null,
        events,
        commands: await recent(6),
        breaks24: Number(today?.breaks || 0),
        repairs24: Number(today?.repairs || 0),
        played24: await playingMs(24),
        played7d: await playingMs(24 * 7)
    };
}

function statusOf(latest) {
    if (!latest) return { cls: 'down', label: 'no data yet', detail: 'nothing has been pushed' };
    const age = Date.now() - new Date(latest.at).getTime();
    if (age > STALE_MS) {
        return { cls: 'down', label: 'offline', live: false,
            detail: `last heard from ${fmtAgo(latest.at)} - the PC or the panel is down` };
    }
    if (!latest.running) {
        return { cls: 'warn', label: 'stopped', live: true,
            detail: latest.stop_reason || 'the clicker is not running' };
    }
    if (latest.phase === 'break') {
        return { cls: 'warn', label: 'on a break', live: true, detail: 'idling on purpose' };
    }
    return { cls: 'live', label: latest.dry_run ? 'running (dry run)' : 'running', live: true,
        detail: `${latest.phase}${latest.location ? ` at ${latest.location}` : ''}` };
}

function tagFor(ev) {
    if (ev.category === 'repair') return ev.type === 'give-up' ? 'fail' : 'repair';
    if (ev.category === 'run') return ev.type === 'stopped' ? 'fail' : 'run';
    return ev.kind || 'short';
}

/** One button, one form: no client JavaScript anywhere on this page. */
function Button({ action, label, fields = null, className = 'mini', disabled = false, title }) {
    return (
        <form action={action} style={{ display: 'inline' }}>
            {fields && Object.entries(fields).map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={String(v)} />
            ))}
            <button className={className} type="submit" disabled={disabled} title={title}>
                {label}
            </button>
        </form>
    );
}

function Control({ latest, status, commands }) {
    const auto = latest?.auto || {};
    const breaks = latest?.breaks || {};
    const offline = !status.live;
    const running = Boolean(latest?.running);
    const live = latest ? !latest.dry_run : false;

    const note = offline
        ? 'The panel is not reporting, so nothing would collect a command.'
        : `Commands are collected on the next heartbeat — within about ${
            Math.round(HEARTBEAT_MS / 1000)}s. Uncollected after 10 min they expire.`;

    return (
        <div className="panel">
            <div className="row small muted" style={{ marginBottom: 8 }}>
                <span>CONTROL</span>
                <div className="spacer" />
                <span>{offline ? 'panel offline' : 'panel connected'}</span>
            </div>

            <div className="row" style={{ marginBottom: 8 }}>
                <Button action={startClicker} label="START" className="go sm"
                    disabled={offline || running} />
                <Button action={stopClicker} label="STOP" className="stop sm"
                    disabled={offline || !running} />
                <div className="spacer" />
                <span className="small muted">mode</span>
                <Button action={setMode} fields={{ mode: 'dry' }} label="dry run"
                    className={`mini ${live ? '' : 'on'}`} disabled={offline || running} />
                <Button action={setMode} fields={{ mode: 'live' }} label="LIVE"
                    className={`mini ${live ? 'onbad' : ''}`} disabled={offline || running}
                    title="arms the real mouse on the PC" />
            </div>

            {live && !running && (
                <div className="banner bad" style={{ marginBottom: 8 }}>
                    LIVE is armed — START will move the real mouse.
                </div>
            )}

            <div className="row" style={{ marginBottom: 8 }}>
                <span className="small muted" style={{ width: 74 }}>auto-repair</span>
                <Button action={setAutoRepair} fields={{ enabled: '1' }} label="ON"
                    className={`mini ${auto.enabled ? 'on' : ''}`} disabled={offline} />
                <Button action={setAutoRepair} fields={{ enabled: '0' }} label="OFF"
                    className={`mini ${auto.enabled ? '' : 'on'}`} disabled={offline} />
                <Button action={testRepair} label="test repair" disabled={offline} />
                <Button action={abortRepair} label="cancel" disabled={offline} />
                <div className="spacer" />
                <span className="small muted">{auto.stage || 'idle'}</span>
            </div>

            {BREAK_KINDS.map((kind) => {
                const on = Boolean(breaks[kind]?.enabled);
                return (
                    <div className="row" key={kind} style={{ marginBottom: 4 }}>
                        <span className="small muted" style={{ width: 74 }}>{kind}</span>
                        {/* One button that flips: the new value is decided here,
                            server-side, which is why it needs no JavaScript. */}
                        <Button action={setBreakEnabled}
                            fields={{ kind, enabled: on ? '0' : '1' }}
                            label={on ? 'ON' : 'OFF'}
                            className={`mini ${on ? 'on' : ''}`} disabled={offline}
                            title={on ? `turn ${kind} off` : `turn ${kind} on`} />
                        <Button action={testBreak} fields={{ kind }} label="test now"
                            disabled={offline || !on || !running}
                            title={!on ? `turn ${kind} on first`
                                : !running ? 'only while the clicker is running'
                                    : 'take this break at the next allowed spot'} />
                        <div className="spacer" />
                        <span className="small muted">{describeTier(breaks[kind])}</span>
                    </div>
                );
            })}

            <div className="small muted" style={{ marginTop: 8 }}>{note}</div>

            {commands.length > 0 && (
                <table style={{ marginTop: 8 }}>
                    <tbody>
                        {commands.map((c) => (
                            <tr key={c.id}>
                                <td className="when">{fmtClock(c.at)}</td>
                                <td className="what">
                                    <span className={`tag ${c.status === 'done' ? 'run'
                                        : c.status === 'pending' || c.status === 'sent' ? 'short'
                                            : 'fail'}`}>
                                        {c.action}
                                    </span>
                                </td>
                                <td>{c.status}{c.result ? ` — ${c.result}` : ''}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

function describeTier(tier) {
    if (!tier) return '';
    if (tier.nextBreakAt) {
        const ms = Number(tier.nextBreakAt) - Date.now();
        if (ms > 0) return `next in ${fmtDuration(ms)}`;
    }
    if (tier.skipped) return 'skipped today';
    if (tier.taken) return 'taken today';
    return tier.enabled ? '' : 'off';
}

export default async function Page() {
    let data;
    let error = null;
    try {
        data = await load();
    } catch (err) {
        error = String(err.message || err);
    }

    if (error) {
        return (
            <main>
                <h1>greenbot</h1>
                <div className="banner bad">{error}</div>
                <div className="panel small muted">
                    Set <code>DATABASE_URL</code> (Neon) and <code>INGEST_TOKEN</code> in the
                    project settings, then redeploy.
                </div>
            </main>
        );
    }

    const { latest, events, commands, breaks24, repairs24, played24, played7d } = data;
    const status = statusOf(latest);

    return (
        <main>
            {/* No JS on the page at all - the browser does the polling. */}
            <meta httpEquiv="refresh" content="15" />

            <div className="row">
                <h1>greenbot</h1>
                <div className="spacer" />
                <span className="small muted">
                    {latest ? `updated ${fmtAgo(latest.at)}` : 'waiting for the first push'}
                    {' · refreshes every 15s'}
                </span>
            </div>

            {!process.env.DASHBOARD_PASSWORD && (
                <div className="banner">
                    No <code>DASHBOARD_PASSWORD</code> is set, so this page is open to anyone
                    with the URL — and it can start and stop the clicker.
                </div>
            )}

            <div className="panel">
                <div className="row">
                    <span className={`dot ${status.cls}`} />
                    <span className={`state ${status.cls}`}>{status.label}</span>
                    <span className="muted">{status.detail}</span>
                </div>
            </div>

            <div className="panel stats">
                <div className="stat">
                    <div className="k">clicking, 24 h</div>
                    <div className="v">{fmtDuration(played24)}</div>
                </div>
                <div className="stat">
                    <div className="k">clicking, 7 days</div>
                    <div className="v">{fmtDuration(played7d)}</div>
                </div>
                <div className="stat">
                    <div className="k">this session</div>
                    <div className="v">
                        {latest && latest.running ? fmtDuration(Number(latest.session_ms)) : '—'}
                    </div>
                </div>
                <div className="stat">
                    <div className="k">clicks</div>
                    <div className="v">{latest ? Number(latest.clicks).toLocaleString() : '—'}</div>
                </div>
                <div className="stat">
                    <div className="k">breaks, 24 h</div>
                    <div className="v">{breaks24}</div>
                </div>
                <div className="stat">
                    <div className="k">repairs, 24 h</div>
                    <div className="v">{repairs24}</div>
                </div>
            </div>

            <div className="two">
                <Control latest={latest} status={status} commands={commands} />

                <div className="panel">
                    <div className="row small muted" style={{ marginBottom: 8 }}>
                        <span>BREAKS &amp; REPAIRS</span>
                        <div className="spacer" />
                        <span>{events.length ? `last ${events.length}` : ''}</span>
                    </div>
                    {events.length === 0
                        ? <div className="empty small">Nothing logged yet.</div>
                        : (
                            <table>
                                <thead>
                                    <tr><th>when</th><th>what</th><th>detail</th></tr>
                                </thead>
                                <tbody>
                                    {events.map((ev) => (
                                        <tr key={ev.id}>
                                            <td className="when">{fmtClock(ev.at)}</td>
                                            <td className="what">
                                                <span className={`tag ${tagFor(ev)}`}>
                                                    {ev.kind || ev.category}
                                                </span>
                                            </td>
                                            <td>{ev.message}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                </div>
            </div>
        </main>
    );
}
