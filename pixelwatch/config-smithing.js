// Shared config handling for calibrate-smithing.js / smithing.js.
//
// One watched pixel. While it is there, nothing happens. When it goes, the
// watcher pushes a notification once and keeps running. It never clicks.
//
// Kept separate from config.js and config3.js so all three watchers have their
// own settings and none of them can disturb another.

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config-smithing.json");

const DEFAULTS = {
  // Pixel to watch, in LOGICAL screen coordinates (what nut-js colorAt uses).
  x: null,
  y: null,
  // Expected colour at that pixel.
  color: { r: 0, g: 0, b: 0 },
  // Max per-channel difference still counted as a match (0-255).
  tolerance: 12,
  // Delay before each check. A fresh random value is drawn every tick, so the
  // polling is not a metronome. Set both to the same number for a fixed rate.
  intervalMinMs: 1000,
  intervalMaxMs: 5000,
  // Phone push when the pixel goes. Set url to "" to turn it off.
  // The topic is unauthenticated: anyone who knows the name can read or post
  // to it, so keep it unguessable.
  notify: {
    url: "https://ntfy.sh/rs3gem123",
    // Distinct from the other watchers, so the phone alert says which one it
    // came from when more than one is running.
    title: "smithing",
    priority: "high",
  },
};

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `No config found at ${CONFIG_PATH}\nRun:  node pixelwatch/calibrate-smithing.js`
    );
  }
  const cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };

  if (!Number.isFinite(cfg.x) || !Number.isFinite(cfg.y)) {
    throw new Error("Config has no pixel set. Run:  node pixelwatch/calibrate-smithing.js");
  }
  const c = cfg.color;
  if (!c || ![c.r, c.g, c.b].every(Number.isFinite)) {
    throw new Error("Config has no colour set. Run:  node pixelwatch/calibrate-smithing.js");
  }

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
// so delivery can be tested before the pixel is calibrated.
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

// A fresh delay for each check, inclusive of both bounds.
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
  CONFIG_PATH, DEFAULTS, load, loadNotify, save, nextInterval, toHex, matches,
};
