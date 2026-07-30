const robot = require("robotjs");

console.log("Move your cursor to the desired position...");
console.log("Reading color in 5 seconds...");

setTimeout(() => {
  const pos = robot.getMousePos();
  const color = robot.getPixelColor(1148, 422);

  console.log(`Cursor position: x=${pos.x}, y=${pos.y}`);
  console.log(`Color at cursor: ${color}`);

  process.exit(0);
}, 5000);
