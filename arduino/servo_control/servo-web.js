// Local web page for driving the servos through servo.js - a test bench for the library.
//
//   node servo-web.js                 -> http://127.0.0.1:8090 (or $PORT if set)
//   node servo-web.js --open          also opens it in the browser
//   node servo-web.js --port COM5 --listen 9000
//
// The page calls the library's methods by name (POST /api/call) and gets live status over
// server-sent events (GET /api/events). While this runs it holds the COM port, so
// watch3.js / servo-cli.js / upload.js can't use it - press Disconnect on the page first.

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { ServoBoard, listPorts } = require("./servo");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SERIAL_PORT = option("--port", undefined);
// --listen wins, then $PORT (set by launchers that assign ports), then 8090.
const LISTEN_PORT = Number(option("--listen", process.env.PORT || 8090));
const HOST = option("--host", "127.0.0.1");
const PAGE = path.join(__dirname, "web", "index.html");
const TICK_MS = 100;      // status of a moving servo is read this often
const IDLE_POLL_MS = 1000; // ...and of a still one this often

// Library methods the page may call. Anything else is refused.
const SERVO_METHODS = new Set([
  "angle", "move", "step", "pulse", "center", "home", "sweep", "tap", "stop", "wait",
  "relax", "hold", "speed", "ease", "limits", "calibrate", "setHome", "save", "load",
  "defaults", "status", "send",
]);
const BOARD_METHODS = new Set([
  "stop", "relax", "hold", "center", "home", "wait", "status", "save", "load", "defaults",
  "info", "ping", "help", "send",
]);

let board = null;
let lastError = null;
let wantConnected = true;  // false after the page's Disconnect: no automatic reconnects
let connecting = null;
let reconnectTimer = null;
let pageCalls = 0;  // page calls in flight
const lastPoll = new Map();  // servo n -> time its status was last read
const clients = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) if (!res.destroyed && !res.writableEnded) res.write(msg);
}

function snapshot() {
  const connected = !!(board && board.isOpen);
  return {
    connected,
    port: connected ? board.path : null,
    version: connected ? board.version : null,
    servos: connected ? board.servos.map((s) => ({ n: s.n, pin: s.pin })) : [],
    error: connected ? null : lastError,
  };
}

function connect(port) {
  if (!connecting) connecting = doConnect(port).finally(() => { connecting = null; });
  return connecting;
}

async function doConnect(port) {
  clearTimeout(reconnectTimer);
  if (board) {
    const old = board;
    board = null;
    await old.close().catch(() => {});
  }
  try {
    const b = await ServoBoard.open({ port: port || SERIAL_PORT });
    b.on("restart", () => {
      log("Arduino restarted");
      broadcast("restart", {});
    });
    b.on("done", ({ servo }) => lastPoll.set(servo, 0));  // show where it ended up right away
    b.on("disconnect", () => {
      if (board !== b) return;
      board = null;
      lastError = `Lost connection to ${b.path}.`;
      log(lastError);
      broadcast("state", snapshot());
      scheduleReconnect(b.path);
    });
    board = b;
    lastError = null;
    lastPoll.clear();
    log(`connected to ${b.path}: ServoCtl ${b.version}, ${b.count} servos on pins ${b.servos.map((s) => s.pin)}`);
  } catch (err) {
    lastError = err.message;
    log(`connect failed: ${err.message}`);
  }
  broadcast("state", snapshot());
  return snapshot();
}

// After an unplug, keep trying until the Arduino is back or the page says Disconnect.
function scheduleReconnect(port) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (!wantConnected || (board && board.isOpen)) return;
    await connect(port);
    if (!(board && board.isOpen)) scheduleReconnect(port);
  }, 2000);
}

async function disconnect() {
  wantConnected = false;
  clearTimeout(reconnectTimer);
  if (board) {
    const old = board;
    board = null;
    await old.close().catch(() => {});
    log(`disconnected from ${old.path}`);
  }
  lastError = null;
  broadcast("state", snapshot());
  return snapshot();
}

// { target: "board" | 1 | 2 ..., method, args } -> the library call's result or error.
async function callMethod({ target, method, args: callArgs = [] } = {}) {
  const fail = (name, message, code) => ({ ok: false, error: { name, code, message } });
  if (!board || !board.isOpen) return fail("ServoError", "not connected", "CLOSED");
  if (!Array.isArray(callArgs)) return fail("TypeError", "args must be an array");
  let subject;
  if (target === "board") {
    if (!BOARD_METHODS.has(method)) return fail("Error", `board.${method}() is not available here`);
    subject = board;
  } else {
    subject = board.servos[Number(target) - 1];
    if (!subject) return fail("RangeError", `no servo ${target}`);
    if (!SERVO_METHODS.has(method)) return fail("Error", `servo.${method}() is not available here`);
  }
  const start = performance.now();
  const ms = () => Math.round((performance.now() - start) * 10) / 10;
  // Read the status of whatever the call touches on the next tick, so motion shows at once -
  // both once its command is queued (the method queues it before its first await) and when
  // it has finished.
  const touched = target === "board" ? board.servos : [subject];
  const pollSoon = () => touched.forEach((s) => lastPoll.set(s.n, 0));
  pageCalls++;
  try {
    const pending = subject[method](...callArgs);
    pollSoon();
    const result = await pending;
    return { ok: true, result: result === undefined ? null : result, ms: ms() };
  } catch (err) {
    return {
      ok: false,
      error: { name: err.name, code: err.code, message: err.message, reply: err.reply || null },
      ms: ms(),
    };
  } finally {
    pageCalls--;
    pollSoon();
  }
}

// Live status for the page, only while a page is open: often for a moving servo, now and
// then for a still one, and right after one finishes a motion.
async function statusLoop() {
  const moving = new Map();
  for (;;) {
    const b = board;
    if (clients.size && b && b.isOpen) {
      for (const s of b.servos) {
        const due = moving.get(s.n) || Date.now() - (lastPoll.get(s.n) || 0) >= IDLE_POLL_MS;
        if (!due) continue;
        const start = performance.now();
        const alone = pageCalls === 0;
        try {
          const status = await s.status();
          lastPoll.set(s.n, Date.now());
          moving.set(s.n, status.moving);
          // Round trip only counts when no page call was queued ahead of the poll.
          const latency = alone && pageCalls === 0 ? Math.round(performance.now() - start) : null;
          if (b === board) broadcast("status", { ...status, latency });
        } catch {
          // Cancelled by stop(), or the connection dropped - the next round sorts it out.
        }
      }
    }
    await sleep(TICK_MS);
  }
}

// Only pages from this server may use the API: this blocks other websites (the Origin check)
// and DNS-rebinding tricks (the Host check, when listening on loopback only).
function trusted(req) {
  const host = req.headers.host || "";
  const loopback = HOST === "127.0.0.1" || HOST === "localhost";
  if (loopback && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10000) throw new Error("request too large");
  }
  return raw ? JSON.parse(raw) : {};
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (!trusted(req)) return sendJson(res, 403, { ok: false, error: { message: "forbidden" } });

  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(fs.readFileSync(PAGE));
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, 200, snapshot());
    }
    if (req.method === "GET" && url.pathname === "/api/ports") {
      return sendJson(res, 200, await listPorts());
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive",
      });
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      lastPoll.clear();  // a new page gets every servo's status straight away
      const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }
    if (req.method === "POST") {
      // JSON only: a cross-site form can't send it without a CORS preflight, which we never allow.
      if (!String(req.headers["content-type"]).startsWith("application/json")) {
        return sendJson(res, 415, { ok: false, error: { message: "JSON only" } });
      }
      const body = await readJson(req);
      if (url.pathname === "/api/call") return sendJson(res, 200, await callMethod(body));
      if (url.pathname === "/api/connect") {
        wantConnected = true;
        return sendJson(res, 200, await connect(body.port));
      }
      if (url.pathname === "/api/disconnect") return sendJson(res, 200, await disconnect());
    }
    sendJson(res, 404, { ok: false, error: { message: "not found" } });
  } catch (err) {
    sendJson(res, 400, { ok: false, error: { message: err.message } });
  }
}

// Browsers try "localhost" as IPv6 (::1) first, and on Windows a refused IPv6 connection
// costs them 300 ms before they fall back to 127.0.0.1 - so listen on both.
function listen(host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.once("error", reject);
    server.listen(LISTEN_PORT, host, () => resolve(server));
  });
}

process.on("SIGINT", async () => {
  if (board) await board.close().catch(() => {});
  process.exit(0);
});

(async () => {
  try {
    await listen(HOST);
  } catch (err) {
    console.error(err.code === "EADDRINUSE"
      ? `Port ${LISTEN_PORT} is taken - is servo-web already running? Try --listen <other port>.`
      : err.message);
    process.exit(1);
  }
  if (HOST === "127.0.0.1") await listen("::1").catch(() => {});  // no IPv6: fine, just slower
  const url = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${LISTEN_PORT}`;
  console.log(`Servo web control: ${url}   (Ctrl+C to stop)`);
  if (HOST === "0.0.0.0") console.log("Listening on all interfaces - anyone on this network can move the servos.");
  await connect();
  if (args.includes("--open") && process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  }
  statusLoop();
})();
