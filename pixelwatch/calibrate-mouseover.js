// Pick pixel A for mouseover.js, visually.
//
//   node calibrate-mouseover.js            -> 5s countdown, screenshot, pick pixel A
//   node calibrate-mouseover.js --delay 0  -> capture immediately
//   node calibrate-mouseover.js --no-open  -> don't open a browser tab, just print the address
//
// Only pixel A is picked here. The 28 inventory spaces aren't: mouseover reads
// them from archeology's calibration (calibrate-archeology.js --only A).
//
// Recapture in the page whenever pixel A isn't on screen yet; its colour is
// read from whichever screenshot was on screen when it was picked.
//
// Serves picker-groups.html and saves to config-mouseover.json, which nothing
// else uses. Saving replaces only pixel A; any settings already in the file stay.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { exec } = require("child_process");
const { screen, FileType } = require("@nut-tree-fork/nut-js");
const config = require("./config-mouseover.js");

const args = process.argv.slice(2);
const delayIdx = args.indexOf("--delay");
const DEFAULT_DELAY = delayIdx !== -1 ? Number(args[delayIdx + 1]) : 5;
const NO_OPEN = args.includes("--no-open");
const PORT = 7340;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readExisting = () =>
  fs.existsSync(config.CONFIG_PATH) ? JSON.parse(fs.readFileSync(config.CONFIG_PATH, "utf8")) : {};

// Read a PNG's dimensions straight from its IHDR chunk: 8-byte signature, then
// chunk length + "IHDR", then width and height as big-endian uint32.
function pngSize(buf) {
  if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("screenshot is not a valid PNG");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Current screenshot, replaced on every capture.
const shot = { bytes: null, width: 0, height: 0, scale: 0, id: 0 };
let logicalW = 0, logicalH = 0;

async function capture() {
  const file = await screen.capture("pixelwatch-mouseover-shot", FileType.PNG, os.tmpdir());
  const bytes = fs.readFileSync(file);
  const { width, height } = pngSize(bytes);

  logicalW = await screen.width();
  logicalH = await screen.height();
  const scale = width / logicalW;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("could not work out the display scale factor");
  }

  shot.bytes = bytes;
  shot.width = width;
  shot.height = height;
  shot.scale = scale;
  shot.id += 1;
  return shot;
}

async function countdown(seconds) {
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(`\rCapturing in ${i}s...  `);
    await sleep(1000);
  }
  if (seconds > 0) process.stdout.write("\rCapturing...          \n");
}

(async () => {
  if (!Number.isFinite(DEFAULT_DELAY) || DEFAULT_DELAY < 0) {
    console.error("--delay must be a non-negative number of seconds");
    process.exit(1);
  }

  // Not needed to pick pixel A, but mouseover won't run without it - say so now.
  try {
    const inv = config.loadInventory();
    console.log(`Inventory: ${inv.spaces.length} spaces from archeology's calibration (${inv.file}).`);
  } catch (err) {
    console.log(`Note: ${err.message}`);
  }

  console.log("Bring the window you want to watch to the front.");
  await countdown(DEFAULT_DELAY);
  await capture();
  console.log(`Captured ${shot.width}x${shot.height} (physical)`);
  console.log(`Logical screen ${logicalW}x${logicalH}, scale ${shot.scale}x`);

  const pageHtml = fs.readFileSync(path.join(__dirname, "picker-groups.html"));

  const meta = () => JSON.stringify({
    scale: shot.scale,
    logicalW, logicalH,
    captureId: shot.id,
    defaultDelay: DEFAULT_DELAY,
    groups: config.GROUPS,
    kept: [],
    blockFrom: config.BLOCK_FROM,
    adding: null,
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/" || url.pathname.startsWith("/index")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageHtml);

    } else if (url.pathname === "/shot.png") {
      // Never cached: the bytes change on every recapture.
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store, max-age=0",
      });
      res.end(shot.bytes);

    } else if (url.pathname === "/meta") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(meta());

    } else if (url.pathname === "/capture" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let delay = DEFAULT_DELAY;
        try {
          const parsed = JSON.parse(body || "{}");
          if (Number.isFinite(parsed.delay) && parsed.delay >= 0) delay = parsed.delay;
        } catch { /* fall back to the default */ }

        try {
          // Timed here rather than in the page: a backgrounded tab throttles
          // its timers, and the whole point is that the tab is not in front.
          console.log(`\nRecapture requested, ${delay}s...`);
          await sleep(delay * 1000);
          await capture();
          console.log(`Captured ${shot.width}x${shot.height} (capture #${shot.id})`);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(meta());
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

    } else if (url.pathname === "/save" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const fail = (code, error) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify({ error }));
        };
        let picked;
        try {
          picked = JSON.parse(body);
        } catch {
          fail(400, "bad json");
          return;
        }
        const list = (picked.groups || {}).A;
        const p = Array.isArray(list) && list.length === 1 ? list[0] : null;
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !p.color) {
          fail(400, "pixel A needs 1 pick");
          return;
        }

        // Read the file again now, and keep everything else in it as it is.
        let existing;
        try {
          existing = readExisting();
        } catch (err) {
          fail(500, `cannot read ${config.CONFIG_PATH}: ${err.message}`);
          return;
        }
        const pixels = { ...(existing.pixels || {}), A: [{ x: p.x, y: p.y, color: p.color }] };
        const file = config.save({ ...existing, pixels });

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: file }));

        console.log(`\nSaved pixel A: (${p.x}, ${p.y}) ${config.toHex(p.color)}  [capture #${p.captureId}]`);
        console.log(`-> ${file}`);
        console.log("Now run:  node pixelwatch/mouseover.js");
        setTimeout(() => { server.close(); process.exit(0); }, 250);
      });

    } else {
      res.writeHead(404).end("not found");
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${PORT}/`;
    console.log(`\nOpen ${url} and pick pixel A - ${config.GROUPS[0].rule}.`);
    console.log("Recapture from the page if pixel A isn't on screen yet.");
    if (!NO_OPEN) {
      exec(`start "" "${url}"`, { shell: "cmd.exe" }, (err) => {
        if (err) console.log("(could not open a browser automatically)");
      });
    }
  });
})().catch((err) => {
  console.error("calibrate-mouseover failed:", err.message);
  process.exit(1);
});
