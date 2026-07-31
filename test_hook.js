// Minimal smoke test for the global input monitor and the mouse backend.
// Press r / s / p / space / q / l anywhere; Ctrl+C to quit.
//
// Uses the same platform monitor as recorder.js instead of uiohook-napi, which
// has no prebuilt binary for current Node on Windows.

const { mouse } = require("@nut-tree-fork/nut-js");
const { InputMonitor } = require("./input-monitor");

console.log("Starting minimal hook test...");

const monitor = new InputMonitor();

monitor.on("ready", () => console.log("Hook started. Press keys."));
monitor.on("info", (line) => console.log(line));
monitor.on("error", (message) => console.error("Monitor Error:", message));
monitor.on("close", (code) => {
  console.log(`Input monitor exited with code ${code}`);
  process.exit(0);
});

monitor.on("key", async (token) => {
  const pos = await mouse.getPosition();
  console.log(`Key: ${token}  (cursor at ${pos.x}, ${pos.y})`);
});

monitor.start();

process.on("exit", () => monitor.stop());
process.on("SIGINT", () => process.exit(0));
