# Handoff: Real-Time Game Object Detection

> **Status:** planned, nothing built yet · **Written:** 2026-10-08
> **Owner** = the person who plays the game, labels the data and makes decisions. **Dev** = whoever implements this (a person or a coding agent).

## 0. How to use this document

- Work through the phases in order. Each phase ends with a **Done when** check.
- **[Owner]** marks tasks that need the owner: playing, labeling, decisions. Everything else is **[Dev]**.
- Go through the open questions (section 11) with the owner before Phase 1.
- Captured frames are never edited. Every experiment and its result goes into `docs/experiments.md`.

## 1. Goal

Recognize two kinds of objects in a game, in real time. For every object on screen, report:
- its type (one of the two)
- its color
- its bounding box and center, in screen pixels
- a confidence score

Show the results live in a preview window, and optionally stream them as JSON.

**Out of scope**

- Anything beyond reading the screen. No mouse or keyboard input, no automation, no access to game memory or files. Screen pixels only.
- An overlay drawn on top of the game. In v1, results go to a separate preview window.

## 2. What's known so far

- Windows PC with an NVIDIA RTX 4070 (12 GB VRAM). The game and the detector share this GPU.
- 2 object types. Each appears in several colors; a color is a variant of the same object, not a different object.
- Still open: which game, its resolution, and how big the objects are on screen (section 11).

## 3. Key decisions

| Decision | Reason |
|---|---|
| Ultralytics YOLO, small size, starting from pretrained weights. Use YOLO26s if the installed version has it, otherwise YOLO11s | The simplest complete path: training, evaluation, tracking and TensorRT export in one tool. Pretrained weights mean far fewer labels are needed. |
| The detector learns only the 2 object types; color is read afterwards from the pixels inside each box | Faster labeling, the detector doesn't need to learn colors, and new colors need no retraining. |
| Training frames are captured exactly like live frames: same capture library, saved as PNG | Training images then match what the model sees live. Video compression smears colors, and color matters here. |
| CVAT for labeling; don't build a labeling tool | Free, proper box labeling with keyboard shortcuts, review, YOLO export, and import of pre-made labels. |
| Train, validation and test sets split by recording session | Neighboring frames are near-duplicates. A random split would make scores look much better than they are. |
| TensorRT FP16 for live inference | A few ms per frame on the 4070, leaving room for the game. |

## 4. Environment and game settings

- **System:** Windows 10/11 with a current NVIDIA driver.
- **Python:** 3.11 or 3.12 in a virtual environment, with:
  - PyTorch with CUDA (from the pytorch.org install selector)
  - `ultralytics`, `opencv-python`, `numpy`, `imagehash`, `pyyaml`
  - TensorRT: Ultralytics installs it on the first export if it's missing; otherwise `pip install tensorrt`.
- **Screen capture:** `dxcam` (DXGI Desktop Duplication). If it misbehaves on this machine, try `windows-capture` (Windows Graphics Capture API), which can also capture a single window.
- **Labeling:** CVAT, either self-hosted with Docker Desktop (WSL 2) or on a cvat.ai account. If Docker is a hassle, X-AnyLabeling is a lighter desktop alternative.
- **Game settings, kept identical for training and live use** (record them in `configs/game.yaml`):
  - Borderless windowed mode. Exclusive fullscreen can capture as black frames.
  - HDR off, both in Windows and in the game. HDR captures look washed out.
  - Fixed resolution, brightness and gamma.

## 5. Overview

```
COLLECT AND TRAIN
  capture (PNG every 1 s) ─► drop near-duplicates ─► label in CVAT ─► YOLO dataset ─► train ─► evaluate
                                                         ▲                                     │
                                                         └─── model pre-labels the next batch ◄┘

LIVE
  capture thread ─► newest frame ─► YOLO (TensorRT) ─► color reader ─► tracker (optional) ─► preview window / JSON stream
```

## 6. Phases

### Phase 0: Environment and capture check (about ½ day) [Dev]

- Set up the virtual environment. Check that `torch.cuda.is_available()` returns true and `yolo checks` passes.
- Capture test: grab the game area for 30 s and report the achieved fps. Save one frame and compare its colors with an in-game screenshot; they must match.
- Make the process per-monitor DPI-aware, so all coordinates are physical screen pixels whatever the Windows scaling is.
- Save the monitor and capture region in `configs/capture.yaml`.

**Done when:** the game area is captured at 60+ fps with correct colors.

### Phase 1: Color-filter test (1–2 hours) [Dev + Owner]

Before labeling anything, check whether simple color filtering already finds the objects.

- Build a small HSV picker: click object pixels in a captured frame to get the HSV range for each color.
- Filter each color, clean up the result, find the shapes and draw boxes around them. Run this on about 50 frames from different situations.
- There are two possible outcomes:
  - **It works almost perfectly.** Keep it as a baseline. Also use it to pre-draw boxes for YOLO labeling; the owner then only fixes them and sets the type. That's a big labeling speed-up.
  - **Many false hits from background colors.** YOLO is needed, as expected. The HSV ranges are still reused by the color reader (Phase 6).

**Done when:** the result and the decision are written in `docs/experiments.md`. Stop and confirm with the owner.

### Phase 2: Frame capture tool (½–1 day) [Dev], recording [Owner]

- [Dev] While a hotkey toggle is on, save the game area as a PNG every N ms (default 1000). A second "burst" hotkey saves 5 frames 200 ms apart, for rare moments.
- [Dev] Save into `data/raw/<session_id>/` with a `meta.json` (resolution, region, game settings, notes).
- [Dev] Skip near-duplicates by comparing a perceptual hash with the last saved frame.
- [Owner] Record 4–6 sessions of 5–10 minutes. Together they should cover:
  - every color of both objects
  - different maps or levels, lighting, crowded and empty scenes
  - objects near and far (big and small), partly hidden, and at the screen edges
  - effects: explosions, particles, menus and pop-ups
  - some frames with no objects, and frames with look-alike things that must **not** be detected

**Done when:** there are at least 1,500 candidate frames from at least 4 sessions.

### Phase 3: Labeling, round 1 (½–1 day) [Owner]

- **CVAT project:**
  - Labels `object_a` and `object_b` (rename them to the real names).
  - A `color` attribute, as a dropdown of the known colors. Fill it in at least for the test session, since it's needed to measure color accuracy. Elsewhere it's optional.
- **Sessions:**
  - One **test** session, never used for training or tuning.
  - One **validation** session.
  - The rest are training sessions.
- **How much to label:**
  - About 300 training frames, spread over the training sessions.
  - At least 100 frames each from the validation and test sessions, labeled carefully.
- Follow the labeling rules (section 7) exactly.
- **Export** in Ultralytics YOLO format. In CVAT that's "Ultralytics YOLO Detection". Older CVAT versions only have "YOLO 1.1", whose folders need rearranging.
  - Folders: `datasets/game/images/{train,val,test}` and `datasets/game/labels/{train,val,test}`.
  - Plus `configs/data.yaml` with the class names.

**Done when:** the dataset loads in Ultralytics without warnings, and 10% of the labels have been spot-checked.

### Phase 4: First model (about ½ day) [Dev]

- **Check object sizes first.** Training shrinks each frame to `imgsz` (640 px by default). If many objects end up smaller than about 10–12 px after shrinking, train at 960 or 1280, or capture a smaller region.
- **Train:**
  `yolo detect train data=configs/data.yaml model=yolo26s.pt imgsz=640 epochs=100 batch=16 device=0`
  Use `yolo11s.pt` if YOLO26 isn't available. At this dataset size, training takes minutes on a 4070.
- **Experiments,** one change at a time, compared on the validation session:
  - Hue: `hsv_h=0.015` (default) vs. `hsv_h=0.5`. The higher value randomizes hue during training, so the detector ignores color and finds the objects in any color. Keep the default if look-alike objects differ from the real ones only by color.
  - Horizontal flip: `fliplr` defaults to 0.5. Set it to 0 if the objects have text or details that only appear on one side.
- **Evaluate on the test session:**
  - mAP50 and mAP50-95
  - precision and recall per class
  - the confusion matrix

  Save every false positive and false negative, and look at them.

**Done when:** the results are written in `docs/experiments.md`.

### Phase 5: Model-assisted labeling loop (2–4 rounds) [Dev + Owner]

- **Each round:**
  1. [Dev] The current model pre-labels the next 300–500 frames; import the labels into CVAT.
  2. [Owner] Fix them, which is much faster than drawing from scratch.
  3. [Dev] Retrain.
- **Which frames to pick:**
  - where the model is unsure (confidence 0.2–0.6)
  - where it disagrees with the color-filter baseline
  - where it got things wrong in the error review
  - hard negatives (look-alikes, effects) and rare colors
- **When to stop:** when the test mAP improves by less than 1 point between rounds.
- **Expected total:** 1,000–2,000 labeled frames. Ultralytics' general advice is 1,500+ images per class, but game objects look far more uniform than real-world photos, so let the test scores decide.

**Done when:** the targets in section 8 are met, or the scores stop improving.

### Phase 6: Color reader (about 1 day) [Dev]

- **Algorithm:**
  1. Crop the box and keep the central 50–60%. That means less background and fewer outlines.
  2. Convert to HSV and ignore pixels with low saturation or low brightness (shading, outlines, background).
  3. Build a hue histogram and take the dominant hue. Hue wraps around, so red sits at both ends of the scale.
  4. Pick the nearest calibrated color within tolerance; otherwise return `unknown`.
  5. Recognize white, gray and black by saturation and brightness instead of hue.
- **Calibration:** use the labeled boxes that have a `color` attribute. Compute each color's hue center, spread, and saturation and brightness range, and save them to `configs/colors.yaml`.
- **Measure** accuracy on the test session, with a confusion matrix by color.
- **If accuracy is too low** (for example, game lighting shifts colors), train a small color classifier instead:
  1. Export crops of the labeled boxes into `datasets/crops/{train,val}/<color>/`.
  2. Train it:
     `yolo classify train model=yolo11n-cls.pt data=datasets/crops imgsz=64 epochs=50`
  3. Run it only on the detected boxes.

**Done when:** color accuracy is at least 98% on the test session.

### Phase 7: Real-time app (2–3 days) [Dev]

- **Export the model:**
  `yolo export model=runs/detect/<run>/weights/best.pt format=engine half=True imgsz=<training size> device=0`
- **Structure:**
  - A capture thread keeps only the newest frame and drops older ones.
  - An inference thread runs the TensorRT model on the newest frame.
  - The color reader runs on each box.
  - An optional tracker (ByteTrack, built into Ultralytics) keeps object IDs stable across frames and reduces flicker.
- **Outputs:**
  - **Preview window:** the frame with boxes, type, color, confidence and center coordinates, plus fps and latency.
  - **JSON stream (optional),** over WebSocket, UDP or to a file, one message per frame, in screen pixels:
    `{"t": 1234.5, "frame": 812, "objects": [{"id": 3, "type": "object_a", "color": "red", "conf": 0.94, "box": [x1, y1, x2, y2], "center": [cx, cy]}]}`
- **Coordinates:** model output → capture-region pixels → add the region's offset → screen pixels. Verify by placing something at a known position.
- **Performance:** log the time of every stage. Also measure the game's own fps with and without the detector, since they share the GPU. If the game suffers, try any of these:
  - cap detection at 30–60 per second
  - switch to the nano model
  - capture a smaller region

**Done when:** it runs for 10 minutes at 60+ detections per second, with capture-to-result latency of 20 ms or less, and the owner finds the game's fps acceptable.

### Phase 8: Hardening (ongoing)

- Tune the confidence threshold for each class using the precision-recall curves.
- After game updates that change visuals, capture fresh frames and re-check the test scores. Keep the capture tool around for this.
- Handle the game window moving, resolution changes, and alt-tab (pause detection when the game isn't in front).

## 7. Labeling rules

Write these down in `docs/labeling-guide.md` and apply them the same way every time. Inconsistent labels are the most common cause of a weak model.

- The box is the tightest rectangle around the object's visible pixels. Decide once whether shadows and glows count.
- Label **every** instance of both types in a frame. An unlabeled object teaches the model "this is background".
- Partly hidden: label it if roughly 30% or more is visible and recognizable. The box covers only the visible part.
- Cut off by the screen edge: label the visible part.
- Too small to recognize by eye: don't label it, and accept that the model won't find it either.
- About 10% of training frames should contain no objects at all.
- When unsure: decide a rule, add it to the guide, and apply it everywhere.

## 8. Targets (initial; adjust once the game is known)

| Area | Target |
|---|---|
| Detection, test session | mAP50 ≥ 0.95; recall ≥ 0.95 per class at the chosen threshold |
| Color | ≥ 98% correct on detected objects |
| Speed | ≥ 60 detections/s; capture-to-result ≤ 20 ms; game fps acceptable to the owner |

## 9. Pitfalls

- HDR on: washed-out captures and wrong colors.
- Exclusive fullscreen: black frames.
- Windows display scaling without DPI awareness: coordinates off by the scaling factor.
- Training on OBS video frames but running on raw captures: the colors don't match.
- A random train/test split: scores look far better than reality.
- Inconsistent labeling: the biggest single cause of poor accuracy.
- The GPU is shared with the game.
- License: Ultralytics is AGPL-3.0. That's fine for personal use, but distributing the app or offering it as a service requires open-sourcing it or an Ultralytics enterprise license.

## 10. Repo layout (suggested)

```
game-detector/
├── configs/
│   ├── game.yaml           game settings used for capture
│   ├── capture.yaml        monitor, region, interval
│   ├── data.yaml           Ultralytics dataset config
│   └── colors.yaml         calibrated colors
├── tools/
│   ├── capture_frames.py   Phase 2
│   ├── color_filter.py     Phase 1 test and HSV picker
│   ├── prelabel.py         export model predictions for CVAT import
│   └── export_crops.py     crops for the color classifier
├── detector/
│   ├── capture.py          capture thread
│   ├── infer.py            TensorRT / Ultralytics wrapper
│   ├── color.py            color reader
│   ├── output.py           preview window, JSON stream
│   └── main.py             real-time app
├── data/raw/<session_id>/  captured frames, never edited
├── datasets/               exported, split datasets (game/, crops/)
├── runs/                   Ultralytics training output (not committed)
└── docs/
    ├── labeling-guide.md
    └── experiments.md
```

## 11. Open questions for the owner (answer before Phase 1)

1. Which game, and at what resolution?
2. Roughly how big are the objects on screen, in pixels (smallest and typical)?
3. How many colors are there, and what are they called?
4. Are there look-alike objects that must not be detected?
5. Is the preview window enough, or should detections also be streamed or saved?
6. Does it need to detect on every frame, or is around 30 per second enough?

## 12. References

- Ultralytics docs: Train, Export (TensorRT), Track, and "Tips for Best Training Results"
- CVAT docs: creating tasks from images; importing and exporting annotations in YOLO formats
- DXcam and windows-capture (GitHub / PyPI)
