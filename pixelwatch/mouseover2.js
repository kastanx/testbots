// Mouseover2: harvests wisps until the inventory is full, dumps at the crater
// until it's (nearly) empty, and so on - with one click per step.
//
//   node mouseover2.js            -> run until Ctrl+C
//   node mouseover2.js --verbose  -> log every reading, not just clicks
//   node mouseover2.js --dry-run  -> make the paths, never send them to the Pi
//   node mouseover2.js --once     -> one look: pixel A, inventory, the wisps
//                                    with their speeds, the crater; then exit
//                                    without moving, clicking or starting anything
//   --model strokes  (default)    -> mouse-sim's stroke model: new movements built
//                                    from your recorded strokes, never the same twice
//   --model replay                -> mouse-sim's motion matching: your recorded
//                                    movements played back, fitted to the click
//                                    (both work with any of the above)
//
// The inventory and pixels A, B and C are read every 1-1.5 s, and two phases
// decide the clicks (mouseover2-phases.js has the details):
//
//   filling   full (28), or pixel A appears     -> click the crater, dumping
//             items still coming in             -> nothing
//             none for 6-10 s:
//               24 or more occupied             -> click the crater, dumping
//               fewer                           -> click a wisp
//   dumping   pixels B and C both missing       -> nothing left to dump:
//                                                  click a wisp, filling
//             items still going out             -> nothing
//             none for 2-4 s:
//               fewer than 4 left               -> click a wisp, filling
//               more left                       -> click the crater again
//
// With B and C both missing there's nothing to dump, so nothing goes to the
// crater then, however full the inventory is.
//
// After a click nothing more is clicked until the inventory moves the right
// way - filling after a wisp, emptying after the crater - or 5-10 s pass
// without that, which counts as a failed click and is clicked again. That's
// the time to walk there, so a target isn't clicked twice on the way. Every
// range is drawn anew each time. It starts by watching: the first click comes
// only once a quiet spell shows nothing is going on.
//
// A wisp click (mouseover2-aim.js): game-detector (GET http://127.0.0.1:8790/)
// is looked at 4 times, 120 ms apart, and each wisp followed across the looks.
// The nearest wisp standing still - against the crater, which doesn't move, so
// the camera turning or the character walking doesn't count - is the target;
// if all of them move, the nearest one, aimed where it will be on screen when
// the click lands. A crater click: the crater nearest the pointer. Then
// mouse-sim makes a path from the pointer onto it with one click on it
// (skip_reaction, no_misses), aimed at the middle of the box (config inset),
// and the Pi plays it as the mouse (/moveclick).
//
// While a wisp path plays, the wisp is followed in every new detector frame,
// from the moment the path is sent until just before the press: its own
// movement against the crater and the crater's on screen. Whenever the press
// would no longer land on it - it set off, or the view slid - the rest of the
// path is bent to where it will be (the Pi's /steer), as often as needed. If
// the wisps are all gone, the click is called off.
//
// Nothing is read, moved or clicked unless RuneScape is the active window and
// the press lands inside it (config window). game-detector and mouse-sim are
// started first if they don't answer, each in its own minimized window, and
// the windows it opened are closed when it stops (Ctrl+C, Ctrl+Break or
// closing its window) - after a click the Pi is playing has finished.
//
// Pixels A, B and C come from config-mouseover2.json (calibrate-mouseover2.js).
// The 28 inventory spaces are archeology's A blocks, read from
// config-archeology.json and never written. A space is occupied when its 10x10 block no longer
// matches the empty slot it was calibrated on.
//
// This script reads the pointer position but never moves it: only the Pi
// does. It uses no servos, so it runs fine next to the servo scripts.
//
// Exit codes: 0 normal stop (Ctrl+C, --once), 1 config or startup error.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { screen, mouse, getActiveWindow, Region, ColorMode } = require("@nut-tree-fork/nut-js");
const config = require("./config-mouseover2.js");
const { Phases } = require("./mouseover2-phases.js");
const { trackWisps, chooseWisp, leadFor, sendTime, centre, craterIn, nearestBox, Follow } =
  require("./mouseover2-aim.js");

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const DRY_RUN = args.includes("--dry-run");
const ONCE = args.includes("--once");

// Which mouse-sim model makes the paths: --model strokes (default) or --model replay
// (also --model=replay). The value is mouse-sim's name for it.
const MODELS = { strokes: "strokes", replay: "mm" };
const MODEL_ABOUT = { strokes: "new movements, never the same twice", replay: "your recordings played back" };
const MODEL = (() => {
  const i = args.findIndex((a) => a === "--model" || a.startsWith("--model="));
  if (i < 0) return "strokes";
  return (args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : args[i + 1] || "").toLowerCase();
})();

const REPO = path.join(__dirname, "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// setTimeout on Windows can fire up to one system timer tick (~16 ms) late.
// Sleep to just short of the target, then finish on the event loop's own
// turns, which are precise.
async function sleepUntil(t) {
  const coarse = t - performance.now() - 16;
  if (coarse > 0) await sleep(coarse);
  while (performance.now() < t) await new Promise((r) => setImmediate(r));
}

const stamp = () => {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
};
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

let cfg = null;
let shuttingDown = false;
let inFlight = null;       // the path the Pi is playing, so Ctrl+C can let it finish
const launched = [];       // { name, pid } of the windows this run opened
const stats = { wisp: 0, crater: 0, still: 0, led: 0, steered: 0, steers: 0, cancelled: 0, readings: 0, away: 0,
                none: 0, skipped: 0, failures: 0 };

// ---- screen -------------------------------------------------------------------

// nut.js grabs in BGR(A) by default. The top-left physical pixel of a logical
// pixel is the value colorAt() reports, including on a DPI-scaled display.
function pixelAt(img, left, top, w, h, x, y) {
  const sx = img.width / w;
  const sy = img.height / h;
  const i = Math.round((y - top) * sy) * img.byteWidth + Math.round((x - left) * sx) * img.channels;
  const d = img.data;
  return img.colorMode === ColorMode.RGB
    ? { r: d[i], g: d[i + 1], b: d[i + 2] }
    : { r: d[i + 2], g: d[i + 1], b: d[i] };
}

async function readOne(p) {
  const img = await screen.grabRegion(new Region(p.x, p.y, 1, 1));
  const actual = pixelAt(img, p.x, p.y, 1, 1, p.x, p.y);
  return { actual, present: config.matches(actual, p.color, cfg.tolerance) };
}

// All the blocks in `list` from one grab of the area around them. A block is
// present - here: the space looks empty - when at least `percent` of its
// pixels match.
function blockReader(list, tol, percent) {
  const n = config.BLOCK;
  const from = config.BLOCK_FROM;
  const xs = list.map((p) => p.x);
  const ys = list.map((p) => p.y);
  const left = Math.min(...xs) + from;
  const top = Math.min(...ys) + from;
  const w = Math.max(...xs) + from + n - left;
  const h = Math.max(...ys) + from + n - top;
  const need = Math.ceil((n * n * percent) / 100);
  return async () => {
    const img = await screen.grabRegion(new Region(left, top, w, h));
    return list.map((p) => {
      const want = p.blockRgb;
      let matched = 0;
      for (let dy = 0; dy < n; dy++) {
        for (let dx = 0; dx < n; dx++) {
          const a = pixelAt(img, left, top, w, h, p.x + from + dx, p.y + from + dy);
          const i = (dy * n + dx) * 3;
          if (Math.abs(a.r - want[i]) <= tol && Math.abs(a.g - want[i + 1]) <= tol &&
              Math.abs(a.b - want[i + 2]) <= tol) matched++;
        }
      }
      return { matched, present: matched >= need };
    });
  };
}

async function pointer() {
  const p = await mouse.getPosition();
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

// The game window's edges if it's the active one: { left, top, right, bottom }.
// With the check off (config window ""), everywhere counts. null otherwise.
async function gameWindow() {
  if (!cfg.window) return { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
  try {
    const w = await getActiveWindow();
    const [title, r] = await Promise.all([w.title, w.region]);
    if (title !== cfg.window) return null;
    return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
  } catch {
    return null;
  }
}

const inWindow = (win, [x, y]) => x >= win.left && x < win.right && y >= win.top && y < win.bottom;

// ---- detector, mouse-sim, Pi ----------------------------------------------------

// One HTTP request on its own connection, closed after the answer. (fetch keeps
// pooled connections open, and exiting with one open trips a libuv assertion
// on Windows.) Resolves { status, text }; rejects with err.code set - TIMEOUT
// when there's no answer in time.
function request(url, { method = "GET", body = null, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const headers = body == null ? {}
      : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    const req = lib.request(u, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    const timer = setTimeout(() => {
      const err = new Error("no answer in time");
      err.code = "TIMEOUT";
      req.destroy(err);
    }, timeoutMs);
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    req.end(body == null ? undefined : body);
  });
}

// Reported when it starts failing and when it works again, not on every check.
function service(name) {
  let failing = false;
  return {
    fail(msg) {
      stats.failures++;
      if (!failing || VERBOSE) log(`${name}: ${msg}`);
      failing = true;
    },
    ok() {
      if (failing) log(`${name}: working again`);
      failing = false;
    },
  };
}

const why = (err) => (err.code === "TIMEOUT" ? "no answer in time" : err.code || err.message);

const fmtBox = (b) => `[${b.map((v) => Math.round(v)).join(",")}]`;

// What game-detector sees now: { W: wisp boxes, C: crater boxes }, each box
// [left, top, right, bottom]. Empty lists when it sees nothing (it answers 503
// then); null when it couldn't be asked.
async function getTargets(detector) {
  let res;
  try {
    res = await request(cfg.detector.url, { timeoutMs: cfg.detector.timeoutMs });
  } catch (err) {
    detector.fail(`can't reach ${cfg.detector.url}: ${why(err)}`);
    return null;
  }
  let body = null;
  try {
    body = JSON.parse(res.text);
  } catch { /* checked below */ }
  if ((res.status !== 200 && res.status !== 503) || !body) {
    detector.fail(`answered HTTP ${res.status}${body ? "" : " without JSON"}`);
    return null;
  }
  detector.ok();
  const boxes = (list) => (Array.isArray(list) ? list : []).filter((b) =>
    Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1]);
  return { W: boxes(body.W), C: boxes(body.C) };
}

// The part of a box the path aims at: `inset` of the width and height trimmed
// off each side.
function aimBox(box, inset) {
  const [x1, y1, x2, y2] = box;
  const w = x2 - x1;
  const h = y2 - y1;
  return { box, left: x1 + w * inset, top: y1 + h * inset, w: w * (1 - 2 * inset), h: h * (1 - 2 * inset) };
}

const dist2 = (a, p) => (a.left + a.w / 2 - p.x) ** 2 + (a.top + a.h / 2 - p.y) ** 2;
const nearest = (aims, p) => aims.reduce((best, a) => (dist2(a, p) < dist2(best, p) ? a : best));

// A path from `from` onto `aim`, from mouse-sim's chosen model (--model), with its
// one click on `aim`: { text, pos, click }. `text` goes to the Pi exactly as
// mouse-sim sent it.
async function makePath(from, aim) {
  const body = JSON.stringify({
    start: { x: from.x, y: from.y },
    target: { left: aim.left, top: aim.top, w: aim.w, h: aim.h },
    model: MODELS[MODEL],
    skip_reaction: true,
    no_misses: true,
  });
  let res;
  try {
    res = await request(cfg.mouseSim.url, { method: "POST", body, timeoutMs: cfg.mouseSim.timeoutMs });
  } catch (err) {
    throw new Error(`can't reach ${cfg.mouseSim.url}: ${why(err)}`);
  }
  if (res.status !== 200) throw new Error(`answered HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  const doc = JSON.parse(res.text);
  if (!Array.isArray(doc.pos) || !doc.pos.length) throw new Error("answered without a path");
  if (!Array.isArray(doc.clicks) || doc.clicks.length !== 1) {
    throw new Error(`answered with ${Array.isArray(doc.clicks) ? doc.clicks.length : 0} clicks, not 1`);
  }
  return { text: res.text, pos: doc.pos, click: doc.clicks[0] };
}

// mouse-sim loads a model with the first path asked of it - the stroke model in
// about a second (15 s the very first time, when it fits your recordings) - so
// one path is asked for before starting, with time to spare, and the first real
// click isn't held up. A mouse-sim from before the stroke model (still running
// from earlier) doesn't know it: that stops here, saying so.
async function warmUpModel() {
  const t0 = performance.now();
  const body = JSON.stringify({ start: { x: 100, y: 100 }, target: { left: 200, top: 200, w: 20, h: 20 },
                                model: MODELS[MODEL], skip_reaction: true, no_misses: true });
  let res;
  try {
    res = await request(cfg.mouseSim.url, { method: "POST", body, timeoutMs: 180000 });
  } catch (err) {
    log(`mouse-sim: couldn't load the ${MODEL} model ahead (${why(err)}) - the first click may wait for it`);
    return;
  }
  if (res.status === 422 && res.text.includes("model")) {
    throw new Error(`mouse-sim doesn't know the "${MODELS[MODEL]}" model: it was started before it existed. ` +
                    "Close its window (\"mouse-sim server\") and start mouseover2 again - it starts a new one.");
  }
  if (res.status !== 200) {
    log(`mouse-sim: loading the ${MODEL} model answered HTTP ${res.status}: ${res.text.trim().slice(0, 200)}`);
    return;
  }
  log(`mouse-sim: ${MODEL} model ready (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

// The Pi plays the path - with its click, or with `noclick` (config click
// false) only the movement. Its answer: { presses, end, steers, ... }.
async function play(text, noclick = !cfg.click) {
  const url = new URL(cfg.pi.url);
  if (noclick) url.searchParams.set("noclick", "1");
  let res;
  try {
    res = await request(url, { method: "POST", body: text, timeoutMs: cfg.pi.timeoutMs });
  } catch (err) {
    throw new Error(`can't reach ${url.origin}: ${why(err)}`);
  }
  if (res.status !== 200) {
    throw new Error(`answered HTTP ${res.status}` +
                    (res.status === 503 ? " (its USB isn't connected to this PC)" : "") +
                    `: ${res.text.trim().slice(0, 200)}`);
  }
  return JSON.parse(res.text);
}

// ---- autostart ----------------------------------------------------------------

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// "yes" when anything answers HTTP at `url`, whatever the status; "no" when
// the connection is refused - nothing listens there; "unsure" otherwise (no
// answer in time: maybe something busy, maybe nothing).
async function answers(url) {
  try {
    await request(url, { timeoutMs: 1500 });
    return "yes";
  } catch (err) {
    return err.code === "ECONNREFUSED" ? "no" : "unsure";
  }
}

// A new console window running `command` in `dir`, as if started by hand but
// minimized, so it never covers the game. If the program stops, the window
// stays open on "Press any key" so its last words can be read. The hidden cmd
// that opens it waits for it (start /WAIT), so killing that cmd's process tree
// closes the window and all in it.
function launch(title, dir, command) {
  const line = `"start "${title}" /MIN /WAIT /D "${dir}" cmd.exe /d /c "${command} & pause""`;
  const child = spawn("cmd.exe", ["/d", "/s", "/c", line], {
    detached: true, stdio: "ignore", windowsVerbatimArguments: true,
  });
  child.unref();
  return child;
}

// Starts `name` unless it already answers at `probe`, then waits until it
// does. A server elsewhere on the network, or with autostart off, is only
// reported.
async function ensureRunning(name, svc, probe) {
  const state = await answers(probe);
  if (state === "yes") {
    log(`${name}: already running`);
    return;
  }
  const u = new URL(svc.url);
  if (state === "unsure" || !cfg.autostart || !LOCAL_HOSTS.has(u.hostname)) {
    log(`${name}: not answering at ${svc.url} - ` +
        (state === "unsure" ? "no answer in time, so not starting another"
         : !cfg.autostart ? "autostart is off" : "not on this PC, so not started"));
    return;
  }
  const s = svc.start;
  const dir = path.resolve(REPO, s.dir);
  if (!fs.existsSync(dir)) throw new Error(`${name}: its folder ${dir} doesn't exist (start.dir in the config)`);
  const command = s.command.replaceAll("{port}", u.port || (u.protocol === "https:" ? "443" : "80"));
  log(`${name}: starting it in a new window "${s.title}": ${command}`);
  const child = launch(s.title, dir, command);
  launched.push({ name, pid: child.pid });
  let closed = false;
  child.on("exit", () => { closed = true; });
  const t0 = performance.now();
  while (performance.now() - t0 < s.readyMs && !shuttingDown) {
    await sleep(500);
    if ((await answers(probe)) === "yes") {
      log(`${name}: up after ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      return;
    }
    if (closed) {
      log(`${name}: its window closed before it answered - carrying on without it`);
      return;
    }
  }
  if (!shuttingDown) {
    log(`${name}: still not answering after ${s.readyMs / 1000} s - see its window. ` +
        "Carrying on; it's tried again on every check.");
  }
}

// Closes the windows this run opened, with everything running in them.
function closeLaunched() {
  for (const { name, pid } of launched.splice(0)) {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    log(r.status === 0 ? `${name}: closed its window (mouseover2 had started it)`
                       : `${name}: couldn't close its window - close it by hand`);
  }
}

// ---- main ---------------------------------------------------------------------

(async () => {
  if (!(MODEL in MODELS)) {
    throw new Error(`--model must be ${Object.keys(MODELS).join(" or ")} (got "${MODEL}")`);
  }
  cfg = config.load();
  const [A] = cfg.pixels.A;
  const [B] = cfg.pixels.B;
  const [C] = cfg.pixels.C;
  const inv = config.loadInventory();
  const total = inv.spaces.length;
  const o = cfg.inventory;
  const w = cfg.wisps;
  const readInventory = blockReader(inv.spaces, inv.tolerance, inv.blockMatchPercent);
  // A space is occupied when its block no longer looks like the empty slot.
  const countOccupied = async () => (await readInventory()).filter((r) => !r.present).length;

  const detector = service("detector");
  const sim = service("mouse-sim");
  const pi = service("Pi");

  const report = () => {
    const what = cfg.click ? "clicks" : "moves";
    console.log(
      `\n${stats.wisp} ${what} on a wisp (${stats.still} still, ${stats.led} aimed ahead, ` +
      `${stats.steered} steered on the way - ${stats.steers} steers in all` +
      (stats.cancelled ? `, ${stats.cancelled} called off (the wisps were gone)` : "") + "), " +
      `${stats.crater} on the crater${DRY_RUN ? " (dry run)" : ""}; paths by the ${MODEL} model; ` +
      `${stats.readings} readings, ${cfg.window || "the game"} not in front ${stats.away} times` +
      (stats.none ? `, no target in view ${stats.none} times` : "") +
      (stats.skipped ? `, ${stats.skipped} skipped (pointer moved)` : "") +
      (stats.failures ? `, ${stats.failures} failed` : "")
    );
  };

  // Looks at the detector `looks` times, lookGapMs apart; null if it couldn't
  // be asked. A look's time is when its frame was taken: detectorLagMs before
  // the answer came.
  async function lookAtWisps() {
    const looks = [];
    for (let i = 0; i < w.looks; i++) {
      if (i) await sleep(w.lookGapMs);
      const found = await getTargets(detector);
      if (!found) return null;
      looks.push({ t: performance.now() - w.detectorLagMs, W: found.W, C: found.C });
    }
    return looks;
  }

  const range = (lo, hi) => (lo === hi ? `${lo / 1000} s` : `${lo / 1000}-${hi / 1000} s`);
  const ac = cfg.afterClick;
  for (const [name, p] of [["A", A], ["B", B], ["C", C]]) {
    console.log(`Pixel ${name}: (${p.x}, ${p.y}) ${config.toHex(p.color)} +/-${cfg.tolerance}`);
  }
  console.log(`Inventory: ${total} spaces from archeology (${inv.file}) - a space is occupied when ` +
              "its 10x10 block differs from the empty slot in " +
              (inv.blockMatchPercent === 100 ? "any pixel" : `more than ${100 - inv.blockMatchPercent}% of its pixels`) +
              ` (+/-${inv.tolerance})`);
  console.log(`Read every ${o.intervalMinMs}-${o.intervalMaxMs}ms` +
              (cfg.window ? `, only while "${cfg.window}" is the active window:` : ":"));
  console.log(`  filling   ${o.fullAt}+ occupied, or pixel A appears -> crater, dumping`);
  console.log(`            nothing added for ${range(o.fillingQuietMinMs, o.fillingQuietMaxMs)}: ` +
              `${o.dumpEarlyAt}+ occupied -> crater, dumping; fewer -> a wisp`);
  console.log("  dumping   pixels B and C both missing -> nothing left to dump: a wisp, filling");
  console.log(`            nothing removed for ${range(o.emptyingQuietMinMs, o.emptyingQuietMaxMs)}: ` +
              `under ${o.emptyBelow} left -> a wisp, filling; otherwise the crater again`);
  console.log("            (B and C both missing: never the crater, however full)");
  console.log(`  after a click, nothing more until items move: ${range(ac.wispMinMs, ac.wispMaxMs)} after a wisp, ` +
              `${range(ac.craterMinMs, ac.craterMaxMs)} after the crater`);
  console.log(`  wisps     ${w.looks} looks ${w.lookGapMs} ms apart; standing still (under ${w.stillPxPerSec} px/s ` +
              `against the crater) preferred; else the nearest, ${w.lead ? "aimed ahead" : "not aimed ahead"}`);
  if (w.track) {
    console.log(`            followed in every detector frame on the way (against the crater); the path is bent ` +
                `when the ${cfg.click ? "press" : "end"} would be over ${w.steerPx} px off it, until ${w.steerMinMs} ms before`);
  }
  console.log(`  targets   ${cfg.detector.url}`);
  console.log(`  model     ${MODEL} - ${MODEL_ABOUT[MODEL]}` +
              ` (--model ${Object.keys(MODELS).filter((m) => m !== MODEL).join("/")} for the other)`);
  console.log(`  path      ${cfg.mouseSim.url} (skip_reaction, no_misses; aims at the middle ` +
              `${Math.round((1 - 2 * cfg.inset) * 100)}% of the box)`);
  console.log(`  played by ${cfg.pi.url}${cfg.click ? " - WITH the click" : "?noclick=1 - no click"}` +
              (DRY_RUN ? "   [DRY RUN - never sent]" : ""));

  if (ONCE) {
    const win = await gameWindow();
    const a = await readOne(A);
    const b = await readOne(B);
    const c = await readOne(C);
    const nothing = !b.present && !c.present;
    const occupied = await countOccupied();
    const phase = (occupied >= o.fullAt || a.present) && !nothing ? "dumping" : "filling";
    console.log("");
    if (cfg.window) log(`  "${cfg.window}" ${win ? "is" : "is NOT"} the active window`);
    for (const [name, r] of [["A", a], ["B", b], ["C", c]]) {
      log(`  pixel ${name}: ${config.toHex(r.actual)} ${r.present ? "present" : "missing"}`);
    }
    log(`  something to dump: ${nothing ? "no (B and C both missing)" : "yes"}`);
    log(`  inventory: ${occupied}/${total} occupied - it would start ${phase}, and watch before the first click`);
    const looks = await lookAtWisps();
    if (looks === null) {
      log("  (--once only looks; mouseover2 starts game-detector when it runs)");
    } else {
      const last = looks[looks.length - 1];
      const tracks = trackWisps(looks, w);
      log(`  detector: ${tracks.length} wisp(s) over ${looks.length} looks` + (tracks.length ? ":" : ""));
      for (const k of tracks) {
        log(`    ${fmtBox(k.box)} ` + (!k.known ? "speed unknown (seen once)"
          : `${Math.round(k.speed)} px/s ${k.byCrater ? "against the crater" : "on screen"} - ` +
            (k.speed < w.stillPxPerSec ? "standing still" : "moving")));
      }
      log(`  detector: ${last.C.length} crater(s)${last.C.length ? ": " + last.C.map(fmtBox).join(" ") : ""}`);
    }
    process.exit(0);
  }

  async function shutdown() {
    if (shuttingDown) process.exit(0);   // a second Ctrl+C leaves at once
    shuttingDown = true;
    if (inFlight) {
      log("stopping after the path the Pi is playing");
      await inFlight.catch(() => {});
    }
    closeLaunched();
    report();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);     // Ctrl+C
  process.on("SIGBREAK", shutdown);   // Ctrl+Break
  process.on("SIGHUP", shutdown);     // its window was closed
  console.log("Ctrl+C to stop.\n");

  await Promise.all([
    ensureRunning("game-detector", cfg.detector, cfg.detector.url),
    ensureRunning("mouse-sim", cfg.mouseSim, new URL("/api/models", cfg.mouseSim.url).href),
  ]);
  await warmUpModel();

  let missing = null;   // the kind last found not in view, to say so once
  function noTarget(kind) {
    stats.none++;
    if (missing !== kind || VERBOSE) log(`[${kind}] no ${kind} in view - trying again on every reading`);
    missing = kind;
  }

  // A path from `from` onto a wisp, aimed at where it will be on screen when
  // the press lands. One still on screen straight on. A moving one - by
  // itself, or with the view (the character walking): aim a little further
  // along its way (leadMarginMs) than the press could reach it, then hold the
  // path back so the press lands just as the wisp gets to the press point. Each
  // path presses at its own time, so the timing is worked out from the path
  // itself. A path that would press too late, or would have to wait much longer
  // than the margin, is re-aimed from its own press time (at most 3 tries).
  // Kept: the one on time with the shortest wait. { p, base, lead, sendAt },
  // sendAt 0 meaning at once.
  async function aimAt(from, track, lookAt) {
    const base = aimBox(track.box, cfg.inset);
    const p = await makePath(from, base);
    const onScreen = Math.hypot(track.screen.vx, track.screen.vy);
    if (!w.lead || !track.known || onScreen < w.stillPxPerSec) return { p, base, lead: [0, 0], sendAt: 0 };
    const v = [track.screen.vx / 1000, track.screen.vy / 1000];
    const p0 = [base.left + base.w / 2, base.top + base.h / 2];
    let reach = performance.now() - lookAt + w.piStartMs + p.click.down;
    let best = null;
    for (let i = 0; i < 3; i++) {
      const ld = leadFor(track, reach + w.leadMarginMs, w);
      if (!ld[0] && !ld[1]) return { p, base, lead: ld, sendAt: 0 };
      const cand = await makePath(from, { ...base, left: base.left + ld[0], top: base.top + ld[1] });
      const at = sendTime({ press: cand.pos[cand.click.down], p0, v, lookAt, latencyMs: w.piStartMs, down: cand.click.down });
      const wait = at - performance.now();
      const offMs = wait < 0 ? -wait : Math.max(0, wait - w.maxWaitMs);   // how far off the press would be
      const score = offMs * 1000 + Math.abs(wait - w.leadMarginMs);        // on time first, then the shortest wait
      if (!best || score < best.score) best = { p: cand, at, score, lead: ld };
      if (offMs <= 10 && wait <= w.leadMarginMs + 200) break;
      reach = performance.now() - lookAt + w.piStartMs + cand.click.down;
    }
    return { p: best.p, base, lead: best.lead, sendAt: Math.min(best.at, performance.now() + w.maxWaitMs) };
  }

  // Right before a path is played: the pointer still where the path starts
  // (the Pi moves it relative to where it is, so a stale start would end - and
  // click - in the wrong place), the game in front, the press and the end
  // inside it. The game window's edges, or null.
  async function clearToPlay(kind, from, p) {
    const now = await pointer();
    if (now.x !== from.x || now.y !== from.y) {
      stats.skipped++;
      log(`[${kind}] the pointer moved while the path was being made - skipped`);
      return null;
    }
    const win = await gameWindow();
    const press = p.pos[p.click.down];
    const end = p.pos[p.pos.length - 1];
    if (!win || !inWindow(win, press) || !inWindow(win, end)) {
      stats.away++;
      log(`[${kind}] ${win ? `the ${cfg.click ? "click" : "path's end"} would land outside the game window`
                            : `"${cfg.window}" stopped being the active window`} - skipped`);
      return null;
    }
    return win;
  }

  // Plays `text` on the Pi (noclick: only the movement). The Pi's answer, or
  // null if it failed.
  async function send(text, noclick = !cfg.click) {
    if (shuttingDown) return null;
    inFlight = play(text, noclick);
    try {
      const res = await inFlight;
      pi.ok();
      return res;
    } catch (err) {
      pi.fail(err.message);
      return null;
    } finally {
      inFlight = null;
    }
  }

  // `at`: where the press (or, without the click, the end) really went, when
  // the path was steered on the way.
  const pressText = (p, at) => {
    const pt = (q) => `(${Math.round(q[0])},${Math.round(q[1])})`;
    return (cfg.click ? `click at ${pt(at || p.pos[p.click.down])} held ${p.click.up - p.click.down} ms`
                      : pt(at || p.pos[p.pos.length - 1])) + `, ${p.pos.length} ms`;
  };
  // A warning when the pointer didn't end where the path did - or, steered,
  // where the Pi says it took it (its answer's `end`, from the start).
  const offPath = async (p, res) => {
    const end = res && Array.isArray(res.end)
      ? [p.pos[0][0] + res.end[0], p.pos[0][1] + res.end[1]] : p.pos[p.pos.length - 1];
    const at = await pointer();
    return at.x !== end[0] || at.y !== end[1]
      ? ` - but the pointer is at (${at.x},${at.y}), not on the path's end (hand on the mouse? Enhance pointer precision on?)`
      : "";
  };

  // The crater nearest the pointer, clicked. True if it was (or, in a dry run,
  // would have been).
  async function clickCrater() {
    const from = await pointer();
    const found = await getTargets(detector);
    if (!found) return false;
    if (!found.C.length) {
      noTarget("crater");
      return false;
    }
    missing = null;
    const base = nearest(found.C.map((b) => aimBox(b, cfg.inset)), from);
    let p;
    try {
      p = await makePath(from, base);
      sim.ok();
    } catch (err) {
      sim.fail(err.message);
      return false;
    }
    if (!(await clearToPlay("crater", from, p))) return false;
    const what = `crater ${fmtBox(base.box)}: (${from.x},${from.y}) -> ${pressText(p)}`;
    if (DRY_RUN) {
      stats.crater++;
      log(`[crater] ${what} - would ${cfg.click ? "click" : "move"} (dry run)`);
      return true;
    }
    if (!(await send(p.text))) return false;
    stats.crater++;
    log(`[crater] ${what} - ${cfg.click ? "clicked" : "moved, no click"}${await offPath(p)}`);
    return true;
  }

  // The Pi's /steer, next to its /moveclick: it bends the path playing now.
  const steerUrl = new URL("/steer", cfg.pi.url);
  let steerable = true;   // false once the Pi has said it has no /steer (an older autoclicker)

  // One /steer request - with a body to steer, without to ask where it is:
  // { status, body, rtt, mid }, mid being when (on our clock) the Pi most
  // likely took it in; null if it didn't get there.
  async function steerPi(req) {
    const t1 = performance.now();
    let res;
    try {
      res = await request(steerUrl, req ? { method: "POST", body: JSON.stringify(req), timeoutMs: 1000 }
                                        : { timeoutMs: 1000 });
    } catch {
      return null;
    }
    const t2 = performance.now();
    let body = null;
    try {
      body = JSON.parse(res.text);
    } catch { /* the callers check */ }
    if (res.status === 404 && steerable) {
      steerable = false;
      log("[wisp] the Pi has no /steer (an older autoclicker) - wisps aren't followed on the way. " +
          "Update it: autoclicker/deploy.sh");
    }
    return { status: res.status, body, rtt: t2 - t1, mid: (t1 + t2) / 2 };
  }

  // Plays a wisp path and follows the wisp while it plays: every new detector
  // frame from the moment the path is sent until steerMinMs before the press.
  // The wisp is looked for where it should be - the crater as seen in that
  // frame plus the wisp's own place against it, so the view sliding (the
  // character walking) doesn't lose it - and where it will be at the press is
  // worked out from its own movement and the crater's. When the press would
  // land over steerPx off that, the rest of the path is bent there, taking at
  // least as long as a hand would (steerPxPerMs); the Pi holds the press back
  // if the bend needs longer than is left. With no wisp in view for lostMs the
  // click is called off. { res: the Pi's answer or null, press: where the
  // press went, story: [...], steers, cancelled }.
  async function playFollowing(p, shot, track, win) {
    const down = p.click.down;
    const story = [];
    const sentAt = performance.now();
    let done = false;
    const playing = send(p.text).then((res) => {
      done = true;
      return res;
    });
    let model = new Follow(track.pts, w);
    // where on the wisp the path presses, kept as the wisp moves
    const aimC = [shot.base.left + shot.base.w / 2 + shot.lead[0], shot.base.top + shot.base.h / 2 + shot.lead[1]];
    const press0 = p.pos[down];
    const off = [press0[0] - aimC[0], press0[1] - aimC[1]];
    let press = press0.slice();
    let pressMs = down;                 // on the Pi's clock
    let piT0 = sentAt + w.piStartMs;    // the Pi's t = 0 on ours, until it says
    let bestRtt = Infinity;
    const sync = (r) => {
      if (r && r.body && Number.isFinite(r.body.at_ms) && r.body.at_ms >= 0 && r.rtt < bestRtt) {
        bestRtt = r.rtt;
        piT0 = r.mid - r.body.at_ms - 0.5;
      }
    };
    const own0 = model.byCrater ? model.own.p.slice() : null;
    const cam0 = model.cam ? model.cam.p.slice() : null;
    let busy = null;          // the steer (or a "where are you") on its way
    let askAt = sentAt + w.piStartMs + 20;
    let stop = false;
    let frames = 0, steers = 0, cancelled = false, cancelling = false, switched = false;
    let lostAt = null, goneAt = null, lastSig = "";

    while (!done && !stop && steerable) {
      if (performance.now() >= piT0 + pressMs - w.steerMinMs) break;
      if (bestRtt === Infinity && !busy && performance.now() >= askAt) {
        // the Pi's clock: where it is in the path, once it has started
        busy = steerPi(null).then((r) => {
          busy = null;
          if (r && r.status === 200 && r.body && r.body.playing) sync(r);
          else askAt = performance.now() + 20;
        });
      }
      const found = await getTargets(detector);
      if (!found) {
        await sleep(w.pollMs);
        continue;
      }
      // A frame the same as the last is no news - but the time it stays so
      // counts, for "gone" and "lost".
      const sig = JSON.stringify(found);
      const fresh = sig !== lastSig;
      lastSig = sig;
      if (fresh) frames++;
      const t = performance.now() - w.detectorLagMs;
      if (found.W.length) goneAt = null;
      else goneAt ??= t;
      if (goneAt !== null && t - goneAt >= w.lostMs && cfg.click && !busy && !cancelling) {
        // no wisp in view for lostMs: nothing left to click
        cancelling = true;
        busy = steerPi({ cancel: true }).then((r) => {
          busy = null;
          if (!r) cancelling = false;              // didn't get there: try again
          else stop = true;
          if (r && r.status === 200) cancelled = true;
        });
      }
      if (!found.W.length) {
        await sleep(w.pollMs);
        continue;
      }
      const k = craterIn(found);
      let hit = nearestBox(found.W, model.expectIn(t, k), w.followPx);
      if (hit) {
        lostAt = null;
        if (fresh) model.add({ t, c: centre(hit.box), k });
      } else {
        lostAt ??= t;
        if (t - lostAt >= w.lostMs) hit = nearestBox(found.W, model.expectIn(t, k), w.retrackPx);
        if (hit) {
          story.push("lost it - following the nearest wisp");
          switched = true;
          lostAt = null;
          model = new Follow([{ t, c: centre(hit.box), k }], w);
        }
      }
      if (!hit || !fresh || !steerable || busy) {
        if (!fresh) await sleep(w.pollMs);
        continue;
      }

      // where the press should go: the same spot on the wisp, where it will be then
      const then = model.at(piT0 + pressMs);
      let want = [then[0] + off[0], then[1] + off[1]];
      const dev = Math.hypot(want[0] - press[0], want[1] - press[1]);
      if (dev <= w.steerPx || !inWindow(win, want)) continue;
      const need = Math.max(40, Math.round(dev / w.steerPxPerMs));
      const arrives = performance.now() + (Number.isFinite(bestRtt) ? bestRtt / 2 : w.piStartMs / 2) - piT0;
      if (arrives + need > pressMs) {
        // the bend outlasts the time left: the Pi holds the press until it's done
        const later = model.at(piT0 + arrives + need);
        want = [later[0] + off[0], later[1] + off[1]];
      }
      const req = { press: [Math.round(want[0]), Math.round(want[1])], ms: need };
      busy = steerPi(req).then((r) => {
        busy = null;
        if (!r) return;                          // didn't get there: the next frame tries again
        if (r.status === 200 && r.body) {
          steers++;
          press = req.press;
          if (Number.isFinite(r.body.press_ms)) pressMs = r.body.press_ms;
          sync(r);
        } else if (!(r.status === 409 && /nothing is playing/.test((r.body || {}).error || "") &&
                     performance.now() < piT0 + 150)) {
          stop = true;                           // the button's down, it's over, or no /steer
        }
      });
    }
    if (busy) await busy;
    const followed = Math.round(performance.now() - sentAt);
    const res = await playing;
    if (frames) {
      let note = `followed it ${followed} ms (${frames} frame${frames === 1 ? "" : "s"})`;
      if (own0 && model.byCrater && !switched) {
        const moved = Math.hypot(model.own.p[0] - own0[0], model.own.p[1] - own0[1]);
        if (moved >= 10) note += `, it moved ${Math.round(moved)} px against the crater`;
      }
      if (cam0 && model.cam && !switched) {
        const slid = Math.hypot(model.cam.p[0] - cam0[0], model.cam.p[1] - cam0[1]);
        if (slid >= 10) note += `, the view slid ${Math.round(slid)} px`;
      }
      story.unshift(note);
    }
    if (steers) {
      story.push(`steered ${steers}x, the ${cfg.click ? "press" : "end"} ` +
                 `${Math.round(Math.hypot(press[0] - press0[0], press[1] - press0[1]))} px over`);
    }
    if (cancelled) story.push("no wisp in view any more - click called off");
    return { res, press, story, steers, cancelled };
  }

  // A wisp clicked: the nearest standing still, or the nearest aimed ahead -
  // and with wisps.track followed on the way (playFollowing). True if it was
  // clicked (or, in a dry run, would have been).
  async function clickWisp() {
    const from = await pointer();
    const looks = await lookAtWisps();
    if (!looks) return false;
    const last = looks[looks.length - 1];
    if (!last.W.length) {
      noTarget("wisp");
      return false;
    }
    missing = null;
    const pick = chooseWisp(trackWisps(looks, w), from, w);
    const track = pick.track;
    let shot;
    try {
      shot = await aimAt(from, track, last.t);
      sim.ok();
    } catch (err) {
      sim.fail(err.message);
      return false;
    }
    const ahead = Math.round(Math.hypot(shot.lead[0], shot.lead[1]));
    const how = (pick.still ? `standing still: ${Math.round(track.speed)} px/s`
      : !track.known ? "speed unknown" : `moving ${Math.round(track.speed)} px/s`) +
      (ahead ? `, aimed ${ahead} px ahead` : "");
    const head = `wisp ${fmtBox(track.box)} (${how}): (${from.x},${from.y})`;
    const p = shot.p;
    const counted = () => {
      stats.wisp++;
      if (pick.still) stats.still++;
      if (ahead) stats.led++;
    };
    if (DRY_RUN) {
      counted();
      log(`[wisp] ${head} -> ${pressText(p)} - would ${cfg.click ? "click" : "move"} (dry run)`);
      return true;
    }

    const story = [];
    const held = Math.max(0, Math.round(shot.sendAt - performance.now()));
    if (held > 0) {
      await sleepUntil(shot.sendAt);
      story.push(`held back ${held} ms`);
    }
    const win = await clearToPlay("wisp", from, p);
    if (!win) return false;
    let res;
    let press = null;
    if (w.track && steerable) {
      const run = await playFollowing(p, shot, track, win);
      res = run.res;
      story.push(...run.story);
      if (run.steers) {
        stats.steered++;
        stats.steers += run.steers;
        press = run.press;
      }
      if (run.cancelled && res) {
        stats.cancelled++;
        log(`[wisp] ${head} -> ${pressText(p, press)} - not clicked; ${story.join("; ")}`);
        return false;
      }
    } else {
      res = await send(p.text);
    }
    if (!res) return false;
    counted();
    log(`[wisp] ${head} -> ${pressText(p, press)} - ${cfg.click ? "clicked" : "moved, no click"}` +
        (story.length ? `; ${story.join("; ")}` : "") + (await offPath(p, res)));
    return true;
  }

  const clickOn = (kind) => (kind === "wisp" ? clickWisp() : clickCrater());

  const phases = new Phases({
    fullAt: o.fullAt,
    dumpEarlyAt: o.dumpEarlyAt,
    emptyBelow: o.emptyBelow,
    fillingQuiet: [o.fillingQuietMinMs, o.fillingQuietMaxMs],
    emptyingQuiet: [o.emptyingQuietMinMs, o.emptyingQuietMaxMs],
    wispWait: [ac.wispMinMs, ac.wispMaxMs],
    craterWait: [ac.craterMinMs, ac.craterMaxMs],
  });
  let wasInFront = null;   // last reading's answer, to report changes once
  let lastAlert = null;    // the last state worth a log line without a click, said once
  async function reading() {
    if (!(await gameWindow())) {
      stats.away++;
      if (wasInFront !== false) log(`"${cfg.window}" isn't the active window - waiting, nothing is read, moved or clicked`);
      wasInFront = false;
      return;
    }
    if (wasInFront === false) log(`"${cfg.window}" is the active window again`);
    wasInFront = true;

    const a = await readOne(A);
    const b = await readOne(B);
    const c = await readOne(C);
    const nothing = !b.present && !c.present;
    const occupied = await countOccupied();
    stats.readings++;
    const before = phases.phase;
    const d = phases.step(performance.now(), occupied, a.present, nothing);
    const seen = `${occupied}/${total}${a.present ? ", A present" : ""}` +
                 (nothing ? ", B+C gone" : `, ${b.present ? "B" : ""}${b.present && c.present ? "+" : ""}${c.present ? "C" : ""} there`);
    const alert = d.alert && d.why !== lastAlert;
    lastAlert = d.alert ? d.why : null;
    if (before !== d.phase || d.act || alert || VERBOSE) log(`[${d.phase}] ${seen} - ${d.why}`);
    if (d.act && (await clickOn(d.act))) phases.clicked(performance.now());
  }

  while (!shuttingDown) {
    const started = performance.now();
    try {
      await reading();
    } catch (err) {
      stats.failures++;
      log(err.message);
    }
    await sleepUntil(started + config.randomIn(o));
  }
})().catch((err) => {
  console.error(err.message);
  closeLaunched();
  process.exit(1);
});
