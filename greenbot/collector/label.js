/* Bounding-box editor mode (v2 Phase 3).
 *
 * Boxes are held in NORMALISED yolo space (cls cx cy w h) for the whole
 * lifetime of an edit. Converting a proposal to pixels and back would drift the
 * 6th decimal and turn every re-save into a diff, so css pixels only ever exist
 * between normToPoint() and pointToNorm().
 */

// Single class for now, but the class lives in the data model and in this list
// rather than being hardcoded at the write site - adding "portal" here plus a
// second entry is the whole change.
const CLASSES = ['clickable'];

const HANDLE = 9;           // css px, the square drawn on a selected box
const GRAB = 7;             // css px, how close the pointer must be to a handle
const MIN_BOX_PX = 4;       // image px; a smaller drag was a click, not a box

const CURSORS = {
    '-1,-1': 'nwse-resize', '0,-1': 'ns-resize', '1,-1': 'nesw-resize',
    '-1,0': 'ew-resize', '1,0': 'ew-resize',
    '-1,1': 'nesw-resize', '0,1': 'ns-resize', '1,1': 'nwse-resize'
};

const lel = {
    open: document.getElementById('lb-open'),
    dir: document.getElementById('lb-dir'),
    progress: document.getElementById('lb-progress'),
    zero: document.getElementById('lb-zero'),
    unlabeled: document.getElementById('lb-unlabeled'),
    prev: document.getElementById('lb-prev'),
    next: document.getElementById('lb-next'),
    save: document.getElementById('lb-save'),
    file: document.getElementById('lb-file'),
    boxes: document.getElementById('lb-boxes'),
    dirty: document.getElementById('lb-dirty'),
    msg: document.getElementById('lb-msg'),
    wrap: document.getElementById('lb-canvaswrap'),
    canvas: document.getElementById('lb-canvas')
};

const lctx = lel.canvas.getContext('2d');

const S = {
    active: false,
    dir: null,
    images: [],             // { path, name, count }  count null = no .txt on disk
    index: -1,
    img: null,
    boxes: [],
    selected: -1,
    drag: null,
    loadToken: 0,
    // Unsaved work survives A/D, so a stray keypress cannot throw away edits.
    edits: new Map(),
    view: { scale: 1, ox: 0, oy: 0, dw: 0, dh: 0, cw: 1, ch: 1, dpr: 1 }
};

/* ------------------------------------------------------------- geometry */

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

// Letterbox: one uniform scale, centred, so the aspect ratio is never
// distorted. The image ends up drawn at exactly (ox, oy, dw, dh) in css px -
// normToPoint()/pointToNorm() below are the only places that know this.
function viewFor(cw, ch, iw, ih, dpr) {
    if (!iw || !ih) return { scale: 1, ox: 0, oy: 0, dw: 0, dh: 0, cw, ch, dpr };
    const scale = Math.min(cw / iw, ch / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    return { scale, dw, dh, ox: (cw - dw) / 2, oy: (ch - dh) / 2, cw, ch, dpr };
}

function fit() {
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, lel.canvas.clientWidth);
    const ch = Math.max(1, lel.canvas.clientHeight);
    const bw = Math.round(cw * dpr);
    const bh = Math.round(ch * dpr);
    if (lel.canvas.width !== bw) lel.canvas.width = bw;
    if (lel.canvas.height !== bh) lel.canvas.height = bh;

    S.view = viewFor(cw, ch, S.img ? S.img.naturalWidth : 0,
        S.img ? S.img.naturalHeight : 0, dpr);
}

function normToPoint(nx, ny) {
    const v = S.view;
    return { x: v.ox + nx * v.dw, y: v.oy + ny * v.dh };
}

function pointToNorm(x, y) {
    const v = S.view;
    return { x: (x - v.ox) / v.dw, y: (y - v.oy) / v.dh };
}

function boxRect(b) {
    const tl = normToPoint(b.cx - b.w / 2, b.cy - b.h / 2);
    return { x: tl.x, y: tl.y, w: b.w * S.view.dw, h: b.h * S.view.dh };
}

function eventPoint(e) {
    const r = lel.canvas.getBoundingClientRect();
    return pointToNorm(e.clientX - r.left, e.clientY - r.top);
}

function handles(b) {
    const r = boxRect(b);
    const xs = [[r.x, -1], [r.x + r.w / 2, 0], [r.x + r.w, 1]];
    const ys = [[r.y, -1], [r.y + r.h / 2, 0], [r.y + r.h, 1]];
    const out = [];
    for (const [y, ey] of ys) {
        for (const [x, ex] of xs) {
            if (!ex && !ey) continue;
            out.push({ x, y, ex, ey });
        }
    }
    return out;
}

function setEdges(b, x0, y0, x1, y1) {
    const ax = clamp01(Math.min(x0, x1));
    const bx = clamp01(Math.max(x0, x1));
    const ay = clamp01(Math.min(y0, y1));
    const by = clamp01(Math.max(y0, y1));
    b.cx = (ax + bx) / 2;
    b.cy = (ay + by) / 2;
    b.w = bx - ax;
    b.h = by - ay;
}

/* ---------------------------------------------------------------- render */

function draw() {
    const v = S.view;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, lel.canvas.width, lel.canvas.height);
    lctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);

    lctx.fillStyle = '#0b0e14';
    lctx.fillRect(0, 0, v.cw, v.ch);

    if (!S.img) {
        lctx.fillStyle = '#5a6072';
        lctx.font = '13px "Segoe UI", system-ui, sans-serif';
        lctx.textAlign = 'center';
        lctx.fillText('open a folder of frames', v.cw / 2, v.ch / 2);
        lctx.textAlign = 'left';
        return;
    }

    lctx.drawImage(S.img, v.ox, v.oy, v.dw, v.dh);
    lctx.strokeStyle = '#262d3b';
    lctx.lineWidth = 1;
    lctx.strokeRect(v.ox + 0.5, v.oy + 0.5, v.dw - 1, v.dh - 1);

    for (let i = 0; i < S.boxes.length; i++) {
        const b = S.boxes[i];
        const r = boxRect(b);
        const sel = i === S.selected;

        lctx.lineWidth = sel ? 2 : 1.5;
        lctx.strokeStyle = sel ? '#ffb648' : '#46d17f';
        lctx.strokeRect(r.x, r.y, r.w, r.h);

        if (CLASSES.length > 1 || sel) {
            lctx.fillStyle = sel ? '#ffb648' : '#46d17f';
            lctx.font = '11px "Segoe UI", system-ui, sans-serif';
            lctx.fillText(CLASSES[b.cls] || `class ${b.cls}`, r.x, Math.max(11, r.y - 4));
        }

        if (sel) {
            lctx.fillStyle = '#ffb648';
            for (const h of handles(b)) {
                lctx.fillRect(h.x - HANDLE / 2, h.y - HANDLE / 2, HANDLE, HANDLE);
            }
        }
    }
}

function effectiveCount(entry) {
    const edited = S.edits.get(entry.path);
    return edited ? edited.length : entry.count;
}

function status() {
    const total = S.images.length;
    lel.progress.textContent = total ? `${S.index + 1} / ${total}` : '— / —';
    lel.zero.textContent = String(S.images.filter((e) => effectiveCount(e) === 0).length);
    lel.unlabeled.textContent = String(S.images.filter((e) => effectiveCount(e) === null).length);
    lel.dir.textContent = S.dir || 'no folder';
    lel.file.textContent = S.index >= 0 ? S.images[S.index].name : '—';
    lel.boxes.textContent = `${S.boxes.length} box${S.boxes.length === 1 ? '' : 'es'}`;
    lel.dirty.textContent = S.index >= 0 && S.edits.has(S.images[S.index].path) ? '● unsaved' : '';
}

function message(text, warn) {
    lel.msg.textContent = text || '';
    lel.msg.className = warn ? 'warn small' : 'muted small';
}

/* ------------------------------------------------------------------ edit */

function markDirty() {
    if (S.index < 0) return;
    S.edits.set(S.images[S.index].path, S.boxes.map((b) => ({ ...b })));
    status();
}

function removeSelected() {
    if (S.selected < 0) return;
    S.boxes.splice(S.selected, 1);
    S.selected = -1;
    markDirty();
    draw();
}

function setClass(cls) {
    if (S.selected < 0 || cls >= CLASSES.length) return;
    S.boxes[S.selected].cls = cls;
    markDirty();
    draw();
}

function hitTest(p) {
    if (S.selected >= 0 && S.selected < S.boxes.length) {
        const css = normToPoint(p.x, p.y);
        for (const h of handles(S.boxes[S.selected])) {
            if (Math.abs(css.x - h.x) <= GRAB && Math.abs(css.y - h.y) <= GRAB) {
                return { kind: 'resize', idx: S.selected, ex: h.ex, ey: h.ey };
            }
        }
    }
    // Topmost first, so a box drawn on top of another one wins.
    for (let i = S.boxes.length - 1; i >= 0; i--) {
        const b = S.boxes[i];
        if (Math.abs(p.x - b.cx) <= b.w / 2 && Math.abs(p.y - b.cy) <= b.h / 2) {
            return { kind: 'move', idx: i, offX: p.x - b.cx, offY: p.y - b.cy };
        }
    }
    return null;
}

function onDown(e) {
    if (!S.img || e.button !== 0) return;
    e.preventDefault();
    const p = eventPoint(e);
    const hit = hitTest(p);

    if (hit) {
        S.selected = hit.idx;
        // Remembered so that a click that only selects does not mark the image
        // dirty - a spurious "unsaved" badge trains you to ignore the real one.
        S.drag = { ...hit, orig: { ...S.boxes[hit.idx] } };
    } else {
        // Drawing a new box is just a resize of a zero-size box from its own
        // top-left corner, so one code path covers both.
        S.boxes.push({ cls: 0, cx: clamp01(p.x), cy: clamp01(p.y), w: 0, h: 0 });
        S.selected = S.boxes.length - 1;
        S.drag = { kind: 'resize', idx: S.selected, ex: 1, ey: 1, fresh: true };
    }

    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', onUp);
    draw();
}

function onDrag(e) {
    const d = S.drag;
    if (!d) return;
    const p = eventPoint(e);
    const b = S.boxes[d.idx];
    if (!b) return;

    if (d.kind === 'move') {
        const halfW = Math.min(b.w / 2, 0.5);
        const halfH = Math.min(b.h / 2, 0.5);
        b.cx = Math.min(1 - halfW, Math.max(halfW, p.x - d.offX));
        b.cy = Math.min(1 - halfH, Math.max(halfH, p.y - d.offY));
    } else {
        let x0 = b.cx - b.w / 2;
        let x1 = b.cx + b.w / 2;
        let y0 = b.cy - b.h / 2;
        let y1 = b.cy + b.h / 2;
        if (d.ex === -1) x0 = p.x; else if (d.ex === 1) x1 = p.x;
        if (d.ey === -1) y0 = p.y; else if (d.ey === 1) y1 = p.y;
        // Dragging a handle past the opposite edge flips which edge it owns.
        if (x0 > x1) { const t = x0; x0 = x1; x1 = t; d.ex = -d.ex; }
        if (y0 > y1) { const t = y0; y0 = y1; y1 = t; d.ey = -d.ey; }
        setEdges(b, x0, y0, x1, y1);
    }
    draw();
}

function onUp() {
    const d = S.drag;
    S.drag = null;
    window.removeEventListener('mousemove', onDrag);
    window.removeEventListener('mouseup', onUp);
    if (!d) return;

    const b = S.boxes[d.idx];
    const iw = S.img ? S.img.naturalWidth : 1;
    const ih = S.img ? S.img.naturalHeight : 1;
    if (b && (b.w * iw < MIN_BOX_PX || b.h * ih < MIN_BOX_PX)) {
        // Too small to be a real target: a fresh one was a click on empty space,
        // an existing one would fail validation on save.
        S.boxes.splice(d.idx, 1);
        S.selected = -1;
        if (!d.fresh) markDirty();
    } else if (d.fresh || !b || d.orig.cx !== b.cx || d.orig.cy !== b.cy ||
        d.orig.w !== b.w || d.orig.h !== b.h) {
        markDirty();
    }
    draw();
    status();
}

function onMove(e) {
    if (S.drag || !S.img) return;
    const p = eventPoint(e);
    const hit = hitTest(p);
    if (hit && hit.kind === 'resize') lel.canvas.style.cursor = CURSORS[`${hit.ex},${hit.ey}`];
    else if (hit) lel.canvas.style.cursor = 'move';
    else lel.canvas.style.cursor = 'crosshair';
}

/* ------------------------------------------------------------------- nav */

async function load(index) {
    if (!S.images.length) return;
    const token = ++S.loadToken;
    const i = Math.max(0, Math.min(S.images.length - 1, index));
    const entry = S.images[i];

    let img;
    try {
        const { dataUrl } = await window.api.labelReadImage(entry.path);
        img = new Image();
        await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = () => rej(new Error(`could not decode ${entry.name}`));
            img.src = dataUrl;
        });
    } catch (err) {
        message(err.message, true);
        return;
    }
    if (token !== S.loadToken) return;       // a later A/D won the race

    let boxes;
    const edited = S.edits.get(entry.path);
    if (edited) {
        boxes = edited.map((b) => ({ ...b }));
    } else {
        try {
            const res = await window.api.labelReadBoxes(entry.path);
            if (token !== S.loadToken) return;
            boxes = res.boxes;
            entry.count = res.exists ? res.boxes.length : null;
        } catch (err) {
            message(err.message, true);
            return;
        }
    }

    S.index = i;
    S.img = img;
    S.boxes = boxes;
    S.selected = -1;
    fit();
    draw();
    status();
    message(`${img.naturalWidth}×${img.naturalHeight}`);
}

async function save() {
    if (S.index < 0) return false;
    const entry = S.images[S.index];
    try {
        const res = await window.api.labelWriteBoxes(entry.path, S.boxes.map((b) => ({ ...b })));
        if (!res.saved) {
            message(`save refused: ${res.reason}`, true);
            return false;
        }
        entry.count = res.count;
        S.edits.delete(entry.path);
        status();
        message(`saved ${res.count} box${res.count === 1 ? '' : 'es'}`);
        return true;
    } catch (err) {
        message(`save failed: ${err.message}`, true);
        return false;
    }
}

async function saveAndNext() {
    if (!await save()) return;
    if (S.index < S.images.length - 1) await load(S.index + 1);
}

async function go(delta) {
    if (!S.images.length) return;
    await load(S.index + delta);
}

async function openFolder(dir) {
    let res;
    try {
        res = await window.api.labelScanFolder(dir);
    } catch (err) {
        message(err.message, true);
        return;
    }
    S.dir = res.dir;
    S.images = res.images;
    S.edits.clear();
    S.index = -1;
    S.img = null;
    S.boxes = [];
    if (S.images.length) {
        await load(0);
    } else {
        fit();
        draw();
        status();
        message('no .jpg or .png files in that folder', true);
    }
}

function onKey(e) {
    if (!S.active) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const k = e.key;
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); removeSelected(); }
    else if (k === 's' || k === 'S') { e.preventDefault(); saveAndNext(); }
    else if (k === 'a' || k === 'A') { e.preventDefault(); go(-1); }
    else if (k === 'd' || k === 'D') { e.preventDefault(); go(1); }
    else if (k === 'Escape') { S.selected = -1; draw(); }
    else if (/^[1-9]$/.test(k)) { e.preventDefault(); setClass(Number(k) - 1); }
}

/* ------------------------------------------------------------- selftest */

// Driven by main.js under --selftest. It walks the same path a user would:
// open a folder, load the first frame, prove the canvas mapping is lossless,
// then save without touching anything.
async function selfTest(dir) {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await openFolder(dir);
    if (!S.images.length) return { error: 'no images found', total: 0 };
    if (!S.img) return { error: 'image never loaded', total: S.images.length };

    const iw = S.img.naturalWidth;
    const ih = S.img.naturalHeight;
    const live = S.view;

    // A single canvas size only letterboxes on one axis, so the other offset is
    // 0 and any bug in it would go unnoticed. Force both regimes.
    const shapes = [live, viewFor(1600, 500, iw, ih, 1), viewFor(800, 900, iw, ih, 1)];
    let mapMaxErrPx = 0;
    let pointErrPx = 0;
    let anchorErrPx = 0;
    let maxOx = 0;
    let maxOy = 0;

    for (const view of shapes) {
        S.view = view;
        maxOx = Math.max(maxOx, view.ox);
        maxOy = Math.max(maxOy, view.oy);

        // The forward transform must agree with where drawImage puts the image;
        // an inverse that merely undoes a wrong forward would pass otherwise.
        const tl = normToPoint(0, 0);
        const br = normToPoint(1, 1);
        anchorErrPx = Math.max(anchorErrPx,
            Math.abs(tl.x - view.ox), Math.abs(tl.y - view.oy),
            Math.abs(br.x - (view.ox + view.dw)), Math.abs(br.y - (view.oy + view.dh)));

        for (const b of S.boxes) {
            const r = boxRect(b);
            const a = pointToNorm(r.x, r.y);
            const c = pointToNorm(r.x + r.w, r.y + r.h);
            const back = { cx: 0, cy: 0, w: 0, h: 0 };
            setEdges(back, a.x, a.y, c.x, c.y);
            mapMaxErrPx = Math.max(mapMaxErrPx,
                Math.abs(back.cx - b.cx) * iw, Math.abs(back.cy - b.cy) * ih,
                Math.abs(back.w - b.w) * iw, Math.abs(back.h - b.h) * ih);
        }

        // And a bare pointer position: the pixel under the cursor must come back.
        for (const [px, py] of [[0, 0], [640, 268], [iw, ih]]) {
            const p = normToPoint(px / iw, py / ih);
            const back = pointToNorm(p.x, p.y);
            pointErrPx = Math.max(pointErrPx,
                Math.abs(back.x * iw - px), Math.abs(back.y * ih - py));
        }
    }
    S.view = live;

    const boxCount = S.boxes.length;
    const saved = await save();

    return {
        total: S.images.length,
        boxCount,
        imageWidth: iw,
        imageHeight: ih,
        canvasW: Math.round(live.cw),
        canvasH: Math.round(live.ch),
        mapMaxErrPx: Number(mapMaxErrPx.toFixed(9)),
        pointErrPx: Number(pointErrPx.toFixed(9)),
        anchorErrPx: Number(anchorErrPx.toFixed(9)),
        testedOffsetX: Number(maxOx.toFixed(3)),
        testedOffsetY: Number(maxOy.toFixed(3)),
        zeroBoxes: S.images.filter((e) => effectiveCount(e) === 0).length,
        saved
    };
}

function boxErrPx(b, x0, y0, x1, y1, iw, ih) {
    return Number(Math.max(
        Math.abs((b.cx - b.w / 2) * iw - x0), Math.abs((b.cy - b.h / 2) * ih - y0),
        Math.abs((b.cx + b.w / 2) * iw - x1), Math.abs((b.cy + b.h / 2) * ih - y1)
    ).toFixed(4));
}

// Drives draw / move / resize / delete with real DOM events, because the mouse
// path is where a wrong mapping would silently corrupt labels. MouseEventInit
// truncates clientX/clientY to whole css px, so ~1 css px of slop is expected
// here - the bugs this guards against are two orders of magnitude bigger.
async function selfTestDraw() {
    if (!S.img) return { error: 'no image loaded' };
    const iw = S.img.naturalWidth;
    const ih = S.img.naturalHeight;
    const before = S.boxes.length;
    const rect = lel.canvas.getBoundingClientRect();

    const at = (px, py) => {
        const p = normToPoint(px / iw, py / ih);
        return { clientX: rect.left + p.x, clientY: rect.top + p.y };
    };
    const send = (target, type, pos) =>
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...pos }));
    const gesture = (from, to) => {
        send(lel.canvas, 'mousedown', from);
        send(window, 'mousemove', to);
        send(window, 'mouseup', to);
    };

    // Clicking a proposal must select it without marking the image edited.
    const first = S.boxes[0];
    send(lel.canvas, 'mousedown', at(first.cx * iw, first.cy * ih));
    send(window, 'mouseup', at(first.cx * iw, first.cy * ih));
    const selected = S.selected === 0;
    const dirtyAfterSelect = S.edits.has(S.images[S.index].path);

    gesture(at(200, 100), at(300, 180));
    const drawn = S.boxes[S.boxes.length - 1];
    const drawnOk = S.boxes.length === before + 1 && S.selected === before;
    const drawErrPx = drawnOk ? boxErrPx(drawn, 200, 100, 300, 180, iw, ih) : -1;

    gesture(at(250, 140), at(290, 160));                 // grab the body, +40/+20
    const moveErrPx = drawnOk ? boxErrPx(drawn, 240, 120, 340, 200, iw, ih) : -1;

    gesture(at(340, 200), at(400, 260));                 // bottom-right handle
    const resizeErrPx = drawnOk ? boxErrPx(drawn, 240, 120, 400, 260, iw, ih) : -1;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));

    return {
        before, after: S.boxes.length, selected, dirtyAfterSelect,
        drawnOk, drawErrPx, moveErrPx, resizeErrPx
    };
}

async function selfTestClear() {
    while (S.boxes.length) {
        S.selected = S.boxes.length - 1;
        removeSelected();
    }
    const saved = await save();
    return {
        saved,
        boxCount: S.boxes.length,
        zeroBoxes: S.images.filter((e) => effectiveCount(e) === 0).length
    };
}

/* -------------------------------------------------------------------- api */

lel.canvas.addEventListener('mousedown', onDown);
lel.canvas.addEventListener('mousemove', onMove);
lel.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', onKey);
new ResizeObserver(() => { if (S.active) { fit(); draw(); } }).observe(lel.wrap);

lel.open.addEventListener('click', async () => {
    const dir = await window.api.labelPickFolder();
    if (dir) await openFolder(dir);
});
lel.prev.addEventListener('click', () => go(-1));
lel.next.addEventListener('click', () => go(1));
lel.save.addEventListener('click', () => saveAndNext());

window.labeler = {
    activate() {
        S.active = true;
        fit();
        draw();
        status();
    },
    deactivate() {
        S.active = false;
    },
    openFolder,
    selfTest,
    selfTestDraw,
    selfTestClear
};
