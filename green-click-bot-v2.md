# Vision Tool — Implementation Plan v2

## Changelog vs v1

- **Removed:** clicking bot, input injection (`pydirectinput`), decision logic, main automation loop. Explicit non-goals now.
- **New definition of done:** a **local HTTP inference service**. `POST` an image → JSON with (a) which location/spot you're standing on, (b) pixel coordinates of clickable (green) targets. Stateless. No clicking, ever, in this phase.
- **New:** labeling + training pipeline for clickable detection (YOLO11n object detection), bootstrapped from HSV auto-proposals.
- **Kept / reused:** Electron capture & labeling app (extended with a bounding-box mode), the location dataset, the trained + validated location classifier.

---

## Phase 0 — Current state (done ✓)

- Electron app captures frames per location and labels them by folder.
- Location dataset split by recording session (train vs val from different sessions).
- YOLO11n-cls location classifier trained, exported, and **validated as correct**, including the `transit` class.

Nothing here changes. The classifier plugs straight into the service in Phase 4.

---

## Phase 1 — Decide how clickables are detected

Two detectors, one interface. The service exposes the same JSON either way, so you can swap later without touching the consumer.

**Option A — HSV thresholding (no training).**
Green mask → contours → bounding boxes. Zero labeling effort, ~2 ms. Fails when: other players wear/emit green, lighting shifts the hue, decoy green UI elements exist.

**Option B — trained detector (YOLO11n detection).**
Learns what a *clickable* looks like (shape + texture + context), not just its color. Robust to green-ish players and lighting. Costs one labeling session + one training run.

**Decision test (30 minutes, do this first):**
Run the HSV script (Phase 2 snippet) over ~200 validation frames spread across locations, eyeball the drawn boxes.

- False positives or misses in more than ~2 % of frames → go Option B.
- Essentially perfect → ship Option A, keep Option B as a config-switchable upgrade path.

Given you already expect player noise, **plan for Option B** and use HSV only as the label bootstrapper below.

**Assumption:** clickables look the same everywhere → **single class `clickable`**. If distinct types exist (e.g. portal vs. resource), add classes now — retrofitting labels later is the expensive part. The service just reports class + box; deciding *which* box matters stays with the consumer.

---

## Phase 2 — Auto-propose boxes with HSV (label bootstrapping)

A Python script walks your existing frames and writes YOLO-format label files the Electron app will load as *proposals*.

```
tools/propose_boxes.py
```

```python
import cv2, os, sys
import numpy as np

SRC = sys.argv[1]           # folder of frames (recurse per location)
LOW, HIGH = (40, 60, 60), (85, 255, 255)   # tune on a few frames first
MIN_AREA = 150              # px², tune to your target size

for root, _, files in os.walk(SRC):
    for f in files:
        if not f.lower().endswith((".png", ".jpg")): continue
        p = os.path.join(root, f)
        img = cv2.imread(p)
        h, w = img.shape[:2]
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, LOW, HIGH)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3,3), np.uint8))
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        lines = []
        for c in cnts:
            if cv2.contourArea(c) < MIN_AREA: continue
            x, y, bw, bh = cv2.boundingRect(c)
            cx, cy = (x + bw/2) / w, (y + bh/2) / h
            lines.append(f"0 {cx:.6f} {cy:.6f} {bw/w:.6f} {bh/h:.6f}")
        with open(os.path.splitext(p)[0] + ".txt", "w") as out:
            out.write("\n".join(lines))
```

Output: one `.txt` per image, YOLO format (`class cx cy w h`, normalized 0–1). Wrong boxes are fine — fixing is faster than drawing.

---

## Phase 3 — Extend the Electron app: bounding-box editor

New mode in the existing labeler. Requirements:

- Load an image + its sibling `.txt`; render proposal boxes on a `<canvas>` overlay.
- Interactions: **drag** on empty space = draw new box, **click** = select, **drag handles** = resize/move, **Del** = remove, **S** = save `.txt` + advance, **A/D** = prev/next image. If multi-class: number keys set class of selected box.
- Save in the same normalized YOLO format (round-trip identical to Phase 2 output).
- Progress indicator (n / total, count of images with 0 boxes as a sanity flag).

Labeling budget: with proposals pre-filled, ~2–4 s per image. **300–600 corrected images total** (spread across locations and sessions, players present in many of them) is enough for a nano detector on a single class.

**Dataset layout after labeling:**

```
dataset-detect/
  images/train/  images/val/
  labels/train/  labels/val/
  data.yaml
```

```yaml
# data.yaml
path: dataset-detect
train: images/train
val: images/val
names:
  0: clickable
```

Same iron rule as the classifier: **split by session**, never randomly across consecutive frames.

---

## Phase 4 — Train + validate the detector (Python)

```bash
yolo detect train model=yolo11n.pt data=dataset-detect/data.yaml epochs=60 imgsz=640
```

Notes:
- Detection uses `yolo11n.pt`, not the `-cls` variant. `imgsz=640` is the norm for detection; drop to 480 later only if latency demands it.
- Default augmentation is fine here; horizontal flip is acceptable for detection (unlike your location classifier) unless left/right context defines what "clickable" means in your world — if in doubt, add `fliplr=0`.
- Train on GPU or Colab exactly like v1; artifacts land in `runs/detect/train/weights/best.pt`.

**Validation gate (before wiring the service):**
- Held-out-session metrics: aim for **precision and recall ≥ 0.95** on `clickable`. This is a big, distinctive target — nano should crush it.
- Eyeball ~50 val frames *with players in view* using `yolo predict`; specifically look for boxes drawn on players.
- If players still trigger false positives: add more labeled frames containing players (hard negatives) and retrain. This fixes it almost every time.

Optional export for a torch-free server: `yolo export model=best.pt format=onnx`. Ultralytics can load the `.onnx` directly and still handle NMS/postprocess for you.

---

## Phase 5 — The deliverable: local HTTP inference service

FastAPI app, bound to `127.0.0.1`, models loaded once at startup, stateless per request.

```
server/
  main.py
  config.yaml        # model paths, thresholds, detector: yolo | hsv, port
  models/
    location_cls.pt        (or .onnx)
    clickable_det.pt       (or .onnx)
  requirements.txt   # fastapi uvicorn[standard] ultralytics opencv-python python-multipart pyyaml
```

### Endpoints

| Method | Path       | Purpose                                  |
|--------|------------|------------------------------------------|
| GET    | `/health`  | liveness + model versions + config echo  |
| POST   | `/analyze` | image in → location + clickables out     |

Input: `multipart/form-data` field `file` (PNG/JPG bytes). Also accept `{"image_b64": "..."}` JSON for convenience from the Electron renderer.

### Response contract

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
  "clickables": [
    {"cx": 812, "cy": 440, "x": 790, "y": 415, "w": 44, "h": 50,
     "class": "clickable", "confidence": 0.91}
  ],
  "image": {"width": 1920, "height": 1080},
  "timing_ms": {"classify": 3.2, "detect": 9.8, "total": 14.1}
}
```

Contract rules:
- **Coordinate space = the submitted image**, pixels, origin top-left. `cx, cy` is the box center (what a future consumer would click); `x, y, w, h` is the full box. The service never rescales — if the consumer captures at a different resolution than it clicks at, that mapping is the consumer's job. Document this in the README.
- If location confidence < threshold (default 0.70) or class is `transit`, return it honestly with `"confidence"` as-is — **no guessing**. Smoothing/majority-voting is deliberately *not* in the service (stateless); the consumer has the frame stream and can vote over `top3` if it wants.
- `detector: hsv` in config swaps Phase-2 logic in behind the identical JSON shape (boxes get `"confidence": 1.0`).

### Core of `main.py`

```python
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO
import numpy as np, cv2, time, yaml

cfg = yaml.safe_load(open("config.yaml"))
clf = YOLO(cfg["models"]["classifier"])
det = YOLO(cfg["models"]["detector"]) if cfg["detector"] == "yolo" else None

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
# CORS matters if you ever call this from the Electron renderer via fetch();
# from Node's http/axios it is irrelevant. Server binds to 127.0.0.1 only.

@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    t0 = time.perf_counter()
    buf = np.frombuffer(await file.read(), np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "not a decodable image")
    h, w = img.shape[:2]

    t1 = time.perf_counter()
    c = clf.predict(img, imgsz=cfg["classify_imgsz"], verbose=False)[0]
    probs = c.probs
    top3 = [{"id": c.names[i], "confidence": round(float(probs.data[i]), 4)}
            for i in probs.top5[:3]]
    t2 = time.perf_counter()

    clickables = []
    if det:
        d = det.predict(img, imgsz=cfg["detect_imgsz"],
                        conf=cfg["detect_conf"], verbose=False)[0]
        for b in d.boxes:
            x1, y1, x2, y2 = map(float, b.xyxy[0])
            clickables.append({
                "cx": round((x1+x2)/2), "cy": round((y1+y2)/2),
                "x": round(x1), "y": round(y1),
                "w": round(x2-x1), "h": round(y2-y1),
                "class": d.names[int(b.cls[0])],
                "confidence": round(float(b.conf[0]), 4)})
    else:
        clickables = hsv_detect(img, cfg)   # Phase-2 logic, same shape
    t3 = time.perf_counter()

    return {"location": {"id": top3[0]["id"], "confidence": top3[0]["confidence"], "top3": top3},
            "clickables": clickables,
            "image": {"width": w, "height": h},
            "timing_ms": {"classify": round((t2-t1)*1e3, 1),
                          "detect": round((t3-t2)*1e3, 1),
                          "total": round((t3-t0)*1e3, 1)}}
```

Run: `uvicorn main:app --host 127.0.0.1 --port 8765` (wrap in `start_server.bat`; reuse the v1 venv).

### Calling it from JS

```js
import { readFile } from "node:fs/promises";

const form = new FormData();
form.append("file", new Blob([await readFile("frame.png")]), "frame.png");
const res = await fetch("http://127.0.0.1:8765/analyze", { method: "POST", body: form });
const { location, clickables } = await res.json();
```

Optionally have the Electron main process spawn/kill the server (`child_process.spawn` on the `.bat`, poll `/health` until ready) so it's one app to launch.

---

## Phase 6 — Acceptance criteria (definition of done)

- [ ] `curl -F "file=@frame.png" http://127.0.0.1:8765/analyze` returns the schema above.
- [ ] Location: correct spot on held-out-session frames (matches your already-validated classifier numbers); `transit`/low-confidence frames reported honestly, never mapped to a spot.
- [ ] Clickables: precision & recall ≥ 0.95 on the val split; no boxes on players across a 50-frame spot check.
- [ ] Latency: `total` ≤ 50 ms CPU-only per request (expect ~15–25 ms).
- [ ] Stability: 1,000 sequential requests, zero errors, flat memory.
- [ ] Config swap `detector: hsv ↔ yolo` requires no consumer change.
- [ ] README documents the JSON contract + coordinate-space rule.

## Explicit non-goals (this phase)

No mouse/keyboard injection, no window focus management, no capture loop inside the service, no decision logic about *which* clickable is correct for the current spot. The service reports facts; a future consumer owns behavior.

---

## Build order

1. Phase 1 decision test (30 min) → confirms Option B.
2. Phase 2 proposal script → run over existing frames.
3. Phase 3 bbox editor in Electron → one labeling session (~300–600 images).
4. Phase 4 train + validation gate.
5. Phase 5 service, wired to both models.
6. Phase 6 checklist → done.