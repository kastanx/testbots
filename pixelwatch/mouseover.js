// Mouseover: with pixel A missing, click a wisp - or, with a full inventory,
// the crater.
//
//   node mouseover.js            -> run until Ctrl+C
//   node mouseover.js --verbose  -> log every check, not just clicks
//   node mouseover.js --dry-run  -> make the paths, never send them to the Pi
//   node mouseover.js --once     -> one look: pixel A, inventory, wisps and
//                                   crater, the path it would play; then exit
//                                   without moving, clicking or starting anything
//
// Every 3-5 s:
//
//   pixel A present                     -> nothing
//   pixel A missing, inventory not full -> click the nearest wisp (W)
//   pixel A missing, inventory full     -> click the crater (C)
//
// Full means 27 or more of the 28 spaces occupied (config fullAt). A click:
//
//   1. game-detector (GET http://127.0.0.1:8790/) lists the wisps and the
//      crater it sees
//   2. the one of that kind nearest the pointer is the target
//   3. mouse-sim makes a path from the pointer onto it, with one click on it
//      (skip_reaction, no_misses) - also when the pointer is on it already
//   4. the Pi plays the path and the click as the mouse (/moveclick)
//
// Nothing is moved or clicked unless RuneScape is the active window and the
// press lands inside it (config window): switching to another app pauses it.
// With config click false the Pi only moves the pointer (noclick=1), and a
// check does nothing while the pointer is on the target already.
//
// game-detector and mouse-sim are started first if they don't answer, each in
// its own minimized window, and it waits until they do. The windows it opened
// are closed when it stops (Ctrl+C, Ctrl+Break or closing its window); ones
// that were already running are left alone. A click the Pi is playing is let
// finish first, so the button is never left down.
//
// The path aims at the middle of the target's box (config inset). Pixel A
// comes from config-mouseover.json (calibrate-mouseover.js). The 28 inventory
// spaces are archeology's A blocks, read from config-archeology.json and never
// written - the same ones mining counts. A space is occupied when its 10x10
// block no longer matches the empty slot it was calibrated on.
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
const config = require("./config-mouseover.js");

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const DRY_RUN = args.includes("--dry-run");
const ONCE = args.includes("--once");

const REPO = path.join(__dirname, "..");

// The two kinds of target, by their key in game-detector's answer.
const KINDS = { W: "wisp", C: "crater" };

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
const stats = { wisp: 0, crater: 0, already: 0, none: 0, busy: 0, away: 0, skipped: 0, failures: 0 };

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

const inside = (a, p) => p.x >= a.left && p.x < a.left + a.w && p.y >= a.top && p.y < a.top + a.h;
const dist2 = (a, p) => (a.left + a.w / 2 - p.x) ** 2 + (a.top + a.h / 2 - p.y) ** 2;
const nearest = (aims, p) => aims.reduce((best, a) => (dist2(a, p) < dist2(best, p) ? a : best));

// A path from `from` onto `aim`, from mouse-sim, with its one click on `aim`:
// { text, pos, click }. `text` goes to the Pi exactly as mouse-sim sent it.
async function makePath(from, aim) {
  const body = JSON.stringify({
    start: { x: from.x, y: from.y },
    target: { left: aim.left, top: aim.top, w: aim.w, h: aim.h },
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

// The Pi plays the path - with its click, or with config click false only the
// movement.
async function play(text) {
  const url = new URL(cfg.pi.url);
  if (!cfg.click) url.searchParams.set("noclick", "1");
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
    log(r.status === 0 ? `${name}: closed its window (mouseover had started it)`
                       : `${name}: couldn't close its window - close it by hand`);
  }
}

// ---- main ---------------------------------------------------------------------

(async () => {
  cfg = config.load();
  const [A] = cfg.pixels.A;
  const inv = config.loadInventory();
  const total = inv.spaces.length;
  const fullAt = cfg.inventory.fullAt;
  const readInventory = blockReader(inv.spaces, inv.tolerance, inv.blockMatchPercent);
  // A space is occupied when its block no longer looks like the empty slot.
  const countOccupied = async () => (await readInventory()).filter((r) => !r.present).length;
  const invText = (occupied) => `${occupied}/${total} occupied${occupied >= fullAt ? " (full)" : ""}`;
  const verb = cfg.click ? "click" : "move onto";

  const detector = service("detector");
  const sim = service("mouse-sim");
  const pi = service("Pi");

  const report = () => {
    const what = cfg.click ? "clicks" : "moves";
    console.log(
      `\n${stats.wisp} ${what} on a wisp, ${stats.crater} on the crater${DRY_RUN ? " (dry run)" : ""}; ` +
      `pixel A present ${stats.busy} times, ${cfg.window || "the game"} not in front ${stats.away}, ` +
      `nothing to go to ${stats.none}` +
      (cfg.click ? "" : `, already on the target ${stats.already}`) +
      (stats.skipped ? `, ${stats.skipped} skipped (pointer moved)` : "") +
      (stats.failures ? `, ${stats.failures} failed` : "")
    );
  };

  console.log(`Pixel A: (${A.x}, ${A.y}) ${config.toHex(A.color)} +/-${cfg.tolerance}`);
  console.log(`Inventory: ${total} spaces from archeology (${inv.file}) - a space is occupied when ` +
              "its 10x10 block differs from the empty slot in " +
              (inv.blockMatchPercent === 100 ? "any pixel" : `more than ${100 - inv.blockMatchPercent}% of its pixels`) +
              ` (+/-${inv.tolerance}); full at ${fullAt}+ occupied`);
  console.log(`Every ${cfg.inventory.intervalMinMs}-${cfg.inventory.intervalMaxMs}ms` +
              (cfg.window ? `, only while "${cfg.window}" is the active window:` : ":"));
  console.log("  pixel A present                     -> nothing");
  console.log(`  pixel A missing, inventory not full -> ${verb} the nearest wisp`);
  console.log(`  pixel A missing, inventory full     -> ${verb} the crater`);
  console.log(`  targets   ${cfg.detector.url}`);
  console.log(`  path      ${cfg.mouseSim.url} (skip_reaction, no_misses; aims at the middle ` +
              `${Math.round((1 - 2 * cfg.inset) * 100)}% of the box)`);
  console.log(`  played by ${cfg.pi.url}${cfg.click ? " - WITH the click" : "?noclick=1 - no click"}` +
              (DRY_RUN ? "   [DRY RUN - never sent]" : ""));

  if (ONCE) {
    const win = await gameWindow();
    const a = await readOne(A);
    const occupied = await countOccupied();
    const key = occupied >= fullAt ? "C" : "W";
    const from = await pointer();
    console.log("");
    if (cfg.window) {
      log(`  "${cfg.window}" ${win ? "is" : "is NOT"} the active window` + (win ? "" : " - it would do nothing"));
    }
    log(`  pixel A: ${config.toHex(a.actual)} ${a.present ? "present - it would do nothing" : "missing"}`);
    log(`  inventory: ${invText(occupied)} - the target would be the ${KINDS[key]}`);
    log(`  pointer: (${from.x}, ${from.y})`);
    const notStarted = "  (--once only looks; mouseover starts it when it runs)";
    const found = await getTargets(detector);
    if (found === null) log(notStarted);
    if (found) {
      for (const k of ["W", "C"]) {
        log(`  detector: ${found[k].length} ${KINDS[k]}(s)` +
            (found[k].length ? `: ${found[k].map(fmtBox).join(" ")}` : ""));
      }
      const boxes = found[key];
      if (!boxes.length) {
        log(`  no ${KINDS[key]} in view - nothing to go to`);
      } else {
        const aim = nearest(boxes.map((b) => aimBox(b, cfg.inset)), from);
        if (!cfg.click && inside(aim, from)) {
          log(`  the pointer is on the ${KINDS[key]} ${fmtBox(aim.box)} already - nothing to move`);
        } else {
          try {
            const p = await makePath(from, aim);
            const end = p.pos[p.pos.length - 1];
            const at = p.pos[p.click.down];
            log(`  path onto the ${KINDS[key]} ${fmtBox(aim.box)}: ${p.pos.length} ms, ` +
                (cfg.click ? `click at (${at[0]}, ${at[1]}) held ${p.click.up - p.click.down} ms`
                           : `ends at (${end[0]}, ${end[1]})`) + " - not played (--once)");
          } catch (err) {
            sim.fail(err.message);
            log(notStarted);
          }
        }
      }
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

  let wasInFront = null;   // last check's answer, to report changes once
  async function check() {
    if (!(await gameWindow())) {
      stats.away++;
      if (wasInFront !== false) log(`"${cfg.window}" isn't the active window - waiting, nothing is moved or clicked`);
      wasInFront = false;
      return;
    }
    if (wasInFront === false) log(`"${cfg.window}" is the active window again`);
    wasInFront = true;

    const a = await readOne(A);
    if (a.present) {
      stats.busy++;
      if (VERBOSE) log(`[A] ${config.toHex(a.actual)} present - nothing`);
      return;
    }
    const occupied = await countOccupied();
    const key = occupied >= fullAt ? "C" : "W";
    const kind = KINDS[key];
    const state = `${invText(occupied)}, A missing`;
    const found = await getTargets(detector);
    if (!found) return;
    const boxes = found[key];
    if (!boxes.length) {
      stats.none++;
      if (VERBOSE) log(`[${kind}] ${state} - no ${kind} in view`);
      return;
    }
    const from = await pointer();
    const aim = nearest(boxes.map((b) => aimBox(b, cfg.inset)), from);
    if (!cfg.click && inside(aim, from)) {
      stats.already++;
      if (VERBOSE) log(`[${kind}] ${state} - the pointer is on the ${kind} ${fmtBox(aim.box)} already`);
      return;
    }

    let p;
    try {
      p = await makePath(from, aim);
      sim.ok();
    } catch (err) {
      sim.fail(err.message);
      return;
    }
    // The Pi moves the pointer relative to where it is: a path from a stale
    // start would end - and click - in the wrong place.
    const now = await pointer();
    if (now.x !== from.x || now.y !== from.y) {
      stats.skipped++;
      log(`[${kind}] the pointer moved while the path was being made - skipped this check`);
      return;
    }
    // Asked again right before playing: never move or click into another app.
    const win = await gameWindow();
    const press = p.pos[p.click.down];
    const end = p.pos[p.pos.length - 1];
    if (!win || !inWindow(win, press) || !inWindow(win, end)) {
      stats.away++;
      log(`[${kind}] ${win ? `the ${cfg.click ? "click" : "path's end"} would land outside the game window`
                            : `"${cfg.window}" stopped being the active window`} - skipped this check`);
      return;
    }

    const what = `${state} - ${kind} ${fmtBox(aim.box)}: (${from.x},${from.y}) -> ` +
                 (cfg.click ? `click at (${press[0]},${press[1]}) held ${p.click.up - p.click.down} ms`
                            : `(${end[0]},${end[1]})`) + `, ${p.pos.length} ms`;
    if (DRY_RUN) {
      stats[kind]++;
      log(`[${kind}] ${what} - would ${cfg.click ? "click" : "move"} (dry run)`);
      return;
    }
    if (shuttingDown) return;
    inFlight = play(p.text);
    try {
      await inFlight;
      pi.ok();
    } catch (err) {
      pi.fail(err.message);
      return;
    } finally {
      inFlight = null;
    }
    stats[kind]++;
    const at = await pointer();
    const off = at.x !== end[0] || at.y !== end[1]
      ? ` - but the pointer is at (${at.x},${at.y}), not on the path's end ` +
        "(hand on the mouse? Enhance pointer precision on?)"
      : "";
    log(`[${kind}] ${what} - ${cfg.click ? "clicked" : "moved, no click"}${off}`);
  }

  while (!shuttingDown) {
    const started = performance.now();
    try {
      await check();
    } catch (err) {
      stats.failures++;
      log(err.message);
    }
    await sleepUntil(started + config.randomIn(cfg.inventory));
  }
})().catch((err) => {
  console.error(err.message);
  closeLaunched();
  process.exit(1);
});
