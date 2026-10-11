// Shared config handling for calibrate.js / watch.js.

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");

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
  // After a click, how long the pixel has to come back before the watcher
  // gives up and exits. A click that does not restore the pixel means
  // something is wrong, so there is no point carrying on.
  verifyDelayMs: 5000,
  // Where to send the click.
  clickUrl: "http://clicker.local:8080/click",
};

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `No config found at ${CONFIG_PATH}\nRun:  npm run calibrate`
    );
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const cfg = { ...DEFAULTS, ...raw };

  if (!Number.isFinite(cfg.x) || !Number.isFinite(cfg.y)) {
    throw new Error("Config has no pixel set. Run:  npm run calibrate");
  }

  // Older configs used a single intervalMs. Honour it as a fixed interval
  // rather than silently ignoring it.
  if (raw.intervalMs != null &&
      raw.intervalMinMs == null && raw.intervalMaxMs == null) {
    cfg.intervalMinMs = cfg.intervalMaxMs = raw.intervalMs;
  }
  delete cfg.intervalMs;
  delete cfg.cooldownMs;

  for (const key of ["intervalMinMs", "intervalMaxMs", "verifyDelayMs"]) {
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
  return cfg;
}

function save(cfg) {
  const merged = { ...DEFAULTS, ...cfg };
  // Superseded keys, dropped so stale files do not look meaningful.
  delete merged.intervalMs;
  delete merged.cooldownMs;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n");
  return CONFIG_PATH;
}

// A fresh delay for each tick, inclusive of both bounds.
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
  CONFIG_PATH, DEFAULTS, load, save, nextInterval, toHex, matches,
};
