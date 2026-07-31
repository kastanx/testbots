# Vision Tool — local inference service

Implementation of [green-click-bot-v2.md](../green-click-bot-v2.md).

`POST` a frame, get back **where you are standing** and **the pixel boxes of the
clickable targets**. That is the whole product. It reports facts; deciding what
to do with them belongs to a consumer that does not exist yet.

```
collector/      Electron app — capture mode (record frames) + label mode (draw boxes)
monitor/        Electron panel — live HUD showing what to click, park it on the side
tools/          HSV tuning, target labelling, live watcher
ml/             dataset prep, training and validation for both models
server/         the deliverable: FastAPI service + acceptance checker
_v1_clickbot_archive/   the retired v1 clicking bot, kept only for reference
```

**Double-click launchers** (no terminal, no Python on PATH needed):
`START MONITOR.bat` · `LABEL TARGETS.bat` · `run.bat <script> [args]` for anything else.

## Non-goals, and two deliberate departures

No mouse or keyboard injection, and no window focus management. The v1 clicking
bot stays retired in `_v1_clickbot_archive/`; nothing clicks anything.

Two things the v2 plan listed as non-goals were added on purpose after the plan
was written, because the consumer needed them:

- **`/analyze/screen` captures the screen.** The plan said "no capture loop
  inside the service" — this is not a loop, it is one grab per request, and the
  service stays stateless. It exists so the consumer never has to know about the
  1280-wide rule.
- **`target` picks which clickable is correct.** The plan said that decision
  belongs to the consumer. It moved here because the answer is a fixed geometric
  rule per spot, and duplicating it in every consumer would be worse.

---

## The JSON contract

`POST /analyze` — `multipart/form-data` field `file`, or JSON `{"image_b64": "..."}`.

```json
{
  "location": {
    "id": "spot_07",
    "confidence": 0.94,
    "top3": [
      {"id": "spot_07", "confidence": 0.94},
      {"id": "spot_04", "confidence": 0.03},
      {"id": "transit", "confidence": 0.01}
    ]
  },
  "target": {"cx": 812, "cy": 440, "x": 790, "y": 415, "w": 44, "h": 50,
             "class": "clickable", "confidence": 0.91},
  "clickables": [
    {"cx": 812, "cy": 440, "x": 790, "y": 415, "w": 44, "h": 50,
     "class": "clickable", "confidence": 0.91}
  ],
  "image": {"width": 1920, "height": 1080},
  "timing_ms": {"classify": 3.2, "detect": 9.8, "total": 14.1}
}
```

**`target` is the one box that matters** for the reported location — read this
and ignore `clickables` unless you want to see everything that was found. It is
`null` when no rule applies (`transit`, or a location with no entry in the
config's `targets` block). `clickables` always lists every detection.

### `POST` or `GET /analyze/screen`

Same answer, but the service grabs the screen itself — no upload. Adds a
`capture` block and a `capture` entry in `timing_ms`.

**Coordinates come back in screen pixels**, ready to click. Inference still runs
at `capture.detect_width` (1280) because that is the scale the collector
recorded at; the boxes are scaled back up afterwards. This matters — at native
resolution the green skill-level digits in the RuneLite HUD clear
`hsv.min_area` and show up as phantom targets, which is exactly what the
downscale suppresses.

```bash
curl http://127.0.0.1:8765/analyze/screen
```

Typical: capture 16 ms, classify 7 ms, detect 1.4 ms, ~25 ms total.

`?preview=1` additionally returns `preview_b64`, a JPEG of the exact downscaled
frame the decision was made on. Opt-in, and deliberately not part of the pinned
`/analyze` contract — it exists so the monitor panel can show what the service
actually saw rather than taking a second, slightly different capture.

### The monitor panel

Double-click **`START MONITOR.bat`**, or:

```bash
npm run monitor --prefix greenbot
```

An always-on-top window you park beside the game. It polls `/analyze/screen`
several times a second and shows the location with a top-3 confidence breakdown,
the live preview with every candidate outlined and the chosen target ringed in
amber, and the screen coordinate to click. The poll rate is a slider.

`START MONITOR.bat` starts the service first if it isn't already listening, and
polls `/health` until the models are loaded rather than guessing a delay.

Like the collector, the panel **excludes itself from screen capture**
(`setContentProtection`). It sits on the screen the service is grabbing, so
without that it would appear inside its own preview and inside the frames the
classifier sees.

### Choosing the target rule per spot

Every spot shows several identical-looking green platforms, so which one is
correct is geometric, not visual — nothing in the pixels distinguishes them.
Don't try to guess a rule from the outside; at some spots the right platform is
not any geometric extreme. Label it instead:

```bash
run.bat tools\label_targets.py
```

Every detected box is outlined and numbered. **Click the correct one** — it
saves and advances immediately. `N` if the target isn't among the boxes at all,
`S` to skip, `U` to undo, `Q` to stop. Labels persist in
`tools/target_labels.json`, so you can stop and resume.

On quit it scores every strategy against your clicks and prints the winner as
pasteable YAML. `--fit` re-runs that scoring without labelling again.

If no strategy reaches 100%, it falls back to `nearest_point` — the median
position of the boxes you actually clicked, normalized — which handles spots
where the right platform isn't an extreme. If it reports frames where the target
wasn't detected at all, that's an HSV problem, not a rule problem: run
`tools/tune_hsv.py`.

`tools/pick_review.py` renders what each strategy would click, if you want to
eyeball a rule after the fact.

Rules go in `config.yaml`:

```yaml
targets:
  spot_04: { pick: largest }
  spot_02: { pick: index, sort: x, index: 1 }
```

Strategies: `largest`, `smallest`, `leftmost`, `rightmost`, `topmost`,
`bottommost`, `nearest_center`, `index` (with `sort: x|y|area` and a 0-based
`index`, negatives counting from the end). Optional per spot: `roi: [x,y,w,h]`
to ignore boxes outside a region, and `min_area`/`max_area` overrides.

**Coordinate space.** Every coordinate is in **pixels of the image you
submitted, origin top-left**. `cx, cy` is the box centre — the point a consumer
would click. `x, y, w, h` is the full box. The service **never rescales**: if
you capture at one resolution and click at another, that mapping is your job.

**Honesty.** If location confidence is below `location_conf_threshold`, or the
class is `transit`, it is returned as-is with its real confidence. Nothing is
remapped to a spot and nothing is suppressed. There is no smoothing or majority
voting in the service — it is **stateless**, and you have the frame stream, so
vote over `top3` yourself if you want to.

**Backends.** `detector: hsv` in `config.yaml` swaps threshold detection in
behind the identical response shape (boxes get `"confidence": 1.0`). No
consumer change, server restart only.

> Feed it frames scaled the way the collector scales them — **max width 1280,
> aspect preserved**. Both models are trained on that; submitting raw 3440×1440
> frames is a domain shift you have not validated.

`GET /health` returns liveness, both model paths and class names, the active
backend, library versions, and an echo of the loaded config.

### Calling it

```bash
curl -F "file=@frame.jpg" http://127.0.0.1:8765/analyze
```

```js
const form = new FormData();
form.append('file', new Blob([await readFile('frame.jpg')]), 'frame.jpg');
const { location, clickables } = await (await fetch(
    'http://127.0.0.1:8765/analyze', { method: 'POST', body: form })).json();
```

---

## Setup

```bash
powershell -ExecutionPolicy Bypass -File greenbot/setup.ps1
```

CUDA torch first (order matters), then ultralytics, fastapi and friends. Prints
`CUDA True NVIDIA GeForce RTX 4070` when it worked. Every `python ...` below
assumes `greenbot/` is the working directory and the venv is active:

```bash
cd greenbot; .\.venv\Scripts\Activate.ps1
```

`server/config.yaml` is the **single source of truth** for host, port,
thresholds, HSV values and model paths. Model paths in it resolve against the
config file's own directory, never the process CWD.

---

## Phase 1 — is HSV good enough?

```bash
python tools/hsv_review.py
```

Samples frames evenly across every label and session, draws the HSV boxes, and
writes contact sheets to `tools/hsv_review_out/`. It prints a zero-box /
implausible-box-count percentage against the plan's ~2% rule — but that number
is a **lower bound proxy**. It cannot tell a box on a target from a box on a
player's green cloak or on a green UI icon. **Look at the sheets.**

More than ~2% wrong → Option B, train the detector. Essentially perfect →
Option A, ship `detector: hsv`.

**Result on this project (session_20260730_2024, 298 frames): Option A.** The
green-outlined agility platforms are detected cleanly; of 1251 boxes, **zero**
landed in the rightmost 10% of the frame, i.e. none on the game UI. So the
`clickables` half of the service works today with no labelling and no detector.

That verdict was measured on frames containing **no other players**, which is
the exact case Option B exists for. Re-run this once you have player-heavy
frames, and look specifically for boxes on green-wearing players.

```bash
python tools/tune_hsv.py --image ml/dataset/raw/<session>/<label>/<frame>.jpg
```

Live trackbars for `hsv.lo` / `hsv.hi` / `min_area` / `morph_kernel`, mask beside
detections. `S` writes them back into `server/config.yaml`, preserving comments.

---

## Phase 2 — bootstrap labels

```bash
python tools/propose_boxes.py
```

Writes a sibling `<stem>.txt` per frame so the editor opens with proposals to
correct instead of a blank canvas. **Images that already have a `.txt` are
skipped** — a re-run can never undo hand corrections. `--overwrite` forces it.

Label format: `0 cx cy w h`, normalized 0–1, 6 decimals, **LF, no trailing
newline**. A 0-byte `.txt` is a valid negative sample, not a missing label — do
not delete it. The editor round-trips these bytes exactly.

---

## Phase 3 — draw the boxes

```bash
npm start --prefix greenbot
```

Two modes. **Capture frames** records the location dataset:

| Key | Action |
|---|---|
| `Alt+Q` / `F7` | previous label |
| `Alt+E` / `F9` | next label |
| `Alt+W` / `F8` | toggle recording |

Rebind in `collector/hotkeys.json`; every accelerator listed for an action is
registered, so the F-keys above are just the second entry. The window footer
shows what actually bound, and the terminal prints it at startup.

These are **global** shortcuts — whatever you bind is swallowed system-wide
while capture mode is active. That is why the defaults are `Alt+` chords rather
than bare `Q`/`W`/`E`: a bare letter would stop that letter reaching game chat
and would toggle recording every time you typed it. Bare letters are allowed if
you accept that trade-off. Label mode unregisters all of them so they cannot
fight the box editor.

The collector window excludes itself from the capture
(`setContentProtection`) — it sits on the screen it is recording and displays
the current label, so without that every frame would carry a visual shortcut
correlated with its own answer.

**Label boxes** is the editor:

| Key / action | Effect |
|---|---|
| drag on empty space | draw a new box |
| click a box | select it |
| drag body / handles | move / resize |
| `Del` `Backspace` | delete selected |
| `S` | save `.txt` and advance |
| `A` `D` | previous / next image |

Progress shows `n / total` and a live count of zero-box images. Capture hotkeys
are unregistered in label mode so they cannot fight the editor.

Budget ~2–4 s per image with proposals pre-filled; **300–600 corrected images**
spread across locations and sessions, with players present in many of them.

```bash
python ml/prepare_detect_dataset.py --val-newest 1
```

Builds `ml/dataset-detect/{images,labels}/{train,val}` + `data.yaml`, split by
session. Only images with a `.txt` are included.

---

## Phase 4 — train and validate

```bash
python ml/train.py                # location classifier -> server/models/location_cls.pt
python ml/evaluate.py

python ml/train_detector.py       # clickable detector -> server/models/clickable_det.pt
python ml/evaluate_detector.py
```

`ml/evaluate_detector.py` enforces the plan's gate — **precision and recall
≥ 0.95** on the held-out session — and exits non-zero on failure. It renders
frames with predictions and ground truth into `ml/detect_review/`, worst
offenders first, for the "no boxes on players" eyeball. If players trigger false
positives, label more frames containing players as hard negatives and retrain.

Both evaluators refuse to give a pass verdict on a diagnostic (single-session)
split. Validation means **entire held-out sessions**; shuffling near-duplicate
consecutive frames reports a fake number.

---

## Phase 5 — run it

```bash
python server/main.py
```

or double-click `server/start_server.bat`. Binds `127.0.0.1` only.

```bash
python server/test_acceptance.py --frame ml/dataset/raw/<session>/<label>/<frame>.jpg
```

Checks the Phase 6 list mechanically: schema conformance key-by-key (extra,
renamed, retyped and **reordered** keys all fail), coordinate-space rule,
b64/multipart equivalence, statelessness, latency (mean **and** p95 ≤ 50 ms),
and N sequential requests with zero errors and flat RSS. Exits non-zero on
failure.

Three bullets it reports as SKIP rather than guessing: detector precision/recall
and the player eyeball (run `ml/evaluate_detector.py`), the low-confidence
honesty path unless you feed it a `transit` frame, and backend swappability
unless you re-run under the other backend with `--expect-shape`.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Server won't start | `server/models/` is empty. Train, or set `detector: hsv`. |
| Black capture / no source | Game is in *exclusive* fullscreen. Use borderless. |
| Collector hotkeys dead | Another app owns them — use the `Ctrl+Alt` variants shown in the footer. |
| Boxes land in the wrong place | You submitted a differently-scaled frame than you are mapping onto. The service never rescales. |
| `CUDA not available` | torch resolved to the CPU build — re-run `setup.ps1`. |
