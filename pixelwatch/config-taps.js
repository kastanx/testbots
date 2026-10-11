// Config for watch-taps.js / calibrate-taps.js.
//
// Three pixels in a fixed sequence, tapping servos on the Arduino
// (arduino/servo_control):
//   step 1: pixel 1 appears -> servo 1 taps
//   step 2: pixel 2 appears -> servo 2 taps
//   step 3: pixel 3 appears -> wait 500-1000 ms -> servo 2 taps twice,
//           then back to step 1
//
// Its own file: no other watcher's config is read or written.

const fs = require("fs");
const path = require("path");

// PIXELWATCH_CONFIG_TAPS points at another file instead, so a test run never
// touches the real calibration.
const CONFIG_PATH =
  process.env.PIXELWATCH_CONFIG_TAPS || path.join(__dirname, "config-taps.json");

const SPOTS = [
  { label: "Pixel 1", rule: "step 1: when it appears, servo 1 taps" },
  { label: "Pixel 2", rule: "step 2: when it appears, servo 2 taps" },
  {
    label: "Pixel 3",
    rule: "step 3: when it appears, wait 500-1000 ms, servo 2 taps twice, then back to step 1",
  },
];

const DEFAULTS = {
  // Three { x, y, color } entries in LOGICAL screen coordinates, pixel 1..3.
  spots: [],
  // Max per-channel difference still counted as a match (0-255).
  tolerance: 12,
  // Time from the start of one check to the start of the next, drawn fresh
  // for every check.
  intervalMinMs: 100,
  intervalMaxMs: 150,
  // A tap sends the servo to tapAngle and back to the middle of its range.
  servo1: { tapAngle: 5 },
  servo2: { tapAngle: 0 },
  tap: {
    // Time at the tap angle, counted from the command - it has to cover the
    // travel too, about 150 ms for an SG90 swinging 90 degrees at full speed.
    holdMs: 250,
    // Time after sending it back to the middle before anything else, so it
    // gets there - without it the second of two taps would not separate.
    gapMs: 200,
  },
  // Step 3 waits this long - a fresh random value each time - between pixel 3
  // appearing and servo 2's double tap.
  step3Delay: { minMs: 500, maxMs: 1000 },
  // Arduino COM port, e.g. "COM4". Empty: $SERVO_PORT, else auto-detect.
  port: "",
};

function validateSpot(spot, index) {
  const name = SPOTS[index] ? SPOTS[index].label : "spot " + index;
  if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) {
    throw new Error(`${name} has no pixel set. Run:  node pixelwatch/calibrate-taps.js`);
  }
  const c = spot.color;
  if (!c || ![c.r, c.g, c.b].every(Number.isFinite)) {
    throw new Error(`${name} has no colour set. Run:  node pixelwatch/calibrate-taps.js`);
  }
}

function checkRange(value, lo, hi, what) {
  if (!Number.isFinite(value) || value < lo || value > hi) {
    throw new Error(`Config ${what} must be a number ${lo}-${hi} (got ${value})`);
  }
}

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `No config found at ${CONFIG_PATH}\nRun:  node pixelwatch/calibrate-taps.js`
    );
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const cfg = { ...DEFAULTS, ...raw };

  if (!Array.isArray(cfg.spots) || cfg.spots.length !== SPOTS.length) {
    throw new Error(
      `Config needs exactly ${SPOTS.length} spots, found ` +
      `${Array.isArray(cfg.spots) ? cfg.spots.length : 0}. ` +
      `Run:  node pixelwatch/calibrate-taps.js`
    );
  }
  cfg.spots.forEach(validateSpot);

  checkRange(cfg.intervalMinMs, 0, 60000, "intervalMinMs");
  checkRange(cfg.intervalMaxMs, 0, 60000, "intervalMaxMs");
  if (cfg.intervalMinMs > cfg.intervalMaxMs) {
    throw new Error(
      `Config intervalMinMs (${cfg.intervalMinMs}) is greater than ` +
      `intervalMaxMs (${cfg.intervalMaxMs})`
    );
  }

  cfg.servo1 = { ...DEFAULTS.servo1, ...(raw.servo1 || {}) };
  cfg.servo2 = { ...DEFAULTS.servo2, ...(raw.servo2 || {}) };
  cfg.tap = { ...DEFAULTS.tap, ...(raw.tap || {}) };
  checkRange(cfg.servo1.tapAngle, 0, 360, "servo1.tapAngle");
  checkRange(cfg.servo2.tapAngle, 0, 360, "servo2.tapAngle");
  checkRange(cfg.tap.holdMs, 0, 10000, "tap.holdMs");
  checkRange(cfg.tap.gapMs, 0, 10000, "tap.gapMs");

  cfg.step3Delay = { ...DEFAULTS.step3Delay, ...(raw.step3Delay || {}) };
  checkRange(cfg.step3Delay.minMs, 0, 60000, "step3Delay.minMs");
  checkRange(cfg.step3Delay.maxMs, 0, 60000, "step3Delay.maxMs");
  if (cfg.step3Delay.minMs > cfg.step3Delay.maxMs) {
    throw new Error(
      `Config step3Delay.minMs (${cfg.step3Delay.minMs}) is greater than ` +
      `step3Delay.maxMs (${cfg.step3Delay.maxMs})`
    );
  }
  return cfg;
}

function save(cfg) {
  const merged = { ...DEFAULTS, ...cfg };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n");
  return CONFIG_PATH;
}

// A fresh interval for each check, inclusive of both bounds.
const nextInterval = (cfg) =>
  cfg.intervalMinMs +
  Math.floor(Math.random() * (cfg.intervalMaxMs - cfg.intervalMinMs + 1));

const toHex = ({ r, g, b }) =>
  "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");

// True when `actual` is within `tolerance` of `expected` on every channel.
const matches = (actual, expected, tolerance) =>
  Math.abs(actual.r - expected.r) <= tolerance &&
  Math.abs(actual.g - expected.g) <= tolerance &&
  Math.abs(actual.b - expected.b) <= tolerance;

module.exports = {
  CONFIG_PATH, DEFAULTS, SPOTS, load, save, nextInterval, toHex, matches,
};
