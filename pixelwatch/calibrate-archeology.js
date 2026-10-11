// Pick the control pixels for archeology.js, visually.
//
//   node calibrate-archeology.js            -> every group, 5s countdown before each capture
//   node calibrate-archeology.js --only A   -> just group A; B, C, D, E stay as they are
//   node calibrate-archeology.js --add B    -> ADD variations to B, keeping the saved ones
//                                              and everything else (add-b-archeology.js)
//   node calibrate-archeology.js --add C    -> the same for C (add-c-archeology.js)
//   node calibrate-archeology.js --delay 0  -> capture immediately
//   node calibrate-archeology.js --no-open  -> don't open a browser tab, just print the address
//
// Groups, in order: A (28 blocks of 10x10), B and C (1 or more variations
// each - present when any of them is), then D, E (one pixel each). In a
// group, each click adds one; Backspace removes the last, the arrow keys nudge
// it, and Enter moves to the next group once this one is done. Clicking a
// group's chip goes back to it. For A, click the middle of each block: the
// 10x10 square around the click is what gets checked.
//
// The pixels are usually not all on screen at the same time, so the picker can
// recapture whenever needed. Each pick's colours are read from whichever
// screenshot was on screen when it was picked, and stay with it.
//
// Serves picker-groups.html and saves to config-archeology.json, which nothing else
// uses. Saving replaces only the groups picked this time (with --add, appends
// to that group instead): everything else in the file - the other groups, and
// all the settings - is kept as it is.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { exec } = require("child_process");
const { screen, FileType } = require("@nut-tree-fork/nut-js");
const config = require("./config-archeology.js");

const args = process.argv.slice(2);
const delayIdx = args.indexOf("--delay");
const DEFAULT_DELAY = delayIdx !== -1 ? Number(args[delayIdx + 1]) : 5;
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx !== -1
  ? String(args[onlyIdx + 1] || "").toUpperCase().split(",").map((k) => k.trim()).filter(Boolean)
  : null;
const addIdx = args.indexOf("--add");
const ADD = addIdx !== -1 ? String(args[addIdx + 1] || "").toUpperCase().trim() : null;
const NO_OPEN = args.includes("--no-open");
const PORT = 7338;

// The groups picked this time, and the ones kept from the file.
const GROUPS = ADD !== null ? config.GROUPS.filter((g) => g.key === ADD)
  : ONLY ? config.GROUPS.filter((g) => ONLY.includes(g.key))
  : config.GROUPS;
const KEPT = config.GROUPS.filter((g) => !GROUPS.includes(g));
// With --add: the group's variations already saved, which stay first.
let saved = [];

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
  const file = await screen.capture("pixelwatch-archeology-shot", FileType.PNG, os.tmpdir());
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

const describe = (g) => (g.variations ? `${g.count} or more variations` :
  `${g.count} ${g.block ? `block${g.count > 1 ? "s" : ""} of ${g.block}x${g.block}` :
                          `pixel${g.count > 1 ? "s" : ""}`}`);

(async () => {
  if (!Number.isFinite(DEFAULT_DELAY) || DEFAULT_DELAY < 0) {
    console.error("--delay must be a non-negative number of seconds");
    process.exit(1);
  }

  if (ADD !== null) {
    const withVariations = config.GROUPS.filter((g) => g.variations).map((g) => g.key);
    if (ONLY) {
      console.error("--add and --only can't be used together");
      process.exit(1);
    }
    if (!withVariations.includes(ADD)) {
      console.error(`--add takes a group that has variations: ${withVariations.join(", ")}` +
                    (ADD ? ` (not ${ADD})` : ""));
      process.exit(1);
    }
  }
  if (ONLY) {
    const unknown = ONLY.filter((k) => !config.GROUPS.some((g) => g.key === k));
    if (!ONLY.length || unknown.length) {
      console.error(`--only takes group letters separated by commas: ${config.GROUPS.map((g) => g.key).join(", ")}` +
                    (unknown.length ? ` (not a group: ${unknown.join(", ")})` : ""));
      process.exit(1);
    }
  }
  if (ONLY || ADD !== null) {
    // What's kept has to be there already, or the file ends up incomplete -
    // with --add that includes the group being added to.
    let existing;
    try {
      existing = readExisting();
    } catch (err) {
      console.error(`Cannot read ${config.CONFIG_PATH}: ${err.message}`);
      process.exit(1);
    }
    const px = existing.pixels || {};
    const needed = ADD !== null ? config.GROUPS : KEPT;
    const lacking = needed.filter((g) => !Array.isArray(px[g.key]) || !config.enough(g, px[g.key].length));
    if (lacking.length) {
      console.error(`${ADD !== null ? `--add ${ADD}` : `--only ${ONLY.join(",")}`} keeps ` +
                    `${ADD !== null ? "everything" : "the other groups"} in ${config.CONFIG_PATH}, but ` +
                    `${lacking.map((g) => g.key).join(", ")} ${lacking.length > 1 ? "aren't" : "isn't"} ` +
                    "calibrated there. Run without --only/--add to pick every group.");
      process.exit(1);
    }
    if (ADD !== null) saved = px[ADD];
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
    groups: GROUPS,
    kept: KEPT.map((g) => g.label),
    blockFrom: config.BLOCK_FROM,
    // With --add: the group added to, and its variations already saved.
    adding: ADD !== null ? { key: ADD, saved } : null,
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
        const groups = picked.groups || {};
        for (const g of GROUPS) {
          const list = groups[g.key];
          if (!Array.isArray(list) || !config.enough(g, list.length)) {
            fail(400, `group ${g.key} needs ${describe(g)}`);
            return;
          }
          if (g.block && !list.every((p) => p && config.parseBlock(p.block, g.block))) {
            fail(400, `group ${g.key} is missing its ${g.block}x${g.block} block colours`);
            return;
          }
        }

        // Read the file again now, and keep everything in it that wasn't
        // picked this time exactly as it is.
        let existing;
        try {
          existing = readExisting();
        } catch (err) {
          fail(500, `cannot read ${config.CONFIG_PATH}: ${err.message}`);
          return;
        }
        const pixels = { ...(existing.pixels || {}) };
        for (const g of GROUPS) {
          const picks = groups[g.key].map((p) => (g.block
            ? { x: p.x, y: p.y, color: p.color, block: p.block }
            : { x: p.x, y: p.y, color: p.color }));
          // --add appends after the variations already in the file.
          pixels[g.key] = g.key === ADD ? [...(pixels[g.key] || []), ...picks] : picks;
        }
        const file = config.save({ ...existing, pixels });

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: file }));

        console.log("");
        for (const g of GROUPS) {
          const list = groups[g.key];
          const shots = [...new Set(list.map((p) => p.captureId))].join(", ");
          if (g.variations) {
            const first = pixels[g.key].length - list.length;   // index of the first one picked now
            list.forEach((p, i) => console.log(
              `${g.key === ADD ? "Added" : "Saved"} ${g.label}${first + i + 1}: ` +
              `(${p.x}, ${p.y}) ${config.toHex(p.color)}  [capture #${p.captureId}]`
            ));
            console.log(`${g.label} now has ${pixels[g.key].length} variation(s) - ` +
                        "present when any one of them is.");
          } else if (g.count > 1) {
            console.log(`Saved ${g.label}: ${describe(g)}  [capture #${shots}]`);
          } else {
            const p = list[0];
            console.log(`Saved ${g.label}: (${p.x}, ${p.y}) ${config.toHex(p.color)}  [capture #${p.captureId}]`);
          }
        }
        if (KEPT.length) console.log(`Kept ${KEPT.map((g) => g.label).join(", ")} as they were.`);
        if (ADD !== null) {
          const kept = pixels[ADD].length - groups[ADD].length;
          if (kept > 0) console.log(`Kept ${ADD}1${kept > 1 ? `-${ADD}${kept}` : ""} as ${kept > 1 ? "they were" : "it was"}.`);
        }
        console.log(`-> ${file}`);
        console.log("Now run:  node pixelwatch/archeology.js");
        setTimeout(() => { server.close(); process.exit(0); }, 250);
      });

    } else {
      res.writeHead(404).end("not found");
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${PORT}/`;
    if (ADD !== null) {
      console.log(`\nOpen ${url} and pick one or more new variations of ${ADD}.`);
      console.log(`${ADD} already has ${saved.length} - they stay, and the new ones are added after them:`);
      saved.forEach((p, i) => console.log(`  ${ADD}${i + 1}: (${p.x}, ${p.y}) ${config.toHex(p.color)}`));
      console.log(`${ADD} counts as present when any one of its variations is.`);
    } else {
      console.log(`\nOpen ${url} and pick:`);
      for (const g of GROUPS) {
        console.log(`  ${g.label} (${describe(g)}) - ${g.rule}`);
      }
    }
    if (KEPT.length) console.log(`Keeping ${KEPT.map((g) => g.label).join(", ")} from the existing calibration.`);
    console.log("Recapture from the page whenever a group needs a different screen state.");
    if (!NO_OPEN) {
      exec(`start "" "${url}"`, { shell: "cmd.exe" }, (err) => {
        if (err) console.log("(could not open a browser automatically)");
      });
    }
  });
})().catch((err) => {
  console.error("calibrate-archeology failed:", err.message);
  process.exit(1);
});
