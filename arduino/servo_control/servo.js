// Control hobby servos on an Arduino Uno running the ServoCtl firmware
// (ServoCtl/ServoCtl.ino) over USB serial.
//
//   const { ServoBoard } = require("../arduino/servo_control");
//   const board = await ServoBoard.open();               // finds the Arduino's COM port
//   const [a, b] = board.servos;                          // servo 1 (pin 9), servo 2 (pin 10)
//   await a.tap(30, { hold: 150, wait: true });           // press, hold 150 ms, come back
//   await Promise.all([a.move(0, 500, { wait: true }), b.move(180, 500, { wait: true })]);
//   await board.close();
//
// Commands go out one at a time, in call order, and each promise settles with the
// firmware's reply. Waiting for a motion doesn't hold up other commands: the firmware
// announces every finished motion ("! done servo=N"), so both servos can move and be
// awaited at the same time. Failures reject with a ServoError whose `code` says why.
// Full documentation: README.md.

const { EventEmitter } = require("events");
const { SerialPort, ReadlineParser } = require("serialport");

// USB vendor ids: Arduino, Arduino.org, WCH (CH340 clones), Silicon Labs (CP210x), FTDI.
const USB_VENDORS = ["2341", "2a03", "1a86", "10c4", "0403"];
const BAUD_RATE = 115200;
const DEFAULT_TIMEOUT_MS = 3000;
const READY_BANNER = /^# ServoCtl \S+ ready/;
const ERR_CODES = { "wait interrupted": "INTERRUPTED", timeout: "TIMEOUT" };
const PREFIX = /^\s*(\d+|\*)\s*:\s*/;
// Firmware command words that start or end a motion - used to track which servos move.
const MOTION_WORDS = new Set(["A", "ANGLE", "M", "MOVE", "STEP", "U", "US", "C", "CENTER",
  "H", "HOME", "SWEEP", "T", "TAP"]);
const HALT_WORDS = new Set(["X", "STOP", "OFF", "RELAX", "DETACH"]);

// code is one of: DEVICE (the firmware answered ERR), TIMEOUT, INTERRUPTED, CANCELLED,
// FOREVER, RESTARTED, CLOSED, NOT_FOUND, OPEN_FAILED, NO_FIRMWARE, OLD_FIRMWARE.
class ServoError extends Error {
  constructor(message, code, reply = null) {
    super(message);
    this.name = "ServoError";
    this.code = code;
    this.reply = reply;  // the firmware's ERR line, when there was one
  }
}

async function listPorts() {
  const ports = await SerialPort.list();
  return ports.map((p) => ({
    path: p.path,
    name: (p.friendlyName || p.manufacturer || "").trim(),
    vendorId: p.vendorId,
    productId: p.productId,
    arduino: USB_VENDORS.includes(String(p.vendorId).toLowerCase()),
  }));
}

async function findServoPort() {
  const ports = await listPorts();
  const hit = ports.find((p) => p.arduino);
  if (hit) return hit.path;
  const seen = ports.map((p) => p.path).join(", ") || "none";
  throw new ServoError(
    `No Arduino found (serial ports: ${seen}). Plug it in or pass { port: "COMx" }.`, "NOT_FOUND");
}

// "target=90.0 us=1472 ms=0 clamped" -> { target: 90, us: 1472, ms: 0, clamped: true }
function parseFields(text) {
  const out = {};
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    const eq = word.indexOf("=");
    if (eq < 0) {
      out[word] = true;
      continue;
    }
    const key = word.slice(0, eq).replace(/_(\w)/g, (_, c) => c.toUpperCase());
    const raw = word.slice(eq + 1);
    const n = Number(raw);
    out[key] = raw !== "" && !Number.isNaN(n) ? n : raw;
  }
  return out;
}

// "2:A 90" -> { target: "2", word: "A" }; "SAVE" -> { target: null, word: "SAVE" }
function splitCommand(cmd) {
  const m = PREFIX.exec(cmd);
  const body = m ? cmd.slice(m[0].length) : cmd;
  return { target: m ? m[1] : null, word: body.trim().split(/\s+/)[0].toUpperCase() };
}

// Numbers always go out with a dot, whatever the locale.
function num(value, what) {
  const n = Number(value);
  if (value === null || value === "" || !Number.isFinite(n)) {
    throw new TypeError(`${what} must be a number, got ${value}`);
  }
  return String(Math.round(n * 1000) / 1000);
}

// One servo on the board. Get them from board.servos / board.servo(n), or open the board
// and get servo 1 in one go with Servo.open().
class Servo {
  // Shortcut for scripts that use one servo: opens the board and returns servo 1. Its
  // path, isOpen, on(), ping(), help() and close() act on the whole board.
  static async open(options = {}) {
    return (await ServoBoard.open(options)).servo(1);
  }

  constructor(board, n, pin) {
    this.board = board;
    this.n = n;      // 1, 2, ...
    this.pin = pin;  // Arduino pin
    this._pos = null;
    this._moving = false;
    this._forever = false;
    this._waiters = [];
  }

  // Motion. Each resolves as soon as the firmware accepts the command, with the fields of
  // its reply ({ target, us, ms, clamped }); pass { wait: true } to resolve when the motion
  // has finished instead (adds { pos }).

  // Go to an angle at the speed() setting.
  async angle(deg, { wait = false } = {}) {
    return this._motion(`A ${num(deg, "angle")}`, wait);
  }

  // Go to an angle in exactly `ms` milliseconds.
  async move(deg, ms, { wait = false } = {}) {
    return this._motion(`M ${num(deg, "angle")} ${num(ms, "ms")}`, wait);
  }

  // Move relative to the current target, e.g. step(-5).
  async step(delta, { wait = false } = {}) {
    return this._motion(`STEP ${num(delta, "delta")}`, wait);
  }

  // Raw pulse width in microseconds (500-2500). Ignores limits().
  async pulse(us, { wait = false } = {}) {
    return this._motion(`U ${num(us, "pulse")}`, wait);
  }

  async center({ wait = false } = {}) {
    return this._motion("C", wait);
  }

  async home({ wait = false } = {}) {
    return this._motion("H", wait);
  }

  // Swing between two angles, `leg` ms per direction, `cycles` round trips (0 = until stop()).
  async sweep(from, to, { leg = 1000, cycles = 0, wait = false } = {}) {
    return this._motion(
      `SWEEP ${num(from, "from")} ${num(to, "to")} ${num(leg, "leg")} ${num(cycles, "cycles")}`, wait);
  }

  // Go to an angle, stay `hold` ms, then return to where it was.
  async tap(deg, { hold = 200, wait = false } = {}) {
    return this._motion(`TAP ${num(deg, "angle")} ${num(hold, "hold")}`, wait);
  }

  // Stops this servo at once, ahead of anything queued for it: its queued commands are
  // cancelled (CANCELLED) and its wait()s reject with INTERRUPTED. Resolves with { pos }.
  async stop() {
    this.board._cancelQueued((job) => job.target === String(this.n), `servo ${this.n} stop()`);
    return parseFields((await this.board._exchange(this._cmd("X"), { priority: true })).text);
  }

  // Resolves with { pos } once this servo has stopped moving - after whatever was already
  // sent to it. Doesn't hold up commands for other servos. With timeoutMs, rejects with
  // TIMEOUT if it takes longer (the motion itself carries on).
  async wait(timeoutMs) {
    if (timeoutMs !== undefined) num(timeoutMs, "timeout");
    await this.board._settled(this.n);
    if (!this.board.isOpen) throw new ServoError("port is closed", "CLOSED");
    if (!this._moving) return { pos: this._pos };
    if (this._forever) {
      throw new ServoError(`servo ${this.n} sweeps until stop() - it never finishes by itself`, "FOREVER");
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this._waiters = this._waiters.filter((w) => w !== waiter);
          reject(new ServoError(`servo ${this.n} still moving after ${timeoutMs} ms`, "TIMEOUT"));
        }, Number(timeoutMs));
      }
      this._waiters.push(waiter);
    });
  }

  // Stop sending pulses: the servo goes limp. Any motion command holds it again.
  async relax() {
    await this.send("OFF");
  }

  // Hold the last position again after relax(). Resolves with { pos }.
  async hold() {
    return parseFields(await this.send("ON"));
  }

  // Settings, per servo. Called without arguments they read the current value. Changes are
  // lost at power-off unless save() is called.

  // Degrees per second for angle/step/pulse/center/home/tap; 0 = as fast as the servo can.
  async speed(degPerSec) {
    const cmd = degPerSec === undefined ? "SPEED" : `SPEED ${num(degPerSec, "speed")}`;
    return parseFields(await this.send(cmd)).speed;
  }

  // Smooth start and stop for move() and sweep().
  async ease(on) {
    const cmd = on === undefined ? "EASE" : `EASE ${on ? "ON" : "OFF"}`;
    return parseFields(await this.send(cmd)).ease === 1;
  }

  // limits() reads, limits(lo, hi) sets, limits(false) goes back to the full range.
  async limits(lo, hi) {
    let cmd = "LIMITS";
    if (lo === false) cmd = "LIMITS OFF";
    else if (lo !== undefined) cmd = `LIMITS ${num(lo, "lo")} ${num(hi, "hi")}`;
    const f = parseFields(await this.send(cmd));
    return { lo: f.lo, hi: f.hi };
  }

  // Pulse widths at 0 degrees and at `range` degrees (default range: unchanged).
  async calibrate(minUs, maxUs, range) {
    let cmd = "CAL";
    if (minUs !== undefined) {
      cmd += ` ${num(minUs, "minUs")} ${num(maxUs, "maxUs")}`;
      if (range !== undefined) cmd += ` ${num(range, "range")}`;
    }
    const f = parseFields(await this.send(cmd));
    return { minUs: f.minUs, maxUs: f.maxUs, range: f.range };
  }

  // Angle taken at power-up; without an argument, the current position.
  async setHome(deg) {
    const cmd = deg === undefined ? "SETHOME" : `SETHOME ${num(deg, "home")}`;
    return parseFields(await this.send(cmd)).home;
  }

  // Store this servo's settings in the Arduino's EEPROM.
  async save() {
    await this.send("SAVE");
  }

  // Go back to this servo's stored settings.
  async load() {
    await this.send("LOAD");
  }

  // Factory settings for this servo (not stored until save()).
  async defaults() {
    await this.send("DEFAULTS");
  }

  // { servo, pin, pos, target, us, moving, mode, attached, speed, ease, lo, hi, home,
  //   minUs, maxUs, range, saved }
  async status() {
    const s = parseFields(await this.send("STATUS"));
    for (const key of ["moving", "attached", "ease", "saved"]) s[key] = s[key] === 1;
    return s;
  }

  // Sends one raw firmware command to this servo: "A 90" goes out as "2:A 90". A command
  // that already has a servo prefix goes out unchanged.
  async send(command, options) {
    const cmd = String(command).trim();
    return this.board.send(PREFIX.test(cmd) ? cmd : this._cmd(cmd), options);
  }

  // The board's, for scripts that only hold a Servo.
  get path() { return this.board.path; }
  get isOpen() { return this.board.isOpen; }
  ping() { return this.board.ping(); }
  help() { return this.board.help(); }
  close() { return this.board.close(); }
  on(event, listener) { this.board.on(event, listener); return this; }
  once(event, listener) { this.board.once(event, listener); return this; }
  off(event, listener) { this.board.off(event, listener); return this; }

  _cmd(cmd) {
    return `${this.n}:${cmd}`;
  }

  async _motion(cmd, wait) {
    const reply = parseFields(await this.send(cmd));
    return wait ? { ...reply, ...(await this.wait()) } : reply;
  }

  // State changes below are called synchronously while the board reads lines, so they
  // always apply in the order the Arduino sent them.

  _started(forever) {
    this._moving = true;
    this._forever = forever;
  }

  _finished(pos) {
    this._pos = pos;
    this._moving = false;
    this._forever = false;
    for (const w of this._waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve({ pos });
    }
  }

  _halted(pos, why) {
    if (pos !== undefined) this._pos = pos;
    this._fail("INTERRUPTED", `servo ${this.n} was ${why} before the motion finished`);
  }

  _synced(status) {
    this._pos = status.pos;
    if (!status.moving && this._moving) this._finished(status.pos);
  }

  _fail(code, message) {
    this._moving = false;
    this._forever = false;
    for (const w of this._waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new ServoError(message, code));
    }
  }
}

// The Arduino with its servos, and the serial connection to it.
class ServoBoard extends EventEmitter {
  // Opens the port and waits until the firmware answers.
  // options.port: "COM4" etc. Default: $SERVO_PORT, else the first Arduino-like USB port.
  // options.timeout: ms to wait for a reply before giving up (default 3000).
  static async open(options = {}) {
    const board = new ServoBoard(options);
    await board._connect();
    return board;
  }

  constructor({ port, timeout = DEFAULT_TIMEOUT_MS } = {}) {
    super();
    this.path = port || process.env.SERVO_PORT || null;
    this.timeout = timeout;
    this.version = null;  // firmware version, e.g. "2.0"
    this.servos = [];     // Servo objects; servos[0] is servo 1
    this._serial = null;
    this._inflight = [];  // written, replies expected in this order
    this._queue = [];     // not written yet
    this._syncing = false;
    this._onPong = null;
    this._closed = false;
    this._ticker = null;
  }

  get isOpen() {
    return !this._closed && !!this._serial && this._serial.isOpen;
  }

  get count() {
    return this.servos.length;
  }

  // Servo n, counting from 1.
  servo(n) {
    const s = this.servos[n - 1];
    if (!s) throw new RangeError(`no servo ${n} - this board has ${this.count}`);
    return s;
  }

  // All servos at once. Positions come back as { pos1, pos2, ... }.

  // Stops every servo, ahead of everything queued: all queued commands are cancelled and
  // every wait() rejects with INTERRUPTED.
  async stop() {
    this._cancelQueued(() => true, "board stop()");
    return parseFields((await this._exchange("*:X", { priority: true })).text);
  }

  async relax() {
    await this.send("*:OFF");
  }

  async hold() {
    return parseFields(await this.send("*:ON"));
  }

  async center({ wait = false } = {}) {
    return this._motionAll("*:C", wait);
  }

  async home({ wait = false } = {}) {
    return this._motionAll("*:H", wait);
  }

  // Resolves with { pos1, pos2, ... } once every servo has stopped moving.
  async wait(timeoutMs) {
    const done = await Promise.all(this.servos.map((s) => s.wait(timeoutMs)));
    return Object.fromEntries(done.map((d, i) => [`pos${i + 1}`, d.pos]));
  }

  // Array with every servo's status().
  async status() {
    return Promise.all(this.servos.map((s) => s.status()));
  }

  // Store / reload / factory-reset the settings of every servo.
  async save() {
    await this.send("SAVE");
  }

  async load() {
    await this.send("LOAD");
  }

  async defaults() {
    await this.send("DEFAULTS");
  }

  // { version, servos, pins }
  async info() {
    return this._readInfo(await this.send("INFO"));
  }

  // Round trip to the Arduino in milliseconds.
  async ping() {
    const start = performance.now();
    await this.send("PING");
    return Math.round((performance.now() - start) * 10) / 10;
  }

  // The firmware's command list, one string per line.
  async help() {
    return (await this._exchange("HELP")).info;
  }

  // Sends one raw firmware command, e.g. "2:M 45 500", and resolves with the reply text
  // after "OK". Firmware waits (W/WAIT) get no timeout unless one is given.
  async send(command, { timeout } = {}) {
    const cmd = String(command).trim();
    if (!cmd || /[\r\n;]/.test(cmd)) {
      throw new TypeError(`send() takes exactly one command, got ${JSON.stringify(command)}`);
    }
    const { word } = splitCommand(cmd);
    if (timeout === undefined && (word === "W" || word === "WAIT")) timeout = 0;
    return (await this._exchange(cmd, { timeout })).text;
  }

  // Closes the port. The servos keep holding their last positions.
  async close() {
    if (this._closed) return;
    this._closed = true;
    this._rejectAll(this._queue, "CLOSED", "port closed");
    for (const s of this.servos) s._fail("CLOSED", "port closed");
    const serial = this._serial;
    if (serial && serial.isOpen) {
      await new Promise((resolve) => serial.drain(() => resolve()));
      await new Promise((resolve) => serial.close(() => resolve()));
    }
    clearInterval(this._ticker);
  }

  async _motionAll(cmd, wait) {
    const reply = parseFields(await this.send(cmd));
    return wait ? { ...reply, ...(await this.wait()) } : reply;
  }

  _readInfo(text) {
    const pins = (/pins=(\S+)/.exec(text) || [])[1] || "";
    return {
      version: (/version=(\S+)/.exec(text) || [])[1] || null,
      servos: Number((/servos=(\d+)/.exec(text) || [])[1] || 0),
      pins: pins ? pins.split(",").map(Number) : [],
    };
  }

  async _connect() {
    if (!this.path) this.path = await findServoPort();
    // hupcl: false keeps DTR low. Raising DTR resets an Uno, which sends the servos home.
    const serial = new SerialPort({ path: this.path, baudRate: BAUD_RATE, hupcl: false, autoOpen: false });
    try {
      await new Promise((resolve, reject) => serial.open((err) => (err ? reject(err) : resolve())));
    } catch (err) {
      this._closed = true;
      const hint = /access denied|busy/i.test(err.message)
        ? "Another program has it open (Arduino IDE, serial monitor, servo-cli, servo-web, watch3.js...)."
        : "Is that the right port? listPorts() / `node servo-cli.js --list` shows them.";
      const why = err.message.replace(/^Opening \S+: /, "");
      throw new ServoError(`Cannot open ${this.path}: ${why}. ${hint}`, "OPEN_FAILED");
    }
    this._serial = serial;
    // On Windows (seen with Node 26 + @serialport/bindings-cpp 13) the native read finishes but
    // does not wake Node's event loop, so replies would sit until something else woke it - e.g.
    // the next write. Ticking the loop every 5 ms delivers them promptly. unref(): the tick
    // never keeps the process alive on its own.
    if (process.platform === "win32") this._ticker = setInterval(() => {}, 5).unref();
    serial.pipe(new ReadlineParser({ delimiter: "\n" }))
      .on("data", (line) => this._onLine(line.replace(/\r$/, "")));
    // Failures also reach callers through rejected commands and the disconnect event.
    serial.on("error", (err) => this.emit("warning", err));
    serial.on("close", (err) => this._onClose(err));

    try {
      this._syncing = true;
      try {
        await this._handshake();
      } finally {
        this._syncing = false;
      }
      await this._learnServos();
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  // Until the firmware has answered, nothing but PING goes out: right after a reset the
  // Uno's bootloader is still listening, and PING is harmless to it where other bytes are not.
  async _handshake() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const answered = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this._onPong = null;
          resolve(false);
        }, 500);
        this._onPong = () => {
          clearTimeout(timer);
          this._onPong = null;
          resolve(true);
        };
        this._serial.write("\nPING\n");
      });
      if (answered) return;
    }
    throw new ServoError(
      `${this.path} is open but ServoCtl does not answer. Is ServoCtl.ino uploaded?`, "NO_FIRMWARE");
  }

  async _learnServos() {
    let info;
    try {
      info = await this.info();
    } catch (err) {
      if (err.code !== "DEVICE") throw err;
      throw new ServoError(
        `The ServoCtl firmware on ${this.path} is older than this library. Run: node upload.js`,
        "OLD_FIRMWARE");
    }
    this.version = info.version;
    this.servos = info.pins.map((pin, i) => new Servo(this, i + 1, pin));
    await Promise.all(this.servos.map((s) => s.status()));  // current positions, moving or not
  }

  _exchange(cmd, { timeout = this.timeout, priority = false } = {}) {
    if (this._closed) return Promise.reject(new ServoError("port is closed", "CLOSED"));
    const job = { cmd, target: splitCommand(cmd).target, timeout, timer: null, info: [] };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    if (priority && !this._syncing) {
      this._write(job);
    } else {
      if (priority) this._queue.unshift(job);
      else this._queue.push(job);
      this._pump();
    }
    return job.promise;
  }

  // Settles once every command already sent or queued for servo n has been answered.
  // Commands without a prefix go to servo 1.
  _settled(n) {
    const forServo = (job) => job.target === String(n) || job.target === "*" || (n === 1 && job.target === null);
    return Promise.allSettled([...this._inflight, ...this._queue].filter(forServo).map((j) => j.promise));
  }

  _cancelQueued(match, by) {
    const cancelled = this._queue.filter(match);
    this._queue = this._queue.filter((job) => !match(job));
    this._rejectAll(cancelled, "CANCELLED", (job) => `"${job.cmd}" cancelled by ${by}`);
  }

  _pump() {
    if (this._syncing || this._closed || this._inflight.length || !this._queue.length) return;
    this._write(this._queue.shift());
  }

  _write(job) {
    this._inflight.push(job);
    if (job.timeout > 0) job.timer = setTimeout(() => this._onTimeout(job), job.timeout);
    this._serial.write(job.cmd + "\n");
  }

  _onLine(line) {
    // Events are unambiguous, so they count even while re-syncing.
    if (line.startsWith("!")) {
      this._onEvent(parseFields(line.slice(1)));
      return;
    }
    if (this._syncing) {
      // endsWith: output left over from before we connected can run into the reply.
      if (line.endsWith("OK pong") && this._onPong) this._onPong();
      return;
    }
    if (line.startsWith("#")) {
      if (READY_BANNER.test(line)) {
        this._onRestart();
      } else {
        if (this._inflight.length) this._inflight[0].info.push(line);
        this.emit("info", line);
      }
      return;
    }
    const m = /^(OK|ERR)(?: (.*))?$/.exec(line);
    const job = m && this._inflight.shift();
    if (!job) return;  // line noise
    clearTimeout(job.timer);
    const text = m[2] || "";
    if (m[1] === "OK") {
      this._track(job.cmd, text);
      job.resolve({ text, info: job.info });
    } else {
      job.reject(new ServoError(text || "error", ERR_CODES[text] || "DEVICE", line));
    }
    this._pump();
  }

  // Keeps each servo's moving/position state in step with the replies. Runs while the line
  // is read, so a "! done" event arriving right after a reply is applied after it.
  _track(cmd, text) {
    const { target, word } = splitCommand(cmd);
    const servos = target === "*" ? this.servos : [this.servos[Number(target || 1) - 1]].filter(Boolean);
    const f = parseFields(text);
    const posOf = (s) => (f[`pos${s.n}`] !== undefined ? f[`pos${s.n}`] : f.pos);
    if (MOTION_WORDS.has(word) || Number.isFinite(Number(word))) {
      for (const s of servos) s._started(word === "SWEEP" && f.cycles === "forever");
    } else if (HALT_WORDS.has(word)) {
      const why = word === "X" || word === "STOP" ? "stopped" : "relaxed";
      for (const s of servos) s._halted(posOf(s), why);
    } else if (word === "?" || word === "STATUS") {
      if (servos[0]) servos[0]._synced(f);
    } else if (f.pos !== undefined || f.pos1 !== undefined) {
      for (const s of servos) if (posOf(s) !== undefined) s._pos = posOf(s);
    }
  }

  _onEvent(f) {
    const servo = this.servos[f.servo - 1];
    if (!f.done || !servo) return;
    servo._finished(f.pos);
    this.emit("done", { servo: f.servo, pos: f.pos });
  }

  _onTimeout(job) {
    // Without that reply the order of the ones after it can't be trusted: fail everything
    // in flight and handshake again before anything else goes out.
    this._rejectAll(this._inflight, "TIMEOUT",
      (j) => `no reply to "${j.cmd}" within ${job.timeout} ms - is the Arduino still connected?`);
    this._syncing = true;
    this._handshake()
      .catch((err) => this._rejectAll(this._queue, err.code, err.message))
      .finally(() => {
        this._syncing = false;
        this._pump();
      });
  }

  _onRestart() {
    // The Arduino rebooted (power dip, reset button, or a program that raised DTR). Commands
    // in flight are lost and every servo went to its home angle.
    this._rejectAll(this._inflight, "RESTARTED", (j) => `the Arduino restarted - "${j.cmd}" was lost`);
    for (const s of this.servos) s._fail("RESTARTED", "the Arduino restarted");
    this.emit("restart");
    for (const s of this.servos) s.status().catch(() => {});  // relearn the positions
    this._pump();
  }

  _onClose(err) {
    const expected = this._closed;
    this._closed = true;
    clearInterval(this._ticker);
    const why = expected ? "port closed" : `lost connection to ${this.path}`;
    this._rejectAll(this._inflight, "CLOSED", why);
    this._rejectAll(this._queue, "CLOSED", why);
    for (const s of this.servos) s._fail("CLOSED", why);
    if (!expected) this.emit("disconnect", err);
  }

  _rejectAll(jobs, code, message) {
    for (const job of jobs.splice(0)) {
      clearTimeout(job.timer);
      job.reject(new ServoError(typeof message === "function" ? message(job) : message, code));
    }
  }
}

module.exports = { ServoBoard, Servo, ServoError, findServoPort, listPorts };
