const LOG_CAP = 300;

const R = {
    btn: document.getElementById('runbtn'),
    dry: document.getElementById('modedry'),
    live: document.getElementById('modelive'),
    confirm: document.getElementById('confirm'),
    confirmYes: document.getElementById('confirmyes'),
    confirmNo: document.getElementById('confirmno'),
    hint: document.getElementById('runhint'),
    phase: document.getElementById('rphase'),
    loc: document.getElementById('rloc'),
    clicks: document.getElementById('rclicks'),
    elapsed: document.getElementById('relapsed'),
    count: document.getElementById('rcount'),
    countfill: document.getElementById('countfill'),
    log: document.getElementById('log'),
    logclear: document.getElementById('logclear'),
    wdrows: document.getElementById('wdrows'),
    brkrows: document.getElementById('brkrows'),
    brknote: document.getElementById('brknote'),
    dayrows: document.getElementById('dayrows'),
    daygrace: document.getElementById('daygrace'),
    daynote: document.getElementById('daynote'),
    autobtn: document.getElementById('autobtn'),
    autotest: document.getElementById('autotest'),
    autoabort: document.getElementById('autoabort'),
    autostage: document.getElementById('autostage'),
    autocycles: document.getElementById('autocycles'),
    autonote: document.getElementById('autonote'),
    telnote: document.getElementById('telnote'),
    rows: document.getElementById('rows'),
    reset: document.getElementById('resettimings'),
    timinghint: document.getElementById('timinghint'),
    pickBtn: document.getElementById('pickbtn'),
    pickHint: document.getElementById('pickhint'),
    pointVal: document.getElementById('pointval')
};

let route = null;
let state = { running: false, dryRun: true, phase: 'stopped', location: null, clicks: 0, startedAt: null };
let mode = 'dry';
let autoOn = false;
let lastAutoStats = null;

function renderAuto(stats) {
    if (!stats) return;
    lastAutoStats = stats;
    autoOn = Boolean(stats.enabled);
    R.autobtn.textContent = `auto-repair: ${autoOn ? 'ON' : 'OFF'}`;
    renderBreaks();
    R.autobtn.style.color = autoOn ? 'var(--warn)' : '';
    R.autobtn.style.borderColor = autoOn ? 'var(--warn)' : '';
    R.autostage.textContent = stats.stage || 'idle';
    R.autocycles.textContent = stats.lifetimeCycles != null
        ? `${stats.cyclesThisHour}/${stats.maxCyclesPerHour} this hour · `
          + `${stats.lifetimeCycles}/${stats.globalMaxCycles} total`
        : '';

    // A disabled reason outranks everything: usually the CLI is unauthenticated,
    // and nothing works until that is fixed.
    if (stats.disabled) {
        R.autonote.textContent = stats.disabled;
        R.autonote.className = 'small warn';
    } else if (!stats.available) {
        R.autonote.textContent = 'harness/supervisor.js is missing - auto-repair unavailable';
        R.autonote.className = 'small warn';
    } else if (stats.lastGiveUp) {
        R.autonote.textContent = `last give-up: ${stats.lastGiveUp}`;
        R.autonote.className = 'small muted';
    } else {
        R.autonote.textContent = 'When the harness stops on its own, hand it to Claude '
            + 'Code and resume clicking if the game comes back. Restarts the clicker '
            + 'unattended.';
        R.autonote.className = 'small muted';
    }
}

// Always go through this so arming and disarming stay symmetric - the confirm
// bar must never be left showing while the mode says something else.
function setMode(next) {
    mode = next === 'live' ? 'live' : 'dry';
    if (mode !== 'live') R.confirm.classList.add('hidden');
}
let engineAvailable = false;
let routeError = null;
let killKey = 'F10';
let pickKey = 'CommandOrControl+Alt+P';
let armed = false;
let currentTab = 'monitor';

// Events carry a monotonic seq from main, so a replayed backlog and a live push
// that overlap during init cannot double-count.
let lastSeq = 0;
let eventCount = 0;
const seenTypes = new Set();

let waitUntil = 0;
let waitMs = 0;

function selectTab(name) {
    currentTab = name;
    for (const tab of document.querySelectorAll('.tab')) {
        tab.classList.toggle('active', tab.dataset.view === name);
    }
    for (const view of document.querySelectorAll('.view')) {
        view.classList.toggle('active', view.id === `view-${name}`);
    }
}

function clock(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toTimeString().slice(0, 8);
}

function fmtMs(ms) {
    if (!Number.isFinite(ms)) return '—';
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function fmtClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function log(kind, text, ts) {
    const line = document.createElement('div');
    line.className = `line ${kind}`;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = clock(ts);
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = kind;
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = text;
    line.append(t, k, m);

    const atBottom = R.log.scrollHeight - R.log.scrollTop - R.log.clientHeight < 24;
    R.log.appendChild(line);
    while (R.log.childElementCount > LOG_CAP) R.log.removeChild(R.log.firstChild);
    if (atBottom) R.log.scrollTop = R.log.scrollHeight;
}

function renderRows() {
    R.rows.innerHTML = '';
    if (!route) return;
    for (const [id, cfg] of Object.entries(route.locations)) {
        const row = document.createElement('div');
        row.className = `trow${cfg.enabled ? '' : ' off'}`;
        row.dataset.id = id;
        row.innerHTML =
            `<input type="checkbox" class="en"${cfg.enabled ? ' checked' : ''} />` +
            '<span class="name"></span>' +
            '<span class="kind"></span>' +
            `<input type="number" class="ms" min="250" max="600000" step="50" value="${Number(cfg.delayMs) || 0}" />` +
            '<span class="sec"></span>';
        row.querySelector('.name').textContent = id;
        row.querySelector('.kind').textContent = cfg.mode;
        row.querySelector('.sec').textContent = `${((Number(cfg.delayMs) || 0) / 1000).toFixed(2)}s`;
        R.rows.appendChild(row);
    }
}

// 0 means no limit everywhere here, so it is shown as "no limit" rather than a
// bare zero that reads like a broken value.
const WATCHDOGS = [
    { key: 'sameLocationMs', label: 'same location', unit: 'ms', step: 10000,
      hint: 'stop if the location has not changed for this long' },
    { key: 'maxClicksWithoutLocationChange', label: 'clicks, no move', unit: '', step: 1,
      hint: 'stop after this many clicks with no location change' },
    { key: 'maxClicksPerRun', label: 'clicks per run', unit: '', step: 100,
      hint: 'lifetime click cap for one run' },
    { key: 'maxRunMs', label: 'run length', unit: 'ms', step: 600000,
      hint: 'lifetime time cap for one run' }
];

function fmtCap(key, value) {
    const n = Number(value) || 0;
    if (!n) return 'no limit';
    if (key.endsWith('Ms')) {
        return n >= 3600000 ? `${(n / 3600000).toFixed(1)}h`
            : n >= 60000 ? `${Math.round(n / 60000)}m` : `${Math.round(n / 1000)}s`;
    }
    return `${n}`;
}

function renderWatchdogs() {
    if (!R.wdrows || !route || !route.watchdog) return;
    R.wdrows.innerHTML = '';
    for (const wd of WATCHDOGS) {
        const value = Number(route.watchdog[wd.key]) || 0;
        const row = document.createElement('div');
        row.className = 'trow';
        row.dataset.wd = wd.key;
        row.title = wd.hint;
        row.innerHTML =
            '<span></span>' +
            '<span class="name"></span>' +
            '<span class="kind"></span>' +
            `<input type="number" class="wdms" min="0" step="${wd.step}" value="${value}" />` +
            '<span class="sec"></span>';
        row.querySelector('.name').textContent = wd.label;
        row.querySelector('.kind').textContent = wd.unit;
        row.querySelector('.sec').textContent = fmtCap(wd.key, value);
        R.wdrows.appendChild(row);
    }
}

// Human-scale units, not milliseconds: nobody wants to type 14400000 to mean
// four hours, or 20000 to mean twenty seconds.
const BREAK_TIERS = [
    {
        key: 'short',
        label: 'short breaks',
        note: "A pause - stretch, read a message. Stays under the game's 5 min idle "
            + 'timer, so it never logs out and clicking just resumes.',
        rows: [
            { key: 'minPlayMs', label: 'play', unit: 'min', min: 1, step: 5,
              hint: 'typical shortest stretch of play between pauses' },
            { key: 'maxPlayMs', label: '  …to', unit: 'min', min: 1, step: 5,
              hint: 'typical longest stretch of play between pauses' },
            { key: 'minIdleMs', label: 'pause', unit: 's', min: 5, step: 10,
              hint: 'typical shortest pause' },
            { key: 'maxIdleMs', label: '  …to', unit: 's', min: 5, step: 10,
              hint: 'typical longest pause - hard-capped below the 5 min logout timer' }
        ]
    },
    {
        key: 'long',
        label: 'long break (logs out)',
        note: 'The toilet break. Idles PAST the 5 min timer so the game logs the '
            + 'character out, then auto-repair logs back in and restarts the clicker.',
        rows: [
            { key: 'minPlayMs', label: 'play', unit: 'min', min: 1, step: 30,
              hint: 'typical shortest stretch of play between long breaks' },
            { key: 'maxPlayMs', label: '  …to', unit: 'min', min: 1, step: 30,
              hint: 'typical longest stretch of play between long breaks' },
            { key: 'minIdleMs', label: 'idle', unit: 'min', min: 6, step: 1,
              hint: 'typical shortest break - hard floor of 6 min clears the logout timer' },
            { key: 'maxIdleMs', label: '  …to', unit: 'min', min: 6, step: 1,
              hint: 'typical longest break' }
        ]
    }
];

const UNIT_MS = { s: 1000, min: 60000 };

function fmtDuration(ms) {
    const n = Number(ms) || 0;
    if (n >= 3600000) return `${(n / 3600000).toFixed(1)}h`;
    if (n >= 60000) return `${Math.round(n / 60000)}m`;
    return `${Math.round(n / 1000)}s`;
}

function renderBreaks() {
    if (!R.brkrows || !route || !route.breaks) return;
    R.brkrows.innerHTML = '';

    for (const tier of BREAK_TIERS) {
        const cfg = route.breaks[tier.key];
        if (!cfg) continue;
        const on = Boolean(cfg.enabled);

        const head = document.createElement('div');
        head.className = 'row small';
        head.style.marginTop = '4px';
        head.dataset.tier = tier.key;
        head.innerHTML =
            '<button class="mini brktoggle"></button>' +
            '<span class="brklabel muted"></span>' +
            '<div class="spacer"></div>' +
            '<button class="mini brktest">test now</button>';
        const toggle = head.querySelector('.brktoggle');
        toggle.textContent = on ? 'ON' : 'OFF';
        toggle.style.color = on ? 'var(--warn)' : '';
        head.querySelector('.brklabel').textContent = tier.label;
        // Arming a break that cannot happen would only log a refusal.
        const test = head.querySelector('.brktest');
        test.disabled = !on || !state.running;
        test.title = !on ? `turn ${tier.label} on first`
            : !state.running ? 'only while the clicker is running'
                : 'take this break at the next allowed spot';
        R.brkrows.appendChild(head);

        for (const row of tier.rows) {
            const ms = Number(cfg[row.key]) || 0;
            const value = Math.round(ms / UNIT_MS[row.unit]);
            const el = document.createElement('div');
            el.className = `trow${on ? '' : ' off'}`;
            el.dataset.tier = tier.key;
            el.dataset.brk = row.key;
            el.title = row.hint || '';
            el.innerHTML =
                '<span></span>' +
                '<span class="name"></span>' +
                '<span class="kind"></span>' +
                `<input type="number" class="brkms" min="${row.min}" step="${row.step}" value="${value}" />` +
                '<span class="sec"></span>';
            el.querySelector('.name').textContent = row.label;
            el.querySelector('.kind').textContent = row.unit;
            el.querySelector('.sec').textContent = fmtDuration(ms);
            R.brkrows.appendChild(el);
        }
    }

    // Only the long break ends the run, and auto-repair is what makes that
    // recoverable. Enabling one without the other is silent until hours later.
    const orphaned = Boolean(route.breaks.long && route.breaks.long.enabled) && !autoOn;
    R.brknote.className = orphaned ? 'small warn' : 'small muted';
    R.brknote.textContent = orphaned
        ? 'The long break is ON but auto-repair is OFF - it will log out and nothing '
          + 'will log back in. Turn auto-repair on below.'
        : `${BREAK_TIERS.map((t) => `${t.label} — ${t.note}`).join('  ')}  `
          + 'Ranges are typical, not hard: intervals are drawn log-normally around '
          + 'them (about 1 in 5 lands outside) and come sooner as the session '
          + 'wears on. A flat 15-35 min is the rhythm of a script, not a person.';
}

// A break can only be forced while the clicker is actually running, and that
// changes far more often than the rest of the panel.
function syncBreakButtons() {
    if (!route) return;
    if (R.brkrows && route.breaks) {
        for (const btn of R.brkrows.querySelectorAll('.brktest')) {
            const tier = btn.closest('.row').dataset.tier;
            const on = Boolean(route.breaks[tier] && route.breaks[tier].enabled);
            btn.disabled = !on || !state.running;
            btn.title = !on ? `turn ${tier} breaks on first`
                : !state.running ? 'only while the clicker is running'
                    : 'take this break at the next allowed spot';
        }
    }
    if (R.dayrows && route.daily) {
        for (const btn of R.dayrows.querySelectorAll('.daytest')) {
            const kind = btn.closest('.row').dataset.day;
            const on = Boolean(route.daily[kind] && route.daily[kind].enabled);
            btn.disabled = !on || !state.running;
        }
    }
}

// Wall-clock breaks. Durations are minutes for meals and hours for sleep,
// because that is how a person says them.
const DAILY = [
    { key: 'lunch', label: 'lunch', unit: 'min', step: 5, min: 6,
      hint: 'roughly when, and roughly how long - both drift every day' },
    { key: 'dinner', label: 'dinner', unit: 'min', step: 5, min: 6,
      hint: 'roughly when, and roughly how long - both drift every day' },
    { key: 'sleep', label: 'sleep', unit: 'h', step: 1, min: 1,
      hint: 'the EARLIEST bedtime - the roll only ever pushes it later' }
];

const DAY_UNIT_MS = { min: 60000, h: 3600000 };

function renderDaily() {
    if (!R.dayrows || !route || !route.daily) return;
    R.dayrows.innerHTML = '';

    for (const ev of DAILY) {
        const cfg = route.daily[ev.key];
        if (!cfg) continue;
        const on = Boolean(cfg.enabled);
        const unit = DAY_UNIT_MS[ev.unit];
        const row = document.createElement('div');
        row.className = `row small${on ? '' : ' muted'}`;
        row.style.marginTop = '4px';
        row.dataset.day = ev.key;
        row.title = ev.hint;
        row.innerHTML =
            '<button class="mini daytoggle" style="width:38px"></button>' +
            '<span class="dayname" style="width:52px"></span>' +
            '<input type="time" class="dayat" step="300" />' +
            '<span class="muted">for</span>' +
            '<input type="number" class="daymin wdms" style="width:52px" />' +
            '<span class="muted">-</span>' +
            '<input type="number" class="daymax wdms" style="width:52px" />' +
            `<span class="muted">${ev.unit}</span>` +
            '<div class="spacer"></div>' +
            '<button class="mini daytest">test now</button>';
        const toggle = row.querySelector('.daytoggle');
        toggle.textContent = on ? 'ON' : 'OFF';
        toggle.style.color = on ? 'var(--warn)' : '';
        row.querySelector('.dayname').textContent = ev.label;
        row.querySelector('.dayat').value = cfg.at;
        for (const [cls, key] of [['.daymin', 'minMs'], ['.daymax', 'maxMs']]) {
            const input = row.querySelector(cls);
            input.min = ev.min;
            input.step = ev.step;
            input.value = ev.unit === 'h'
                ? Math.round((Number(cfg[key]) || 0) / unit * 10) / 10
                : Math.round((Number(cfg[key]) || 0) / unit);
        }
        const test = row.querySelector('.daytest');
        test.disabled = !on || !state.running;
        test.title = !on ? `turn ${ev.label} on first`
            : !state.running ? 'only while the clicker is running'
                : 'take it now, shortened to 6 min so it is watchable';
        R.dayrows.appendChild(row);
    }

    R.daygrace.value = Math.round((Number(route.daily.minPlayBeforeMs) || 0) / 60000);
    renderDayPlan();
}

// The configured time is not the time it will happen. Show what today rolled to.
let dayPlan = null;

function renderDayPlan() {
    if (!R.daynote) return;
    const anyOn = DAILY.some((e) => route && route.daily[e.key] && route.daily[e.key].enabled);
    if (!anyOn) {
        R.daynote.className = 'small muted';
        R.daynote.textContent = 'All off - the clicker will play straight through, '
            + 'which no person does.';
        return;
    }
    if (!dayPlan || !dayPlan.ok) {
        R.daynote.className = 'small muted';
        R.daynote.textContent = 'Times drift every day and the duration is drawn around '
            + 'the range, so no two days repeat. Today\'s plan appears once the clicker '
            + 'has started.';
        return;
    }
    const parts = Object.entries(dayPlan.events || {}).map(([k, v]) => `${k}: ${v}`);
    R.daynote.className = 'small muted';
    R.daynote.textContent = parts.length ? `today — ${parts.join('   ')}` : 'nothing planned today';
}

// Read-only: the dashboard is configured by environment variables, because the
// token is a secret and route.json is not a place to keep one.
async function refreshTelemetry() {
    if (!R.telnote) return;
    let stats = null;
    try {
        stats = await window.api.run.telemetryStats();
    } catch (err) {
        stats = null;
    }
    if (!stats || !stats.configured) {
        R.telnote.className = 'small muted';
        R.telnote.textContent = 'Remote dashboard off — set GREENBOT_DASH_URL and '
            + 'GREENBOT_DASH_TOKEN before starting the panel to push status there.';
        return;
    }
    const failing = Boolean(stats.lastError);
    R.telnote.className = failing ? 'small warn' : 'small muted';
    R.telnote.textContent = failing
        ? `dashboard ${stats.url} — ${stats.lastError} (${stats.queued} queued)`
        : `dashboard ${stats.url} — ${stats.posts} pushes every `
            + `${Math.round((stats.heartbeatMs || 10000) / 1000)}s, `
            + `${stats.applied} remote commands applied`
            + `${stats.queued ? `, ${stats.queued} queued` : ''}`;
}

async function refreshDayPlan() {
    try {
        dayPlan = await window.api.run.dailyPlan();
    } catch (err) {
        dayPlan = null;
    }
    renderDayPlan();
}

async function patchDaily(patch, note) {
    const res = await window.api.run.saveRoute({ daily: patch });
    if (!res || !res.route) return;
    route = res.route;
    renderDaily();
    if (note) log('run', note(route.daily));
}

async function patchBreaks(patch, note) {
    const res = await window.api.run.saveRoute({ breaks: patch });
    if (!res || !res.route) return;
    route = res.route;
    // Re-render from what landed on disk: route.js clamps each tier's idle to
    // its own side of the logout timer, and the fields must show that.
    renderBreaks();
    if (note) log('run', note(route.breaks));
}

function renderPoint() {
    const transit = route && route.locations.transit;
    const point = transit && transit.point;
    R.pointVal.textContent = point ? `${point.x} , ${point.y}` : 'not set';
    R.pointVal.classList.toggle('muted', !point);
}

function renderPick() {
    R.pickHint.classList.toggle('hidden', !armed);
    if (armed) {
        R.pickHint.innerHTML = 'Move the mouse over the transit target on screen, then press <kbd></kbd>';
        R.pickHint.querySelector('kbd').textContent = pickKey.replace('CommandOrControl', 'Ctrl');
    }
    const transit = route && route.locations.transit;
    R.pickBtn.disabled = !transit;
    R.pickBtn.textContent = armed ? 'Cancel' : (transit && transit.point ? 'Re-pick' : 'Set click point');
}

function render() {
    const ready = engineAvailable && Boolean(route);
    R.btn.textContent = state.running ? 'STOP' : 'START';
    R.btn.className = state.running ? 'stop' : (mode === 'live' ? 'armed' : '');
    R.btn.disabled = !ready;

    R.dry.classList.toggle('on', mode === 'dry');
    R.live.classList.toggle('on', mode === 'live');
    R.dry.disabled = state.running;
    R.live.disabled = state.running;

    if (!ready) {
        R.hint.textContent = routeError || 'harness/engine.js is missing — nothing to drive';
    } else if (state.running) {
        R.hint.innerHTML = `${state.dryRun ? 'dry run' : 'LIVE — clicking for real'} · press <kbd></kbd> anywhere to stop`;
        R.hint.querySelector('kbd').textContent = killKey;
    } else if (mode === 'live') {
        R.hint.textContent = `LIVE armed — START will click for real, ${killKey} stops it`;
    } else {
        R.hint.textContent = 'dry run — decisions are logged, nothing is clicked';
    }

    syncBreakButtons();
    R.phase.textContent = state.phase;
    R.phase.className = `stat ${state.phase}`;
    R.loc.textContent = state.location || '—';
    R.clicks.textContent = String(state.clicks);
}

function renderCountdown() {
    if (state.startedAt && state.running) {
        R.elapsed.textContent = fmtClock(Date.now() - state.startedAt);
    }
    if (!waitUntil || !state.running) {
        R.count.textContent = '—';
        R.countfill.style.width = '0';
        return;
    }
    const left = Math.max(0, waitUntil - Date.now());
    R.count.textContent = fmtMs(left);
    R.countfill.style.width = `${waitMs ? (left / waitMs) * 100 : 0}%`;
}

function applyEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.seq !== undefined) {
        if (ev.seq <= lastSeq) return;
        lastSeq = ev.seq;
    }
    eventCount += 1;
    seenTypes.add(ev.type);

    // Repair events. Without these the log stayed silent for the entire minutes
    // a repair takes, which reads as "nothing is happening" and gets cancelled.
    if (ev.type && ev.type.startsWith('auto:')) {
        switch (ev.type) {
            case 'auto:cycle-start':
                log('run', `repair cycle ${ev.cycle} — ${ev.reason}`, ev.ts);
                break;
            case 'auto:claude-start':
                log('run', 'claude starting…', ev.ts);
                break;
            case 'auto:claude-output':
                log('claude', ev.line, ev.ts);
                break;
            case 'auto:claude-done':
                log('run', `claude done (exit ${ev.code}) in ${Math.round((ev.ms || 0) / 1000)}s`, ev.ts);
                if (ev.report) log('claude', `report: ${ev.report.split('\n')[0]}`, ev.ts);
                break;
            case 'auto:verify':
                log(ev.ok ? 'run' : 'warn',
                    `verify ${ev.stage}: ${ev.ok ? 'ok' : 'FAILED'} — ${ev.detail}`, ev.ts);
                break;
            case 'auto:resumed':
                log('run', 'clicker resumed', ev.ts);
                break;
            case 'auto:progress':
                log('run', ev.message, ev.ts);
                break;
            case 'auto:give-up':
                log('warn', `repair gave up: ${ev.reason}`, ev.ts);
                break;
            case 'auto:disabled':
                log('warn', `auto-repair disabled: ${ev.reason}`, ev.ts);
                break;
            default:
                break;
        }
        renderAuto(Object.assign({ enabled: autoOn }, lastAutoStats || {},
            { stage: ev.type === 'auto:give-up' ? 'idle' : 'repairing' }));
        return;
    }

    switch (ev.type) {
        case 'started':
            state.running = true;
            state.startedAt = ev.at || ev.ts || Date.now();
            state.clicks = 0;
            state.phase = 'polling';
            waitUntil = 0;
            // From the event, not from state: this arrives before start()'s reply
            // assigns state.dryRun, so state still holds the previous run's mode.
            if (typeof ev.dryRun === 'boolean') state.dryRun = ev.dryRun;
            log('run', `started — ${state.dryRun ? 'dry run' : 'LIVE'}`, ev.ts);
            refreshDayPlan();
            break;
        case 'tick':
            state.phase = ev.phase || state.phase;
            state.location = ev.location;
            break;
        case 'click': {
            state.clicks += 1;
            state.phase = 'clicking';
            waitUntil = 0;
            const at = ev.at || {};
            const box = ev.box ? ` in ${ev.box.w}×${ev.box.h} box` : '';
            log(ev.dryRun ? 'dry' : 'click',
                `#${state.clicks} ${ev.location} ${ev.mode} at ${at.x},${at.y}${box}${ev.dryRun ? ' (not clicked)' : ''}`,
                ev.ts);
            break;
        }
        case 'wait': {
            state.phase = 'waiting';
            waitMs = Number(ev.appliedMs) || 0;
            waitUntil = (ev.ts || Date.now()) + waitMs;
            const parts = [`base ${fmtMs(ev.baseMs)}`];
            if (ev.hesitationMs) parts.push(`hesitate +${fmtMs(ev.hesitationMs)}`);
            if (ev.pauseMs) parts.push(`pause +${fmtMs(ev.pauseMs)}`);
            log('wait', `${ev.location} ${fmtMs(ev.appliedMs)}  (${parts.join(', ')})`, ev.ts);
            break;
        }
        case 'warn':
            log('warn', String(ev.message), ev.ts);
            break;
        case 'daily:planned': {
            const parts = Object.entries(ev.events || {}).map(([k, v]) => `${k} ${v}`);
            log('run', `today — ${parts.join(', ')}`, ev.ts);
            refreshDayPlan();
            break;
        }
        case 'daily:missed':
            log('warn', `${ev.kind} was missed — the window passed while the bot `
                + 'was not running', ev.ts);
            break;
        case 'break:scheduled':
            log('run', `next ${ev.kind} break in ${fmtMs(ev.inMs)}`, ev.ts);
            break;
        case 'break:armed':
            log('run', `${ev.kind} break armed — it will start at the next spot, `
                + 'never on transit', ev.ts);
            break;
        case 'break:start':
            state.phase = 'break';
            log('warn', `${ev.kind} break${ev.forced ? ' (test)' : ''} — idle for `
                + `${fmtMs(ev.idleMs)} at ${ev.location}; `
                + (ev.expectsLogout
                    ? `the game logs out after ${fmtMs(ev.logoutAfterMs)} of it`
                    : 'short enough to stay logged in'), ev.ts);
            break;
        case 'break:idle':
            // Reuse the click countdown: it already renders "time until the next
            // thing happens", which during a break is the end of the break.
            state.phase = 'break';
            waitMs = Number(ev.idleMs) || 0;
            waitUntil = (ev.ts || Date.now()) + (Number(ev.remainingMs) || 0);
            break;
        case 'break:done':
            waitUntil = 0;
            log(ev.loggedOut ? 'warn' : 'run',
                `${ev.kind} break over after ${fmtMs(ev.ms)} — `
                + (ev.loggedOut
                    ? `logged out (${ev.detail}), handing over to auto-repair`
                    : `still logged in (${ev.detail})`), ev.ts);
            break;
        case 'stopped':
            state.running = false;
            state.phase = 'stopped';
            waitUntil = 0;
            log('stop', `stopped — ${ev.reason || 'no reason given'}`, ev.ts);
            break;
        default:
            break;
    }

    render();
    renderCountdown();
}

async function start() {
    R.confirm.classList.add('hidden');
    const live = mode === 'live';
    const res = await window.api.run.start({ live, confirm: live });
    if (res && res.ok) {
        state.dryRun = res.dryRun;
        state.running = true;
        state.startedAt = Date.now();
        render();
    } else {
        log('warn', (res && res.error) || 'start refused');
    }
    return res;
}

async function stop() {
    // Optimistic: the run is over the moment main returns, whatever the engine
    // takes to say so.
    const res = await window.api.run.stop();
    state.running = false;
    state.phase = 'stopped';
    waitUntil = 0;
    // Drop back to dry run. START and STOP are the same button in the same
    // place, so without this a stray second click restarts a LIVE run with no
    // confirmation - the mode has to be re-armed deliberately every time.
    setMode('dry');
    render();
    renderCountdown();
    return res;
}

async function saveRow(id) {
    const row = R.rows.querySelector(`.trow[data-id="${id}"]`);
    if (!row) return;
    const patch = { locations: {} };
    patch.locations[id] = {
        delayMs: Number(row.querySelector('.ms').value),
        enabled: row.querySelector('.en').checked
    };
    const res = await window.api.run.saveRoute(patch);
    if (!res.route) {
        log('warn', res.error || 'route.json could not be written');
        return;
    }
    route = res.route;
    const saved = route.locations[id];
    row.querySelector('.ms').value = String(saved.delayMs);
    row.querySelector('.sec').textContent = `${(saved.delayMs / 1000).toFixed(2)}s`;
    row.classList.toggle('off', !saved.enabled);
    R.timinghint.textContent = state.running && !res.appliedToRun
        ? 'saved — takes effect on the next start'
        : 'saved to route.json';
}

function wire() {
    for (const tab of document.querySelectorAll('.tab')) {
        tab.addEventListener('click', () => selectTab(tab.dataset.view));
    }

    R.btn.addEventListener('click', () => (state.running ? stop() : start()));

    R.dry.addEventListener('click', () => {
        if (state.running) return;
        setMode('dry');
        window.api.run.setMode('dry');
        render();
    });

    // Two deliberate actions to arm live clicking, never one stray click.
    R.live.addEventListener('click', () => {
        if (state.running || mode === 'live') return;
        R.confirm.classList.remove('hidden');
    });
    R.confirmNo.addEventListener('click', () => R.confirm.classList.add('hidden'));
    R.confirmYes.addEventListener('click', () => {
        R.confirm.classList.add('hidden');
        // The bar is hidden mid-run, so arming from it would be arming unseen.
        if (state.running) return;
        setMode('live');
        // Tell main immediately. Arming only set renderer state, so a start that
        // did not come from this button - control.js, or the repair skill - read
        // the stale run.dryRun and silently ran dry. That is exactly what
        // happened during a live end-to-end test.
        window.api.run.setMode('live');
        log('warn', 'live clicking armed — START will move the real mouse');
        render();
    });

    R.wdrows.addEventListener('change', async (e) => {
        if (!e.target.classList.contains('wdms')) return;
        const row = e.target.closest('.trow');
        const key = row.dataset.wd;
        const value = Math.max(0, Math.round(Number(e.target.value) || 0));
        const res = await window.api.run.saveRoute({ watchdog: { [key]: value } });
        if (res && res.route) {
            route = res.route;
            renderWatchdogs();
            log('run', `watchdog ${key} = ${fmtCap(key, route.watchdog[key])}`);
        }
    });

    R.dayrows.addEventListener('click', async (e) => {
        const row = e.target.closest('.row');
        if (!row || !row.dataset.day) return;
        const kind = row.dataset.day;

        if (e.target.classList.contains('daytoggle')) {
            const on = !(route.daily[kind] && route.daily[kind].enabled);
            await patchDaily({ [kind]: { enabled: on } },
                (d) => `${kind} ${d[kind].enabled ? 'ON' : 'OFF'}`);
            return;
        }
        if (e.target.classList.contains('daytest')) {
            const res = await window.api.run.testBreak(kind);
            if (!res || !res.ok) {
                log('warn', `could not arm ${kind}: ${(res && res.reason) || 'no reply'}`);
            }
        }
    });

    R.dayrows.addEventListener('change', async (e) => {
        const row = e.target.closest('.row');
        if (!row || !row.dataset.day) return;
        const kind = row.dataset.day;
        const spec = DAILY.find((d) => d.key === kind);

        if (e.target.classList.contains('dayat')) {
            await patchDaily({ [kind]: { at: e.target.value } },
                (d) => `${kind} at ${d[kind].at}`);
            await refreshDayPlan();
            return;
        }
        const key = e.target.classList.contains('daymin') ? 'minMs'
            : e.target.classList.contains('daymax') ? 'maxMs' : null;
        if (!key) return;
        const value = Math.max(0, Number(e.target.value) || 0) * DAY_UNIT_MS[spec.unit];
        await patchDaily({ [kind]: { [key]: Math.round(value) } },
            (d) => `${kind} ${key} = ${fmtDuration(d[kind][key])}`);
    });

    R.daygrace.addEventListener('change', async () => {
        const mins = Math.max(0, Math.round(Number(R.daygrace.value) || 0));
        await patchDaily({ minPlayBeforeMs: mins * 60000 },
            (d) => `skip anything within ${Math.round(d.minPlayBeforeMs / 60000)} min of START`);
    });

    R.brkrows.addEventListener('click', async (e) => {
        const head = e.target.closest('.row');
        if (!head || !head.dataset.tier) return;
        const tier = head.dataset.tier;

        if (e.target.classList.contains('brktoggle')) {
            const on = !(route.breaks[tier] && route.breaks[tier].enabled);
            await patchBreaks({ [tier]: { enabled: on } },
                (b) => `${tier} breaks ${b[tier].enabled ? 'ON' : 'OFF'}`);
            return;
        }
        if (e.target.classList.contains('brktest')) {
            const res = await window.api.run.testBreak(tier);
            // main logs the outcome as a warn event, so this only has to report
            // a refusal that never reached the engine.
            if (!res || !res.ok) {
                log('warn', `could not arm the ${tier} break: `
                    + `${(res && res.reason) || 'no reply'}`);
            }
        }
    });

    R.brkrows.addEventListener('change', async (e) => {
        if (!e.target.classList.contains('brkms')) return;
        const row = e.target.closest('.trow');
        const tier = row.dataset.tier;
        const key = row.dataset.brk;
        const unit = row.querySelector('.kind').textContent;
        const value = Math.max(1, Math.round(Number(e.target.value) || 0)) * UNIT_MS[unit];
        await patchBreaks({ [tier]: { [key]: value } },
            (b) => `${tier} ${key} = ${fmtDuration(b[tier][key])}`);
    });

    R.brkrows.addEventListener('input', (e) => {
        if (!e.target.classList.contains('brkms')) return;
        const row = e.target.closest('.trow');
        const unit = row.querySelector('.kind').textContent;
        row.querySelector('.sec').textContent =
            fmtDuration((Number(e.target.value) || 0) * UNIT_MS[unit]);
    });

    R.wdrows.addEventListener('input', (e) => {
        if (!e.target.classList.contains('wdms')) return;
        const row = e.target.closest('.trow');
        row.querySelector('.sec').textContent = fmtCap(row.dataset.wd, e.target.value);
    });

    R.logclear.addEventListener('click', () => { R.log.innerHTML = ''; });

    // wire() is synchronous; the initial stats fetch happens in initRun().
    R.autobtn.addEventListener('click', async () => {
        renderAuto(await window.api.run.setAutoRepair(!autoOn));
    });

    R.autotest.addEventListener('click', async () => {
        R.autotest.disabled = true;
        R.autotest.textContent = 'repairing…';
        R.autoabort.classList.remove('hidden');
        log('run', 'manual repair test — this runs the real cycle, watch below');
        try {
            const res = await window.api.run.testRepair();
            log(res && res.ok ? 'run' : 'warn',
                res && res.ok ? `repair test succeeded in ${res.steps || '?'} step(s)`
                    : `repair test failed: ${(res && res.reason) || 'unknown'}`);
        } finally {
            R.autotest.disabled = false;
            R.autotest.textContent = 'test repair now';
            R.autoabort.classList.add('hidden');
            renderAuto(await window.api.run.autoStats());
        }
    });

    R.autoabort.addEventListener('click', async () => {
        renderAuto(await window.api.run.abortRepair());
        log('warn', 'repair cancelled');
    });

    R.rows.addEventListener('input', (e) => {
        if (!e.target.classList.contains('ms')) return;
        const ms = Number(e.target.value);
        e.target.closest('.trow').querySelector('.sec').textContent =
            Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)}s` : '—';
    });
    R.rows.addEventListener('change', (e) => {
        const row = e.target.closest('.trow');
        if (row) saveRow(row.dataset.id);
    });

    R.reset.addEventListener('click', async () => {
        const res = await window.api.run.resetTimings();
        if (!res.route) {
            log('warn', res.error || 'route.json could not be written');
            return;
        }
        route = res.route;
        renderRows();
        renderWatchdogs();
        R.timinghint.textContent = 'restored the recorded "releka android" timings';
    });

    R.pickBtn.addEventListener('click', async () => {
        const res = armed ? await window.api.run.disarmPick() : await window.api.run.armPick();
        armed = Boolean(res.armed);
        pickKey = res.accelerator || pickKey;
        if (res.error) log('warn', res.error);
        renderPick();
    });

    window.addEventListener('beforeunload', () => {
        if (armed) window.api.run.disarmPick();
    });
}

function onPick(info) {
    armed = Boolean(info.armed);
    if (info.point && route && route.locations.transit) {
        route.locations.transit.point = info.point;
        log('run', `transit click point set to ${info.point.x}, ${info.point.y}`);
    }
    renderPoint();
    renderPick();
}

// Selftest surface: the run tab has to be drivable without a mouse.
window.__run = {
    ready: false,
    selectTab,
    start,
    stop,
    diag: () => ({
        tab: currentTab,
        rows: R.rows.childElementCount,
        events: eventCount,
        types: [...seenTypes],
        phase: state.phase,
        running: Boolean(state.running),
        clicks: state.clicks,
        dryRun: Boolean(state.dryRun),
        mode,
        armed,
        engineAvailable,
        breakRows: R.brkrows.childElementCount,
        breakTests: R.brkrows.querySelectorAll('.brktest:not([disabled])').length,
        breaksOn: Boolean(route && route.breaks && route.breaks.short.enabled),
        dayRows: R.dayrows.childElementCount,
        dayTests: R.dayrows.querySelectorAll('.daytest:not([disabled])').length,
        // The orphaned-breaks warning is the only thing telling the user that
        // breaks without auto-repair end the session for good.
        breakWarn: R.brknote.classList.contains('warn')
    }),
    setBreaks: async (tier, on) => {
        const res = await window.api.run.saveRoute({
            breaks: { [tier]: { enabled: Boolean(on) } } });
        if (res && res.route) route = res.route;
        renderBreaks();
        return route && route.breaks;
    },
    testBreak: (tier) => window.api.run.testBreak(tier),
    setDaily: async (kind, on) => {
        const res = await window.api.run.saveRoute({ daily: { [kind]: { enabled: Boolean(on) } } });
        if (res && res.route) route = res.route;
        renderDaily();
        return route && route.daily;
    }
};

(async function initRun() {
    // Listen first, pull second: an event fired between the two arrives with a
    // seq the backlog already covers, and is dropped rather than lost.
    window.api.onEngineEvent(applyEvent);
    window.api.onPick(onPick);
    // The dashboard can arm LIVE too, and the panel must not go on claiming it
    // is in dry run when it is not.
    window.api.onMode(({ dryRun }) => {
        setMode(dryRun ? 'dry' : 'live');
        state.dryRun = dryRun;
        log('warn', `mode set to ${dryRun ? 'dry run' : 'LIVE'} from the dashboard`);
        render();
    });

    const s = await window.api.run.state();
    route = s.route;
    routeError = s.routeError;
    state = Object.assign(state, s.run);
    engineAvailable = s.engineAvailable;
    killKey = s.killAccelerator || killKey;
    pickKey = (s.pick && s.pick.accelerator) || pickKey;
    armed = Boolean(s.pick && s.pick.armed);

    wire();
    renderAuto(await window.api.run.autoStats());
    renderRows();
    renderWatchdogs();
    renderBreaks();
    renderDaily();
    renderPoint();
    renderPick();
    render();
    for (const ev of s.events) applyEvent(ev);

    setInterval(renderCountdown, 200);
    // The plan is rolled by the engine, so it only exists once a run has started.
    refreshDayPlan();
    setInterval(refreshDayPlan, 30000);
    refreshTelemetry();
    setInterval(refreshTelemetry, 30000);

    window.__run.ready = true;
})();
