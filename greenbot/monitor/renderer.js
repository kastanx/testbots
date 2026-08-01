const el = {
    loc: document.getElementById('loc'),
    conf: document.getElementById('conf'),
    bars: document.getElementById('bars'),
    shot: document.getElementById('shot'),
    wrap: document.getElementById('wrap'),
    click: document.getElementById('click'),
    boxinfo: document.getElementById('boxinfo'),
    status: document.getElementById('status'),
    statustext: document.getElementById('statustext'),
    dot: document.getElementById('dot'),
    rate: document.getElementById('rate'),
    timing: document.getElementById('timing'),
    capvis: document.getElementById('capvis'),
    capvishint: document.getElementById('capvishint'),
    hz: document.getElementById('hz'),
    hzval: document.getElementById('hzval')
};

// Boxes are drawn on a canvas layered over the preview, so the JPEG itself is
// never re-encoded and the overlay stays crisp when the window is resized.
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
el.wrap.appendChild(canvas);
const ctx = canvas.getContext('2d');

let config = { url: '', hz: 3 };
let lastTick = 0;
let ticks = 0;
let errors = 0;
let rendered = false;
let lastError = null;

// Kept current on BOTH paths. Reporting ticks:0 after a dozen failed polls sent
// the selftest chasing the wrong problem once already.
function diag(extra) {
    window.__diag = Object.assign({ ticks, errors, rendered, lastError }, extra);
}

let protectedNow = true;

function renderCapVis(on) {
    protectedNow = Boolean(on);
    el.capvis.textContent = protectedNow ? 'hidden from capture' : 'VISIBLE in capture';
    el.capvis.style.color = protectedNow ? '' : 'var(--warn)';
    el.capvis.style.borderColor = protectedNow ? '' : 'var(--warn)';
    el.capvishint.textContent = protectedNow
        ? 'invisible to Remote Desktop — click to show'
        : 'appears in the frames the service analyses';
}

function setStatus(live, text) {
    el.dot.className = live ? 'live' : 'down';
    el.status.className = 'panel small' + (live ? '' : ' down');
    el.statustext.textContent = text;
}

function drawOverlay(payload) {
    const img = el.shot;
    if (!img.naturalWidth) return;

    // The preview is the detect-scale frame; clickables are in SCREEN pixels.
    const sx = img.naturalWidth / payload.image.width;
    const sy = img.naturalHeight / payload.image.height;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const target = payload.target;
    for (const b of payload.clickables) {
        const isTarget = target
            && b.x === target.x && b.y === target.y && b.w === target.w && b.h === target.h;
        ctx.lineWidth = isTarget ? 3 : 1;
        ctx.strokeStyle = isTarget ? '#ffd83d' : 'rgba(160,170,190,.55)';
        ctx.strokeRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    }

    if (target) {
        const cx = target.cx * sx;
        const cy = target.cy * sy;
        ctx.strokeStyle = '#ffd83d';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 11, 0, Math.PI * 2);
        ctx.moveTo(cx - 17, cy); ctx.lineTo(cx - 4, cy);
        ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 17, cy);
        ctx.moveTo(cx, cy - 17); ctx.lineTo(cx, cy - 4);
        ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 17);
        ctx.stroke();
    }
    rendered = true;
}

function renderTop3(top3) {
    el.bars.innerHTML = '';
    for (const entry of top3.slice(0, 3)) {
        const row = document.createElement('div');
        row.className = 'bar';
        row.innerHTML =
            `<span class="muted">${entry.id}</span>` +
            `<span class="track"><span class="fill" style="width:${(entry.confidence * 100).toFixed(1)}%"></span></span>` +
            `<span class="val">${(entry.confidence * 100).toFixed(0)}%</span>`;
        el.bars.appendChild(row);
    }
}

function onTick(tick) {
    ticks += 1;
    const now = performance.now();
    if (lastTick) el.rate.textContent = `${(1000 / (now - lastTick)).toFixed(1)}/s`;
    lastTick = now;

    if (!tick.ok) {
        errors += 1;
        lastError = tick.error || 'server unreachable';
        diag();
        setStatus(false, lastError);
        el.loc.textContent = '—';
        el.loc.className = 'unknown';
        el.conf.textContent = '—';
        el.conf.className = '';
        el.click.textContent = 'no data';
        el.click.className = 'none';
        el.boxinfo.textContent = `${tick.url || config.url} — is the service running?`;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
    }

    const p = tick.payload;
    setStatus(true, `${p.image.width}×${p.image.height} → ${p.capture.detect_width}px`);
    el.timing.textContent =
        `cap ${p.timing_ms.capture} · cls ${p.timing_ms.classify} · det ${p.timing_ms.detect} ms`;

    const conf = p.location.confidence;
    el.loc.textContent = p.location.id;
    el.loc.className = p.location.id === 'transit' ? 'transit' : '';
    el.conf.textContent = conf.toFixed(3);
    el.conf.className = conf >= 0.7 ? 'high' : 'low';
    renderTop3(p.location.top3);

    if (p.target) {
        el.click.textContent = `${p.target.cx} , ${p.target.cy}`;
        el.click.className = '';
        el.boxinfo.textContent =
            `box ${p.target.w}×${p.target.h} at (${p.target.x}, ${p.target.y})` +
            `  ·  ${p.clickables.length} candidate${p.clickables.length === 1 ? '' : 's'}`;
    } else {
        el.click.textContent = p.location.id === 'transit'
            ? 'in transit — nothing to click'
            : 'no target for this location';
        el.click.className = 'none';
        el.boxinfo.textContent = `${p.clickables.length} green box(es) found`;
    }

    if (p.preview_b64) {
        el.shot.onload = () => drawOverlay(p);
        el.shot.src = `data:image/jpeg;base64,${p.preview_b64}`;
    } else {
        drawOverlay(p);
    }

    diag({ location: p.location.id });
}

(async function init() {
    config = await window.api.getConfig();
    el.hz.value = String(Math.round(config.hz));
    el.hzval.textContent = `${Math.round(config.hz)} Hz`;
    el.boxinfo.textContent = config.url;

    renderCapVis(config.contentProtected);
    el.capvis.addEventListener('click', async () => {
        renderCapVis(await window.api.setContentProtection(!protectedNow));
    });

    el.hz.addEventListener('input', async () => {
        const applied = await window.api.setHz(Number(el.hz.value));
        el.hzval.textContent = `${Math.round(applied)} Hz`;
    });

    window.api.onTick(onTick);
    diag();
})();
