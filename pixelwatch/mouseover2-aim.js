// Wisp picking and following for mouseover2.js, without the screen or the
// network: from game-detector's boxes, which wisps stand still, which move and
// how fast, how far ahead of a moving one to aim, and - while the pointer is
// on its way - where the wisp will be when the press lands. Kept apart so it
// can be tested on made-up wisp movements.
//
// A look is { t, W, C }: when it was taken (ms) and the detector's wisp and
// crater boxes, [left, top, right, bottom].
//
// The crater doesn't move. When the camera turns or the character walks,
// everything shifts on screen together, so a wisp's own movement is measured
// against the crater: only what moves against it is the wisp moving. Where to
// press is on screen, so that's the crater's (the camera's) movement plus the
// wisp's own. Without the crater in view it's all judged on screen.

const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
const mean = (vs) => vs.reduce((s, v) => s + v, 0) / vs.length;

// The crater's centre in a look - the biggest box if there are several - or
// null.
function craterIn(look) {
  if (!look.C || !look.C.length) return null;
  return centre(look.C.reduce((a, b) => (area(b) > area(a) ? b : a)));
}

// Least-squares slope of ys over ts, per ms (0 with fewer than two points).
function slope(ts, ys) {
  const n = ts.length;
  if (n < 2) return 0;
  const mt = mean(ts);
  const my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (ts[i] - mt) * (ys[i] - my);
    den += (ts[i] - mt) ** 2;
  }
  return den > 0 ? num / den : 0;
}

// The box among `boxes` whose centre is nearest `p`, within maxPx:
// { box, d } or null.
function nearestBox(boxes, p, maxPx) {
  let best = null;
  for (const box of boxes) {
    const c = centre(box);
    const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
    if (d <= maxPx && (!best || d < best.d)) best = { box, d };
  }
  return best;
}

// Every wisp in the last look: { box, pts, seen, known, screen: {vx, vy},
// own: {vx, vy}, speed, byCrater }. Each is followed back through the earlier
// looks to the nearest wisp within matchPx of where it would have been - the
// crater's shift between the looks taken off, so a camera move doesn't lose
// it. `pts` are its centres, oldest first: { t, c, k } with k the crater's
// centre (or null). Speeds are px/s; `own` is against the crater when it was in
// all those looks, `speed` is its size. With fewer than two looks its speed is
// unknown (`known` false).
function trackWisps(looks, { matchPx }) {
  const last = looks[looks.length - 1];
  return last.W.map((box) => {
    const pts = [{ t: last.t, c: centre(box), k: craterIn(last) }];
    for (let i = looks.length - 2; i >= 0; i--) {
      const next = pts[0];
      const k = craterIn(looks[i]);
      const ex = next.k && k ? [next.c[0] - (next.k[0] - k[0]), next.c[1] - (next.k[1] - k[1])] : next.c;
      const hit = nearestBox(looks[i].W, ex, matchPx);
      if (!hit) break;
      pts.unshift({ t: looks[i].t, c: centre(hit.box), k });
    }
    const ts = pts.map((p) => p.t);
    const screen = {
      vx: slope(ts, pts.map((p) => p.c[0])) * 1000,
      vy: slope(ts, pts.map((p) => p.c[1])) * 1000,
    };
    const byCrater = pts.every((p) => p.k);
    const own = byCrater
      ? { vx: slope(ts, pts.map((p) => p.c[0] - p.k[0])) * 1000, vy: slope(ts, pts.map((p) => p.c[1] - p.k[1])) * 1000 }
      : screen;
    return { box, pts, seen: pts.length, known: pts.length >= 2, screen, own,
             speed: Math.hypot(own.vx, own.vy), byCrater };
  });
}

// The wisp to click: the nearest to `pointer` of those standing still (against
// the crater); if none does, the nearest of them all. { track, still }.
function chooseWisp(tracks, pointer, { stillPxPerSec }) {
  const dist = (k) => {
    const [x, y] = centre(k.box);
    return (x - pointer.x) ** 2 + (y - pointer.y) ** 2;
  };
  const isStill = (k) => k.known && k.speed < stillPxPerSec;
  const still = tracks.filter(isStill);
  const pool = still.length ? still : tracks;
  const track = pool.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  return { track, still: isStill(track) };
}

// When to hand a path to the Pi so its press lands just as a moving wisp
// passes the press point (performance.now() time, ms). The wisp's centre was
// at p0 in the frame taken at lookAt and moves v px per ms on screen; it comes
// closest to `press` tStar ms after that. Before the press come latencyMs (the
// Pi's start) and the path's own `down` ms.
function sendTime({ press, p0, v, lookAt, latencyMs, down }) {
  const s2 = v[0] ** 2 + v[1] ** 2;
  const tStar = s2 ? ((press[0] - p0[0]) * v[0] + (press[1] - p0[1]) * v[1]) / s2 : 0;
  return lookAt + tStar - latencyMs - down;
}

// How far ahead of a wisp to aim, [dx, dy]: where its on-screen movement takes
// it in leadMs, at most maxLeadPx. On screen, because that's where the press
// lands: a wisp standing still while the view slides (the character walking)
// is aimed ahead too. [0, 0] when it's still on screen, or its speed unknown.
function leadFor(track, leadMs, { stillPxPerSec, maxLeadPx }) {
  if (!track.known || Math.hypot(track.screen.vx, track.screen.vy) < stillPxPerSec) return [0, 0];
  let dx = (track.screen.vx * leadMs) / 1000;
  let dy = (track.screen.vy * leadMs) / 1000;
  const d = Math.hypot(dx, dy);
  if (d > maxLeadPx) {
    dx *= maxLeadPx / d;
    dy *= maxLeadPx / d;
  }
  return [dx, dy];
}

// A slope needs points at least this far apart (ms); closer, it's noise.
const MIN_SPAN_MS = 60;

// One wisp, followed frame by frame while the pointer travels to it. Its
// position is kept in two parts, each a straight-line fit over the last
// followWindowMs: the crater on screen (the camera: turning, the character
// walking) and the wisp against the crater (its own movement). Either part
// slower than stillPxPerSec counts as standing still - no slope, the mean of
// its last three positions, so detector jitter doesn't make it drift. When
// a frame in the window has no crater, the wisp is fitted on screen as one.
// Samples are { t, c: wisp centre, k: crater centre or null }, oldest first.
class Follow {
  constructor(samples, { followWindowMs, stillPxPerSec }) {
    this.s = samples.slice();
    this.windowMs = followWindowMs;
    this.still = stillPxPerSec / 1000;
    this.fit();
  }

  add(sample) {
    this.s.push(sample);
    this.fit();
  }

  fit() {
    const tl = this.s[this.s.length - 1].t;
    const recent = this.s.filter((q) => q.t >= tl - this.windowMs);
    const pts = recent.length >= 2 ? recent : this.s.slice(-2);
    const ts = pts.map((q) => q.t);
    const part = (get) => {
      const xs = pts.map((q) => get(q)[0]);
      const ys = pts.map((q) => get(q)[1]);
      const span = ts[ts.length - 1] - ts[0];
      const v = span >= MIN_SPAN_MS ? [slope(ts, xs), slope(ts, ys)] : [0, 0];
      if (Math.hypot(v[0], v[1]) < this.still) {
        return { p: [mean(xs.slice(-3)), mean(ys.slice(-3))], v: [0, 0] };
      }
      // the fitted line at the last sample's time
      const mt = mean(ts);
      return { p: [mean(xs) + v[0] * (tl - mt), mean(ys) + v[1] * (tl - mt)], v };
    };
    this.t = tl;
    this.byCrater = pts.every((q) => q.k);
    this.cam = this.byCrater ? part((q) => q.k) : null;
    this.own = this.byCrater ? part((q) => [q.c[0] - q.k[0], q.c[1] - q.k[1]]) : part((q) => q.c);
  }

  // The wisp's centre on screen at time t.
  at(t) {
    const dt = t - this.t;
    const o = [this.own.p[0] + this.own.v[0] * dt, this.own.p[1] + this.own.v[1] * dt];
    if (!this.cam) return o;
    return [this.cam.p[0] + this.cam.v[0] * dt + o[0], this.cam.p[1] + this.cam.v[1] * dt + o[1]];
  }

  // Where it should be in a frame taken at t that shows the crater at k: the
  // crater as seen there, plus the wisp's own position against it.
  expectIn(t, k) {
    if (!this.cam || !k) return this.at(t);
    const dt = t - this.t;
    return [k[0] + this.own.p[0] + this.own.v[0] * dt, k[1] + this.own.p[1] + this.own.v[1] * dt];
  }

  // Its own speed (against the crater; on screen without it) and the
  // camera's, px/s.
  get ownSpeed() { return Math.hypot(this.own.v[0], this.own.v[1]) * 1000; }
  get camSpeed() { return this.cam ? Math.hypot(this.cam.v[0], this.cam.v[1]) * 1000 : 0; }
}

module.exports = { trackWisps, chooseWisp, leadFor, sendTime, centre, craterIn, nearestBox, Follow };
