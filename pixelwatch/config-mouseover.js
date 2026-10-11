// Config for mouseover.js / calibrate-mouseover.js.
//
// Every 3-5 s pixel A and the 28 inventory spaces are checked. With pixel A
// missing, a wisp - or, with a full inventory, the crater - that game-detector
// sees is clicked: mouse-sim makes the path and its click, and the Pi plays
// them as the mouse.
//
// Pixel A is stored here, in config-mouseover.json (calibrate-mouseover.js
// makes it). The 28 inventory spaces are NOT: they're archeology's A blocks,
// read from config-archeology.json and never written - the same ones mining
// counts.
//
// game-detector and mouse-sim are started if they aren't running yet, each in
// its own minimized window, and the ones mouseover started are closed when it
// stops.

const fs = require("fs");
const path = require("path");
const arch = require("./config-archeology.js");

// PIXELWATCH_CONFIG_MOUSEOVER points at another file instead, so a test run
// never touches the real one. PIXELWATCH_CONFIG_ARCHEOLOGY does the same for
// the inventory spaces.
const CONFIG_PATH =
  process.env.PIXELWATCH_CONFIG_MOUSEOVER || path.join(__dirname, "config-mouseover.json");

const GROUPS = [
  { key: "A", label: "A", count: 1,
    rule: "missing -> the pointer goes onto a wisp, or onto the crater when the inventory is full" },
];

const DEFAULTS = {
  // { A: [{ x, y, color }] } in LOGICAL screen coordinates.
  pixels: {},
  // Max per-channel difference still counted as a match for pixel A (0-255).
  // The inventory spaces are judged with archeology's own tolerance and
  // blockMatchPercent, exactly as archeology judges them.
  tolerance: 12,
  inventory: {
    // Checks start this far apart.
    intervalMinMs: 3000, intervalMaxMs: 5000,
    // This many of the 28 spaces occupied, or more: the inventory is full and
    // the crater is the target. Fewer: a wisp.
    fullAt: 27,
  },
  // true: the Pi plays the path's click on the target. false: it only moves
  // the pointer there (noclick=1), and nothing happens while the pointer is
  // already on the target.
  click: true,
  // Nothing is moved or clicked unless the window with exactly this title is
  // the active one and the press lands inside it, so switching to another app
  // pauses mouseover. "" turns this check off.
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
  // pointer starts moving at once, and the path's one click is on the target
  // (the Pi leaves it out).
  mouseSim: {
    url: "http://127.0.0.1:8765/api/generate", timeoutMs: 5000,
    start: {
      dir: "mouse-sim", command: ".venv\\Scripts\\python.exe serve.py --port {port} --preload",
      title: "mouse-sim server", readyMs: 60000,
    },
  },
  // The Pi plays the path as the mouse. noclick=1 is always added.
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

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${err.message}`);
  }
}

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`No config found at ${CONFIG_PATH}\nRun:  node pixelwatch/calibrate-mouseover.js`);
  }
  const raw = readRaw();
  const cfg = { ...DEFAULTS, ...raw };

  const list = (cfg.pixels || {}).A;
  const p = Array.isArray(list) && list.length === 1 ? list[0] : null;
  const c = p && p.color;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
      !c || ![c.r, c.g, c.b].every(Number.isFinite)) {
    throw new Error("Config has no pixel A. Run:  node pixelwatch/calibrate-mouseover.js");
  }

  for (const key of ["inventory", "detector", "mouseSim", "pi"]) {
    cfg[key] = { ...DEFAULTS[key], ...(raw[key] || {}) };
  }
  for (const key of ["detector", "mouseSim"]) {
    cfg[key].start = { ...DEFAULTS[key].start, ...((raw[key] || {}).start || {}) };
  }

  checkRange(cfg.tolerance, 0, 255, "tolerance");
  checkPair(cfg.inventory, "intervalMinMs", "intervalMaxMs", "inventory");
  const spaces = arch.GROUPS.find((g) => g.key === "A").count;
  checkRange(cfg.inventory.fullAt, 1, spaces, "inventory.fullAt");
  if (!Number.isInteger(cfg.inventory.fullAt)) {
    throw new Error(`Config inventory.fullAt must be a whole number (got ${cfg.inventory.fullAt})`);
  }
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
    throw new Error(`mouseover reads the 28 inventory spaces from archeology's calibration, ` +
                    `but there is none at ${file}\n${fix}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = raw.pixels && raw.pixels.A;
  const want = arch.GROUPS.find((g) => g.key === "A").count;
  if (!Array.isArray(list) || list.length !== want) {
    throw new Error(`archeology's calibration has ${Array.isArray(list) ? list.length : 0} ` +
                    `inventory spaces, mouseover needs ${want}.\n${fix}`);
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

// A fresh check interval.
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
