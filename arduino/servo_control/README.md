# ServoCtl: control the servos over USB

Firmware for the Arduino Uno and a Node.js library for controlling its hobby servos over USB. There are two servos, wired as in LaskaKit Maxi Starter Kit v2, Lekce 27: servo 1 on pin 9, servo 2 on pin 10. They move independently and can be moved and awaited at the same time.

| File | What it is |
|---|---|
| [ServoCtl/ServoCtl.ino](ServoCtl/ServoCtl.ino) | Firmware. It takes text commands over USB and drives the servos. |
| [servo.js](servo.js) | Node.js library, meant for `pixelwatch/watch3.js`. `require("../arduino/servo_control")` loads it. |
| [servo-cli.js](servo-cli.js) | Command-line tool: an interactive console, one-off commands, scripts, and arrow-key jogging. |
| [servo-web.js](servo-web.js) + [web/index.html](web/index.html) | Local web page for testing the library by hand: a live dial per servo, a button for every method, and a log of each call. |
| [upload.js](upload.js) | Compiles the firmware and uploads it to the Uno. |
| `package.json` | Adds one dependency, [`serialport`](https://serialport.io). `node_modules/` stays out of git through the local `.gitignore`. |

Contents: [Hardware](#hardware) · [Setup](#setup) · [Quick start](#quick-start) · [JavaScript library](#javascript-library) · [Web test page](#web-test-page) · [Command-line tool](#command-line-tool) · [Firmware commands](#firmware-commands) · [Calibration, limits, saving](#calibration-limits-saving) · [Protocol](#protocol-for-other-programs) · [Troubleshooting](#troubleshooting)

## Hardware

| Servo wire | Servo 1 | Servo 2 |
|---|---|---|
| brown | GND | GND |
| red | 5V | 5V |
| orange (signal) | D9 | D10 |

**Power.** Both servos run off the Uno's 5 V, which comes from USB. That's fine for small servos like the SG90 with a light load. Two servos moving at once can pull more current than USB gives, and then the Arduino restarts. The library reports that as a `restart` event, and the web page shows a notice. If it happens, power the servos from a separate 5 V supply and connect that supply's GND to the Arduino's GND.

**More servos:** add their pins to `SERVO_PINS` in the sketch (the Uno can take up to 12) and upload again. The saved settings of the existing servos are kept.

## Setup

These steps are already done on this PC. On a new machine:

1. Install [arduino-cli](https://github.com/arduino/arduino-cli/releases). Here it's the portable zip unpacked to `%LOCALAPPDATA%\Programs\arduino-cli`, which `upload.js` checks before PATH. Then:
   ```bash
   arduino-cli core install arduino:avr
   arduino-cli lib install Servo
   ```
2. Install the JS dependency and flash the firmware:
   ```bash
   cd arduino/servo_control
   npm install
   node upload.js
   ```
   `upload.js` finds the Arduino's port by itself. `node upload.js COM5` picks one explicitly. The upload fails if another program has the port open, so close `watch3.js`, `servo-cli.js` or the web page's server first.

## Quick start

```bash
cd arduino/servo_control
node servo-cli.js                  # interactive console: type HELP, JOG, EXIT
node servo-cli.js A 90             # servo 1 to 90 degrees
node servo-cli.js 2:A 90           # servo 2 to 90 degrees
node servo-cli.js "M 0 1000; 2:M 180 1000; *:W"   # both move for 1 s, wait for both
npm run web                        # web test page
```

```js
const { ServoBoard } = require("../arduino/servo_control");

const board = await ServoBoard.open();            // finds the COM port by itself
const [left, right] = board.servos;               // servo 1 (pin 9), servo 2 (pin 10)
await left.tap(60, { hold: 200, wait: true });    // press and come back
await Promise.all([left.angle(0, { wait: true }), right.angle(180, { wait: true })]);  // both at once
await board.close();
```

Only one program at a time can have the COM port open. That means `watch3.js`, `servo-cli.js`, the web page's server or `upload.js`, not two of them together.

## JavaScript library

`servo.js` is CommonJS and exports `ServoBoard`, `Servo`, `ServoError`, `findServoPort()` and `listPorts()`.

- **`ServoBoard`:** the Arduino and its connection, plus commands for all servos at once.
- **`Servo`:** one servo. Get them from `board.servos` or `board.servo(n)`.

### Opening

```js
const board = await ServoBoard.open();                  // first Arduino-like USB port
const board = await ServoBoard.open({ port: "COM4" });  // or a specific one
const servo = await Servo.open();                       // shortcut: open the board, get servo 1
```

| Option | Default | Meaning |
|---|---|---|
| `port` | `$SERVO_PORT`, else auto-detect | COM port. Auto-detect looks for USB vendor ids of Arduino, CH340, CP210x and FTDI. |
| `timeout` | `3000` | How long to wait for a firmware reply, in ms. Waiting for motion has no limit unless you give one. |

- **Timing:** opening takes about 150 ms, and a round trip to the Arduino takes about 5–15 ms. Open the board once when your script starts and keep it open.
- **No restart:** opening does not restart the Arduino, so the servos stay where they are. The Arduino IDE's serial monitor does restart it, and then both servos go to their home angles.
- **Old firmware:** if the board still runs firmware older than 2.0, `open()` fails with `OLD_FIRMWARE`. Run `node upload.js`.

`board.servos` is an array of `Servo` objects, where `servos[0]` is servo 1. `board.servo(2)` gets servo 2 and throws a `RangeError` for a servo that doesn't exist. `board.count`, `board.version`, `board.path` and `board.isOpen` describe the connection. Each servo has `n` (1, 2, …) and `pin`.

### One servo: motion

Each call resolves once the Arduino has accepted the command. Pass `{ wait: true }` to resolve when the motion has finished instead.

| Method | Does |
|---|---|
| `angle(deg, { wait })` | Go to an angle at the `speed()` setting. |
| `move(deg, ms, { wait })` | Go to an angle in exactly `ms` milliseconds (eased if `ease(true)`). |
| `step(delta, { wait })` | Move relative to the current target, e.g. `step(-5)`. |
| `pulse(us, { wait })` | Raw pulse width, 500–2500 µs. Ignores `limits()`. |
| `center({ wait })` / `home({ wait })` | Go to the middle of the range / to the home angle. |
| `tap(deg, { hold = 200, wait })` | Go to `deg`, stay `hold` ms, go back to where it was. |
| `sweep(from, to, { leg = 1000, cycles = 0, wait })` | Swing back and forth, `leg` ms per direction. `cycles: 0` runs until `stop()`. |
| `stop()` | Stop this servo. Details below. Resolves with `{ pos }`. |
| `wait(timeoutMs?)` | Resolves with `{ pos }` when this servo has stopped moving. |
| `relax()` | Stop sending pulses so the servo goes limp. Any motion command holds it again. |
| `hold()` | Hold the last position again. Resolves with `{ pos }`. |

Motion calls resolve with the fields of the firmware's reply, as numbers:

```js
await servo.angle(200)                     // { target: 180, us: 2400, ms: 0, clamped: true }
await servo.move(45, 500, { wait: true })  // { target: 45, us: 1008, ms: 500, pos: 45 }
await servo.tap(60, { hold: 150 })         // { tap: true, target: 60, hold: 150, back: 90 }
```

- `target` and `us` are where the servo is going, in degrees and in pulse microseconds.
- `ms` is how long the move takes.
- `clamped` means the request was outside the limits and got cut to fit.
- `pos` (with `wait`) is where it ended up.

**Waiting doesn't block anything.** The firmware announces every finished motion, so `wait()` and `{ wait: true }` never hold up commands for the other servo. For example, `Promise.all([a.move(0, 800, { wait: true }), b.move(180, 800, { wait: true })])` takes 800 ms, not 1600. `wait()` also covers commands you sent without awaiting: `servo.angle(90); await servo.wait()` waits for that move.

**`servo.stop()`** skips ahead of other commands and cancels this servo's queued commands, which reject with `CANCELLED`. A `wait()` on it rejects with `INTERRUPTED`. The other servo carries on.

### One servo: settings and information

Call a setting with no argument to read it, or with an argument to change it. Each servo has its own settings. Changes are lost at power-off unless you call `save()`.

| Method | Returns | Meaning |
|---|---|---|
| `speed(degPerSec?)` | number | Speed for `angle`, `step`, `pulse`, `center`, `home` and `tap`. `0` (the default) means as fast as the servo can go. |
| `ease(on?)` | boolean | Smooth start and stop for `move` and `sweep`. |
| `limits(lo?, hi?)` / `limits(false)` | `{ lo, hi }` | Soft angle limits. `false` goes back to the full range. |
| `calibrate(minUs?, maxUs?, range?)` | `{ minUs, maxUs, range }` | Pulse width at 0° and at `range`°. See [calibration](#calibration-limits-saving). |
| `setHome(deg?)` | number | Angle the servo takes at power-up. With no argument, the current position. |
| `save()` / `load()` / `defaults()` | – | This servo only: store in EEPROM / go back to the stored values / factory settings (not stored until `save()`). |
| `status()` | object | `{ servo, pin, pos, target, us, moving, mode, attached, speed, ease, lo, hi, home, minUs, maxUs, range, saved }`. `mode` is `idle`, `move`, `sweep` or `tap`. `saved` is true when the settings match the EEPROM. |
| `send("A 90")` | string | Raw [firmware command](#firmware-commands) for this servo; it goes out as `2:A 90`. A command that already has a prefix goes out unchanged. Resolves with the reply text after `OK`. |

### The whole board

| Method | Does |
|---|---|
| `board.stop()` | Stops every servo. It skips the queue, cancels all queued commands and interrupts every `wait()`. Resolves with `{ pos1, pos2 }`. |
| `board.relax()` / `board.hold()` | Relax / hold every servo. |
| `board.center({ wait })` / `board.home({ wait })` | Every servo to its middle / home angle. |
| `board.wait(timeoutMs?)` | Resolves with `{ pos1, pos2 }` when every servo has stopped moving. |
| `board.status()` | Array with every servo's `status()`. |
| `board.save()` / `load()` / `defaults()` | Settings of every servo. |
| `board.info()` | `{ version, servos, pins }` from the firmware. |
| `board.ping()` / `board.help()` | Round-trip time in ms / the firmware's command list as lines. |
| `board.send("2:M 45 500")` | Any firmware command, sent exactly as written. A firmware `W` sent this way does hold up other commands until it's answered. |
| `board.close()` | Closes the port. The servos keep holding their positions. |

A `Servo` from `Servo.open()` also has `close()`, `ping()`, `help()`, `on()`, `path` and `isOpen`, which act on the whole board. That way a single-servo script needs nothing else.

### Errors and events

- **Bad arguments** throw `TypeError`: `angle("abc")`, or two commands in one `send()`.
- **Everything else** rejects with `ServoError`, which has `err.code` and, if the Arduino answered `ERR`, the raw line in `err.reply`:

| `code` | Meaning |
|---|---|
| `DEVICE` | The firmware answered `ERR`, e.g. an unknown command or a value out of range. |
| `TIMEOUT` | No reply in time, or `wait(ms)` ran out. The motion itself carries on. |
| `INTERRUPTED` | A `wait()` ended because its servo was stopped or relaxed. |
| `CANCELLED` | The command was still queued when `stop()` was called. |
| `FOREVER` | `wait()` on a servo that sweeps until `stop()`. |
| `RESTARTED` | The Arduino rebooted, so running commands and waits were lost. See the `restart` event. |
| `CLOSED` | The port is closed, or the USB cable was pulled. |
| `NOT_FOUND`, `OPEN_FAILED`, `NO_FIRMWARE`, `OLD_FIRMWARE` | From `open()`: no Arduino found / port busy or missing / something answers but it isn't ServoCtl / ServoCtl older than 2.0. |

Events on the board (`board.on(...)`):

| Event | When |
|---|---|
| `done` | `{ servo, pos }`: a servo finished a motion. |
| `restart` | The Arduino rebooted: power dip, reset button, or another program raised DTR. The servos went to their home angles. |
| `disconnect` | The port closed on its own, e.g. the cable was pulled. Pending commands reject with `CLOSED`. Call `ServoBoard.open()` again to reconnect. |
| `info` | A `#` line from the firmware, such as the `HELP` text. |
| `warning` | A low-level serial port error. It's informational: failures also show up as rejected calls. |

### Using it from watch3.js

This only shows how it would fit; `watch3.js` itself hasn't been changed. Open the board once next to `config.load()` and use it in place of, or next to, `sendClick()`. The wrapper below returns the same `{ ok, error }` shape as `sendClick()`:

```js
const { ServoBoard } = require("../arduino/servo_control");

// in the async main, once:
const board = await ServoBoard.open();
board.on("restart", () => log("servo: Arduino restarted"));

// Press with servo n. Same result shape as sendClick().
async function servoTap(n, angle, holdMs) {
  try {
    await board.servo(n).tap(angle, { hold: holdMs, wait: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${err.code || "error"}: ${err.message}` };
  }
}
```

When `watch3.js` exits with `process.exit()`, the operating system closes the port, and the servos stay where they are.

**Timing a physical press:** with `speed(0)` the firmware sends the new position right away. The servo still needs time to get there, roughly 0.1 s per 60° for an SG90. `tap()`'s `hold` counts from that instant, so make `hold` long enough to cover the travel too. Alternatively, set a `speed()` below what the servo can actually reach. Then the firmware paces the move itself, and `{ wait: true }` resolves when the servo has really arrived.

Use JOG on the web page or in the console to find the rest angle and the press angle.

## Web test page

```bash
cd arduino/servo_control
npm run web                                  # starts the page and opens http://127.0.0.1:8090
node servo-web.js                            # same, without opening the browser
node servo-web.js --port COM5 --listen 9000  # another COM port / another web port
```

This is a control panel for trying the library out by hand. Every button calls a `servo.js` method on the local server. The log at the bottom shows each call (e.g. `servo2.tap(60, { hold: 200 })`), what it returned or which `ServoError` it threw, and how long it took.

- **Dials:** one per servo, updating live even while an awaited motion runs.

  | Mark | Meaning |
  |---|---|
  | Blue needle | where the firmware has sent the servo |
  | Black mark | target |
  | Green dot | home |
  | Light arc | allowed range |

  Click a dial to control that servo.
- **Controls move: Servo 1 | Servo 2 | Both** picks which servo the Position and Motion controls act on. With **Both**, every action goes to both servos at once.
- **STOP ALL** (or Space) stops every servo.
- **Position:** a slider that moves the servo as you drag, ±1°/±10° steps, Min / Center / Home / Max, and Relax / Hold.
- **Motion:** `move`, `tap`, `sweep` and raw `pulse`.
  - Tap can repeat N times with a gap between taps. Each tap waits for the previous one to finish.
  - **Await motion** adds `{ wait: true }`, so the log shows how long a motion really took.
- **Settings:** speed, ease, limits, calibration and home, plus Save / Load / Factory defaults. They apply to the one selected servo, so they're disabled while **Both** is picked.
- **Raw firmware command:** `board.send()`, sent as written. `2:` in front picks servo 2, several commands are separated by `;`. There are also Help, Ping and Status buttons.
- **Keys:** 1 / 2 pick a servo, B both, ← / → ±1°, Shift+← / → ±10°, Space or Esc stops all, C centers, H goes home.

While the page's server runs, it holds the COM port. To use `watch3.js`, `servo-cli.js` or `upload.js`, press **Disconnect** on the page first, or stop the server with Ctrl+C. If the USB cable is pulled, the page reconnects by itself once the Arduino is back.

The server listens only on this PC's loopback address, `127.0.0.1` / `::1`, and refuses requests coming from other websites. `--host 0.0.0.0` makes the page reachable from a phone on the same network, but then anyone on that network can move the servos.

## Command-line tool

```bash
node servo-cli.js                          # interactive console
node servo-cli.js A 90                     # run commands and exit (servo 1)
node servo-cli.js "2:M 0 800; 2:W"         # servo 2
node servo-cli.js "*:H; *:W"               # both servos home, wait for both
node servo-cli.js --script moves.txt       # run a file of commands
type moves.txt | node servo-cli.js         # or pipe them in
node servo-cli.js --list                   # list serial ports
node servo-cli.js --port COM5 PING         # pick a port (or set SERVO_PORT)
npm run console                            # same as node servo-cli.js
```

- **Commands** go to the firmware exactly as typed. See [Firmware commands](#firmware-commands) for the `2:` / `*:` prefixes.
- **Syntax:** separate several commands with `;` and put the whole thing in quotes, because PowerShell and cmd treat `;` as their own separator. `#` starts a comment.
- **Errors:** when commands come from arguments, a script or a pipe, the first `ERR` stops the run. In the interactive console it just prints and carries on.
- **Ctrl+C:** while a command runs (for example `W` during a long move), Ctrl+C stops every servo. At the `servo>` prompt it quits.
- **Exit codes:** `0` means every command answered OK, `1` means one answered `ERR`, `2` means a connection problem.

Extra commands in the console and in scripts; the CLI handles these itself and doesn't send them to the Arduino:

| Command | Does |
|---|---|
| `JOG` | Arrow-key control until Esc. Keys are listed below. |
| `SLEEP <ms>` | Pause, e.g. between steps of a script. |
| `EXIT` / `QUIT` | Leave the console. |

JOG keys:

| Key | Action |
|---|---|
| 1 / 2 | pick a servo |
| ← / → | −1° / +1° |
| ↓ / ↑ | −10° / +10° |
| Home / End | lower / upper limit |
| Space | center |
| H | home |
| R | relax |
| O | hold again |
| Esc | back to the prompt |

Example script (`moves.txt`):

```text
# servo 1 presses slowly while servo 2 swings once
SPEED 120          # deg/s, servo 1
TAP 60 250
2:SWEEP 30 150 600 1
*:W                # wait for both
C ; 2:C ; *:W
```

## Firmware commands

- **Format:** one command per line, in upper or lower case. Separate arguments with spaces or commas, and write decimals with a dot (`45.5`, not `45,5`). The longest line accepted is 63 characters.
- **Replies:** every command gets exactly one reply line, starting with `OK` or `ERR`, in the order the commands were sent.
- **Picking a servo:** without a prefix, a command goes to servo 1. `N:` in front picks servo N: `2:A 90`, or `2: A 90` with a space after the colon, but not before it. `*:` means every servo, and it works for `X`, `OFF`, `ON`, `C`, `H` and `W`. With `*:`, positions come back as `pos1= pos2=`, and C/H targets as `target1= target2=`.

| Command | Aliases | Does | Example reply |
|---|---|---|---|
| `A <deg>` | `ANGLE`, or just the number | Go to an angle at `SPEED`. | `OK target=90.0 us=1472 ms=0` |
| `M <deg> <ms>` | `MOVE` | Go to an angle in exactly `<ms>` ms (eased if `EASE ON`). | `OK target=45.0 us=1008 ms=700` |
| `STEP <deg>` | | Move relative to the current target, e.g. `STEP -5`. | `OK target=40.0 us=956 ms=0` |
| `U <us>` | `US` | Raw pulse width, clamped to 500–2500 µs. Uses `SPEED`, ignores `LIMITS`. | `OK target=90.0 us=1472 ms=0` |
| `C` | `CENTER` | Go to the middle of the range (90° by default). `*:` for all. | same as `A` |
| `H` | `HOME` | Go to the home angle. `*:` for all. | same as `A` |
| `SWEEP <a> <b> [ms] [n]` | | Swing between `a` and `b`, `ms` per direction (default 1000). `n` round trips; `0` (the default) means until `STOP`. Ends at `a`. | `OK sweep a=0.0 b=160.0 leg=2400 cycles=forever` |
| `TAP <deg> [ms]` | `T` | Go to `deg`, hold `ms` (default 200), return. | `OK tap target=60.0 hold=200 back=90.0` |
| `X` | `STOP` | Stop where it is. `*:` for all. | `OK pos=67.4` |
| `W [ms]` | `WAIT` | Reply once the motion has finished, or `ERR timeout` after `ms`. `*:W` waits for all. | `OK pos=45.0` |
| `OFF` | `RELAX`, `DETACH` | Stop sending pulses, so the servo goes limp. `*:` for all. | `OK relaxed` |
| `ON` | `ATTACH` | Send pulses again, holding the last position. `*:` for all. | `OK pos=90.0` |
| `SPEED [deg/s]` | | Read or set the speed: `0` (as fast as possible) or 0.1–10000. | `OK speed=0.0` |
| `EASE [ON\|OFF]` | | Smooth start and stop for `M` and `SWEEP`. | `OK ease=1` |
| `LIMITS [lo hi \| OFF]` | `LIM` | Read or set soft angle limits. | `OK lo=10.0 hi=170.0` |
| `CAL [min_us max_us [range]]` | | Read or set the calibration. | `OK min_us=544 max_us=2400 range=180.0` |
| `SETHOME [deg]` | | Set the power-up angle (default: the current position). | `OK home=90.0` |
| `SAVE` / `LOAD` / `DEFAULTS` | | Settings of every servo, or of one with `N:`: store in EEPROM / reload the stored ones / factory values. | `OK saved` |
| `?` | `STATUS` | Everything about one servo, as `key=value`. | `OK servo=2 pin=10 pos=90.0 target=90.0 us=1472 moving=0 mode=idle attached=1 speed=0.0 ease=0 lo=0.0 hi=180.0 home=90.0 min_us=544 max_us=2400 range=180.0 saved=1` |
| `INFO` | | Firmware version and servos. | `OK version=2.0 servos=2 pins=9,10` |
| `PING` | | Check the connection. | `OK pong` |
| `HELP` | | The command list, as `#` lines followed by `OK`. | |

**Events:** when a servo finishes a motion, the firmware also sends an unrequested line like `! done servo=2 pos=45.0`. It doesn't come for `X` or `OFF`, or when a new command replaces the motion. Lines starting with `!` are always events and never replies.

Notes:

- **Motion commands** reply straight away and the servo keeps moving. A new motion command replaces the current one, starting from wherever the servo is at that moment.
- **Limits:** angles outside `LIMITS` are clamped and the reply ends with `clamped`. `U` only respects the fixed 500–2500 µs bounds.
- **No position feedback:** the servos can't report where they really are. `pos` is where the firmware has sent them. With `SPEED 0`, `pos` jumps straight to the target while the servo is still on its way.
- **WAIT and other commands:** a command sent while a `W` is pending answers the `W` with `ERR wait interrupted` first, then gets its own reply. `W` on an endless sweep answers `ERR servo N sweeps forever - send STOP first`.
- **Start-up:** at power-up each servo goes to its home angle, 90° by default, and the firmware prints `# ServoCtl 2.0 ready - servos on pins 9,10. ...`.
- **Errors look like this:** `ERR unknown command: FOO (send HELP)`, `ERR no servo 3 - servos are 1-2`, `ERR *: only works with X, OFF, ON, C, H and W`, `ERR not a number: x`, `ERR time must be 0-3600000 ms`.

Lesson 27's original sweep is `SWEEP 0 160 2400`.

## Calibration, limits, saving

Each servo has its own settings. The defaults are the same as `Servo.write()` in Lesson 27:

| Setting | Default |
|---|---|
| 0° | 544 µs |
| 180° | 2400 µs |
| Limits | 0–180° |
| Speed | 0 |
| Home | 90° |
| Ease | off |

Settings stay in memory until they're saved. `SAVE` saves every servo, and `2:SAVE` saves only servo 2. After that they survive power-off. `DEFAULTS` + `SAVE` returns to factory settings.

- **Find the real ends of your servo.** Step the raw pulse up or down with `U`, e.g. `2:U 600`, then `2:U 550`. Stop as soon as the servo stops moving or starts buzzing, because pushing it against its end stop strains the gears. Then set those values with `2:CAL <us_at_0> <us_at_max>`.
- **Reverse the direction** by swapping the two values: `CAL 2400 544`.
- **A 270° servo:** `CAL 500 2500 270`. The limits follow the new range if they were at full range.
- **Protect the mechanism** with `LIMITS 20 150`. Nothing except `U` can go outside those angles.
- **Choose where it starts** by moving there and sending `SETHOME`, or send `SETHOME 90` directly. Then `SAVE`.

Firmware 2.0 stores settings in a new format. Settings saved by 1.0 aren't read, and every servo starts at factory settings until you save again.

## Protocol (for other programs)

`servo.js` does all of this for you. It's only needed if you talk to the Arduino from something else.

- **Serial settings:** 115200 baud, 8N1, lines ending in `\n` (`\r` is ignored).
- **Keep DTR low.** Raising DTR restarts an Uno, and the servos then go home. The Arduino IDE serial monitor and `arduino-cli monitor` raise it. Node `serialport` doesn't if you open it with `hupcl: false`.
- **Handshake before sending anything else.** Send `PING` and wait for `OK pong`. If the board has just restarted, its bootloader is listening for about a second, and random bytes sent to it can in rare cases damage the uploaded program. `PING` is harmless. Then `INFO` tells you the servos and pins.
- **One command at a time.** Wait for each reply before sending the next.
- **Other lines:**
  - `#` lines are informational. `# ServoCtl ... ready` means the board has (re)started.
  - `!` lines are events and can arrive at any time between replies.
- **Waiting without blocking:** a firmware `W` holds up the reply stream until the motion ends. To wait for one servo while commanding the other, watch for `! done servo=N` events instead, which is what `servo.js` does.
- **Junk bytes on connect:** each time a PC opens the port, the Uno's USB chip sends a few junk bytes (`0xF0`) to the board. The firmware ignores all bytes that aren't printable ASCII.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot open COM4: Access denied` | Another program has the port open, e.g. `watch3.js`, `servo-cli.js`, the web page's server (press Disconnect there), the Arduino IDE or a serial monitor. Close it. |
| `No Arduino found` | Check the cable. `node servo-cli.js --list` shows the ports; then pass `--port COMx` or set `SERVO_PORT`. |
| `... ServoCtl does not answer` | Different firmware is on the board, e.g. a lesson sketch. Run `node upload.js`. |
| `OLD_FIRMWARE` / `older than this library` | The board runs ServoCtl 1.x. Run `node upload.js`. |
| The Arduino restarts or disconnects when the servos move | Not enough power, which is more likely with both servos. See [Hardware](#hardware). |
| A servo buzzes or strains at one end | It's being pushed past its end stop. Use `LIMITS` or recalibrate with `CAL`. |
| The servos jump to 90° when some program connects | That program raised DTR and restarted the Arduino. `servo.js` and its tools don't do this. |
| Replies are slow or only arrive after the next command (your own Node code on Windows) | A serialport quirk on Windows: incoming data waits until something wakes Node's event loop. `servo.js` handles it by waking the loop every 5 ms while the port is open. Do the same if you use `serialport` directly. |
