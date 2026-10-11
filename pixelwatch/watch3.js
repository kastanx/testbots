// Watch three pixels; click on one, stop on the others.
//
//   node watch3.js             -> run until Ctrl+C or an abort
//   node watch3.js --verbose   -> log every cycle, not just changes
//   node watch3.js --dry-run   -> never click, never abort
//   node watch3.js --once      -> read all three, print what would happen, exit
//   node watch3.js --test-notify -> send one push and exit
//
// One cycle, in order:
//
//   1. Guard missing                       -> abort (exit 2)
//   2. Trigger found                       -> send a click
//   3. Trigger missing AND fallback missing -> abort (exit 3)
//
// The fallback is only read when the trigger is missing, since that is the
// only case where its state changes the outcome.
//
// "Missing" means the colour at that pixel differs from the calibrated colour
// by more than `tolerance` on any channel.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { screen, Point } = require("@nut-tree-fork/nut-js");
const config = require("./config3.js");

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const DRY_RUN = args.includes("--dry-run");
const ONCE = args.includes("--once");
const TEST_NOTIFY = args.includes("--test-notify");

const GUARD = 0;
const TRIGGER = 1;
const FALLBACK = 2;

const EXIT_GUARD_LOST = 2;
const EXIT_BOTH_LOST = 3;

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

(async () => {
  // Checked before the full load, so delivery can be verified before the
  // pixels have been calibrated.
  if (TEST_NOTIFY) {
    const notify = config.loadNotify();
    if (!notify.url) {
      console.error("notify.url is empty in config3.json - nothing to test");
      process.exit(1);
    }
    console.log(`Sending a test notification to ${notify.url} ...`);
    const res = await sendNotification(notify, {
      message: "Test from pixelwatch3. If you can read this on your phone, " +
               "abort alerts will reach you.",
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
  console.log("Ctrl+C to stop.\n");

  let cycles = 0, clicks = 0, failures = 0;
  const lastState = config.SPOTS.map(() => null);

  const report = () => {
    console.log(
      `\n${cycles} cycles, ${clicks} clicks sent` +
      (failures ? `, ${failures} failed` : "")
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

  const abort = async (code, why) => {
    log(`ABORT: ${why}`);
    // Awaited: process.exit() would kill the request before it is flushed.
    const res = await sendNotification(cfg.notify, {
      message: `Stopped: ${why}`,
      tags: "octagonal_sign",
    });
    if (res.skipped) {
      log("notify skipped (notify.url is empty)");
    } else if (res.ok) {
      log(`notified -> HTTP ${res.status}`);
    } else {
      log(`notify FAILED: ${res.error || "HTTP " + res.status}`);
    }
    report();
    process.exit(code);
  };

  process.on("SIGINT", () => { report(); process.exit(0); });

  for (;;) {
    cycles++;
    if (VERBOSE) log(`cycle ${cycles}`);

    let guard, trigger, fallback = null;
    try {
      guard = await readSpot(GUARD);
      note(GUARD, guard);
      trigger = await readSpot(TRIGGER);
      note(TRIGGER, trigger);
      // Only consulted when the trigger is missing, except in --once where the
      // point is to show the full picture.
      if (!trigger.present || ONCE) {
        fallback = await readSpot(FALLBACK);
        note(FALLBACK, fallback);
      }
    } catch (err) {
      log(`could not read pixel: ${err.message}`);
      if (ONCE) process.exit(1);
      await sleep(config.nextInterval(cfg));
      continue;
    }

    if (ONCE) {
      console.log("");
      if (!guard.present) {
        console.log("Result: guard MISSING - would abort (exit 2).");
      } else if (trigger.present) {
        console.log("Result: trigger present - would send a click.");
      } else if (fallback && !fallback.present) {
        console.log("Result: trigger and fallback both MISSING - would abort (exit 3).");
      } else {
        console.log("Result: trigger missing, fallback present - would do nothing.");
      }
      process.exit(0);
    }

    // The three rules are mutually exclusive for a given cycle: once the guard
    // is gone nothing else in the cycle would have run, so a dry run must not
    // pretend otherwise.
    if (!guard.present) {
      // 1. Guard missing -> stop.
      const why = `guard missing at (${cfg.spots[GUARD].x}, ${cfg.spots[GUARD].y}) ` +
                  `- got ${config.toHex(guard.actual)}, ` +
                  `want ${config.toHex(cfg.spots[GUARD].color)}`;
      if (!DRY_RUN) await abort(EXIT_GUARD_LOST, why);
      log(`would ABORT: ${why} - skipping rest of cycle, dry run`);
    } else if (trigger.present) {
      // 2. Trigger found -> click.
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
    } else if (fallback && !fallback.present) {
      // 3. Trigger missing and fallback missing -> stop.
      const why = "trigger and fallback both missing " +
                  `(${config.toHex(trigger.actual)} / ${config.toHex(fallback.actual)})`;
      if (!DRY_RUN) await abort(EXIT_BOTH_LOST, why);
      log(`would ABORT: ${why} - continuing, dry run`);
    }

    const wait = config.nextInterval(cfg);
    if (VERBOSE) log(`next cycle in ${wait}ms`);
    await sleep(wait);
  }
})().catch(async (err) => {
  console.error(err.message);
  // Only possible once the config has loaded; a config error has no url yet.
  if (cfg && cfg.notify && cfg.notify.url) {
    await sendNotification(cfg.notify, {
      message: `Crashed: ${err.message}`,
      tags: "rotating_light",
    });
  }
  process.exit(1);
});
