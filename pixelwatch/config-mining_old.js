// Config for mining_old.js (formerly watch3v3.js).
//
// The pixels are NOT stored here. They come from config3v2.json - the same
// calibration watch3v2.js uses, made with calibrate3v2.js - which this reads
// and never writes. So does everything else watch3v2.js shares: tolerance, the
// interval range, servo 1's pressed angle (servo.activeAngle) and the COM
// port, and the push topic. Servo 1 releases to the middle of its range.
//
// config-mining_old.json only holds what mining_old adds: how servo 2 presses, and the push
// title. It's optional; the defaults below apply without it.

const fs = require("fs");
const path = require("path");
const v2 = require("./config3v2.js");

// PIXELWATCH_CONFIG_MINING_OLD points at another file instead, so a test run never
// touches the real one. PIXELWATCH_CONFIG3V2 does the same for the pixels.
const CONFIG_PATH =
  process.env.PIXELWATCH_CONFIG_MINING_OLD || path.join(__dirname, "config-mining_old.json");

const SPOTS = [
  {
    key: "guard",
    label: "Guard",
    rule: "pause if missing; servo 1 pressed while this and fallback are present",
  },
  { key: "trigger", label: "Trigger", rule: "tap servo 2 when found" },
  {
    key: "fallback",
    label: "Fallback",
    rule: "pause if this and the trigger are both missing; servo 1 pressed while this and guard are present",
  },
];

const DEFAULTS = {
  servo2: {
    // A press sends servo 2 here...
    pressAngle: 0,
    // ...keeps it there this long - long enough to cover the travel too, about
    // 150 ms for an SG90 swinging 90 degrees at full speed - and then sends it
    // back to the middle of its range.
    pressHoldMs: 250,
  },
  notify: {
    // Distinct from the other watchers, so the phone alert says which one it
    // came from when more than one is running.
    title: "mining_old",
  },
};

function readOwn() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function load() {
  const base = v2.load();   // pixels and shared settings - read only
  const own = readOwn();
  const cfg = { ...base };

  cfg.servo2 = { ...DEFAULTS.servo2, ...(own.servo2 || {}) };
  const { pressAngle, pressHoldMs } = cfg.servo2;
  if (!Number.isFinite(pressAngle) || pressAngle < 0 || pressAngle > 360) {
    throw new Error(`Config servo2.pressAngle must be a number 0-360 (got ${pressAngle})`);
  }
  if (!Number.isFinite(pressHoldMs) || pressHoldMs < 0 || pressHoldMs > 10000) {
    throw new Error(`Config servo2.pressHoldMs must be a number 0-10000 (got ${pressHoldMs})`);
  }

  cfg.notify = { ...base.notify, ...DEFAULTS.notify, ...(own.notify || {}) };
  if (cfg.notify.url) {
    try {
      new URL(cfg.notify.url);
    } catch {
      throw new Error(`Config notify.url is not a valid URL: ${cfg.notify.url}`);
    }
  }
  return cfg;
}

// Notification settings alone, tolerant of missing files, so delivery can be
// tested before anything is calibrated.
function loadNotify() {
  let own = {};
  try {
    own = readOwn();
  } catch {
    // Unreadable - fall back to the defaults.
  }
  return { ...v2.loadNotify(), ...DEFAULTS.notify, ...(own.notify || {}) };
}

module.exports = {
  CONFIG_PATH,
  PIXELS_PATH: v2.CONFIG_PATH,
  DEFAULTS,
  SPOTS,
  load,
  loadNotify,
  nextInterval: v2.nextInterval,
  toHex: v2.toHex,
  matches: v2.matches,
};
