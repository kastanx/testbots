# Green-Click Vision Bot — Implementation Plan

Target machine: **Windows + NVIDIA RTX 4070**. Your language: **JavaScript** (Electron for tooling). Python is installed as a managed dependency and used only where the ML ecosystem lives (training + runtime bot).

---

## 1. Architecture overview

```
┌────────────────────────┐        ┌──────────────────────────┐        ┌─────────────────────────┐
│  ELECTRON COLLECTOR    │        │  PYTHON TRAINING          │        │  PYTHON RUNTIME BOT      │
│  (JS — you build this) │  --->  │  (mostly CLI commands)    │  --->  │  (~150 lines, provided   │
│                        │        │                           │        │   as skeleton below)     │
│ • capture screen 3 fps │        │ • assemble train/val      │        │ • bettercam 30 Hz capture│
│ • hotkey label switch  │        │ • YOLO11n-cls on 4070     │        │ • HSV green detection    │
│ • save session/label/  │        │ • confusion matrix eval   │        │ • classifier @ 3–5 Hz    │
│   frame_XXXX.jpg       │        │ • export best.pt          │        │ • vote smoothing → zone  │
└────────────────────────┘        └──────────────────────────┘        │ • zone rules → click     │
                                                                      └─────────────────────────┘
```

Key decisions (from our discussion, frozen here):

| Concern | Decision | Why |
|---|---|---|
| Green detection | OpenCV HSV threshold, every frame | 1–3 ms, deterministic, no ML needed |
| "Where am I" (20 spots + transit) | YOLO11n-cls classifier, 21 classes | Spots look similar; hashing/ORB too fragile with player noise |
| Runtime inference | Ultralytics `YOLO("best.pt")` directly on the 4070 | Avoids hand-rolled ONNX preprocessing bugs; ~2–3 ms anyway |
| Data collection app | Electron | You know JS; it's a tooling app, perf doesn't matter at 3 fps |
| Runtime bot | Python | bettercam / pydirectinput have no good JS equivalents |
| Game display mode | **Borderless fullscreen, native res, primary monitor** | Makes collector capture == runtime capture == click coordinates. Non-negotiable for consistency |
| Clicks | pydirectinput + gaussian jitter + cooldowns | Games ignore synthetic pyautogui events; jitter for human-ish cadence |

⚠️ Standing reminder: if this world is an online game with anti-cheat, automation likely violates ToS and carries ban risk regardless of jitter. Build the kill switch first, decide risk yourself.

---

## 2. Phase 0 — Install prerequisites (~30 min)

Open **PowerShell** (normal user):

```powershell
# Node LTS (for the Electron collector)
winget install -e --id OpenJS.NodeJS.LTS

# Python 3.11 (3.11 = safest for the ML stack)
winget install -e --id Python.Python.3.11

# optional but recommended
winget install -e --id Git.Git
winget install -e --id Microsoft.VisualStudioCode
```

Close and reopen the terminal, then verify:

```powershell
node --version        # v20.x or v22.x
py -3.11 --version    # Python 3.11.x
nvidia-smi            # driver visible; update GeForce driver if this fails
```

Create the project:

```powershell
mkdir C:\dev\greenbot
cd C:\dev\greenbot
mkdir collector, ml, ml\dataset, ml\dataset\raw, bot
```

Python virtual environment + ML packages. **Order matters** — install CUDA torch *before* ultralytics, otherwise you get the CPU build:

```powershell
cd C:\dev\greenbot
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1

pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
pip install ultralytics opencv-python bettercam pydirectinput keyboard numpy
```

**Definition of done:**

```powershell
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# → True NVIDIA GeForce RTX 4070
```

---

## 3. Phase 1 — Electron "Frame Collector" app (~4–8 h)

Purpose: you play the game; the app captures the screen at ~3 fps into `ml/dataset/raw/<session>/<label>/frame_<ts>.jpg`. You switch labels and toggle recording with **global hotkeys** (the game keeps focus).

### Features (v1 scope — resist adding more)

- Pick capture source on startup (the screen the game runs on).
- Label list loaded from `labels.json`: `spot_01 … spot_20, transit`.
- Global hotkeys: **F7 / F9** = previous / next label, **F8** = toggle recording.
- Small **always-on-top** window showing: current label, ● REC indicator, per-label frame counts.
- New session folder (`session_YYYYMMDD_HHMM`) each app launch.
- Frames downscaled to max width 1280, JPEG q85 (plenty for 224–320 px training, keeps a full pass ~1 GB).

### Project layout

```
collector/
  package.json
  main.js        # window, globalShortcut, IPC, fs writes
  preload.js     # contextBridge API
  index.html     # tiny UI: source picker, label display, counters, preview
  renderer.js    # getUserMedia capture loop, canvas → JPEG blob → IPC
  labels.json
```

```powershell
cd collector
npm init -y
npm i -D electron
# package.json: "main": "main.js", "scripts": { "start": "electron ." }
```

### The non-obvious glue code

**main.js** — sources come from the main process in modern Electron; hotkeys must be `globalShortcut` so they fire while the game is focused:

```js
const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer } = require("electron");
const fs = require("fs/promises");
const path = require("path");

const labels = require("./labels.json");           // ["spot_01", ... , "transit"]
let labelIdx = 0, recording = false, win;
const session = "session_" + new Date().toISOString().slice(0,16).replace(/[-:T]/g, "");
const RAW = path.join(__dirname, "..", "ml", "dataset", "raw", session);

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 380, height: 260, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, "preload.js") }
  });
  win.loadFile("index.html");

  ipcMain.handle("get-sources", () =>
    desktopCapturer.getSources({ types: ["screen"] })
      .then(s => s.map(x => ({ id: x.id, name: x.name }))));

  ipcMain.handle("save-frame", async (_e, buf) => {
    if (!recording) return;
    const dir = path.join(RAW, labels[labelIdx]);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `frame_${Date.now()}.jpg`), Buffer.from(buf));
    win.webContents.send("state", { label: labels[labelIdx], recording, saved: 1 });
  });

  const update = () => win.webContents.send("state", { label: labels[labelIdx], recording, saved: 0 });
  globalShortcut.register("F8", () => { recording = !recording; update(); });
  globalShortcut.register("F9", () => { labelIdx = (labelIdx + 1) % labels.length; update(); });
  globalShortcut.register("F7", () => { labelIdx = (labelIdx + labels.length - 1) % labels.length; update(); });
  update();
});
app.on("will-quit", () => globalShortcut.unregisterAll());
```

**renderer.js** — capture the chosen screen and pump frames:

```js
const FPS = 3, MAXW = 1280;

async function start(sourceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId } }
  });
  const video = document.getElementById("preview");
  video.srcObject = stream; await video.play();

  const canvas = document.createElement("canvas");
  setInterval(async () => {
    const scale = Math.min(1, MAXW / video.videoWidth);
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.85));
    window.api.saveFrame(await blob.arrayBuffer());   // main.js drops it if not recording
  }, 1000 / FPS);
}
```

**preload.js** exposes `getSources`, `saveFrame`, and an `onState` subscription via `contextBridge` — standard boilerplate.

### Definition of done

Run `npm start`, pick the screen, press F8, alt-tab into anything, walk around, press F8 again. Files appear under `ml/dataset/raw/session_.../spot_01/`, the mini window shows the label and REC state, F7/F9 cycle labels while the game has focus.

Fallback if the game swallows F-keys: register `CommandOrControl+Alt+1..0` style accelerators instead, or alt-tab to toggle — annoying but workable.

---

## 4. Phase 2 — Data collection protocol (~45 min per session, 3–4 sessions)

Rules that determine whether training works at all:

1. **Game in borderless fullscreen at native resolution on the primary monitor.** Same forever after — collection, training, runtime.
2. One **session = one full pass** over all 21 labels. At each spot: select label, F8, spend 30–60 s doing small in-place movements (pan camera, strafe within the spot's tolerance), F8 stop. ~100–180 frames per label per session.
3. `transit`: record continuously while walking between spots. This class is what stops the bot from clicking confidently while you're mid-move.
4. Repeat **3–4 sessions on different days / times / player densities**. Variety across sessions beats frame count within one.
5. Capture reality: if popups, chat windows, or weather effects occur in the game, let them happen during recording.
6. Never mix sessions when splitting: **validation = entire held-out sessions** (e.g., the newest one). Random shuffling of near-duplicate consecutive frames gives you a fake 99.9% and a broken bot.

Disk math: 21 labels × ~150 frames × ~150 KB ≈ 0.5 GB per session. Trivial.

---

## 5. Phase 3 — Train on the 4070 (~1–2 h incl. dataset prep, training itself ≈ minutes)

### 5.1 Assemble train/val — `ml/prepare_dataset.py`

```python
import shutil, sys
from pathlib import Path

RAW = Path(__file__).parent / "dataset" / "raw"
OUT = Path(__file__).parent / "dataset"
VAL_SESSIONS = set(sys.argv[1:])          # e.g. python prepare_dataset.py session_202608011900

for split in ("train", "val"):
    d = OUT / split
    if d.exists(): shutil.rmtree(d)

for session in RAW.iterdir():
    split = "val" if session.name in VAL_SESSIONS else "train"
    for label_dir in session.iterdir():
        dst = OUT / split / label_dir.name
        dst.mkdir(parents=True, exist_ok=True)
        for f in label_dir.glob("*.jpg"):
            shutil.copy2(f, dst / f"{session.name}_{f.name}")

for split in ("train", "val"):
    for d in sorted((OUT / split).iterdir()):
        print(split, d.name, len(list(d.glob('*.jpg'))))
```

### 5.2 Train + evaluate

```powershell
cd C:\dev\greenbot; .\.venv\Scripts\Activate.ps1
python ml\prepare_dataset.py session_<your_newest>

yolo classify train model=yolo11n-cls.pt data=ml/dataset epochs=50 imgsz=224 batch=128 device=0 fliplr=0.0 flipud=0.0
```

- `fliplr=0.0` is **mandatory** — mirrored spots must not collapse into each other.
- Default random-erasing augmentation stays on: it simulates players occluding parts of the scene.
- 4070 handles batch 128 @ 224 px easily; a run is a few minutes.

Evaluate: open `runs/classify/train*/confusion_matrix.png` and the val top-1 accuracy.

| Result on held-out session | Action |
|---|---|
| top-1 ≥ 0.97, clean diagonal | Ship it → Phase 4 |
| Two specific spots confused | Retrain with `imgsz=320` (discriminative detail may be lost at 224); if still confused, the spots may be near-identical → handle with adjacency veto in Phase 5 |
| Broad mess | Data problem: more sessions, check labels weren't mis-keyed during recording |

Keep the winner as `runs/classify/train*/weights/best.pt`. Copy it to `bot/best.pt`.

### 5.3 Smoke test

```powershell
yolo classify predict model=bot/best.pt source=ml/dataset/val/spot_07 device=0
```

Spot-check a few predictions visually.

---

## 6. Phase 4 — Runtime bot (~4–6 h)

Design: **fast loop at 30 Hz** (capture + green detection + click logic), **classifier every 8th frame** (~4 Hz), zone decided by **majority vote over last 5 predictions** with confidence gating. `transit` or unstable vote ⇒ no clicking. Start in **dry-run mode**: overlay only, no clicks.

### `bot/config.json`

```json
{
  "hsv_lo": [40, 60, 60],
  "hsv_hi": [85, 255, 255],
  "min_area": 400,
  "conf_threshold": 0.70,
  "vote_window": 5,
  "vote_needed": 3,
  "classify_every_n": 8,
  "click_cooldown_ms": 1500,
  "zones": {
    "spot_01": { "pick": "leftmost" },
    "spot_02": { "pick": "largest" },
    "spot_03": { "pick": "index", "index": 1, "sort": "x" }
  }
}
```

(`pick` strategies: `leftmost`, `rightmost`, `largest`, `nearest_center`, `index` after sorting by x or y. Fill in all 20 as you learn the rules of your world.)

### `bot/main.py` — skeleton

```python
import ctypes; ctypes.windll.shcore.SetProcessDpiAwareness(2)   # BEFORE anything measures pixels
import json, time, random, collections
import cv2, numpy as np, bettercam, pydirectinput, keyboard
from ultralytics import YOLO

cfg = json.load(open("config.json"))
model = YOLO("best.pt")                       # runs on the 4070 automatically
names = model.names
votes = collections.deque(maxlen=cfg["vote_window"])
last_click = 0
DRY_RUN = True                                 # flip to False only after overlay looks right
pydirectinput.PAUSE = 0

cam = bettercam.create(output_color="BGR")
cam.start(target_fps=30)
print("F10 = quit. Dry run:", DRY_RUN)

frame_i = 0
zone = None
while not keyboard.is_pressed("f10"):          # kill switch — first feature, not last
    frame = cam.get_latest_frame()
    if frame is None: continue
    frame_i += 1

    # --- green candidates, every frame (~2 ms) ---
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, tuple(cfg["hsv_lo"]), tuple(cfg["hsv_hi"]))
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cands = [cv2.boundingRect(c) for c in cnts if cv2.contourArea(c) > cfg["min_area"]]

    # --- localization, every Nth frame ---
    if frame_i % cfg["classify_every_n"] == 0:
        r = model(frame, imgsz=224, verbose=False)[0]
        if float(r.probs.top1conf) >= cfg["conf_threshold"]:
            votes.append(names[int(r.probs.top1)])
        if votes:
            top, n = collections.Counter(votes).most_common(1)[0]
            zone = top if n >= cfg["vote_needed"] else None

    # --- decide + click ---
    target = pick_target(cands, cfg["zones"].get(zone)) if zone and zone != "transit" else None
    now = time.time() * 1000
    if target and now - last_click > cfg["click_cooldown_ms"]:
        x, y, w, h = target
        cx = int(x + w/2 + random.gauss(0, w/6))
        cy = int(y + h/2 + random.gauss(0, h/6))
        if DRY_RUN:
            cv2.drawMarker(frame, (cx, cy), (0,0,255), cv2.MARKER_CROSS, 30, 3)
        else:
            time.sleep(random.uniform(0.03, 0.12))
            pydirectinput.moveTo(cx, cy); pydirectinput.click()
        last_click = now

    # --- debug overlay ---
    for (x, y, w, h) in cands:
        cv2.rectangle(frame, (x, y), (x+w, y+h), (0,255,0), 2)
    cv2.putText(frame, f"zone={zone}", (20, 40), 0, 1, (255,255,255), 2)
    cv2.imshow("bot", cv2.resize(frame, None, fx=0.5, fy=0.5))
    cv2.waitKey(1)
```

`pick_target(cands, rule)` is ~15 lines of sorting/selection per the config — pure JS-style logic, just in Python.

### Definition of done (dry run)

Walk to each spot: overlay shows the correct `zone=` within ~1 s of arriving, shows `transit`/`None` while moving, green boxes wrap the right blobs, red cross lands where you'd click. Only then set `DRY_RUN = False`.

Click coordinates are frame coordinates because you capture the full primary monitor — no offset math needed. If clicks land offset anyway, the DPI awareness line isn't first, or Windows display scaling changed since capture.

---

## 7. Phase 5 — Hardening (ongoing, 2–4 h)

- **Anti-flap:** after a zone change, require the new zone to win 2 consecutive vote windows before clicking resumes.
- **Adjacency veto (if two spots confuse the model):** `adjacency.json` mapping each spot → reachable spots; reject a zone change that isn't reachable from the last confirmed zone unless the vote is unanimous 5/5. This plus the classifier is usually bulletproof.
- **Constellation cross-check:** optionally store expected green-blob count per zone; mismatch ⇒ skip clicking this cycle.
- **Humanization:** you already have gaussian click offsets + random pre-click delay; add occasional longer idle pauses (`random.random() < 0.02 → sleep 2–6 s`) and never click at a metronomic cadence.
- **HSV tuning:** if greens are missed/over-detected, write a 20-line script with cv2 trackbars on a saved frame to dial `hsv_lo/hi` and `min_area`.

---

## 8. Phase 6 — Iteration loop

When the bot mislocalizes or hesitates:

1. In the runtime loop, dump low-confidence frames (`top1conf < 0.6`) to `ml/dataset/raw/triage/`.
2. Sort them into the correct label folders inside a new session folder (file explorer is fine; the collector app doesn't need a review mode in v1).
3. `prepare_dataset.py` → retrain (minutes on the 4070) → copy new `best.pt` → done.

Expect 1–2 of these cycles before it feels solid.

---

## 9. Final directory layout

```
C:\dev\greenbot\
  .venv\
  collector\            # Electron app (Phase 1)
  ml\
    prepare_dataset.py
    dataset\
      raw\session_*\<label>\*.jpg
      train\<label>\*.jpg
      val\<label>\*.jpg
  bot\
    main.py
    config.json
    adjacency.json      # optional, Phase 5
    best.pt
  runs\                 # ultralytics training outputs
```

---

## 10. Effort & risk summary

| Phase | Estimate |
|---|---|
| 0 Prereqs | 0.5 h |
| 1 Electron collector | 4–8 h |
| 2 Data collection | 3 × ~45 min across several days |
| 3 Training + eval | 1–2 h (GPU time: minutes) |
| 4 Runtime bot to dry-run | 4–6 h |
| 5–6 Hardening + iteration | 2–4 h spread out |
| **Total** | **~2–3 focused days** |

| Risk | Mitigation |
|---|---|
| Exclusive fullscreen → black capture / missing source | Borderless fullscreen, always |
| DPI scaling → offset clicks | `SetProcessDpiAwareness(2)` first line; keep Windows scaling constant |
| Game swallows F7/F8/F9 | Ctrl+Alt+digit accelerators, or alt-tab toggling |
| Two spots genuinely near-identical | `imgsz=320`, then adjacency veto + blob constellation |
| `keyboard` lib hook silently dead | Run terminal as admin if F10 doesn't register |
| Anti-cheat / ToS | Jitter + cooldowns reduce, never eliminate, detection risk — your call |

**Build order, restated:** Phase 0 → collector → one full data session → train → look at the confusion matrix **before** writing any bot code. The matrix tells you in 10 minutes whether the vision plan holds for your particular world.
