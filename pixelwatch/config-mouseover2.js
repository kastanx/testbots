// Config for mouseover2.js / calibrate-mouseover2.js - the fill/dump version
// of mouseover. Its own file: mouseover's config is never read or written.
//
// The inventory is read about every second, and the clicks follow two phases:
//
//   filling   full (28), or pixel A appears         -> click the crater, dumping
//             items still coming in                 -> nothing
//             none for 6-10 s:
//               24 or more occupied                 -> click the crater, dumping
//               fewer                               -> click a wisp
//   dumping   pixels B and C both missing           -> nothing left to dump:
//                                                      click a wisp, filling
//             items still going out                 -> nothing
//             none for 2-4 s:
//               fewer than emptyBelow left          -> click a wisp, filling
//               more left                           -> click the crater again
//
// B and C both missing means there's nothing to dump, however many spaces are
// occupied - so nothing goes to the crater then. While either is there, there
// is.
//
// After a click nothing else is clicked until the inventory starts moving the
// right way - filling after a wisp, emptying after the crater - or 5-10 s pass
// without that (afterClick), which counts as a failed click and is clicked
// again. That leaves time to walk there, so a target isn't clicked twice on
// the way. Every range is drawn anew each time: after each item for the quiet
// spells, at each click for the waits.
//
// Wisps can move. Before a wisp click the detector is looked at a few times
// (wisps), each wisp is followed across the looks, and one standing still -
// measured against the crater, which doesn't move - is preferred. If all of
// them move, the nearest is aimed at where it will be when the click lands.
// On the way there the wisp is followed in every detector frame and the path
// bent toward it when it sets off or the view slides (wisps.track).
//
// Pixels A, B and C are stored here, in config-mouseover2.json
// (calibrate-mouseover2.js makes them). The 28 inventory spaces are NOT:
// they're archeology's A blocks, read from config-archeology.json and never
// written.

const fs = require("fs");
const path = require("path");
const arch = require("./config-archeology.js");

// PIXELWATCH_CONFIG_MOUSEOVER2 points at another file instead, so a test run
// never touches the real one. PIXELWATCH_CONFIG_ARCHEOLOGY does the same for
// the inventory spaces.
const CONFIG_PATH =
  process.env.PIXELWATCH_CONFIG_MOUSEOVER2 || path.join(__dirname, "config-mouseover2.json");

const GROUPS = [
  { key: "A", label: "A", count: 1,
    rule: "appears while filling -> click the crater and dump, like a full inventory" },
  { key: "B", label: "B", count: 1,
    rule: "B and C both missing -> nothing left to dump: back to the wisps" },
  { key: "C", label: "C", count: 1,
    rule: "B and C both missing -> nothing left to dump: back to the wisps" },
];

const DEFAULTS = {
  // { A, B, C: [{ x, y, color }] } in LOGICAL screen coordinates.
  pixels: {},
  // Max per-channel difference still counted as a match for pixels A, B and C
  // (0-255). The inventory spaces are judged with archeology's own tolerance
  // and blockMatchPercent, exactly as archeology judges them.
  tolerance: 12,
  inventory: {
    // Readings start this far apart.
    intervalMinMs: 1000, intervalMaxMs: 1500,
    // This many of the 28 spaces occupied, or more, on two readings in a row:
    // full - dump.
    fullAt: 28,
    // When filling stops with this many occupied or more (but not full),
    // dump instead of starting another wisp.
    dumpEarlyAt: 24,
    // Fewer than this many occupied, on two readings in a row, once nothing
    // more goes out: emptied - fill again.
    emptyBelow: 4,
    // No item added for this long (random between the two, drawn anew after
    // every item): filling has stopped.
    fillingQuietMinMs: 6000, fillingQuietMaxMs: 10000,
    // No item removed for this long (likewise): dumping has stopped.
    emptyingQuietMinMs: 2000, emptyingQuietMaxMs: 4000,
  },
  // After a click, how long the inventory has to start moving - the walk there
  // and the first item. Random between the two, drawn anew at every click.
  // Past it the click counts as failed and is made again.
  //   wisp:   items have to start coming in  (the start of filling)
  //   crater: items have to start going out  (the start of dumping)
  afterClick: { wispMinMs: 5000, wispMaxMs: 10000, craterMinMs: 5000, craterMaxMs: 10000 },
  // Picking a wisp. The detector is looked at `looks` times, lookGapMs apart,
  // and each wisp followed across the looks - the nearest wisp within matchPx
  // of where it was. Slower than stillPxPerSec counts as standing still,
  // measured against the crater when it's in view (so camera moves don't
  // count), on screen otherwise. The nearest still wisp is clicked; if none
  // stands still, the nearest one, and with `lead` on it's met where it's
  // going: the path aims leadMarginMs of its movement further along than the
  // press could reach (at most maxLeadPx ahead), and is held back - up to
  // maxWaitMs - so the press lands just as the wisp gets there. "Going" is on
  // screen: a wisp still against the crater while the view slides (the
  // character walking) is aimed ahead too. A look counts from when its frame
  // was taken: detectorLagMs before the detector's answer (it measured 18 ms
  // from the screen grab to its result, 30 at worst).
  //
  // With `track` on, the wisp is followed while the path plays: the detector
  // is asked every pollMs, and each new frame is used, from the moment the
  // path is sent until steerMinMs before the press. The wisp is looked for
  // within followPx of where it should be - the crater in that frame plus the
  // wisp's own place against it - and its own movement and the crater's are
  // each fitted over the last followWindowMs. When the press would land over
  // steerPx off where the wisp will be by then, the rest of the path is bent
  // there (the Pi's /steer), at no more than steerPxPerMs on average; the Pi
  // holds the press back when the bend needs longer than is left. Lost for
  // lostMs: the nearest wisp within retrackPx is followed instead; no wisp at
  // all for lostMs: the click is called off. piStartMs is how long the Pi
  // takes from a request to the first move (measured 31-55 ms over WiFi) - for
  // aiming ahead, and while following until the Pi says where it is.
  wisps: {
    looks: 4, lookGapMs: 120, matchPx: 60, stillPxPerSec: 40,
    lead: true, maxLeadPx: 300, leadMarginMs: 150, maxWaitMs: 800,
    track: true, pollMs: 8, followPx: 45, followWindowMs: 200, detectorLagMs: 25,
    steerPx: 6, steerPxPerMs: 0.6, steerMinMs: 60, lostMs: 150, retrackPx: 150, piStartMs: 45,
  },
  // true: the Pi plays the path's click on the target. false: it only moves
  // the pointer there (noclick=1) - the phases run the same.
  click: true,
  // Nothing is moved or clicked, and the inventory isn't read, unless the
  // window with exactly this title is the active one; the press has to land
  // inside it too. "" turns this check off.
  window: "RuneScape",
  // Start game-detector and mouse-sim when they don't answer (only when their
  // url is on this PC). Each `start` below says how: `command` runs in `dir`
  // (relative to the testbots folder) in a new minimized window titled
  // `title`, {port} is the url's port, and it gets readyMs to start answering.
  autostart: true,
  // game-detector's live boxes (game-detector/API.md): "W" wisps, "C" crater.
  detector: {
    url: "http://127.0.0.1:8790/", timeoutMs: 2000,
    start: {
      // .\ because Windows can be set not to look in the current folder for
      // a bare name (NoDefaultCurrentDirectoryInExePath). --no-preview: the
      // preview opens always-on-top, half the screen wide, wherever Windows
      // puts it - often over the game, where the pointer would hover on it.
      dir: "game-detector", command: "call .\\run.bat detector.main --track --no-preview --http {port}",
      title: "game-detector", readyMs: 120000,
    },
  },
  // mouse-sim's path generator, asked for skip_reaction and no_misses: the
  // pointer starts moving at once, and the path's one click is on the target.
  mouseSim: {
    url: "http://127.0.0.1:8765/api/generate", timeoutMs: 5000,
    start: {
      dir: "mouse-sim", command: ".venv\\Scripts\\python.exe serve.py --port {port} --preload",
      title: "mouse-sim server", readyMs: 60000,
    },
  },
  // The Pi plays the path as the mouse.
  pi: { url: "http://192.168.0.131:8080/moveclick", timeoutMs: 20000 },
  // A detector box also holds the background around the wisp or crater, but
  // mouse-sim treats the whole box as the target. This fraction of the box's
  // width and height is trimmed off each side first: 0.25 aims at the middle
  // half.
  inset: 0.25,
};

function checkRange(value, lo, hi, what) {
  if (!Number.isFinite(value) || value < lo || value > hi) {
    throw new Error(`Config ${what} must be a number ${lo}-${hi} (got ${value})`);
  }
}

// A min/max pair of times, e.g. intervalMinMs/intervalMaxMs.
function checkPair(section, lo, hi, name) {
  checkRange(section[lo], 0, 600000, `${name}.${lo}`);
  checkRange(section[hi], 0, 600000, `${name}.${hi}`);
  if (section[lo] > section[hi]) {
    throw new Error(`Config ${name}.${lo} is greater than ${name}.${hi}`);
  }
}

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`No config found at ${CONFIG_PATH}\nRun:  node pixelwatch/calibrate-mouseover2.js`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${err.message}`);
  }
  const cfg = { ...DEFAULTS, ...raw };

  const missing = GROUPS.map((g) => g.key).filter((key) => {
    const list = (cfg.pixels || {})[key];
    const p = Array.isArray(list) && list.length === 1 ? list[0] : null;
    const c = p && p.color;
    return !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !c || ![c.r, c.g, c.b].every(Number.isFinite);
  });
  if (missing.length) {
    throw new Error(`Config has no pixel ${missing.join(", ")}. Run:  node pixelwatch/calibrate-mouseover2.js` +
                    " (it picks just the ones missing)");
  }

  for (const key of ["inventory", "afterClick", "wisps", "detector", "mouseSim", "pi"]) {
    cfg[key] = { ...DEFAULTS[key], ...(raw[key] || {}) };
  }
  for (const key of ["detector", "mouseSim"]) {
    cfg[key].start = { ...DEFAULTS[key].start, ...((raw[key] || {}).start || {}) };
  }

  checkRange(cfg.tolerance, 0, 255, "tolerance");
  const inv = cfg.inventory;
  checkPair(inv, "intervalMinMs", "intervalMaxMs", "inventory");
  const spaces = arch.GROUPS.find((g) => g.key === "A").count;
  checkRange(inv.fullAt, 1, spaces, "inventory.fullAt");
  checkRange(inv.dumpEarlyAt, 1, spaces, "inventory.dumpEarlyAt");
  checkRange(inv.emptyBelow, 1, spaces, "inventory.emptyBelow");
  for (const k of ["fullAt", "dumpEarlyAt", "emptyBelow"]) {
    if (!Number.isInteger(inv[k])) throw new Error(`Config inventory.${k} must be a whole number (got ${inv[k]})`);
  }
  if (inv.emptyBelow > inv.fullAt) {
    throw new Error(`Config inventory.emptyBelow (${inv.emptyBelow}) can't be above fullAt (${inv.fullAt})`);
  }
  if (inv.dumpEarlyAt > inv.fullAt) {
    throw new Error(`Config inventory.dumpEarlyAt (${inv.dumpEarlyAt}) can't be above fullAt (${inv.fullAt})`);
  }
  checkPair(inv, "fillingQuietMinMs", "fillingQuietMaxMs", "inventory");
  checkPair(inv, "emptyingQuietMinMs", "emptyingQuietMaxMs", "inventory");
  checkPair(cfg.afterClick, "wispMinMs", "wispMaxMs", "afterClick");
  checkPair(cfg.afterClick, "craterMinMs", "craterMaxMs", "afterClick");
  const w = cfg.wisps;
  checkRange(w.looks, 1, 20, "wisps.looks");
  if (!Number.isInteger(w.looks)) throw new Error(`Config wisps.looks must be a whole number (got ${w.looks})`);
  checkRange(w.lookGapMs, 0, 2000, "wisps.lookGapMs");
  checkRange(w.matchPx, 1, 1000, "wisps.matchPx");
  checkRange(w.stillPxPerSec, 0, 10000, "wisps.stillPxPerSec");
  checkRange(w.maxLeadPx, 0, 2000, "wisps.maxLeadPx");
  checkRange(w.leadMarginMs, 0, 2000, "wisps.leadMarginMs");
  checkRange(w.maxWaitMs, 0, 5000, "wisps.maxWaitMs");
  if (typeof w.track !== "boolean") throw new Error(`Config wisps.track must be true or false (got ${w.track})`);
  checkRange(w.pollMs, 1, 1000, "wisps.pollMs");
  checkRange(w.followPx, 1, 1000, "wisps.followPx");
  checkRange(w.followWindowMs, 50, 5000, "wisps.followWindowMs");
  checkRange(w.detectorLagMs, 0, 1000, "wisps.detectorLagMs");
  checkRange(w.steerPx, 0, 1000, "wisps.steerPx");
  checkRange(w.steerPxPerMs, 0.05, 20, "wisps.steerPxPerMs");
  checkRange(w.steerMinMs, 0, 2000, "wisps.steerMinMs");
  checkRange(w.lostMs, 0, 5000, "wisps.lostMs");
  checkRange(w.retrackPx, 1, 2000, "wisps.retrackPx");
  checkRange(w.piStartMs, 0, 1000, "wisps.piStartMs");
  if (typeof w.lead !== "boolean") throw new Error(`Config wisps.lead must be true or false (got ${w.lead})`);
  for (const key of ["detector", "mouseSim", "pi"]) {
    try {
      new URL(cfg[key].url);
    } catch {
      throw new Error(`Config ${key}.url is not a valid URL: ${cfg[key].url}`);
    }
    checkRange(cfg[key].timeoutMs, 1, 600000, `${key}.timeoutMs`);
  }
  for (const key of ["detector", "mouseSim"]) {
    const s = cfg[key].start;
    for (const field of ["dir", "command", "title"]) {
      if (typeof s[field] !== "string" || !s[field]) {
        throw new Error(`Config ${key}.start.${field} must be a non-empty string`);
      }
    }
    if (/"/.test(s.command + s.title + s.dir)) {
      throw new Error(`Config ${key}.start: no double quotes in dir, command or title`);
    }
    checkRange(s.readyMs, 1000, 600000, `${key}.start.readyMs`);
  }
  for (const key of ["autostart", "click"]) {
    if (typeof cfg[key] !== "boolean") {
      throw new Error(`Config ${key} must be true or false (got ${cfg[key]})`);
    }
  }
  if (typeof cfg.window !== "string") {
    throw new Error(`Config window must be a window title, or "" for no check (got ${cfg.window})`);
  }
  checkRange(cfg.inset, 0, 0.45, "inset");
  return cfg;
}

// The 28 inventory spaces from archeology's calibration, read only: each one's
// 10x10 block as calibrated, plus archeology's tolerance and blockMatchPercent.
function loadInventory() {
  const file = arch.CONFIG_PATH;
  const fix = "Calibrate archeology's inventory first:  node pixelwatch/calibrate-archeology.js --only A";
  if (!fs.existsSync(file)) {
    throw new Error(`mouseover2 reads the 28 inventory spaces from archeology's calibration, ` +
                    `but there is none at ${file}\n${fix}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = raw.pixels && raw.pixels.A;
  const want = arch.GROUPS.find((g) => g.key === "A").count;
  if (!Array.isArray(list) || list.length !== want) {
    throw new Error(`archeology's calibration has ${Array.isArray(list) ? list.length : 0} ` +
                    `inventory spaces, mouseover2 needs ${want}.\n${fix}`);
  }
  const spaces = list.map((p, i) => {
    const rgb = p && arch.parseBlock(p.block, arch.BLOCK);
    if (!rgb || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new Error(`Inventory space ${i + 1} in archeology's calibration has no 10x10 block.\n${fix}`);
    }
    return { x: p.x, y: p.y, blockRgb: rgb };
  });
  const tolerance = Number.isFinite(raw.tolerance) ? raw.tolerance : arch.DEFAULTS.tolerance;
  const blockMatchPercent = Number.isFinite(raw.blockMatchPercent)
    ? raw.blockMatchPercent : arch.DEFAULTS.blockMatchPercent;
  return { file, spaces, tolerance, blockMatchPercent };
}

// Writes `cfg` as given - the calibrator passes the file's current contents
// with the new pixel A. Defaults aren't written out, so later changes to them
// still apply.
function save(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  return CONFIG_PATH;
}

// A fresh value in [lo, hi], inclusive of both bounds.
const randomBetween = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

// A fresh reading interval.
const randomIn = ({ intervalMinMs, intervalMaxMs }) => randomBetween(intervalMinMs, intervalMaxMs);

const toHex = ({ r, g, b }) =>
  "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");

// True when `actual` is within `tolerance` of `expected` on every channel.
const matches = (actual, expected, tolerance) =>
  Math.abs(actual.r - expected.r) <= tolerance &&
  Math.abs(actual.g - expected.g) <= tolerance &&
  Math.abs(actual.b - expected.b) <= tolerance;

module.exports = {
  CONFIG_PATH, DEFAULTS, GROUPS, BLOCK: arch.BLOCK, BLOCK_FROM: arch.BLOCK_FROM,
  load, loadInventory, save, randomBetween, randomIn, toHex, matches,
};
