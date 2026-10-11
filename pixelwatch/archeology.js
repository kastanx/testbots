// Archeology: three sections of pixel checks driving the two servos.
//
//   node archeology.js             -> run until Ctrl+C
//   node archeology.js --verbose   -> log every check, not just actions
//   node archeology.js --dry-run   -> never open the servo port; log what it would do
//   node archeology.js --once      -> read every pixel, print what each section would do, exit
//
// Each section runs on its own check interval:
//
//   1. hold      every 500-1000 ms - at least 27 of the 28 A blocks missing (at
//                                   most one left) AND B present -> servo 1
//                                   holds button 2 (126) until B goes missing,
//                                   at most 5 s. While holding, ONLY B is
//                                   checked, every 100-150 ms: sections 2 and 3
//                                   don't look at the screen at all. Then
//                                   checking resumes.
//   2. button1   every 100-150 ms  - C missing (all of its variations) AND D
//                                   present -> servo 1 taps button 1 (5), then
//                                   no checks for 3-5 s
//   3. servo2    every 3-5 s       - E present -> servo 2 taps
//
// E goes first: when section 1 is about to hold or section 2 is about to tap,
// E is checked right then, and if it's present servo 2 taps - and finishes -
// before the hold or the tap goes ahead. After such a tap the hold checks A
// and B again before pressing, and section 2 checks C and D again before
// tapping. A section that isn't about to act doesn't check E. Section 3's own
// 3-5 s check of E runs as well, unchanged.
//
// A tap goes to the angle, holds tap.holdMs, returns to the middle of the
// range and waits tap.gapMs. Both servos rest at the middle.
//
// Servo moves run one at a time: a tap finishes before the next tap or a hold
// starts, and the two servos never move at the same time (both at once can
// pull more than USB gives and restart the Arduino). A hold cancels every
// section 2 and 3 tap whose pixels were read before it was decided, and it
// checks A and B again right before pressing.
//
// If the condition still holds when a hold ends at the 5 s limit, the next
// check 500-1000 ms later starts a new hold.
//
// Checks start their interval apart, measured start to start; when an action
// runs longer, the next check starts as soon as it ends. After a hold, the next
// section 1 check is one interval after the release; after a button 1 tap, the
// next section 2 check is one cooldown after the tap.
//
// Each A control is the 10x10 block around its calibrated point, and counts as
// present only when every one of its 100 pixels matches the calibration
// (blockMatchPercent, default 100) - any change inside the block makes it
// missing.
//
// B and C can each have several variations (add-b-archeology.js and add-c-archeology.js
// add them): the group counts as present when ANY of its variations is
// present, and as missing only when all of them are. That goes for every check
// of it - for B starting a hold, just before pressing, and while holding; for C
// the button 1 tap.
//
// Pixels: single ones with a 1x1 screen grab (~7 ms); the 28 A blocks with one
// grab of the area around them (~7 ms for an inventory-sized area).
//
// Only one program can hold the Arduino's COM port, so close the other
// watchers, servo-cli.js and the servo web page first.
//
// Exit codes: 0 normal stop (Ctrl+C, --once), 1 config or startup error.

const { screen, Region, ColorMode } = require("@nut-tree-fork/nut-js");
const config = require("./config-archeology.js");

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const DRY_RUN = args.includes("--dry-run");
const ONCE = args.includes("--once");

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
// True from the moment section 1 decides to hold until it has released.
// Sections 2 and 3 do nothing while it's set.
let holding = false;
// How many times section 1 has decided to hold. A section 2 or 3 tap is
// dropped if a hold was decided after its pixels were read - even once that
// hold is over, since those pixels are from before it.
let holdDecisions = 0;

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

// Present when any pixel in `list` (a group's variations) is. Reads them in
// order and stops at the first one present.
async function readAny(list) {
  for (let i = 0; i < list.length; i++) {
    const r = await readOne(list[i]);
    if (r.present) return { present: true, which: i, actual: r.actual };
  }
  return { present: false, which: -1 };
}

const countMissing = (reads) => reads.filter((r) => !r.present).length;

// All the blocks in `list` from one grab of the area around them. A block is
// present when at least blockMatchPercent of its pixels match.
function blockReader(list) {
  const n = config.BLOCK;
  const from = config.BLOCK_FROM;
  const xs = list.map((p) => p.x);
  const ys = list.map((p) => p.y);
  const left = Math.min(...xs) + from;
  const top = Math.min(...ys) + from;
  const w = Math.max(...xs) + from + n - left;
  const h = Math.max(...ys) + from + n - top;
  const need = Math.ceil((n * n * cfg.blockMatchPercent) / 100);
  const tol = cfg.tolerance;
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
  cfg = config.load();
  const px = cfg.pixels;
  const Bs = px.B;   // B's variations
  const Cs = px.C;   // C's variations
  const [D] = px.D, [E] = px.E;
  const readA = blockReader(px.A);
  const readB = () => readAny(Bs);
  const readC = () => readAny(Cs);
  // A read of a variations group for the log: which variation was present.
  const anyText = (key, list) => (r) => (r.present
    ? `present (${key}${r.which + 1} ${config.toHex(r.actual)})`
    : list.length > 1 ? `missing (all ${list.length} variations)` : "missing");
  const bText = anyText("B", Bs);
  const cText = anyText("C", Cs);

  const stats = { holds: 0, holdEnds: {}, button1Taps: 0, servo2Taps: 0, eFirstTaps: 0, failures: 0 };
  const report = () => {
    const ends = Object.entries(stats.holdEnds).map(([k, v]) => `${v} ${k}`).join(", ");
    console.log(
      `\n${stats.holds} holds${ends ? ` (${ends})` : ""}, ` +
      `${stats.button1Taps} button 1 taps, ${stats.servo2Taps} servo 2 taps` +
      (stats.eFirstTaps ? ` (${stats.eFirstTaps} of them E-first)` : "") +
      (stats.failures ? `, ${stats.failures} failed` : "")
    );
  };

  console.log("Control pixels:");
  console.log(`  A: ${px.A.length} blocks of ${config.BLOCK}x${config.BLOCK}, present when ` +
              (cfg.blockMatchPercent === 100 ? "all" : `${cfg.blockMatchPercent}%`) + " of a block's pixels match");
  for (const [k, list] of [["B", Bs], ["C", Cs]]) {
    console.log(`  ${k}: ${list.length} variation${list.length > 1 ? "s - present when any one of them is" : ""}`);
    list.forEach((p, i) => console.log(`     ${k}${i + 1}: (${p.x}, ${p.y}) ${config.toHex(p.color)}`));
  }
  for (const [k, p] of [["D", D], ["E", E]]) {
    console.log(`  ${k}: (${p.x}, ${p.y}) ${config.toHex(p.color)}`);
  }
  console.log(`Tolerance +/-${cfg.tolerance}`);
  console.log(
    `1. hold     every ${cfg.hold.intervalMinMs}-${cfg.hold.intervalMaxMs}ms: ` +
    `${cfg.hold.minAMissing}+ of ${px.A.length} A missing + B present ` +
    `-> servo 1 holds button 2 (${cfg.servo1.button2Angle} deg) until B missing ` +
    `(checked every ${cfg.hold.releaseCheckMinMs}-${cfg.hold.releaseCheckMaxMs}ms), max ${cfg.hold.maxHoldMs}ms`
  );
  console.log(
    `2. button1  every ${cfg.button1Tap.intervalMinMs}-${cfg.button1Tap.intervalMaxMs}ms: C missing + D present ` +
    `-> servo 1 taps button 1 (${cfg.servo1.button1Angle} deg), ` +
    `then ${cfg.button1Tap.cooldownMinMs}-${cfg.button1Tap.cooldownMaxMs}ms cooldown`
  );
  console.log(
    `3. servo2   every ${cfg.servo2Tap.intervalMinMs}-${cfg.servo2Tap.intervalMaxMs}ms: E present ` +
    `-> servo 2 taps (${cfg.servo2.tapAngle} deg)` + (DRY_RUN ? "   [DRY RUN - port not opened]" : "")
  );
  console.log("E first: before a 1. hold or a 2. tap, if E is present servo 2 taps first, then the hold/tap");
  console.log("Ctrl+C to stop (centers both servos first).\n");

  if (ONCE) {
    const a = await readA();
    const aMissing = countMissing(a);
    const aEnough = aMissing >= cfg.hold.minAMissing;
    // Every B and C variation, to show each one.
    const readAll = async (list) => { const out = []; for (const p of list) out.push(await readOne(p)); return out; };
    const bs = await readAll(Bs);
    const cs = await readAll(Cs);
    const b = { present: bs.some((r) => r.present) };
    const c = { present: cs.some((r) => r.present) };
    const [d, e] = [await readOne(D), await readOne(E)];
    const s = (r) => `${config.toHex(r.actual)} ${r.present ? "present" : "missing"}`;
    const presentList = a.map((r, i) => (r.present ? `A${i + 1}` : null)).filter(Boolean);
    log(`  A: ${aMissing}/${px.A.length} missing - ` +
        (presentList.length ? `present: ${presentList.join(" ")}` : "none present"));
    log(`  B ${b.present ? "PRESENT" : "MISSING"}: ` + bs.map((r, i) => `B${i + 1} ${s(r)}`).join("   "));
    log(`  C ${c.present ? "PRESENT" : "MISSING"}: ` + cs.map((r, i) => `C${i + 1} ${s(r)}`).join("   "));
    log(`  D ${s(d)}   E ${s(e)}`);
    console.log("");
    const first = e.present ? " - E present, so servo 2 taps first" : "";
    console.log(aEnough && b.present
      ? `1. hold:    ${aMissing}/${px.A.length} A missing and B present - would hold button 2${first}.`
      : "1. hold:    no hold (" +
        (aEnough ? "B missing" : `only ${aMissing}/${px.A.length} A missing, needs ${cfg.hold.minAMissing}`) + ").");
    console.log(!c.present && d.present
      ? `2. button1: C missing and D present - would tap button 1${first}.`
      : "2. button1: no tap.");
    console.log(e.present ? "3. servo2:  E present - would tap servo 2." : "3. servo2:  no tap.");
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
      const wanted = [
        [1, st1, cfg.servo1.button1Angle, "button 1"],
        [1, st1, cfg.servo1.button2Angle, "button 2"],
        [2, st2, cfg.servo2.tapAngle, "tap"],
      ];
      log(`servo 1 on ${board.path} pin ${st1.pin}: limits ${st1.lo}-${st1.hi}, center ${st1.range / 2} deg`);
      log(`servo 2 on ${board.path} pin ${st2.pin}: limits ${st2.lo}-${st2.hi}, center ${st2.range / 2} deg`);
      for (const [n, st, a, what] of wanted) {
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
      // servo.js sends commands in call order, so these land after anything
      // already queued - including releasing a hold.
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
  // return when to run next: one interval after a hold, a cooldown after a tap.
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

  // E goes first: called inside withServos() when section 1 is about to hold
  // or section 2 is about to tap. If E is present, servo 2 taps - and finishes -
  // before they go ahead. True if it tapped.
  async function eFirst(who) {
    const e = await readOne(E);
    if (VERBOSE) log(`[${who}] E first: ${config.toHex(e.actual)} ${e.present ? "present" : "missing"}`);
    if (!e.present) return false;
    const out = await tap(2, cfg.servo2.tapAngle);
    stats.servo2Taps++;
    stats.eFirstTaps++;
    log(`[${who}] E present - servo 2 tapped first` +
        (out && out.clamped ? ` (CLAMPED to ${out.target})` : "") + (DRY_RUN ? " (dry run)" : ""));
    return true;
  }

  // Section 1: at least minAMissing of A missing + B present -> hold button 2
  // until B goes missing.
  const holdSection = section(cfg.hold, async () => {
    const b = await readB();
    if (VERBOSE) log(`[hold] B ${bText(b)}`);
    if (!b.present) return;
    const missing = countMissing(await readA());
    if (VERBOSE) log(`[hold] A ${missing}/${px.A.length} missing`);
    if (missing < cfg.hold.minAMissing) return;

    // From here until the release, sections 2 and 3 stand still.
    holding = true;
    holdDecisions++;
    try {
      await withServos(async () => {
        if (shuttingDown) return;
        if (!(await ensureBoard())) {
          log("[hold] servo board not connected - can't hold");
          return;
        }
        await eFirst("hold");
        if (shuttingDown) return;
        // A tap may have been running while this waited its turn, or E may
        // just have been tapped; check the whole condition again rather than
        // press for a screen that's gone.
        const bNow = await readB();
        if (!bNow.present) {
          if (VERBOSE) log("[hold] B went missing before the hold could start - no hold");
          return;
        }
        const nowMissing = countMissing(await readA());
        if (nowMissing < cfg.hold.minAMissing) {
          if (VERBOSE) {
            log(`[hold] A pixels came back (${nowMissing}/${px.A.length} missing) ` +
                "before the hold could start - no hold");
          }
          return;
        }
        await restIfNeeded();
        log(`[hold] ${nowMissing}/${px.A.length} A missing and B ${bText(bNow)} - ` +
            `servo 1 holds button 2 (${cfg.servo1.button2Angle} deg)`);
        await move(1, cfg.servo1.button2Angle);
        stats.holds++;
        const until = performance.now() + cfg.hold.maxHoldMs;
        let lastCheck = performance.now();
        let why = null;
        while (!why) {
          const gap = config.randomBetween(cfg.hold.releaseCheckMinMs, cfg.hold.releaseCheckMaxMs);
          await sleepUntil(Math.min(lastCheck + gap, until));
          if (shuttingDown) return;
          if (performance.now() >= until) {
            why = `${cfg.hold.maxHoldMs / 1000}s limit`;
            break;
          }
          if (restNeeded) {
            // The Arduino restarted mid-hold: press again.
            await move(1, cfg.servo1.button2Angle);
            await move(2, "center");
            restNeeded = false;
            log("[hold] pressed button 2 again after the restart");
          }
          lastCheck = performance.now();
          const bb = await readB();
          if (VERBOSE) log(`[hold]   B ${bText(bb)}`);
          if (!bb.present) why = "B missing";
        }
        await move(1, "center");
        stats.holdEnds[why] = (stats.holdEnds[why] || 0) + 1;
        log(`[hold] released (${why}) - checking again`);
      });
    } finally {
      holding = false;
    }
    return performance.now() + config.randomIn(cfg.hold);
  });

  // Section 2: C missing (all its variations) + D present -> tap button 1, then
  // cool down.
  const button1Section = section(cfg.button1Tap, async () => {
    if (holding) return;
    const decisions = holdDecisions;
    const c = await readC();
    const d = await readOne(D);
    if (VERBOSE) {
      log(`[button1] C ${cText(c)}, D ${config.toHex(d.actual)} ${d.present ? "present" : "missing"}`);
    }
    if (c.present || !d.present) return;
    return withServos(async () => {
      if (holdDecisions !== decisions || shuttingDown) return;   // a hold got in first
      if (!(await ensureBoard())) {
        stats.failures++;
        log("[button1] servo board not connected - no tap");
        return;
      }
      if (await eFirst("button1")) {
        // That took a while: a hold decided meanwhile goes next, and C and D
        // may have changed - check them again before tapping.
        if (holdDecisions !== decisions || shuttingDown) {
          if (VERBOSE) log("[button1] a hold was decided meanwhile - no tap");
          return;
        }
        const c2 = await readC();
        const d2 = await readOne(D);
        if (c2.present || !d2.present) {
          if (VERBOSE) log(`[button1] after E: C ${cText(c2)}, D ${d2.present ? "present" : "missing"} - no tap`);
          return;
        }
      }
      const out = await tap(1, cfg.servo1.button1Angle);
      stats.button1Taps++;
      // Measured from the end of the tap.
      const cooldown = config.randomBetween(cfg.button1Tap.cooldownMinMs, cfg.button1Tap.cooldownMaxMs);
      log(`[button1] C missing and D present - servo 1 tapped button 1` +
          (out && out.clamped ? ` (CLAMPED to ${out.target})` : "") + (DRY_RUN ? " (dry run)" : "") +
          ` - next check in ${(cooldown / 1000).toFixed(1)}s`);
      return performance.now() + cooldown;
    });
  });

  // Section 3: E present -> tap servo 2.
  const servo2Section = section(cfg.servo2Tap, async () => {
    if (holding) return;
    const decisions = holdDecisions;
    const e = await readOne(E);
    if (VERBOSE) log(`[servo2] E ${config.toHex(e.actual)} ${e.present ? "present" : "missing"}`);
    if (!e.present) return;
    await withServos(async () => {
      if (holdDecisions !== decisions || shuttingDown) return;   // a hold got in first
      if (!(await ensureBoard())) {
        stats.failures++;
        log("[servo2] servo board not connected - no tap");
        return;
      }
      const out = await tap(2, cfg.servo2.tapAngle);
      stats.servo2Taps++;
      log(`[servo2] E present - servo 2 tapped` +
          (out && out.clamped ? ` (CLAMPED to ${out.target})` : "") + (DRY_RUN ? " (dry run)" : ""));
    });
  });

  await Promise.all([holdSection, button1Section, servo2Section]);
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
