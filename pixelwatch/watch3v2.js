// watch3.js plus a servo, pausing where watch3.js would stop.
//
//   node watch3v2.js               -> run until Ctrl+C
//   node watch3v2.js --verbose     -> log every cycle, not just changes
//   node watch3v2.js --dry-run     -> never click, never move the servo, never notify
//   node watch3v2.js --once        -> read all three, print what would happen, exit
//   node watch3v2.js --test-notify -> send one push and exit
//
// Same rules as watch3.js, one cycle, in order:
//
//   1. Guard missing                       -> pause
//   2. Trigger found                       -> send a click
//   3. Trigger missing AND fallback missing -> pause
//
// Added on top of watch3.js:
//
//   - Servo. The servo on the Arduino (arduino/servo_control, through servo.js)
//     goes to servo.activeAngle (5) as soon as the guard (pixel 1) and the
//     fallback (pixel 3) are both present, and to servo.homeAngle (90) as soon
//     as either is missing. It looks at those two pixels only - not the
//     trigger, not the rules, not whether the clicking is paused.
//
//   - Pause instead of stop, for the clicking. Where watch3.js exits, this
//     pauses: one push, no clicks. Clicking resumes once this sequence has been
//     seen, in order: the trigger (pixel 2), then the guard (pixel 1), then the
//     fallback (pixel 3) with the guard still there. It never exits on pixel
//     state. The servo carries on following pixels 1 and 3 throughout.
//
// A re-arm step counts its pixel when a check finds it present - it need not
// have been absent first, so a pixel that never went away can't lock the
// sequence up. Several steps can complete on one check. The sequence is only
// checked from the check after a pause began, and the rules run on the check
// that completes it.
//
// All three pixels are read every cycle, because the servo needs the fallback
// even while the trigger is present.
//
// Only one program can hold the Arduino's COM port, so close servo-cli.js or
// the servo web page first. Ctrl+C sends the servo home before exiting.
//
// "Missing" means the colour at that pixel differs from the calibrated colour
// by more than `tolerance` on any channel.
//
// Exit codes: 0 normal stop (Ctrl+C, --once), 1 config or startup error.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { screen, Point } = require("@nut-tree-fork/nut-js");
const config = require("./config3v2.js");

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

// How often to try reopening the servo's COM port after losing it.
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

function sendClick(clickUrl, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(clickUrl);
    } catch {
      resolve({ ok: false, error: `bad clickUrl: ${clickUrl}` });
      return;
    }

    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url, { method: "POST", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
        });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

let cfg = null;
let servo = null;          // open Servo, or null while disconnected (always null in a dry run)
let desiredAngle = null;   // where the servo should be
let sentAngle = null;      // last angle the Arduino accepted; null = unknown
let nextReconnectAt = 0;
let servoDownNotified = false;
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
async function openServo() {
  const { Servo } = require("../arduino/servo_control");
  const s = await Servo.open({ port: cfg.servo.port || undefined });
  s.on("restart", () => {
    // The firmware went to its own saved home angle, which need not be ours,
    // and any command in flight was lost.
    log("servo: the Arduino restarted - re-sending the servo position");
    sentAngle = null;
  });
  s.on("disconnect", () => servoLost("USB connection lost"));
  s.on("warning", (err) => { if (VERBOSE) log(`servo warning: ${err.message}`); });
  return s;
}

function servoLost(why) {
  if (!servo) return;
  const old = servo;
  servo = null;
  sentAngle = null;
  nextReconnectAt = Date.now() + RECONNECT_MS;
  old.close().catch(() => {});
  log(`servo DISCONNECTED: ${why}. Retrying every ${RECONNECT_MS / 1000}s.`);
  if (!servoDownNotified) {
    servoDownNotified = true;
    push(`Servo disconnected: ${why}. Pixels are still watched and clicks still ` +
         `sent; it reconnects by itself.`, "warning");
  }
}

// Bring the servo to desiredAngle if it isn't confirmed there. Called every
// cycle, so a dropped command, a restarted Arduino or a reconnect all heal on
// their own.
async function syncServo() {
  if (shuttingDown || sentAngle === desiredAngle) return;

  if (DRY_RUN) {
    log(`would move the servo to ${desiredAngle} deg (dry run)`);
    sentAngle = desiredAngle;
    return;
  }

  if (!servo) {
    if (Date.now() < nextReconnectAt) return;
    nextReconnectAt = Date.now() + RECONNECT_MS;
    try {
      servo = await openServo();
    } catch (err) {
      if (VERBOSE) log(`servo reconnect failed: ${err.message}`);
      return;
    }
    servoDownNotified = false;
    log(`servo reconnected on ${servo.path}`);
  }

  try {
    const reply = await servo.angle(desiredAngle);
    sentAngle = desiredAngle;
    log(`servo -> ${reply.target} deg` +
        (reply.clamped ? ` (asked for ${desiredAngle}: CLAMPED by the firmware's limits)` : ""));
  } catch (err) {
    log(`servo command failed: ${err.code || "error"}: ${err.message}`);
    if (err.code === "CLOSED") servoLost(err.message);
    // Anything else leaves sentAngle stale, so the next cycle tries again.
  }
}

(async () => {
  // Checked before the full load, so delivery can be verified before the
  // pixels have been calibrated.
  if (TEST_NOTIFY) {
    const notify = config.loadNotify();
    if (!notify.url) {
      console.error("notify.url is empty in config3v2.json - nothing to test");
      process.exit(1);
    }
    console.log(`Sending a test notification to ${notify.url} ...`);
    const res = await sendNotification(notify, {
      message: "Test from pixelwatch3 v2. If you can read this on your phone, " +
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
  console.log("Watching three pixels:");
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
  console.log(`Click -> ${cfg.clickUrl}${DRY_RUN ? "   [DRY RUN]" : ""}`);
  console.log(
    `Servo: ${cfg.servo.activeAngle} deg whenever guard and fallback are both present, ` +
    `${cfg.servo.homeAngle} deg otherwise - ignores the trigger and pauses` +
    `${DRY_RUN ? "   [DRY RUN - port not opened]" : ""}`
  );
  console.log("On pause: one push, no clicks; clicking re-arms on trigger, then guard, then fallback.");
  console.log("Ctrl+C to stop (sends the servo home first).\n");

  if (!DRY_RUN && !ONCE) {
    try {
      servo = await openServo();
    } catch (err) {
      console.error(`Cannot reach the servo: ${err.message}`);
      process.exit(1);
    }
    try {
      const st = await servo.status();
      log(`servo on ${servo.path}: at ${st.pos} deg, limits ${st.lo}-${st.hi}, ` +
          `firmware power-up home ${st.home}`);
      for (const [name, a] of [["active", cfg.servo.activeAngle], ["home", cfg.servo.homeAngle]]) {
        if (a < st.lo || a > st.hi) {
          log(`WARNING: ${name} angle ${a} is outside the firmware limits ` +
              `${st.lo}-${st.hi} and will be clamped`);
        }
      }
    } catch (err) {
      log(`servo status unavailable: ${err.message}`);
    }
  }

  let cycles = 0, clicks = 0, failures = 0, pauses = 0, rearms = 0;
  let state = RUNNING;
  let step = 0;
  const lastState = config.SPOTS.map(() => null);

  const report = () => {
    console.log(
      `\n${cycles} cycles, ${clicks} clicks sent` +
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
    if (servo) {
      log(`stopping - sending the servo home (${cfg.servo.homeAngle} deg) first`);
      // servo.js runs commands in call order, so this lands after anything the
      // main loop already queued.
      try {
        await servo.angle(cfg.servo.homeAngle);
      } catch (err) {
        log(`could not send the servo home: ${err.message}`);
      }
      try {
        await servo.close();
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
      await syncServo();
      await sleep(config.nextInterval(cfg));
      continue;
    }
    const p = [guard.present, trigger.present, fallback.present];

    if (ONCE) {
      console.log("");
      if (!guard.present) {
        console.log("Result: guard MISSING - would pause.");
      } else if (trigger.present) {
        console.log("Result: trigger present - would send a click.");
      } else if (!fallback.present) {
        console.log("Result: trigger and fallback both MISSING - would pause.");
      } else {
        console.log("Result: trigger missing, fallback present - would do nothing.");
      }
      console.log(guard.present && fallback.present
        ? `        servo would be held at ${cfg.servo.activeAngle} deg.`
        : `        servo would be home (${cfg.servo.homeAngle} deg).`);
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

    // watch3.js's rules, unchanged - except that where it would exit, this pauses.
    let pausedBecause = null;
    let click = false;
    if (state === RUNNING) {
      if (!guard.present) {
        // 1. Guard missing -> pause.
        pausedBecause = `guard missing at (${cfg.spots[GUARD].x}, ${cfg.spots[GUARD].y}) ` +
                        `- got ${config.toHex(guard.actual)}, ` +
                        `want ${config.toHex(cfg.spots[GUARD].color)}`;
      } else if (trigger.present) {
        // 2. Trigger found -> click.
        click = true;
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

    // The servo follows pixels 1 and 3 and nothing else: not the trigger, not
    // the pause. Moved before the click and the push.
    desiredAngle = guard.present && fallback.present
      ? cfg.servo.activeAngle
      : cfg.servo.homeAngle;
    await syncServo();

    if (click) {
      if (DRY_RUN) {
        clicks++;
        log("would click (dry run)");
      } else {
        const res = await sendClick(cfg.clickUrl);
        if (res.ok) {
          clicks++;
          log(`clicked -> ${res.status}`);
        } else {
          failures++;
          log(`click FAILED: ${res.error || "HTTP " + res.status}`);
        }
      }
    }

    if (pausedBecause) {
      await push(
        `Clicking paused: ${pausedBecause}. ` +
        "Waiting for trigger, then guard, then fallback." +
        (sentAngle === desiredAngle ? "" : " Servo is NOT reachable."),
        "octagonal_sign"
      );
    }

    const wait = config.nextInterval(cfg);
    if (VERBOSE) log(`next cycle in ${wait}ms`);
    await sleep(wait);
  }
})().catch(async (err) => {
  console.error(err.message);
  // Best effort: leave the servo home rather than wherever it was.
  if (servo && cfg) {
    try {
      await servo.angle(cfg.servo.homeAngle);
      await servo.close();
    } catch { /* already failing */ }
  }
  // Only possible once the config has loaded; a config error has no url yet.
  if (cfg && cfg.notify && cfg.notify.url && !DRY_RUN) {
    await sendNotification(cfg.notify, {
      message: `watch3v2 crashed: ${err.message}. Tried to send the servo home.`,
      tags: "rotating_light",
    });
  }
  process.exit(1);
});
