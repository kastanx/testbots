// Mining (old): watch3v2.js with servo 2 pressing instead of the Pi's HTTP mouse.
//
//   node mining_old.js               -> run until Ctrl+C
//   node mining_old.js --verbose     -> log every cycle, not just changes
//   node mining_old.js --dry-run     -> never move a servo, never notify
//   node mining_old.js --once        -> read all three, print what would happen, exit
//   node mining_old.js --test-notify -> send one push and exit
//
// Same rules as watch3.js / watch3v2.js, one cycle, in order:
//
//   1. Guard missing                       -> pause
//   2. Trigger found                       -> press with servo 2
//   3. Trigger missing AND fallback missing -> pause
//
// Servo 2 (pin D10) replaces watch3v2.js's HTTP click: a press sends it to
// servo2.pressAngle (0), holds servo2.pressHoldMs, then brings it back to the
// middle of its range. It rests at that middle between presses.
//
// Servo 1 (pin D9) is PRESSED - servo.activeAngle (5) - while pixel 1 (guard)
// and pixel 3 (fallback) are both present, and RELEASED - to the middle of its
// range - as soon as either or both are missing. It looks at those two pixels
// only: not pixel 2, not the rules, not whether pressing is paused.
//
// Pause instead of stop, for servo 2's presses. Where watch3.js exits, this
// pauses: one push, no presses. Pressing resumes once this sequence has been
// seen, in order: the trigger (pixel 2), then the guard (pixel 1), then the
// fallback (pixel 3) with the guard still there. It never exits on pixel state.
//
// A re-arm step counts its pixel when a check finds it present - it need not
// have been absent first. Several steps can complete on one check. The
// sequence is only checked from the check after a pause began, and the rules
// run on the check that completes it.
//
// Pixels: read from config3v2.json - the same calibration as watch3v2.js,
// never written here. config-mining_old.json only holds the servo 2 press settings.
//
// Only one program can hold the Arduino's COM port, so close watch3v2.js,
// servo-cli.js or the servo web page first. Ctrl+C releases servo 1 and
// centers servo 2 before exiting.
//
// Exit codes: 0 normal stop (Ctrl+C, --once), 1 config or startup error.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { screen, Point } = require("@nut-tree-fork/nut-js");
const config = require("./config-mining_old.js");

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const DRY_RUN = args.includes("--dry-run");
const ONCE = args.includes("--once");
const TEST_NOTIFY = args.includes("--test-notify");

const GUARD = 0;
const TRIGGER = 1;
const FALLBACK = 2;

const RUNNING = "RUNNING";
const PAUSED = "PAUSED";

const PRESS = "press";
const RELEASE = "release";

// The re-arm sequence, in order.
const STEPS = [
  { waiting: "trigger (pixel 2)", done: "trigger seen", met: (p) => p[TRIGGER] },
  { waiting: "guard (pixel 1)", done: "guard seen", met: (p) => p[GUARD] },
  {
    waiting: "fallback (pixel 3) with the guard",
    done: "fallback seen with the guard",
    met: (p) => p[GUARD] && p[FALLBACK],
  },
];

// How often to try reopening the board's COM port after losing it.
const RECONNECT_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

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
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.end(body);
  });
}

let cfg = null;
let board = null;          // open ServoBoard, or null while disconnected (always null in a dry run)
let desired1 = null;       // PRESS or RELEASE: where servo 1 should be
let sent1 = null;          // what the Arduino last accepted for servo 1; null = unknown
let servo2Rested = false;  // servo 2 confirmed at the middle of its range
let nextReconnectAt = 0;
let boardDownNotified = false;
let shuttingDown = false;

async function push(message, tags) {
  if (DRY_RUN) {
    log(`would notify: ${message} (dry run)`);
    return;
  }
  const res = await sendNotification(cfg.notify, { message, tags });
  if (res.skipped) {
    log("notify skipped (notify.url is empty)");
  } else if (res.ok) {
    log(`notified -> HTTP ${res.status}`);
  } else {
    log(`notify FAILED: ${res.error || "HTTP " + res.status}`);
  }
}

// Loaded here rather than at the top, so --dry-run, --once and --test-notify
// never need the serial port library at all.
async function openBoard() {
  const { ServoBoard } = require("../arduino/servo_control");
  const b = await ServoBoard.open({ port: cfg.servo.port || undefined });
  if (b.count < 2) {
    await b.close().catch(() => {});
    throw new Error(
      `the Arduino reports ${b.count} servo(s); mining_old needs servo 2 on D10 ` +
      "(ServoCtl 2.0 - run node arduino/servo_control/upload.js)"
    );
  }
  b.on("restart", () => {
    // The firmware sent both servos to their own saved home angles, and any
    // command in flight was lost.
    log("servos: the Arduino restarted - re-sending positions");
    sent1 = null;
    servo2Rested = false;
  });
  b.on("disconnect", () => boardLost("USB connection lost"));
  b.on("warning", (err) => { if (VERBOSE) log(`servo warning: ${err.message}`); });
  return b;
}

function boardLost(why) {
  if (!board) return;
  const old = board;
  board = null;
  sent1 = null;
  servo2Rested = false;
  nextReconnectAt = Date.now() + RECONNECT_MS;
  old.close().catch(() => {});
  log(`servo board DISCONNECTED: ${why}. Retrying every ${RECONNECT_MS / 1000}s.`);
  if (!boardDownNotified) {
    boardDownNotified = true;
    push(`Servo board disconnected: ${why}. No servo moves until it's back; pixels ` +
         "are still watched and it reconnects by itself.", "warning");
  }
}

// Reopen the board if it was lost, at most every RECONNECT_MS. True if open.
async function ensureBoard() {
  if (board) return true;
  if (Date.now() < nextReconnectAt) return false;
  nextReconnectAt = Date.now() + RECONNECT_MS;
  try {
    board = await openBoard();
  } catch (err) {
    if (VERBOSE) log(`servo board reconnect failed: ${err.message}`);
    return false;
  }
  boardDownNotified = false;
  log(`servo board reconnected on ${board.path}`);
  return true;
}

// Bring servo 1 to desired1 if it isn't confirmed there. Called every cycle,
// so a dropped command, a restarted Arduino or a reconnect all heal on their own.
async function syncServo1() {
  if (shuttingDown || sent1 === desired1) return;
  const what = desired1 === PRESS
    ? `pressed (${cfg.servo.activeAngle} deg)`
    : "released (center)";

  if (DRY_RUN) {
    log(`would set servo 1 ${what} (dry run)`);
    sent1 = desired1;
    return;
  }
  if (!(await ensureBoard())) return;

  try {
    const s1 = board.servo(1);
    const reply = desired1 === PRESS
      ? await s1.angle(cfg.servo.activeAngle)
      : await s1.center();
    sent1 = desired1;
    log(`servo 1 ${desired1 === PRESS ? "PRESSED" : "RELEASED"} -> ${reply.target} deg` +
        (reply.clamped ? " (CLAMPED by the firmware's limits)" : ""));
  } catch (err) {
    log(`servo 1 command failed: ${err.code || "error"}: ${err.message}`);
    if (err.code === "CLOSED") boardLost(err.message);
    // Anything else leaves sent1 stale, so the next cycle tries again.
  }
}

// Keep servo 2 resting at the middle of its range between presses: at startup,
// and again after a restart or a reconnect.
async function restServo2() {
  if (shuttingDown || servo2Rested) return;

  if (DRY_RUN) {
    log("would center servo 2 (dry run)");
    servo2Rested = true;
    return;
  }
  if (!(await ensureBoard())) return;

  try {
    const reply = await board.servo(2).center();
    servo2Rested = true;
    log(`servo 2 -> ${reply.target} deg (rest)`);
  } catch (err) {
    log(`servo 2 command failed: ${err.code || "error"}: ${err.message}`);
    if (err.code === "CLOSED") boardLost(err.message);
  }
}

// The press that replaces watch3v2.js's HTTP click. Same result shape as its
// sendClick(): { ok, error }.
async function pressServo2() {
  if (!(await ensureBoard())) return { ok: false, error: "servo board not connected" };
  const s2 = board.servo(2);
  servo2Rested = false;
  try {
    const out = await s2.angle(cfg.servo2.pressAngle, { wait: true });
    // With the firmware at full speed the move "finishes" at once, while the
    // servo is still travelling, so the hold also covers the travel.
    await sleep(cfg.servo2.pressHoldMs);
    const back = await s2.center({ wait: true });
    servo2Rested = true;
    return { ok: true, at: out.target, clamped: !!out.clamped, back: back.target };
  } catch (err) {
    if (err.code === "CLOSED") boardLost(err.message);
    return { ok: false, error: `${err.code || "error"}: ${err.message}` };
  }
}

// Leave both servos at rest: servo 1 released, servo 2 centered.
async function parkServos() {
  await Promise.all([board.servo(1).center(), board.servo(2).center()]);
}

(async () => {
  // Checked before the full load, so delivery can be verified before the
  // pixels have been calibrated.
  if (TEST_NOTIFY) {
    const notify = config.loadNotify();
    if (!notify.url) {
      console.error("notify.url is empty - nothing to test");
      process.exit(1);
    }
    console.log(`Sending a test notification to ${notify.url} ...`);
    const res = await sendNotification(notify, {
      message: "Test from mining_old. If you can read this on your phone, " +
               "pause alerts will reach you.",
      priority: "default",
      tags: "white_check_mark",
    });
    console.log(res.ok
      ? `delivered -> HTTP ${res.status}`
      : `FAILED: ${res.error || "HTTP " + res.status}`);
    process.exit(res.ok ? 0 : 1);
  }

  cfg = config.load();
  const points = cfg.spots.map((s) => new Point(s.x, s.y));

  const readSpot = async (i) => {
    const c = await screen.colorAt(points[i]);
    const actual = { r: c.R, g: c.G, b: c.B };
    return {
      actual,
      present: config.matches(actual, cfg.spots[i].color, cfg.tolerance),
    };
  };

  const describe = (i, reading) =>
    `${config.SPOTS[i].label} ${config.toHex(reading.actual)} ` +
    `${reading.present ? "present" : "MISSING"}`;

  const fixedRate = cfg.intervalMinMs === cfg.intervalMaxMs;
  console.log(`Watching three pixels (from ${config.PIXELS_PATH}):`);
  config.SPOTS.forEach((s, i) => {
    const spot = cfg.spots[i];
    console.log(
      `  ${i + 1}. ${s.label.padEnd(9)} (${spot.x}, ${spot.y}) ` +
      `${config.toHex(spot.color)}  - ${s.rule}`
    );
  });
  console.log(
    `Tolerance +/-${cfg.tolerance}, ` +
    (fixedRate
      ? `every ${cfg.intervalMinMs}ms`
      : `every ${cfg.intervalMinMs}-${cfg.intervalMaxMs}ms (random)`)
  );
  console.log(
    `Servo 1: PRESSED (${cfg.servo.activeAngle} deg) while pixels 1 and 3 are both present, ` +
    "RELEASED (center) when either is missing - ignores pixel 2, the rules and pauses" +
    (DRY_RUN ? "   [DRY RUN - port not opened]" : "")
  );
  console.log(
    `Servo 2: presses on the trigger - ${cfg.servo2.pressAngle} deg, ` +
    `hold ${cfg.servo2.pressHoldMs}ms, back to center`
  );
  console.log("On pause: one push, no presses; pressing re-arms on trigger, then guard, then fallback.");
  console.log("Ctrl+C to stop (releases servo 1 and centers servo 2 first).\n");

  if (!DRY_RUN && !ONCE) {
    try {
      board = await openBoard();
    } catch (err) {
      console.error(`Cannot reach the servos: ${err.message}`);
      process.exit(1);
    }
    try {
      const [st1, st2] = await Promise.all([board.servo(1).status(), board.servo(2).status()]);
      log(`servo 1 on ${board.path} pin ${st1.pin}: at ${st1.pos} deg, limits ${st1.lo}-${st1.hi}, ` +
          `center ${st1.range / 2} deg`);
      log(`servo 2 on ${board.path} pin ${st2.pin}: at ${st2.pos} deg, limits ${st2.lo}-${st2.hi}, ` +
          `center ${st2.range / 2} deg`);
      const checks = [
        ["servo 1 press", cfg.servo.activeAngle, st1],
        ["servo 2 press", cfg.servo2.pressAngle, st2],
      ];
      for (const [name, a, st] of checks) {
        if (a < st.lo || a > st.hi) {
          log(`WARNING: ${name} angle ${a} is outside the firmware limits ` +
              `${st.lo}-${st.hi} and will be clamped`);
        }
      }
    } catch (err) {
      log(`servo status unavailable: ${err.message}`);
    }
  }

  let cycles = 0, presses = 0, failures = 0, pauses = 0, rearms = 0;
  let state = RUNNING;
  let step = 0;
  const lastState = config.SPOTS.map(() => null);

  const report = () => {
    console.log(
      `\n${cycles} cycles, ${presses} presses` +
      (failures ? `, ${failures} failed` : "") +
      `, ${pauses} pauses, ${rearms} re-arms; currently ${state}` +
      (state === PAUSED ? ` waiting for ${STEPS[step].waiting}` : "")
    );
  };

  // Log on every cycle when verbose, otherwise only when a spot changes state.
  const note = (i, reading) => {
    if (VERBOSE || ONCE) {
      log("  " + describe(i, reading));
    } else if (reading.present !== lastState[i]) {
      log(describe(i, reading));
    }
    lastState[i] = reading.present;
  };

  process.on("SIGINT", async () => {
    if (shuttingDown) process.exit(0);   // a second Ctrl+C leaves at once
    shuttingDown = true;
    if (board) {
      log("stopping - releasing servo 1 and centering servo 2 first");
      // servo.js sends commands in call order, so these land after anything
      // the main loop already queued.
      try {
        await parkServos();
      } catch (err) {
        log(`could not park the servos: ${err.message}`);
      }
      try {
        await board.close();
      } catch { /* exiting anyway */ }
    }
    report();
    process.exit(0);
  });

  while (!shuttingDown) {
    cycles++;
    if (VERBOSE) log(`cycle ${cycles}  [${state}]`);

    let guard, trigger, fallback;
    try {
      guard = await readSpot(GUARD);
      note(GUARD, guard);
      trigger = await readSpot(TRIGGER);
      note(TRIGGER, trigger);
      fallback = await readSpot(FALLBACK);
      note(FALLBACK, fallback);
    } catch (err) {
      log(`could not read pixel: ${err.message}`);
      if (ONCE) process.exit(1);
      await syncServo1();
      await sleep(config.nextInterval(cfg));
      continue;
    }
    const p = [guard.present, trigger.present, fallback.present];

    if (ONCE) {
      console.log("");
      if (!guard.present) {
        console.log("Result: guard MISSING - would pause.");
      } else if (trigger.present) {
        console.log("Result: trigger present - would press with servo 2.");
      } else if (!fallback.present) {
        console.log("Result: trigger and fallback both MISSING - would pause.");
      } else {
        console.log("Result: trigger missing, fallback present - would do nothing.");
      }
      console.log(guard.present && fallback.present
        ? `        servo 1 would be PRESSED (${cfg.servo.activeAngle} deg).`
        : "        servo 1 would be RELEASED (center).");
      process.exit(0);
    }

    // Paused since an earlier cycle: does this check complete the re-arm?
    if (state === PAUSED) {
      while (step < STEPS.length && STEPS[step].met(p)) {
        log(`re-arm ${step + 1}/${STEPS.length}: ${STEPS[step].done}`);
        step++;
      }
      if (step === STEPS.length) {
        state = RUNNING;
        step = 0;
        rearms++;
        log("RE-ARMED - running again");
      } else if (VERBOSE) {
        log(`  paused, waiting for ${STEPS[step].waiting} (step ${step + 1}/${STEPS.length})`);
      }
    }

    // watch3.js's rules - pausing where it would exit, pressing where it clicks.
    let pausedBecause = null;
    let press = false;
    if (state === RUNNING) {
      if (!guard.present) {
        // 1. Guard missing -> pause.
        pausedBecause = `guard missing at (${cfg.spots[GUARD].x}, ${cfg.spots[GUARD].y}) ` +
                        `- got ${config.toHex(guard.actual)}, ` +
                        `want ${config.toHex(cfg.spots[GUARD].color)}`;
      } else if (trigger.present) {
        // 2. Trigger found -> press with servo 2.
        press = true;
      } else if (!fallback.present) {
        // 3. Trigger missing and fallback missing -> pause.
        pausedBecause = "trigger and fallback both missing " +
                        `(${config.toHex(trigger.actual)} / ${config.toHex(fallback.actual)})`;
      }
      if (pausedBecause) {
        state = PAUSED;
        step = 0;
        pauses++;
        log(`PAUSED: ${pausedBecause}. Waiting for trigger, then guard, then fallback.`);
      }
    }

    // Servo 1: pressed while pixels 1 and 3 are both present, released when
    // either is missing. Nothing else decides it.
    desired1 = guard.present && fallback.present ? PRESS : RELEASE;
    await syncServo1();
    await restServo2();

    if (press) {
      if (DRY_RUN) {
        presses++;
        log(`would press with servo 2 (${cfg.servo2.pressAngle} deg, back to center) (dry run)`);
      } else {
        const res = await pressServo2();
        if (res.ok) {
          presses++;
          log(`pressed -> servo 2 ${res.at} deg, back to ${res.back} deg` +
              (res.clamped ? ` (press angle CLAMPED by the firmware's limits)` : ""));
        } else {
          failures++;
          log(`press FAILED: ${res.error}`);
        }
      }
    }

    if (pausedBecause) {
      await push(
        `Pressing paused: ${pausedBecause}. ` +
        "Waiting for trigger, then guard, then fallback." +
        (DRY_RUN || board ? "" : " Servo board is NOT reachable."),
        "octagonal_sign"
      );
    }

    const wait = config.nextInterval(cfg);
    if (VERBOSE) log(`next cycle in ${wait}ms`);
    await sleep(wait);
  }
})().catch(async (err) => {
  console.error(err.message);
  // Best effort: park the servos rather than leave them wherever they were.
  if (board && cfg) {
    try {
      await parkServos();
      await board.close();
    } catch { /* already failing */ }
  }
  // Only possible once the config has loaded; a config error has no url yet.
  if (cfg && cfg.notify && cfg.notify.url && !DRY_RUN) {
    await sendNotification(cfg.notify, {
      message: `mining_old crashed: ${err.message}. Tried to park the servos.`,
      tags: "rotating_light",
    });
  }
  process.exit(1);
});
