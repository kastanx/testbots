// Tap the servos through a fixed sequence of three pixels.
//
//   node watch-taps.js             -> run until Ctrl+C
//   node watch-taps.js --verbose   -> log every check, not just steps
//   node watch-taps.js --dry-run   -> never open the servo port; log what it would do
//   node watch-taps.js --once      -> read all three, print what would happen, exit
//
// A sequence, one step at a time:
//
//   step 1: wait for pixel 1 -> servo 1 taps                             -> step 2
//   step 2: wait for pixel 2 -> servo 2 taps                             -> step 3
//   step 3: wait for pixel 3 -> wait 500-1000 ms -> servo 2 taps twice -> back to step 1
//
// The step 3 wait is a fresh random value each time (step3Delay in the config).
//
// Each check looks only at the current step's pixel. A pixel showing out of
// turn does nothing: pixel 3 on screen during step 1 is ignored until the
// sequence reaches step 3. A step only advances once all of its taps went
// through; a failed tap is retried on the next check.
//
// A tap sends the servo to its tapAngle (servo 1: 5, servo 2: 0), holds
// tap.holdMs, then brings it back to the middle of its range and waits
// tap.gapMs. Both servos rest at the middle, and never move at the same time.
//
// Checks start 100-150 ms apart (a fresh random value each time). When a step's
// taps take longer than that, the next check starts as soon as they end.
//
// Nothing pauses and nothing exits on pixel state; only Ctrl+C stops it, after
// centering both servos.
//
// Pixels are read with a 1x1 screen grab: the same value as nut.js colorAt(),
// but about 7 ms instead of about 55 ms.
//
// Only one program can hold the Arduino's COM port, so close watch3v2.js,
// mining_old.js, servo-cli.js and the servo web page first.
//
// Exit codes: 0 normal stop (Ctrl+C, --once), 1 config or startup error.

const { screen, Region, ColorMode } = require("@nut-tree-fork/nut-js");
const config = require("./config-taps.js");

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const DRY_RUN = args.includes("--dry-run");
const ONCE = args.includes("--once");

// The sequence, in order; after the last step it starts again at the first.
// `delay` names a { minMs, maxMs } config entry to wait between the pixel
// appearing and the taps.
const STEPS = [
  { spot: 0, servo: 1, taps: 1 },
  { spot: 1, servo: 2, taps: 1 },
  { spot: 2, servo: 2, taps: 2, delay: "step3Delay" },
];

const describeStep = (n) => {
  const s = STEPS[n];
  const d = s.delay && cfg ? cfg[s.delay] : null;
  return `step ${n + 1}: waiting for pixel ${s.spot + 1} (then ` +
         (d ? `${d.minMs}-${d.maxMs} ms, then ` : "") +
         `servo ${s.servo} taps${s.taps > 1 ? ` ${s.taps} times` : ""})`;
};

// How often to try reopening the board's COM port after losing it.
const RECONNECT_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// setTimeout on Windows can fire up to one system timer tick (~16 ms) late,
// which would push checks past 150 ms apart. Sleep to just short of the
// target, then finish on the event loop's own turns, which are precise.
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
let restNeeded = true;     // both servos to be sent to the middle before the next tap
let nextReconnectAt = 0;
let shuttingDown = false;

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
    log("servos: the Arduino restarted - centering both again");
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
  restNeeded = true;
  log(`servo board reconnected on ${board.path}`);
  return true;
}

// Both servos to the middle of their range: at startup, and again after a
// restart or a reconnect.
async function restServos() {
  if (!restNeeded || shuttingDown) return;
  if (DRY_RUN) {
    log("would center both servos (dry run)");
    restNeeded = false;
    return;
  }
  if (!(await ensureBoard())) return;
  try {
    await Promise.all([board.servo(1).center(), board.servo(2).center()]);
    restNeeded = false;
    log("both servos centered (rest)");
  } catch (err) {
    log(`centering failed: ${err.code || "error"}: ${err.message}`);
    if (err.code === "CLOSED") boardLost(err.message);
  }
}

// One tap: to the tap angle, hold, back to the middle, gap.
async function tap(n) {
  const angle = n === 1 ? cfg.servo1.tapAngle : cfg.servo2.tapAngle;
  if (DRY_RUN) {
    log(`would tap servo ${n} (${angle} deg, back to center) (dry run)`);
    return { ok: true };
  }
  if (!(await ensureBoard())) return { ok: false, error: "servo board not connected" };
  const s = board.servo(n);
  try {
    const out = await s.angle(angle, { wait: true });
    // With the firmware at full speed a move "finishes" at once while the
    // servo is still travelling, so holdMs also covers the travel there...
    await sleep(cfg.tap.holdMs);
    await s.center({ wait: true });
    // ...and gapMs the travel back.
    await sleep(cfg.tap.gapMs);
    return { ok: true, at: out.target, clamped: !!out.clamped };
  } catch (err) {
    if (err.code === "CLOSED") boardLost(err.message);
    return { ok: false, error: `${err.code || "error"}: ${err.message}` };
  }
}

(async () => {
  cfg = config.load();

  // nut.js grabs in BGR(A) by default. The top-left pixel of a 1x1 grab is
  // the value colorAt() reports, including on a DPI-scaled display.
  const readSpot = async (i) => {
    const spot = cfg.spots[i];
    const img = await screen.grabRegion(new Region(spot.x, spot.y, 1, 1));
    const d = img.data;
    const actual = img.colorMode === ColorMode.RGB
      ? { r: d[0], g: d[1], b: d[2] }
      : { r: d[2], g: d[1], b: d[0] };
    return { actual, present: config.matches(actual, spot.color, cfg.tolerance) };
  };

  console.log("Sequence of three pixels:");
  config.SPOTS.forEach((s, i) => {
    const spot = cfg.spots[i];
    console.log(`  ${i + 1}. (${spot.x}, ${spot.y}) ${config.toHex(spot.color)}  - ${s.rule}`);
  });
  console.log(
    `Tolerance +/-${cfg.tolerance}, checks start every ` +
    `${cfg.intervalMinMs}-${cfg.intervalMaxMs}ms (random)`
  );
  console.log(
    `Tap: servo 1 to ${cfg.servo1.tapAngle} deg, servo 2 to ${cfg.servo2.tapAngle} deg; ` +
    `hold ${cfg.tap.holdMs}ms, back to center, gap ${cfg.tap.gapMs}ms` +
    (DRY_RUN ? "   [DRY RUN - port not opened]" : "")
  );
  console.log(
    `Step 3 waits ${cfg.step3Delay.minMs}-${cfg.step3Delay.maxMs}ms (random) ` +
    "between pixel 3 appearing and the double tap"
  );
  console.log("Ctrl+C to stop (centers both servos first).\n");

  if (ONCE) {
    const present = [];
    for (let i = 0; i < STEPS.length; i++) {
      const r = await readSpot(STEPS[i].spot);
      present.push(r.present);
      log(`  pixel ${i + 1} ${config.toHex(r.actual)} ${r.present ? "present" : "missing"}`);
    }
    console.log("");
    console.log(present[0]
      ? "Result: the sequence starts at step 1 - pixel 1 is present, so servo 1 would tap now and it would move to step 2."
      : "Result: the sequence starts at step 1 - pixel 1 is missing, so it would wait for pixel 1.");
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
      for (const [n, st, a] of [[1, st1, cfg.servo1.tapAngle], [2, st2, cfg.servo2.tapAngle]]) {
        log(`servo ${n} on ${board.path} pin ${st.pin}: at ${st.pos} deg, limits ${st.lo}-${st.hi}, ` +
            `center ${st.range / 2} deg`);
        if (a < st.lo || a > st.hi) {
          log(`WARNING: servo ${n} tap angle ${a} is outside the firmware limits ` +
              `${st.lo}-${st.hi} and will be clamped`);
        }
      }
    } catch (err) {
      log(`servo status unavailable: ${err.message}`);
    }
  }

  let current = 0;   // index into STEPS
  let checks = 0, failures = 0, rounds = 0;
  const taps = { 1: 0, 2: 0 };

  const report = () => {
    console.log(
      `\n${checks} checks, ${rounds} full sequences, servo 1 tapped ${taps[1]}x, ` +
      `servo 2 tapped ${taps[2]}x` + (failures ? `, ${failures} taps failed` : "") +
      `; stopped at ${describeStep(current)}`
    );
  };

  process.on("SIGINT", async () => {
    if (shuttingDown) process.exit(0);   // a second Ctrl+C leaves at once
    shuttingDown = true;
    if (board) {
      log("stopping - centering both servos first");
      // servo.js sends commands in call order, so these land after anything
      // the loop already queued.
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

  log(describeStep(current));

  while (!shuttingDown) {
    const started = performance.now();
    checks++;
    await restServos();

    const step = STEPS[current];
    let r = null;
    try {
      r = await readSpot(step.spot);
    } catch (err) {
      log(`could not read pixel ${step.spot + 1}: ${err.message}`);
    }

    if (r && VERBOSE) {
      log(`  step ${current + 1}: pixel ${step.spot + 1} ${config.toHex(r.actual)} ` +
          `${r.present ? "present" : "missing"}`);
    }

    if (r && r.present && !shuttingDown) {
      log(`step ${current + 1}: pixel ${step.spot + 1} present (${config.toHex(r.actual)})`);
      if (step.delay) {
        const d = cfg[step.delay];
        const ms = d.minMs + Math.floor(Math.random() * (d.maxMs - d.minMs + 1));
        log(`  waiting ${ms} ms before servo ${step.servo} taps`);
        await sleepUntil(performance.now() + ms);
      }
      let allOk = true;
      for (let k = 0; k < step.taps && !shuttingDown; k++) {
        const res = await tap(step.servo);
        if (res.ok) {
          taps[step.servo]++;
          if (!DRY_RUN) {
            log(`  servo ${step.servo} tap` + (step.taps > 1 ? ` ${k + 1}/${step.taps}` : "") +
                (res.clamped ? ` (angle CLAMPED to ${res.at} by the firmware's limits)` : ""));
          }
        } else {
          failures++;
          allOk = false;
          log(`  servo ${step.servo} tap FAILED: ${res.error} - staying on step ${current + 1}`);
          break;
        }
      }
      if (allOk && !shuttingDown) {
        current = (current + 1) % STEPS.length;
        if (current === 0) rounds++;
        log(describeStep(current));
      }
    }

    // Next check 100-150 ms after this one started; right away if the taps
    // already took longer than that.
    await sleepUntil(started + config.nextInterval(cfg));
  }
})().catch(async (err) => {
  console.error(err.message);
  // Best effort: leave both servos at rest rather than wherever they were.
  if (board) {
    try {
      await Promise.all([board.servo(1).center(), board.servo(2).center()]);
      await board.close();
    } catch { /* already failing */ }
  }
  process.exit(1);
});
