// Shared config handling for calibrate3.js / watch3.js.
//
// Three watched pixels, each with its own role in one check cycle:
//   0 guard     - missing means stop entirely
//   1 trigger   - present means send a click
//   2 fallback  - only consulted when the trigger is missing; if this is
//                 missing too, stop
//
// Kept separate from config.js / config.json so the single-pixel scripts keep
// working untouched.

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config3.json");

const SPOTS = [
  { key: "guard", label: "Guard", rule: "abort if this pixel is missing" },
  { key: "trigger", label: "Trigger", rule: "click when this pixel is found" },
  {
    key: "fallback",
    label: "Fallback",
    rule: "abort if this and the trigger are both missing",
  },
];

const DEFAULTS = {
  // Three { x, y, color } entries in LOGICAL screen coordinates, in the order
  // described by SPOTS.
  spots: [],
  // Max per-channel difference still counted as a match (0-255).
  tolerance: 12,
  // Delay before each cycle. A fresh random value is drawn every tick, so the
  // polling is not a metronome. Set both to the same number for a fixed rate.
  intervalMinMs: 1000,
  intervalMaxMs: 5000,
  // Where to send the click.
  clickUrl: "http://192.168.0.131:8080/click",
  // Phone push on abort, via ntfy.sh. Set url to "" to turn it off.
  // The topic is unauthenticated: anyone who knows the name can read or post
  // to it, so keep it unguessable.
  notify: {
    url: "https://ntfy.sh/rs3gem123",
    title: "pixelwatch",
    priority: "high",
  },
};

function validateSpot(spot, index) {
  const name = SPOTS[index] ? SPOTS[index].label : "spot " + index;
  if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) {
    throw new Error(`${name} has no pixel set. Run:  node pixelwatch/calibrate3.js`);
  }
  const c = spot.color;
  if (!c || ![c.r, c.g, c.b].every(Number.isFinite)) {
    throw new Error(`${name} has no colour set. Run:  node pixelwatch/calibrate3.js`);
  }
}

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `No config found at ${CONFIG_PATH}\nRun:  node pixelwatch/calibrate3.js`
    );
  }
  const cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };

  if (!Array.isArray(cfg.spots) || cfg.spots.length !== SPOTS.length) {
    throw new Error(
      `Config needs exactly ${SPOTS.length} spots, found ` +
      `${Array.isArray(cfg.spots) ? cfg.spots.length : 0}. ` +
      `Run:  node pixelwatch/calibrate3.js`
    );
  }
  cfg.spots.forEach(validateSpot);

  for (const key of ["intervalMinMs", "intervalMaxMs"]) {
    if (!Number.isFinite(cfg[key]) || cfg[key] < 0) {
      throw new Error(`Config ${key} must be a number >= 0 (got ${cfg[key]})`);
    }
  }
  if (cfg.intervalMinMs > cfg.intervalMaxMs) {
    throw new Error(
      `Config intervalMinMs (${cfg.intervalMinMs}) is greater than ` +
      `intervalMaxMs (${cfg.intervalMaxMs})`
    );
  }

  cfg.notify = { ...DEFAULTS.notify, ...(cfg.notify || {}) };
  if (cfg.notify.url) {
    try {
      new URL(cfg.notify.url);
    } catch {
      throw new Error(`Config notify.url is not a valid URL: ${cfg.notify.url}`);
    }
  }
  return cfg;
}

// Notification settings alone, tolerant of a missing or half-written config,
// so delivery can be tested before the pixels are calibrated.
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

// A fresh delay for each cycle, inclusive of both bounds.
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
  CONFIG_PATH, DEFAULTS, SPOTS, load, loadNotify, save, nextInterval, toHex, matches,
};
