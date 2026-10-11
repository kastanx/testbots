// Config for mining.js / calibrate-mining.js.
//
// Two checks, each every 3-5 s:
//   pixel A    - present -> servo 2 taps
//   inventory  - 24 or more of the 28 spaces occupied -> servo 1 taps (5),
//                and 1 s later they're counted again: still 24 or more ->
//                push and pause
//
// Pixel A is stored here, in config-mining.json (calibrate-mining.js makes it).
// The 28 inventory spaces are NOT: they're archeology's A blocks, read from
// config-archeology.json and never written - recalibrating archeology's
// inventory (calibrate-archeology.js --only A) changes them for both.

const fs = require("fs");
const path = require("path");
const arch = require("./config-archeology.js");

// PIXELWATCH_CONFIG_MINING points at another file instead, so a test run never
// touches the real one. PIXELWATCH_CONFIG_ARCHEOLOGY does the same for the
// inventory spaces.
const CONFIG_PATH =
  process.env.PIXELWATCH_CONFIG_MINING || path.join(__dirname, "config-mining.json");

const GROUPS = [
  { key: "A", label: "A", count: 1, rule: "present -> servo 2 taps (checked every 3-5 s)" },
];

const DEFAULTS = {
  // { A: [{ x, y, color }] } in LOGICAL screen coordinates.
  pixels: {},
  // Max per-channel difference still counted as a match for pixel A (0-255).
  // The inventory spaces are judged with archeology's own tolerance and
  // blockMatchPercent, exactly as archeology judges them.
  tolerance: 12,
  // Pixel A present -> servo 2 goes here and back to the middle of its range.
  servo2: { tapAngle: 0 },
  // Inventory full -> servo 1 goes here and back to the middle of its range.
  servo1: { tapAngle: 5 },
  tap: {
    // Time at the tap angle, counted from the command - it has to cover the
    // travel too, about 150 ms for an SG90 swinging 90 degrees at full speed.
    holdMs: 250,
    // Time after sending it back to the middle before anything else.
    gapMs: 200,
  },
  // Pixel A: checks start this far apart.
  pixelA: { intervalMinMs: 3000, intervalMaxMs: 5000 },
  inventory: {
    // Checks start this far apart. After a servo 1 tap, the next check is this
    // far after the second count.
    intervalMinMs: 3000, intervalMaxMs: 5000,
    // This many of the 28 spaces occupied, or more -> servo 1 taps.
    minOccupied: 24,
    // The spaces are counted again this long after servo 1 is sent back.
    recheckMs: 1000,
  },
  // Phone push when it pauses. Set url to "" to turn it off. The topic is
  // unauthenticated: anyone who knows the name can read or post to it.
  notify: { url: "https://ntfy.sh/rs3gem123", title: "mining", priority: "high" },
  // Arduino COM port, e.g. "COM4". Empty: $SERVO_PORT, else auto-detect.
  port: "",
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
    throw new Error(
      `No config found at ${CONFIG_PATH}\nRun:  node pixelwatch/calibrate-mining.js`
    );
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const cfg = { ...DEFAULTS, ...raw };

  const list = (cfg.pixels || {}).A;
  const p = Array.isArray(list) && list.length === 1 ? list[0] : null;
  const c = p && p.color;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
      !c || ![c.r, c.g, c.b].every(Number.isFinite)) {
    throw new Error("Config has no pixel A. Run:  node pixelwatch/calibrate-mining.js");
  }

  for (const key of ["servo1", "servo2", "tap", "pixelA", "inventory", "notify"]) {
    cfg[key] = { ...DEFAULTS[key], ...(raw[key] || {}) };
  }
  checkRange(cfg.tolerance, 0, 255, "tolerance");
  checkRange(cfg.servo1.tapAngle, 0, 360, "servo1.tapAngle");
  checkRange(cfg.servo2.tapAngle, 0, 360, "servo2.tapAngle");
  checkRange(cfg.tap.holdMs, 0, 10000, "tap.holdMs");
  checkRange(cfg.tap.gapMs, 0, 10000, "tap.gapMs");
  checkPair(cfg.pixelA, "intervalMinMs", "intervalMaxMs", "pixelA");
  checkPair(cfg.inventory, "intervalMinMs", "intervalMaxMs", "inventory");
  checkRange(cfg.inventory.recheckMs, 0, 60000, "inventory.recheckMs");
  const spaces = arch.GROUPS.find((g) => g.key === "A").count;
  checkRange(cfg.inventory.minOccupied, 1, spaces, "inventory.minOccupied");
  if (!Number.isInteger(cfg.inventory.minOccupied)) {
    throw new Error(`Config inventory.minOccupied must be a whole number (got ${cfg.inventory.minOccupied})`);
  }
  if (cfg.notify.url) {
    try {
      new URL(cfg.notify.url);
    } catch {
      throw new Error(`Config notify.url is not a valid URL: ${cfg.notify.url}`);
    }
  }
  return cfg;
}

// The 28 inventory spaces from archeology's calibration, read only: each one's
// 10x10 block as calibrated, plus archeology's tolerance and blockMatchPercent.
function loadInventory() {
  const file = arch.CONFIG_PATH;
  const fix = "Calibrate archeology's inventory first:  node pixelwatch/calibrate-archeology.js --only A";
  if (!fs.existsSync(file)) {
    throw new Error(`mining reads the 28 inventory spaces from archeology's calibration, ` +
                    `but there is none at ${file}\n${fix}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = raw.pixels && raw.pixels.A;
  const want = arch.GROUPS.find((g) => g.key === "A").count;
  if (!Array.isArray(list) || list.length !== want) {
    throw new Error(`archeology's calibration has ${Array.isArray(list) ? list.length : 0} ` +
                    `inventory spaces, mining needs ${want}.\n${fix}`);
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

// Notification settings alone, tolerant of a missing or half-written config,
// so delivery can be tested before pixel A has been calibrated.
function loadNotify() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // No config yet, or unreadable - fall back to the defaults.
  }
  return { ...DEFAULTS.notify, ...(raw.notify || {}) };
}

function save(cfg) {
  const merged = { ...DEFAULTS, ...cfg };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n");
  return CONFIG_PATH;
}

// A fresh value in [lo, hi], inclusive of both bounds.
const randomBetween = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

// A fresh check interval for a section.
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
  load, loadInventory, loadNotify, save, randomBetween, randomIn, toHex, matches,
};
