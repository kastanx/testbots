// Watch a pixel; click the Pi when it goes missing, and stop if that fails.
//
//   node watch.js             -> run until Ctrl+C or an abort
//   node watch.js --verbose   -> log every check, not just changes
//   node watch.js --dry-run   -> never actually send a click, never abort
//   node watch.js --once      -> single check, print the result, exit
//
// "Missing" means the colour at the configured pixel differs from the
// calibrated colour by more than `tolerance` on any channel.
//
// After each click the pixel gets `verifyDelayMs` to come back. If it does,
// normal polling resumes. If it does not, the click clearly is not doing what
// it should, so the watcher exits with code 2 rather than clicking forever.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { screen, Point } = require("@nut-tree-fork/nut-js");
const config = require("./config.js");

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const DRY_RUN = args.includes("--dry-run");
const ONCE = args.includes("--once");

// How often to re-check while waiting for the pixel to come back.
const VERIFY_POLL_MS = 250;

const EXIT_ABORTED = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

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

(async () => {
  const cfg = config.load();
  const target = new Point(cfg.x, cfg.y);

  const readPixel = async () => {
    const c = await screen.colorAt(target);
    const actual = { r: c.R, g: c.G, b: c.B };
    return { actual, present: config.matches(actual, cfg.color, cfg.tolerance) };
  };

  // Give the pixel up to verifyDelayMs to reappear. Returns as soon as it does,
  // otherwise returns the last reading taken (or null if none could be read).
  const waitForPixel = async () => {
    const deadline = Date.now() + cfg.verifyDelayMs;
    let last = null;
    do {
      const remaining = deadline - Date.now();
      await sleep(Math.max(0, Math.min(VERIFY_POLL_MS, remaining)));
      try {
        last = await readPixel();
        if (last.present) return last;
      } catch (err) {
        log(`could not read pixel while verifying: ${err.message}`);
      }
    } while (Date.now() < deadline);
    return last;
  };

  const fixedRate = cfg.intervalMinMs === cfg.intervalMaxMs;
  console.log(
    `Watching (${cfg.x}, ${cfg.y}) for ${config.toHex(cfg.color)} ` +
    `+/-${cfg.tolerance}, ` +
    (fixedRate
      ? `every ${cfg.intervalMinMs}ms`
      : `every ${cfg.intervalMinMs}-${cfg.intervalMaxMs}ms (random)`)
  );
  console.log(`Click -> ${cfg.clickUrl}${DRY_RUN ? "   [DRY RUN]" : ""}`);
  console.log(
    `After a click the pixel has ${cfg.verifyDelayMs}ms to come back, ` +
    `or the watcher ${DRY_RUN ? "would exit" : "exits"}.`
  );
  console.log("Ctrl+C to stop.\n");

  let lastPresent = null;
  let checks = 0, clicks = 0, failures = 0;

  const report = () => {
    console.log(
      `\n${checks} checks, ${clicks} clicks sent` +
      (failures ? `, ${failures} failed` : "")
    );
  };

  process.on("SIGINT", () => { report(); process.exit(0); });

  for (;;) {
    checks++;
    let reading;
    try {
      reading = await readPixel();
    } catch (err) {
      log(`could not read pixel: ${err.message}`);
      if (ONCE) process.exit(1);
      await sleep(config.nextInterval(cfg));
      continue;
    }
    const { actual, present } = reading;

    if (VERBOSE || ONCE) {
      log(`${config.toHex(actual)} ${present ? "present" : "MISSING"}`);
    } else if (present !== lastPresent) {
      log(present
        ? `pixel back (${config.toHex(actual)})`
        : `pixel missing (${config.toHex(actual)}, want ${config.toHex(cfg.color)})`);
    }
    lastPresent = present;

    if (ONCE) {
      console.log(present
        ? "Result: pixel PRESENT - no click would be sent."
        : "Result: pixel MISSING - a click would be sent.");
      process.exit(0);
    }

    if (!present) {
      let clicked;
      if (DRY_RUN) {
        clicks++;
        log("would click (dry run)");
        clicked = true;
      } else {
        const res = await sendClick(cfg.clickUrl);
        clicked = res.ok;
        if (res.ok) {
          clicks++;
          log(`clicked -> ${res.status}`);
        } else {
          failures++;
          log(`click FAILED: ${res.error || "HTTP " + res.status}`);
        }
      }

      // Only worth verifying if a click actually went out.
      if (clicked) {
        const after = await waitForPixel();
        if (after && after.present) {
          log(`pixel back after click (${config.toHex(after.actual)})`);
          lastPresent = true;
        } else {
          const seen = after ? config.toHex(after.actual) : "unreadable";
          const msg =
            `pixel still missing ${cfg.verifyDelayMs}ms after click (${seen})`;
          if (DRY_RUN) {
            log(`would ABORT: ${msg} - continuing, dry run`);
            lastPresent = false;
          } else {
            log(`ABORT: ${msg}`);
            report();
            process.exit(EXIT_ABORTED);
          }
        }
      }
    }

    const wait = config.nextInterval(cfg);
    if (VERBOSE) log(`next check in ${wait}ms`);
    await sleep(wait);
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
