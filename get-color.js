// Reads the screen colour under the cursor (or at an explicit point).
//
//   node get-color.js          -> colour under the cursor after 5s
//   node get-color.js 1148 422 -> colour at that exact pixel after 5s
//
// Uses nut-js rather than robotjs: robotjs has no prebuilt binaries for modern
// Node on Windows and needs a full MSVC toolchain to compile.

const { mouse, screen, Point } = require("@nut-tree-fork/nut-js");

const [argX, argY] = process.argv.slice(2).map(Number);
const hasExplicitPoint = Number.isFinite(argX) && Number.isFinite(argY);

const toHex = ({ R, G, B }) =>
  [R, G, B].map((c) => c.toString(16).padStart(2, "0")).join("");

if (hasExplicitPoint) {
  console.log(`Reading color at (${argX}, ${argY}) in 5 seconds...`);
} else {
  console.log("Move your cursor to the desired position...");
  console.log("Reading color in 5 seconds...");
}

setTimeout(async () => {
  try {
    const pos = await mouse.getPosition();
    const target = hasExplicitPoint ? new Point(argX, argY) : pos;
    const color = await screen.colorAt(target);

    console.log(`Cursor position: x=${pos.x}, y=${pos.y}`);
    console.log(`Color at (${target.x}, ${target.y}): ${toHex(color)}`);

    process.exit(0);
  } catch (err) {
    console.error("Failed to read color:", err.message);
    process.exit(1);
  }
}, 5000);
