// Config for archeology.js / calibrate-archeology.js.
//
// Control pixels, in groups:
//   A - 28 blocks of 10x10 pixels
//   B, C - 1 or more variations each: present when ANY of them is, missing
//          only when all of them are
//   D, E - 1 pixel each
//
// Three sections, each on its own check interval:
//   1. at least 27 of the 28 A missing AND B present -> servo 1 holds button 2
//      until B goes missing (at most maxHoldMs); nothing else is checked
//      meanwhile
//   2. C missing AND D present -> servo 1 taps button 1, then a cooldown
//      before checking again
//   3. E present               -> servo 2 taps
//
// Its own file: no other watcher's config is read or written.

const fs = require("fs");
const path = require("path");

// PIXELWATCH_CONFIG_ARCHEOLOGY points at another file instead, so a test run never
// touches the real calibration.
const CONFIG_PATH =
  process.env.PIXELWATCH_CONFIG_ARCHEOLOGY || path.join(__dirname, "config-archeology.json");

// A block group's controls are BLOCK x BLOCK squares, running from
// (x + BLOCK_FROM, y + BLOCK_FROM) to (x + BLOCK_FROM + BLOCK - 1, ...) around
// the picked pixel (x, y).
const BLOCK = 10;
const BLOCK_FROM = -5;

// count: how many picks a group takes - for a `variations` group, the fewest
// (it takes any number more, and is present when any one of them is).
const GROUPS = [
  { key: "A", label: "A", count: 28, block: BLOCK,
    rule: "10x10 block around each click; 27+ of 28 missing (with B present) -> servo 1 holds button 2" },
  { key: "B", label: "B", count: 1, variations: true,
    rule: "any variation present (with 27+ A missing) starts the hold; all of them missing ends it" },
  { key: "C", label: "C", count: 1, variations: true,
    rule: "all variations missing (with D present) -> servo 1 taps button 1, then 3-5 s cooldown" },
  { key: "D", label: "D", count: 1, rule: "present (with C missing) -> servo 1 taps button 1, then 3-5 s cooldown" },
  { key: "E", label: "E", count: 1, rule: "present -> servo 2 taps (checked every 3-5 s)" },
];

const DEFAULTS = {
  // { A: [28 x {x, y, color, block}], B, C: [1 or more x {x, y, color}],
  //   D, E: [1 x {x, y, color}] } in LOGICAL screen coordinates. `block` is
  // the 10x10 square's colours, one string of hex RRGGBB per row, top to
  // bottom. Each entry in B and C is one variation.
  pixels: {},
  // Max per-channel difference still counted as a match (0-255).
  tolerance: 12,
  // An A block counts as present when at least this percentage of its pixels
  // match (100: every one of them).
  blockMatchPercent: 100,
  servo1: {
    // Servo 1 presses one of two buttons, and rests at the middle of its range.
    button1Angle: 5,
    button2Angle: 126,
  },
  // Servo 2 taps by going here and back to the middle.
  servo2: { tapAngle: 0 },
  tap: {
    // Time at the tap angle, counted from the command - it has to cover the
    // travel too, about 150 ms for an SG90 swinging 90 degrees at full speed.
    holdMs: 250,
    // Time after sending it back to the middle before anything else.
    gapMs: 200,
  },
  // Section 1: A/B -> hold button 2. Checks start interval apart. It holds
  // when at least minAMissing of the A pixels are missing (27: at most one
  // left) and B is present; while holding it checks only B, releaseCheck
  // apart, for at most maxHoldMs.
  hold: {
    intervalMinMs: 500, intervalMaxMs: 1000,
    minAMissing: 27,
    releaseCheckMinMs: 100, releaseCheckMaxMs: 150,
    maxHoldMs: 5000,
  },
  // Section 2: C/D -> tap button 1. Checks start interval apart; after a
  // tap, the next check is a cooldown later.
  button1Tap: {
    intervalMinMs: 100, intervalMaxMs: 150,
    cooldownMinMs: 3000, cooldownMaxMs: 5000,
  },
  // Section 3: E -> tap servo 2.
  servo2Tap: { intervalMinMs: 3000, intervalMaxMs: 5000 },
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

// Whether n picks are right for group g: exactly count, or for a variations
// group at least count.
const enough = (g, n) => (g.variations ? n >= g.count : n === g.count);

// A block's rows of hex RRGGBB as [r, g, b, r, g, b, ...], or null if they
// aren't size rows of size pixels each.
function parseBlock(rows, size) {
  if (!Array.isArray(rows) || rows.length !== size ||
      !rows.every((r) => typeof r === "string" && r.length === size * 6 && /^[0-9a-f]+$/i.test(r))) {
    return null;
  }
  const out = new Uint8Array(size * size * 3);
  rows.forEach((row, dy) => {
    for (let i = 0; i < size * 3; i++) out[dy * size * 3 + i] = parseInt(row.substr(i * 2, 2), 16);
  });
  return out;
}

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `No config found at ${CONFIG_PATH}\nRun:  node pixelwatch/calibrate-archeology.js`
    );
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const cfg = { ...DEFAULTS, ...raw };

  const px = cfg.pixels || {};
  for (const g of GROUPS) {
    const list = px[g.key];
    if (!Array.isArray(list) || !enough(g, list.length)) {
      throw new Error(
        `Config needs ${g.variations ? "at least " : ""}${g.count} pixel(s) in group ${g.key}, found ` +
        `${Array.isArray(list) ? list.length : 0}. Run:  node pixelwatch/calibrate-archeology.js`
      );
    }
    list.forEach((p, i) => {
      const c = p && p.color;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
          !c || ![c.r, c.g, c.b].every(Number.isFinite)) {
        throw new Error(`Pixel ${g.key}${g.count > 1 || g.variations ? i + 1 : ""} is incomplete. ` +
                        "Run:  node pixelwatch/calibrate-archeology.js");
      }
      if (g.block) {
        const rgb = parseBlock(p.block, g.block);
        if (!rgb) {
          throw new Error(
            `${g.key} is checked as ${g.block}x${g.block} blocks now, and ${g.key}${i + 1} has no block ` +
            `saved. Recalibrate just group ${g.key} - the other groups are kept as they are:\n` +
            `  node pixelwatch/calibrate-archeology.js --only ${g.key}`
          );
        }
        // Not enumerable, so it never ends up in a saved file.
        Object.defineProperty(p, "blockRgb", { value: rgb });
      }
    });
  }
  checkRange(cfg.blockMatchPercent, 1, 100, "blockMatchPercent");

  for (const key of ["servo1", "servo2", "tap", "hold", "button1Tap", "servo2Tap"]) {
    cfg[key] = { ...DEFAULTS[key], ...(raw[key] || {}) };
  }
  checkRange(cfg.servo1.button1Angle, 0, 360, "servo1.button1Angle");
  checkRange(cfg.servo1.button2Angle, 0, 360, "servo1.button2Angle");
  checkRange(cfg.servo2.tapAngle, 0, 360, "servo2.tapAngle");
  checkRange(cfg.tap.holdMs, 0, 10000, "tap.holdMs");
  checkRange(cfg.tap.gapMs, 0, 10000, "tap.gapMs");
  checkRange(cfg.hold.maxHoldMs, 0, 600000, "hold.maxHoldMs");
  const aCount = GROUPS.find((g) => g.key === "A").count;
  checkRange(cfg.hold.minAMissing, 1, aCount, "hold.minAMissing");
  if (!Number.isInteger(cfg.hold.minAMissing)) {
    throw new Error(`Config hold.minAMissing must be a whole number (got ${cfg.hold.minAMissing})`);
  }
  checkPair(cfg.hold, "intervalMinMs", "intervalMaxMs", "hold");
  checkPair(cfg.hold, "releaseCheckMinMs", "releaseCheckMaxMs", "hold");
  checkPair(cfg.button1Tap, "intervalMinMs", "intervalMaxMs", "button1Tap");
  checkPair(cfg.button1Tap, "cooldownMinMs", "cooldownMaxMs", "button1Tap");
  checkPair(cfg.servo2Tap, "intervalMinMs", "intervalMaxMs", "servo2Tap");
  return cfg;
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
  CONFIG_PATH, DEFAULTS, GROUPS, BLOCK, BLOCK_FROM,
  load, save, enough, parseBlock, randomBetween, randomIn, toHex, matches,
};
