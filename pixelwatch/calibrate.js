// Pick the pixel to watch, visually.
//
//   node calibrate.js            -> screenshot after 5s, then pick in the browser
//   node calibrate.js --delay 0  -> screenshot immediately
//
// Takes a screenshot, serves it on localhost, and waits for you to click a
// pixel. Saves the coordinates and colour to config.json for watch.js.
//
// Screenshots come out at the physical resolution while nut-js colorAt() takes
// logical (DPI-scaled) coordinates, so the picker divides by `scale` before
// saving. On a 300% display that is a factor of 3.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { exec } = require("child_process");
const { screen, FileType } = require("@nut-tree-fork/nut-js");
const config = require("./config.js");

const args = process.argv.slice(2);
const delayIdx = args.indexOf("--delay");
const delaySec = delayIdx !== -1 ? Number(args[delayIdx + 1]) : 5;
const PORT = 7333;

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

async function countdown(seconds) {
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(`\rScreenshot in ${i}s...  `);
    await sleep(1000);
  }
  if (seconds > 0) process.stdout.write("\rTaking screenshot...   \n");
}

(async () => {
  if (!Number.isFinite(delaySec) || delaySec < 0) {
    console.error("--delay must be a non-negative number of seconds");
    process.exit(1);
  }

  console.log("Bring the window you want to watch to the front.");
  await countdown(delaySec);

  const shotPath = await screen.capture(
    "pixelwatch-shot", FileType.PNG, os.tmpdir()
  );
  const pngBytes = fs.readFileSync(shotPath);
  const { width: physW, height: physH } = pngSize(pngBytes);

  const logicalW = await screen.width();
  const logicalH = await screen.height();
  const scale = physW / logicalW;

  console.log(`Captured ${physW}x${physH} (physical)`);
  console.log(`Logical screen ${logicalW}x${logicalH}, scale ${scale}x`);

  if (!Number.isFinite(scale) || scale <= 0) {
    console.error("Could not work out the display scale factor. Aborting.");
    process.exit(1);
  }

  const pageHtml = fs.readFileSync(path.join(__dirname, "picker.html"));

  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url.startsWith("/index")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageHtml);
    } else if (req.url === "/shot.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(pngBytes);
    } else if (req.url === "/meta") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ scale, logicalW, logicalH }));
    } else if (req.url === "/save" && req.method === "POST") {
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

        const existing = fs.existsSync(config.CONFIG_PATH)
          ? JSON.parse(fs.readFileSync(config.CONFIG_PATH, "utf8"))
          : {};

        // Keep any tuning the user already did; only replace the pixel itself.
        const saved = config.save({
          ...existing,
          x: picked.x,
          y: picked.y,
          color: picked.color,
        });

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: saved }));

        console.log(
          `\nSaved pixel (${picked.x}, ${picked.y}) ` +
          `${config.toHex(picked.color)} -> ${saved}`
        );
        console.log("Now run:  npm run watch");
        setTimeout(() => { server.close(); process.exit(0); }, 250);
      });
    } else {
      res.writeHead(404).end("not found");
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${PORT}/`;
    console.log(`\nOpen ${url} and click the pixel you want to watch.`);
    exec(`start "" "${url}"`, { shell: "cmd.exe" }, (err) => {
      if (err) console.log("(could not open a browser automatically)");
    });
  });
})().catch((err) => {
  console.error("calibrate failed:", err.message);
  process.exit(1);
});
