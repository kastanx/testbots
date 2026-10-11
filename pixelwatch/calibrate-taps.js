// Pick the three pixels for watch-taps.js, visually, each from its own screenshot.
//
//   node calibrate-taps.js            -> 5s countdown before each capture
//   node calibrate-taps.js --delay 0  -> capture immediately
//
// Serves picker3.html read-only - the page takes its spot labels from /meta -
// and saves to config-taps.json, which nothing else uses.
//
// The three pixels are usually not all on screen at the same time, so the
// picker can recapture between spots. Each spot's colour is read from
// whichever screenshot was on screen when you picked it, and stays with it.
//
// Screenshots come out at the physical resolution while the watcher reads
// logical (DPI-scaled) coordinates, so the picker divides by `scale` before
// saving.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { exec } = require("child_process");
const { screen, FileType } = require("@nut-tree-fork/nut-js");
const config = require("./config-taps.js");

const args = process.argv.slice(2);
const delayIdx = args.indexOf("--delay");
const DEFAULT_DELAY = delayIdx !== -1 ? Number(args[delayIdx + 1]) : 5;
const PORT = 7337;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read a PNG's dimensions straight from its IHDR chunk: 8-byte signature, then
// chunk length + "IHDR", then width and height as big-endian uint32.
// Saves pulling in an image library just to get two numbers.
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
  const file = await screen.capture("pixelwatch-taps-shot", FileType.PNG, os.tmpdir());
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

  console.log("Bring the window you want to watch to the front.");
  await countdown(DEFAULT_DELAY);
  await capture();
  console.log(`Captured ${shot.width}x${shot.height} (physical)`);
  console.log(`Logical screen ${logicalW}x${logicalH}, scale ${shot.scale}x`);

  const pageHtml = fs.readFileSync(path.join(__dirname, "picker3.html"));

  const meta = () => JSON.stringify({
    scale: shot.scale,
    logicalW, logicalH,
    captureId: shot.id,
    defaultDelay: DEFAULT_DELAY,
    spots: config.SPOTS.map((s) => ({ label: s.label, rule: s.rule })),
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
        let picked;
        try {
          picked = JSON.parse(body);
        } catch {
          res.writeHead(400).end('{"error":"bad json"}');
          return;
        }
        if (!Array.isArray(picked.spots) || picked.spots.length !== config.SPOTS.length) {
          res.writeHead(400).end('{"error":"wrong number of spots"}');
          return;
        }

        const existing = fs.existsSync(config.CONFIG_PATH)
          ? JSON.parse(fs.readFileSync(config.CONFIG_PATH, "utf8"))
          : {};

        // Keep any tuning already in the file; only replace the pixels.
        const saved = config.save({
          ...existing,
          spots: picked.spots.map((s) => ({ x: s.x, y: s.y, color: s.color })),
        });

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: saved }));

        console.log("");
        picked.spots.forEach((s, i) => {
          console.log(
            `Saved ${config.SPOTS[i].label.padEnd(8)} (${s.x}, ${s.y}) ` +
            `${config.toHex(s.color)}  [capture #${s.captureId}]`
          );
        });
        console.log(`-> ${saved}`);
        console.log("Now run:  node pixelwatch/watch-taps.js");
        setTimeout(() => { server.close(); process.exit(0); }, 250);
      });

    } else {
      res.writeHead(404).end("not found");
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${PORT}/`;
    console.log(`\nOpen ${url} and pick the three pixels.`);
    config.SPOTS.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.label.padEnd(8)} ${s.rule}`);
    });
    console.log("Recapture from the page whenever a pixel needs a different screen state.");
    exec(`start "" "${url}"`, { shell: "cmd.exe" }, (err) => {
      if (err) console.log("(could not open a browser automatically)");
    });
  });
})().catch((err) => {
  console.error("calibrate-taps failed:", err.message);
  process.exit(1);
});
