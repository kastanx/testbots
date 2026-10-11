// Mining: pixel A -> servo 2 taps; a full inventory -> servo 1 taps, and if
// that didn't free it, push and pause.
//
//   node mining.js               -> run until Ctrl+C
//   node mining.js --verbose     -> log every check, not just actions
//   node mining.js --dry-run     -> never open the servo port, never push; log what it would do
//   node mining.js --once        -> read pixel A and the inventory, print what would happen, exit
//   node mining.js --test-notify -> send one push and exit
//
// Two checks, each on its own 3-5 s interval:
//
//   pixel A     A present -> servo 2 taps (0 and back to the middle)
//   inventory   24 or more of the 28 spaces occupied -> servo 1 taps (5 and
//               back to the middle), and 1 s later the spaces are counted
//               again: still 24 or more -> one push, and PAUSE. Fewer than 24
//               occupied -> nothing. After a tap, the next check is 3-5 s after
//               the second count.
//
// Paused: nothing is tapped, and pixel A isn't checked at all. The inventory is
// still counted every 3-5 s, and once fewer than 24 spaces are occupied it
// resumes by itself.
//
// The 28 inventory spaces are archeology's A blocks, read from
// config-archeology.json (never written). A space counts as occupied when its
// 10x10 block no longer matches the empty slot it was calibrated on - the same
// test archeology uses, with archeology's tolerance and blockMatchPercent.
// Pixel A comes from config-mining.json (calibrate-mining.js).
//
// Servo moves run one at a time, and the two servos never move at the same
// time. A servo 1 tap, its 1 s wait and the second count go together: no
// servo 2 tap in between. Pixel A is read right before its tap, so it's never
// tapped on a reading from before an inventory tap.
//
// Only one program can hold the Arduino's COM port, so close the other
// watchers, servo-cli.js and the servo web page first.
//
// Exit codes: 0 normal stop (Ctrl+C, --once, --test-notify delivered),
// 1 config or startup error.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { screen, Region, ColorMode } = require("@nut-tree-fork/nut-js");
const config = require("./config-mining.js");

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const DRY_RUN = args.includes("--dry-run");
const ONCE = args.includes("--once");
const TEST_NOTIFY = args.includes("--test-notify");

// How often to try reopening the board's COM port after losing it.
const RECONNECT_MS = 5000;

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
let board = null;          // open ServoBoard, or null while disconnected (always null in a dry run)
let restNeeded = true;     // both servos to be sent to the middle before the next move
let nextReconnectAt = 0;
let shuttingDown = false;
// Set when the inventory stayed full after a servo 1 tap; cleared once fewer
// than minOccupied spaces are occupied. While set nothing is tapped and pixel A
// isn't checked.
let paused = false;

// One servo move sequence at a time, in the order they were asked for.
let servoQueue = Promise.resolve();
function withServos(fn) {
  const run = servoQueue.then(fn);
  servoQueue = run.catch(() => {});
  return run;
}

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

// ---- push ---------------------------------------------------------------------

// Push to ntfy. The message is the body; title/priority/tags are headers, so
// they must stay ASCII - Node rejects non-ASCII header values outright.
function sendNotification(notify, { message, priority, tags }, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!notify || !notify.url) {
      resolve({ ok: false, skipped: true });
      return;
    }
    let url;
    try {
      url = new URL(notify.url);
    } catch {
      resolve({ ok: false, error: `bad notify.url: ${notify.url}` });
      return;
    }

    const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, "?");
    const body = Buffer.from(message, "utf8");
    const headers = {
      "content-type": "text/plain; charset=utf-8",
      "content-length": body.length,
    };
    if (notify.title) headers["Title"] = ascii(notify.title);
    if (priority || notify.priority) headers["Priority"] = ascii(priority || notify.priority);
    if (tags) headers["Tags"] = ascii(tags);

    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method: "POST", headers, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.end(body);
  });
}

// ---- servos -------------------------------------------------------------------

// Loaded here rather than at the top, so --dry-run and --once never need the
// serial port library at all.
async function openBoard() {
  const { ServoBoard } = require("../arduino/servo_control");
  const b = await ServoBoard.open({ port: cfg.port || undefined });
  if (b.count < 2) {
    await b.close().catch(() => {});
    throw new Error(
      `the Arduino reports ${b.count} servo(s); this needs servo 2 on D10 ` +
      "(ServoCtl 2.0 - run node arduino/servo_control/upload.js)"
    );
  }
  b.on("restart", () => {
    // The firmware sent both servos to their own saved home angles, and any
    // command in flight was lost.
    log("servos: the Arduino restarted - putting them back");
    restNeeded = true;
  });
  b.on("disconnect", () => boardLost("USB connection lost"));
  b.on("warning", (err) => { if (VERBOSE) log(`servo warning: ${err.message}`); });
  return b;
}

function boardLost(why) {
  if (!board) return;
  const old = board;
  board = null;
  restNeeded = true;
  nextReconnectAt = Date.now() + RECONNECT_MS;
  old.close().catch(() => {});
  log(`servo board DISCONNECTED: ${why}. Retrying every ${RECONNECT_MS / 1000}s.`);
}

// Reopen the board if it was lost, at most every RECONNECT_MS. True if usable.
async function ensureBoard() {
  if (DRY_RUN) return true;
  if (board) return true;
  if (Date.now() < nextReconnectAt) return false;
  nextReconnectAt = Date.now() + RECONNECT_MS;
  try {
    board = await openBoard();
  } catch (err) {
    if (VERBOSE) log(`servo board reconnect failed: ${err.message}`);
    return false;
  }
  restNeeded = true;
  log(`servo board reconnected on ${board.path}`);
  return true;
}

// Send one servo to an angle, or to the middle ("center"). Dry runs only log.
async function move(n, angle) {
  if (DRY_RUN) {
    if (VERBOSE) log(`  would move servo ${n} to ${angle === "center" ? "center" : angle + " deg"} (dry run)`);
    return { target: angle };
  }
  const s = board.servo(n);
  return angle === "center" ? s.center() : s.angle(angle, { wait: true });
}

// Both servos to the middle, if a start, restart or reconnect left them unknown.
// Called inside withServos().
async function restIfNeeded() {
  if (!restNeeded) return;
  await Promise.all([move(1, "center"), move(2, "center")]);
  restNeeded = false;
  log("both servos centered (rest)");
}

// One tap. Called inside withServos().
async function tap(n, angle) {
  await restIfNeeded();
  const out = await move(n, angle);
  // With the firmware at full speed a move "finishes" at once while the servo
  // is still travelling, so holdMs also covers the travel there...
  await sleep(cfg.tap.holdMs);
  await move(n, "center");
  // ...and gapMs the travel back.
  await sleep(cfg.tap.gapMs);
  return out;
}

// ---- main ---------------------------------------------------------------------

(async () => {
  // Checked before the full load, so delivery can be verified before pixel A
  // has been calibrated.
  if (TEST_NOTIFY) {
    const notify = config.loadNotify();
    if (!notify.url) {
      console.error("notify.url is empty in config-mining.json - nothing to test");
      process.exit(1);
    }
    console.log(`Sending a test notification to ${notify.url} ...`);
    const res = await sendNotification(notify, {
      message: "Test from mining. If you can read this on your phone, " +
               "its pause alerts will reach you.",
      priority: "default",
      tags: "white_check_mark",
    });
    console.log(res.ok ? `delivered -> HTTP ${res.status}` : `FAILED: ${res.error || "HTTP " + res.status}`);
    process.exit(res.ok ? 0 : 1);
  }

  cfg = config.load();
  const inv = config.loadInventory();
  const [A] = cfg.pixels.A;
  const total = inv.spaces.length;
  const minOcc = cfg.inventory.minOccupied;
  const readInventory = blockReader(inv.spaces, inv.tolerance, inv.blockMatchPercent);
  // A space is occupied when its block no longer looks like the empty slot.
  const countOccupied = async () => {
    const reads = await readInventory();
    return { occupied: reads.filter((r) => !r.present).length, reads };
  };

  const stats = { aTaps: 0, presses: 0, pauses: 0, resumes: 0, failures: 0 };
  const report = () => {
    console.log(
      `\n${stats.aTaps} servo 2 taps (pixel A), ${stats.presses} servo 1 taps (inventory), ` +
      `${stats.pauses} pauses, ${stats.resumes} resumes` +
      (stats.failures ? `, ${stats.failures} failed` : "") +
      (paused ? " - stopped while PAUSED" : "")
    );
  };

  console.log(`Pixel A: (${A.x}, ${A.y}) ${config.toHex(A.color)} +/-${cfg.tolerance}`);
  console.log(`Inventory: ${total} spaces from archeology (${inv.file}) - a space is occupied when ` +
              "its 10x10 block differs from the empty slot in " +
              (inv.blockMatchPercent === 100 ? "any pixel" : `more than ${100 - inv.blockMatchPercent}% of its pixels`) +
              ` (+/-${inv.tolerance})`);
  console.log(
    `1. pixel A    every ${cfg.pixelA.intervalMinMs}-${cfg.pixelA.intervalMaxMs}ms: ` +
    `A present -> servo 2 taps (${cfg.servo2.tapAngle} deg)`
  );
  console.log(
    `2. inventory  every ${cfg.inventory.intervalMinMs}-${cfg.inventory.intervalMaxMs}ms: ` +
    `${minOcc}+ of ${total} occupied -> servo 1 taps (${cfg.servo1.tapAngle} deg); ` +
    `${cfg.inventory.recheckMs}ms later counted again: still ${minOcc}+ -> push and PAUSE`
  );
  console.log(`Paused: no taps, pixel A not checked; resumes once fewer than ${minOcc} are occupied.` +
              (DRY_RUN ? "   [DRY RUN - port not opened, no pushes]" : ""));
  console.log("Ctrl+C to stop (centers both servos first).\n");

  if (ONCE) {
    const a = await readOne(A);
    const { occupied, reads } = await countOccupied();
    const empty = reads.map((r, i) => (r.present ? i + 1 : null)).filter(Boolean);
    log(`  pixel A ${config.toHex(a.actual)} ${a.present ? "present" : "missing"}`);
    log(`  inventory: ${occupied}/${total} occupied - ` +
        (empty.length ? `empty: space ${empty.join(" ")}` : "no empty space"));
    console.log("");
    console.log(a.present ? "1. pixel A:   present - would tap servo 2." : "1. pixel A:   missing - no tap.");
    console.log(occupied >= minOcc
      ? `2. inventory: ${occupied}/${total} occupied - would tap servo 1, count again ` +
        `${cfg.inventory.recheckMs}ms later, and pause + push if still ${minOcc} or more.`
      : `2. inventory: ${occupied}/${total} occupied, under ${minOcc} - nothing.`);
    process.exit(0);
  }

  if (!DRY_RUN) {
    try {
      board = await openBoard();
    } catch (err) {
      console.error(`Cannot reach the servos: ${err.message}`);
      process.exit(1);
    }
    try {
      const [st1, st2] = await Promise.all([board.servo(1).status(), board.servo(2).status()]);
      log(`servo 1 on ${board.path} pin ${st1.pin}: limits ${st1.lo}-${st1.hi}, center ${st1.range / 2} deg`);
      log(`servo 2 on ${board.path} pin ${st2.pin}: limits ${st2.lo}-${st2.hi}, center ${st2.range / 2} deg`);
      for (const [n, st, a, what] of [[1, st1, cfg.servo1.tapAngle, "inventory tap"],
                                      [2, st2, cfg.servo2.tapAngle, "pixel A tap"]]) {
        if (a < st.lo || a > st.hi) {
          log(`WARNING: servo ${n} ${what} angle ${a} is outside the firmware limits ` +
              `${st.lo}-${st.hi} and will be clamped`);
        }
      }
    } catch (err) {
      log(`servo status unavailable: ${err.message}`);
    }
  }

  process.on("SIGINT", async () => {
    if (shuttingDown) process.exit(0);   // a second Ctrl+C leaves at once
    shuttingDown = true;
    if (board) {
      log("stopping - centering both servos first");
      try {
        await Promise.all([board.servo(1).center(), board.servo(2).center()]);
      } catch (err) {
        log(`could not center the servos: ${err.message}`);
      }
      try {
        await board.close();
      } catch { /* exiting anyway */ }
    }
    report();
    process.exit(0);
  });

  await withServos(restIfNeeded).catch((err) => log(`centering failed: ${err.message}`));

  // Runs `check` every interval, measured start to start. `check` can instead
  // return when to run next (after an inventory tap: an interval after the
  // second count).
  async function section(range, check) {
    while (!shuttingDown) {
      const started = performance.now();
      let next;
      try {
        next = await check();
      } catch (err) {
        stats.failures++;
        log(`${err.message}`);
        if (err.code === "CLOSED") boardLost(err.message);
      }
      await sleepUntil(typeof next === "number" ? next : started + config.randomIn(range));
    }
  }

  const clampNote = (out) => (out && out.clamped ? ` (CLAMPED to ${out.target})` : "") +
                             (DRY_RUN ? " (dry run)" : "");

  // One push per pause - not awaited, so the servo queue never waits on the
  // network.
  function pushPause(why) {
    if (DRY_RUN) {
      log(`would push: ${why} - dry run`);
      return;
    }
    sendNotification(cfg.notify, {
      message: `Mining paused: ${why}. It resumes by itself once fewer than ${minOcc} are occupied.`,
      tags: "warning",
    }).then((res) => {
      if (res.skipped) log("push skipped (notify.url is empty)");
      else if (res.ok) log(`pushed -> HTTP ${res.status}`);
      else {
        stats.failures++;
        log(`push FAILED: ${res.error || "HTTP " + res.status}`);
      }
    });
  }

  // Pixel A: present -> servo 2 taps. Nothing while paused.
  const pixelASection = section(cfg.pixelA, async () => {
    if (paused) return;
    return withServos(async () => {
      // Read in turn, right before the tap.
      if (paused || shuttingDown) return;
      const a = await readOne(A);
      if (VERBOSE) log(`[A] ${config.toHex(a.actual)} ${a.present ? "present" : "missing"}`);
      if (!a.present) return;
      if (!(await ensureBoard())) {
        stats.failures++;
        log("[A] servo board not connected - no tap");
        return;
      }
      const out = await tap(2, cfg.servo2.tapAngle);
      stats.aTaps++;
      log(`[A] pixel A present - servo 2 tapped${clampNote(out)}`);
    });
  });

  // Inventory: minOccupied+ occupied -> servo 1 taps, count again, pause if
  // still full. While paused, only watch for it to free up.
  const inventorySection = section(cfg.inventory, async () => {
    if (paused) {
      const { occupied } = await countOccupied();
      if (VERBOSE) log(`[inventory] paused - ${occupied}/${total} occupied`);
      if (occupied < minOcc) {
        paused = false;
        stats.resumes++;
        log(`[inventory] ${occupied}/${total} occupied - RESUMED`);
      }
      return;
    }
    return withServos(async () => {
      if (paused || shuttingDown) return;
      const first = await countOccupied();
      if (VERBOSE) log(`[inventory] ${first.occupied}/${total} occupied`);
      if (first.occupied < minOcc) return;
      if (!(await ensureBoard())) {
        stats.failures++;
        log("[inventory] servo board not connected - no tap");
        return;
      }
      const out = await tap(1, cfg.servo1.tapAngle);
      stats.presses++;
      log(`[inventory] ${first.occupied}/${total} occupied - servo 1 tapped${clampNote(out)}, ` +
          `counting again in ${cfg.inventory.recheckMs}ms`);
      // tap() already waited gapMs after sending servo 1 back to the middle.
      await sleep(Math.max(0, cfg.inventory.recheckMs - cfg.tap.gapMs));
      if (shuttingDown) return;
      const second = await countOccupied();
      if (second.occupied >= minOcc) {
        paused = true;
        stats.pauses++;
        const why = `${second.occupied}/${total} inventory spaces still occupied after the servo 1 tap`;
        log(`[inventory] ${why} - PAUSED`);
        pushPause(why);
      } else {
        log(`[inventory] ${second.occupied}/${total} occupied after the tap - carrying on`);
      }
      return performance.now() + config.randomIn(cfg.inventory);
    });
  });

  await Promise.all([pixelASection, inventorySection]);
})().catch(async (err) => {
  console.error(err.message);
  // Best effort: leave both servos at rest rather than wherever they were.
  if (board) {
    try {
      await Promise.all([board.servo(1).center(), board.servo(2).center()]);
      await board.close();
    } catch { /* already failing */ }
  }
  if (cfg && cfg.notify && cfg.notify.url && !DRY_RUN) {
    await sendNotification(cfg.notify, { message: `Mining crashed: ${err.message}`, tags: "rotating_light" });
  }
  process.exit(1);
});
