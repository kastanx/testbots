// Compiles ServoCtl/ServoCtl.ino and uploads it to the Uno.
//
//   node upload.js          finds the Arduino's port
//   node upload.js COM5     uses the given port
//
// Needs arduino-cli with the arduino:avr core and the Servo library (see README.md).
// Close anything that has the port open first (servo-cli, watch3.js, a serial monitor).

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { findServoPort } = require("./servo");

function arduinoCli() {
  const portable = path.join(process.env.LOCALAPPDATA || "", "Programs", "arduino-cli", "arduino-cli.exe");
  return fs.existsSync(portable) ? portable : "arduino-cli";
}

(async () => {
  const port = process.argv[2] || process.env.SERVO_PORT || (await findServoPort());
  const sketch = path.join(__dirname, "ServoCtl");
  console.log(`Uploading ${sketch} to ${port} ...`);
  const result = spawnSync(arduinoCli(), [
    "compile", "--fqbn", "arduino:avr:uno", "--upload", "--verify", "--port", port, sketch,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status);
})().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
