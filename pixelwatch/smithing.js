// Smithing: watch one pixel and notify when it goes. Keeps running. Never clicks.
//
//   node smithing.js               -> run until Ctrl+C
//   node smithing.js --verbose     -> log every check, not just changes
//   node smithing.js --dry-run     -> never actually notify
//   node smithing.js --once        -> single check, print the result, exit
//   node smithing.js --test-notify -> send one push and exit
//
// The alarm latches, so a pixel that stays missing does not keep pushing:
//
//   armed  + pixel missing -> push once, and disarm
//   fired  + pixel missing -> silent, however long it lasts
//   fired  + pixel back    -> re-arm, ready to push again next time
//
// It starts armed, so a pixel that is already missing at startup pushes once.
//
// "Missing" means the colour at the configured pixel differs from the
// calibrated colour by more than `tolerance` on any channel.
//
// Exit codes: 0 normal stop (Ctrl+C, --once), 1 config or startup error.
// A missing pixel never exits - that is the whole point.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { screen, Point } = require("@nut-tree-fork/nut-js");
const config = require("./config-smithing.js");

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const DRY_RUN = args.includes("--dry-run");
const ONCE = args.includes("--once");
const TEST_NOTIFY = args.includes("--test-notify");

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

(async () => {
  // Checked before the full load, so delivery can be verified before the pixel
  // has been calibrated.
  if (TEST_NOTIFY) {
    const notify = config.loadNotify();
    if (!notify.url) {
      console.error("notify.url is empty in config-smithing.json - nothing to test");
      process.exit(1);
    }
    console.log(`Sending a test notification to ${notify.url} ...`);
    const res = await sendNotification(notify, {
      message: "Test from smithing. If you can read this on your " +
               "phone, smithing alerts will reach you.",
      priority: "default",
      tags: "white_check_mark",
    });
    console.log(res.ok
      ? `delivered -> HTTP ${res.status}`
      : `FAILED: ${res.error || "HTTP " + res.status}`);
    process.exit(res.ok ? 0 : 1);
  }

  cfg = config.load();
  const target = new Point(cfg.x, cfg.y);

  const readPixel = async () => {
    const c = await screen.colorAt(target);
    const actual = { r: c.R, g: c.G, b: c.B };
    return { actual, present: config.matches(actual, cfg.color, cfg.tolerance) };
  };

  const fixedRate = cfg.intervalMinMs === cfg.intervalMaxMs;
  console.log(
    `Alarm on (${cfg.x}, ${cfg.y}) expecting ${config.toHex(cfg.color)} ` +
    `+/-${cfg.tolerance}, ` +
    (fixedRate
      ? `every ${cfg.intervalMinMs}ms`
      : `every ${cfg.intervalMinMs}-${cfg.intervalMaxMs}ms (random)`)
  );
  console.log(
    `If it goes: notify ${cfg.notify.url || "(disabled)"} once, then stay quiet ` +
    `until it returns${DRY_RUN ? "   [DRY RUN - no pushes sent]" : ""}`
  );
  console.log("Keeps running either way. No clicks are ever sent.");
  console.log("Ctrl+C to stop.\n");

  let checks = 0, alerts = 0, rearms = 0, failures = 0;
  // Armed means a miss would fire. Starts armed so an already-missing pixel
  // pushes once at startup.
  let armed = true;
  let lastPresent = null;

  const report = () => {
    console.log(
      `\n${checks} checks, ${alerts} alerts sent` +
      (failures ? `, ${failures} failed` : "") +
      `, ${rearms} times re-armed` +
      `, currently ${armed ? "armed" : "fired (waiting for the pixel to return)"}`
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
      log(`${config.toHex(actual)} ${present ? "present" : "MISSING"}` +
          `${VERBOSE ? (armed ? "  [armed]" : "  [fired]") : ""}`);
    } else if (present !== lastPresent) {
      // lastPresent is null on the first check: it is not "back", it is just
      // the first look.
      const first = lastPresent === null;
      log(present
        ? `pixel ${first ? "present" : "back"} (${config.toHex(actual)})`
        : `pixel MISSING (${config.toHex(actual)}, want ${config.toHex(cfg.color)})`);
    }
    lastPresent = present;

    if (ONCE) {
      console.log(present
        ? "Result: pixel PRESENT - armed, no alert."
        : "Result: pixel MISSING - would notify once, then keep running.");
      process.exit(0);
    }

    if (!present && armed) {
      // Edge: armed -> fired. This is the only place a push goes out.
      const why =
        `pixel at (${cfg.x}, ${cfg.y}) disappeared - got ` +
        `${config.toHex(actual)}, want ${config.toHex(cfg.color)}`;
      armed = false;

      if (DRY_RUN) {
        alerts++;
        log(`would ALARM: ${why} - dry run, staying quiet until it returns`);
      } else {
        log(`ALARM: ${why}`);
        const res = await sendNotification(cfg.notify, {
          message: `Smithing: ${why}`,
          tags: "rotating_light",
        });
        if (res.skipped) {
          log("notify skipped (notify.url is empty)");
        } else if (res.ok) {
          alerts++;
          log(`notified -> HTTP ${res.status}. Quiet until the pixel returns.`);
        } else {
          failures++;
          log(`notify FAILED: ${res.error || "HTTP " + res.status}`);
        }
      }
    } else if (present && !armed) {
      // Edge: fired -> armed. Ready to fire again on the next miss.
      armed = true;
      rearms++;
      log("re-armed (pixel is back)");
    }

    const wait = config.nextInterval(cfg);
    if (VERBOSE) log(`next check in ${wait}ms`);
    await sleep(wait);
  }
})().catch(async (err) => {
  console.error(err.message);
  // Only possible once the config has loaded; a config error has no url yet.
  if (cfg && cfg.notify && cfg.notify.url) {
    await sendNotification(cfg.notify, {
      message: `Smithing crashed: ${err.message}`,
      tags: "rotating_light",
    });
  }
  process.exit(1);
});
