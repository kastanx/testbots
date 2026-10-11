# Experiments

Every experiment and its result, newest last. Captured frames are never edited;
changes go into new sessions or new runs.

## 2026-10-08 · Phase 0: environment

| | |
|---|---|
| OS | Windows 11 Pro (10.0.26200), one 3440×1440 @ 144 Hz monitor, 100% scaling |
| GPU | RTX 4070 12 GB, driver 560.94 (CUDA 12.6) |
| Python | 3.11.9, venv in `.venv/` |
| PyTorch | 2.6.0+cu124, `cuda.is_available()` = True |
| Ultralytics | 8.4.174 (has YOLO26), `ultralytics.checks()` passes |
| OpenCV / NumPy | 5.0.0 / 2.4.6 |
| Capture | dxcam 0.3.0 (DXGI), mss as fallback |
| TensorRT | 10.7.0 (`tensorrt-cu12`); Ultralytics doesn't install it on Windows |
| DPI | per-monitor aware (V2) in every entry point |

`python -m tools.check_env` → READY.

**Capture check** (`python -m tools.capture_bench --full --seconds 30`, game client open):

| backend | region | fps | frame gap p50 / p95 | grab ms mean / p95 | DXGI vs GDI |
|---|---|---|---|---|---|
| dxcam | full screen 3440×1440 | 60.1 | 16.4 / 30.3 ms | 4.0 / 13.3 | 100% identical pixels, mean diff 0.0 |

DXGI only delivers a frame when the screen changes, so 60 fps is the rate at
which the screen content was changing. Colors come through intact. Still to do
once the game is chosen: compare a saved frame with an in-game screenshot, and
repeat on the game window only (a smaller region also makes grabs cheaper).
**Done when** (60+ fps, correct colors): met for full-screen capture.

Notes:
- Ultralytics' global settings point `runs_dir` at `testbots/runs` (left over from
  greenbot), so `tools.train` passes an absolute project path.
- In this Ultralytics version, `half=True` and `int8=True` are deprecated in favor of
  `quantize=16` / `quantize=8`.

## 2026-10-08 · Self-test on a synthetic scene

No game has been chosen yet, so `tools/synth.py` stands in for one. Two types
(`gem`, `slime`) in seven colors (red, orange, yellow, green, blue, purple,
white). Look-alikes that must not be detected: coins and crystal shards in the
same colors, colored flowers, a pond, HUD icons. Also partial occlusion (trees,
pillars, explosions), cut-off at the frame edges, and per-frame lighting and tint.
Ground-truth boxes are the tight box of the visible pixels; objects less than 30%
visible are not labeled, matching the labeling guide.

**Dataset:** 1,200 train / 200 val / 200 test frames at 1280×720, PNG, 10% with no
objects. Each split uses different background "worlds", the synthetic
equivalent of splitting by session. 2.0 GB, 88 s to render.

**Color calibration from labeled boxes** (`detector.color.calibrate`, the
Phase 6 method): it recovers all seven colors at the hues they were drawn with
(red 0.1, orange 14.9, yellow 28.2, green 62.1, blue 107.9, purple 139.8; white
as achromatic).

### Phase 1 color filter on the synthetic test split

`python -m tools.color_filter --colors datasets/synth/colors.yaml run --frames datasets/synth/images/test --limit 50`

| frames | recall | precision | false boxes / frame | ms / frame |
|---|---|---|---|---|
| 50 | 0.81 | 0.08 | ~67 | 6.3 |

It finds most objects, but rocks pass as "white", dirt as "yellow"/"orange",
and flowers, HUD icons and look-alikes all produce boxes. This is the "many
false hits from background colors" outcome: a learned detector is needed, and
the color table is reused by the color reader. The real game may well behave
differently; repeat this test on its frames.

### Tool checks (offline, scratch folder)

- Recorder: a duplicate frame (perceptual hash distance ≤ 4) is skipped; burst
  frames are always kept; numbering continues with `--append`.
- `build_dataset`: one YOLO 1.1 zip plus one unpacked Ultralytics export with
  the class order swapped. Classes are remapped by name, and the empty-test-split
  warning shows.
- `calibrate_colors fit` + `test` on 60 CVAT-for-images XML frames with color
  attributes: **99.3% color accuracy on 421 labeled boxes** (target 98%). Errors:
  1 red→green, 1 white→blue, 1 white→orange, all small or occluded boxes.

### Phase 4 on the synthetic data: first model

`python -m tools.train --name synth --data datasets/synth/data.yaml epochs=10 batch=16 workers=4`
(YOLO26s from pretrained weights, imgsz 640, 10 epochs, 5.8 min on the 4070 while the game client was running)

| split | mAP50 | mAP50-95 | gem P / R | slime P / R |
|---|---|---|---|---|
| val | 0.995 | 0.956 | 0.987 / 0.991 | 0.993 / 0.988 |
| test (`tools.evaluate`) | 0.994 | 0.963 | 0.976 / 0.979 | 0.995 / 0.993 |

At conf 0.25 on the test split: box precision 0.957, recall 0.993, type correct
for 99.93% of the boxes found. The error review (`runs/eval/synth_test/errors/`)
shows the false positives are mostly objects cut off at the frame edge or behind
cover with less than 30% visible. They are real objects, but the labeling rule
says not to label them. It reached mAP50 0.99 after the first epoch: the
synthetic objects are easy. Real game objects will need more data and more epochs.

### Phase 7 on the synthetic data: TensorRT and the live app

**Export:** `best.pt` → FP16 TensorRT engine at 384×640 (h×w, fits 16:9 frames
with no wasted padding). TensorRT 10.7, 22.7 MB, 547 s to build (the game was
using the GPU at the same time). An engine only runs at its export size; the
live app reads that size from the engine. Non-square engines can't go through
`model.val`, so evaluate the `.pt` weights.

**Inference alone** (one 1280×720 frame, 100 runs, game client running):

| model | Ultralytics inference | wall p50 | wall mean | wall p95 |
|---|---|---|---|---|
| `.pt` FP16 | 15.9 ms | 18.5 ms | 21.4 ms | 30.9 ms |
| `.engine` FP16 | 1.75 ms | 2.6 ms | 7.5 ms | 14.1 ms |

The engine's timing is bimodal: about 2.6 ms when the GPU is free, about 14 ms
when the call has to wait for the game's frame to finish rendering. The game kept
the GPU 67-77% busy throughout these tests. So sharing the GPU with the game, not
the model, sets the latency.

**Live app** (`detector.main --no-preview --duration 15-30`; latency = frame
grabbed → result ready, incl. color reading; tracking = ByteTrack):

| source | model | tracking | det/s | latency mean / p50 / p95 ms | ≤ 20 ms |
|---|---|---|---|---|---|
| synth 60 fps | `.pt` | Ultralytics `track()` | 24.9 | 47.8 / 44.9 / 63.8 | 0% |
| synth 60 fps | engine | Ultralytics `track()` | 58.6 | 13.2 / 16.4 / 30.5 | 82% |
| synth 60 fps | engine | direct ByteTrack | 44-55 | 21-36 / 17-33 / 35-47 | 2-73% |
| screen 3440×1440 | engine | none | 59.4 | 15.1 / 15.8 / 26.6 | 94% |
| screen 3440×1440 | engine | Ultralytics `track()` | 55.9 | 24.2 / 20.8 / 33.6 | 46% |
| screen 3440×1440 | engine | direct ByteTrack | 59.2 | 17.7 / 17.5 / 30.0 | 89% |
| synth, preview window on | engine | direct ByteTrack | 60.1 | 10-14 (p95 15-16) | - |

- Ultralytics' `model.track()` adds about 4 ms of extra GPU syncs per frame, so the
  app now calls ByteTrack directly on the CPU results.
- The synthetic source draws every frame inside the same process, so it competes
  for CPU with the detector, and its numbers swing between runs (the same setup
  gave 44 to 60 det/s). The screen runs are steadier and closer to real use.
- The screen produced 60-64 new frames/s while these ran, so 60 det/s is the
  ceiling: every frame was processed.

**Live accuracy against ground truth** (synth, engine, tracking): box precision
0.97, recall 0.99, type 99.95%, color 99.0-99.3% over 9,000-17,500 matched boxes.
Most color errors are red/white objects partly behind a tree (the canopy's green
fills the box center), and red↔orange on dark frames.

**Coordinates** (the plan's "place something at a known position"): a window
showing a synthetic frame was placed at (400, 300) and captured from the screen
by its title. The captured frame matched the shown image pixel for pixel (mean
difference 0.0007). 8/8 objects were found, and their reported screen centers
were within 0.5 px of truth + the window's client origin (408, 331).

**JSON stream:** UDP and JSON-lines both checked: 304 messages in 6 s, one per
frame, increasing frame ids, boxes and centers in screen pixels, in the plan's
format plus `latency_ms`.

**Preview window:** `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` and
topmost both took effect, so the window can sit over the game without showing up
in its own capture.

**Against the Phase 7 targets:** about 60 det/s (all the screen produced); mean
latency 15-18 ms on the real screen, but p95 is 27-30 ms because of GPU sharing,
so ≤ 20 ms holds on average but not for every frame. Not measured yet: a 10-minute
run, and the game's own fps with and without the detector (owner). Ways to lower
the tail: cap the game's fps or lower its graphics settings, capture only the game
window, `--max-rate 30`, the nano model.

### Change to the plan: duplicate filter (Phase 2)

The plan skips a frame when its perceptual hash is close to the last saved
frame's. With a still camera that also drops frames where only a small object
moved, because a whole-frame hash barely changes. Those are exactly the frames
training needs. The recorder now skips a frame only if the hash is close **and**
no 16×16 block of a 512-px grey thumbnail changed by 8+ grey levels on average.
Checked on a real 3440×1440 screen grab: an identical frame and a +2 brightness
flicker are skipped, and a 50 px object appearing on a still screen is kept. The
recorder loop itself (scripted hotkeys, real screen) saved 1 periodic frame and
a 5-frame burst, skipped 6 duplicates of the static screen, and wrote a correct
meta.json.

## 2026-10-08 · Owner's answers, Phase 0 on RuneScape

**Answers** (handoff section 11):
1. RuneScape (NXT client), **windowed, not borderless**. The window is maximized:
   client area 3440×1369 on the 3440×1440 monitor.
2. Object sizes: not measured by hand. `tools.check_sizes` computes them from the
   labels.
3. **Colors don't matter:** the objects can be any color. No color names and no
   color labels.
4. **No look-alikes.**
5. Preview is the main output (the JSON stream stays available).
6. **10-30 detections/s is enough.**

**Decisions that follow:**
- The color reader reports the actual color as `#rrggbb` when no named colors are
  calibrated (named colors still work if ever wanted). There's no color attribute
  in labeling.
- Training defaults to `hsv_h=0.5` (`tools.train`): hue is randomized so the
  detector ignores color and generalizes to colors it hasn't seen. With no
  look-alikes, there's nothing that only color could tell apart.
- **Phase 1 (color filter) is skipped:** its colors would have to be
  calibrated per color, and the objects can be any color.
- The live app defaults to `--max-rate 30`. A rate-capped frame is taken when it
  arrives, never after waiting, so each processed frame is fresh.
- Windowed mode is fine for capture (not exclusive fullscreen). But DXGI captures
  the screen, so anything in front of the game window ends up in the frame. Each
  frame now records whether the game was the foreground window (the preview window
  counts as the game, since the capture can't see it). Recording skips frames where
  it wasn't, and the live app pauses.

**Capture check on the game window** (`tools.capture_bench`, 30 s): 60.0 fps,
3440×1369, frame gap p50 16.6 / p95 20.3 ms, grab 2.9 ms mean (p95 5.6), DXGI vs
GDI 100% identical pixels. **Phase 0 done for RuneScape.**

**Live timing on the game window** (synthetic engine 384×640 standing in for
the real model, so only the timing means anything; game client in front):

| max-rate | det/s | latency mean / p50 / p95 / max ms | ≤ 20 ms | frame age at start |
|---|---|---|---|---|
| 30, first version (picks the newest frame when due) | 29.6 | 20.6 / 19.4 / 31.2 / 43.7 | - | ~8 ms |
| 30, waits for the next frame after the cap | 23.0 | 15.2 / 16.0 / 17.4 / 19.7 | 100% | 0.4 ms |
| **30, skips frames that come too soon (current)** | **29.7** | **14.7 / 15.8 / 17.3 / 20.7** | **99.4%** | **0.45 ms** |
| 10, current | 10.2 | 14.7 / 16.0 / 17.1 / 20.4 | 99.2% | 0.42 ms |

The recorder on the game window saved 6 frames in 3 s at a 500 ms interval with
0 duplicates (the game is always animating). The test frames were deleted.

## 2026-10-08 · Labeling setup (owner's choices)

- The objects are **wisp** and **crater** (class ids 0 and 1).
- **Built-in labeler instead of CVAT** (owner's choice; deviation from the plan's
  "don't build a labeling tool"). There are 2 classes and no attributes, so a
  small tool with no setup (no Docker, no account, no export step) wins.
  `tools/label.py` writes YOLO labels to `data/labels/<session>/`, and
  `build_dataset` reads them directly. CVAT exports still work.
- Recorder keys are now **L** start/stop, **K** burst, **J** end (the owner's
  keyboard has no F-keys). They act only while the game window has focus, since
  letters are typed everywhere.
- `split: trainval` was added for a single quick test session: an 80/20 split in
  recording order.

Labeler check (headless, scripted mouse and keys, on real 3440×1369 game frames):
box drawing, type change, right-click delete and undo, an empty frame, a skipped
frame, zoom/pan, and quit all worked. A box drawn at the fit view landed within
0.1 px of the expected full-resolution coordinates. The window is 3281×1352 and
fits the 3440×1392 work area. Redraw takes 1.6 ms, the next frame opens in ~60 ms.
`build_dataset` with `trainval` put 2 frames in train and 1 in val, as expected.

### Next

- Owner: record a quick test session, label it, then the first wisp/crater model.
- `check_sizes` on those labels decides imgsz (3440-wide frames shrink 5.4× at 640).

## 2026-10-08 · First real labels: session test1 (Divination: wisps and the energy rift)

**Recording:** `test1`, 2 min 41 s, 138 frames at 3440×1369, no duplicates (the game
is always animating). A Vibrant wisp colony: green wisps, one energy rift ("crater"),
other players harvesting, the owner's red dragon familiar.

**Owner's labels:** 5 frames, 29 boxes (24 wisps, 5 craters). Boxes are tight and
consistent. The crater is labeled as its bright center only (now a rule in the
labeling guide). Two kinds of misses: the wisp next to the dragon's head was unlabeled
in all 5 frames, and one wisp in frame 2. I added those 6 boxes; the originals are
in `data/labels/test1_backup_user/`. Labeling took the owner about a minute per frame,
which is too slow for 1,000+ frames, so the rest was bootstrapped.

**Object sizes** (`check_sizes`): wisps 24-35 px (spring 70-80 px), craters 62-86 px
at full resolution. At imgsz 640 on the whole frame, 79% of wisps fall under 10 px;
1920 keeps all of them at 14 px or more.

**Bootstrap attempt 1, whole frames at imgsz 1920** (batch 2, 4 frames): it didn't
converge. With 2 steps per epoch the warmup took 50 epochs, batch 2 is unstable,
and it filled 11.9 of 12 GB GPU memory next to the game. Stopped at epoch 75
(recall 0.08).

**Bootstrap attempt 2, crops** (new `build_dataset --tiles`): 40 crops per frame of
1147×1147 px, shrunk to 640. That is the same shrink a whole frame gets at
imgsz 1920, so objects keep their live size. 80% of crops are centred near objects,
and crops that would cut an object badly are re-drawn. Trained at 640, batch 16:
P 0.985 / R 0.987 / mAP50 0.992 on frame 5's crops after 80 epochs (4.5 min).
`tools.train` writes `infer.yaml` (imgsz 1920) so whole frames get detected at the
matching size.

**Auto-labeling the other 133 frames** (`tools.autolabel`, conf 0.35) and checking
them by eye:
- Inventory memories, the minimap, the XP tracker and a buff icon came out as
  wisps (~15 per frame). Fixed with `ignore` regions for the UI panels in
  capture.yaml, which the live app, auto-labeling and the labeler all apply.
- 19 "craters" on sun glare on the water (left of the screen): removed. The real
  rift is in the middle of the screen in every frame.
- 83 "wisps" on the cyan progress bar shown over a wisp someone is harvesting, and
  on blue sparkles: removed by color (wisps in this colony are green, hue 41-79;
  the bar is hue ~90).
- 19 "wisps" on the dragon's wing and claw, golden chronicles and a dark blob:
  removed after viewing all 24 yellowish boxes. The dragon-wing mistake comes from
  the seed frames, where a wisp always sat at the dragon's head.
- Result: 895 boxes in 138 frames, 3-10 wisps and 1 crater per frame (one frame's
  crater is half under a tooltip and stays unlabeled).

These look-alikes (chronicles, memories, the progress bar) differ from wisps mostly
by color, so **training no longer randomizes hue** (`tools.train` default back to
hsv_h=0.015). Other wisp colors come from recording at other colonies.

**Round 2:** trained on all 138 frames: the first 110 train, the last 28 validate, with
10 crops each (`build_dataset --tiles 10`, `train --name round2 epochs=40`, 15 min).

| crops of the last 20% of the session | P | R | mAP50 | mAP50-95 |
|---|---|---|---|---|
| all | 0.990 | 0.956 | 0.985 | 0.839 |
| wisp | 0.991 | 0.912 | 0.975 | 0.735 |
| crater | 0.990 | 1.000 | 0.995 | 0.943 |

(Measured against the cleaned auto-labels, not hand labels, so this is agreement
with the bootstrap rather than ground truth.)

Whole held-out frames (115, 122, 129, 136) checked by eye at imgsz 1920: wisps found
at 0.84-0.98 confidence, the rift in every frame. **No boxes in the UI panels even
before the ignore filter**: the round-2 model learned that inventory memories aren't
wisps. It also skips the cyan bar, chronicles and sun glare. One wisp on the rift's
green rim (frame 115) was missed.

**Live on the game window**, `.pt` at imgsz 1920, tracking on, default 30/s cap: 29.9
det/s, latency mean 22.2 / p95 23.3 ms (detect 21.2 ms), 5-7 objects per frame. The
snapshots match what's on screen. The preview now defaults to half the screen width
with compact labels (box, confidence, a dot in the object's color); `d` toggles the
full labels.

## 2026-10-08 · Progress-bar filter, one-command retraining

The owner saw false wisps on the cyan harvest progress bar while watching live.
The bar is a fixed UI element: a straight horizontal strip 5-6 px tall and ~76 px
long. Its fill is H 82-98 / S 104-252 / V 154-255, and the empty part has the same
hue and saturation but is darker (V 28-60). `detector/filters.py` drops a wisp
detection when at least 0.56 of its colored pixels belong to a thin (≤ 9 rows)
straight horizontal band of that hue.
- All 70 bar boxes from the test1 auto-labels were caught (lowest share 0.61,
  median 0.97), counting bars that had only just started filling.
- None of the 758 labeled wisps was dropped (highest share 0.51, p99 0.35), including
  wisps with the bar across them.
- 6 blue energy orbs (the harvest projectile) are not bars and aren't touched; the
  model already treats them as background.
- Round-2 model on all of test1 at conf 0.4: without filters P 0.9886 / R 0.9654
  (10 FP); with filters P 0.9908 / R 0.9654 (8 FP), so no recall lost. Most bar cases
  in test1 were already learned. The filter is for new situations like the ones
  seen live.

Filters live in `configs/capture.yaml` (`ignore`, `bar_filter`) and apply live, when
auto-labeling and in labeler suggestions. The live default threshold is now 0.4: real
wisps score p5 0.76 / median 0.89 and the leftover junk mostly scores below 0.35.

`tools.retrain` does dataset (crops) → train → TensorRT export in one command and adds
new labeled sessions to `configs/dataset.yaml` as training sessions. Smoke-tested with
1 epoch; that run was deleted.

## 2026-10-08 · Rule change: only untouched wisps

The owner only wants wisps nobody is harvesting. A wisp with the cyan progress bar
across it (small, or the big teal kind) no longer counts. No new recording was
needed; test1 has plenty of both kinds.

**Finding harvested wisps** (`DetectionFilters.harvested`): a thin (≤ 9 rows) horizontal
band of the bar's hue, at least 40 px long, whose centre is within max(20 px, 0.6 ×
width) of the wisp's centre, between above the box top and 0.7 of its height. RS3
centres the bar over the wisp it belongs to. Without the centring check, a free wisp
next to a harvested one was flagged by the neighbour's bar.
- Of 758 labeled wisps in test1, 145 are being harvested, including all 60 big teal
  ones, and 613 are untouched. All 12 small harvested wisps sampled for review have
  a bar centred across them. Untouched wisps near a bar were checked as well.
- Labels: the 145 were removed; the previous labels are in
  `data/labels/test1_backup_round2/`.
- `bar_filter.drop_harvested: true` in capture.yaml applies the rule live, in
  auto-labeling and in the labeler. It costs 1.8 ms per frame on average.
- Round-2 model (trained before the change) plus filters, on test1 against the new
  labels: P 0.989 / R 0.965 (wisp 0.987 / 0.958, crater 1.0 / 1.0). The rule works
  without retraining. Round 3 is retrained on the new labels so the model itself
  skips harvested wisps.

**Round 3** (`tools.retrain`: test1 with the untouched-wisps labels, 40 epochs, engine
768×1920). Crops of the last 20%: P 0.988 / R 0.957 / mAP50 0.984 (wisp 0.976 / 0.932,
crater 1.0 / 0.982).

Whole frames, held-out frames 111-138 only, conf 0.4, against the new labels:

| model | filters | P | R | FP | harvested wisps still detected |
|---|---|---|---|---|---|
| round2 | UI only | 0.831 | 0.964 | 27 | 22 |
| round2 | UI + bar + harvested | 0.978 | 0.964 | 3 | - |
| round3 | UI only | 0.880 | 0.957 | 18 | 15 |
| round3 | UI + bar + harvested | **0.993** | **0.957** | **1** | - |

Retraining taught the model only part of the rule (22 → 15 harvested wisps on
these frames). A harvested wisp still looks like a wisp with a bar on it, and one
session isn't enough examples. The filter does the rest, deterministically, so keep
it on. `detector.main` now picks round3 by default.

**Next (owner, 2026-10-08):** the owner will play in worlds without other players, so
new sessions there match live use best. Record 2-3 sessions in empty worlds; auto-label
them with round3 plus the filters, review, retrain, and keep one session as the
held-out test session. test1 stays in as training data in case other players show up.

## 2026-10-08 · Empty-world sessions empty1-3, auto-labeled and reviewed

**Recording:** empty1 288, empty2 301, empty3 189 frames (5 + 5 + 3 min). Same Vibrant
colony and camera, a world without other players. The owner harvests and converts at
the rift, the inventory fills, chronicles appear, and the dragon familiar is gone.

**Auto-labeling** (`tools.autolabel`, round3 plus all filters, conf 0.35): 4.2-4.5
untouched wisps and 1.0 crater per frame, confidence median 0.91 / p10 0.87. Every
frame has exactly one crater, near the centre, so no glare craters.

**Review:**
- Yellowish boxes (34): 13 real wisps tinted by the game's hover square or click
  marker; 21 wrong ones (the player character, the golden walk-target arrow, sun
  glare on the water, a "+7 xp" popup), removed.
- Cyan boxes (37): all wrong. Mostly the player's blue converting aura, plus blue
  energy orbs and one bar end. Removed.
- **The player character is the main new false positive.** The camera follows the
  player, so it always stands at the screen centre: the cyan-aura boxes had centres
  at x 1681-1733, y 672-729. An ignore zone there would have removed 192 real wisps,
  which float around the rift right next to the player, so it isn't used. Instead,
  boxes near the centre were ranked by how much wisp-green (H 45-75, S≥120, V≥140)
  they contain. The 25 least green (share ≤ 0.08) were all junk (player,
  chronicle, sparkles), and from about 0.09 up they were real wisps. 29 removed,
  including a few player boxes left in the test1 labels.
- Least-green boxes over all sessions: the remaining 80 are real wisps (hovered or
  clicked ones); one more harvested wisp was removed.
- A looser bar check (any bar piece ≥ 25 px crossing the box): 44 hits, all untouched
  wisps next to a harvested one whose bar starts at their edge. Kept.
- Oversized boxes (29): 11 hovered wisps with the box stretched to the hover square
  (kept). 16 covered two adjacent wisps; split in half along the long side.
- Possible misses (unlabeled detections 0.10-0.35, 60): almost all junk.
- 600 lowest-confidence labels viewed tile by tile, plus 300 random ones.

Backups: `data/labels/<session>_backup_auto/` (the raw auto-labels) and
`data/labels/test1_backup_round3/`.

**Result:** test1 138 frames / 596 wisps; empty1 288 / 1229; empty2 301 / 1247;
empty3 189 / 839. Each frame has one crater (one test1 frame's rift is under a
tooltip).

**Split:** test1 and empty2 `trainval` (their last 20% validate), empty1 `train`,
**empty3 `test`, held out**. Its labels come from round3 plus this review, so a test
score measures agreement with reviewed auto-labels, not independent ground truth.

`tools.retrain` now continues from the newest roundN model by default (20 epochs;
`--fresh` = pretrained weights, 40 epochs) and picks crops per frame to give about
3500 training crops. `tools.autolabel` now writes the class names (`data.yaml`) that
`build_dataset` needs.

### Round 4 and duplicate boxes

**Round 4** = fine-tuned from round3 on test1 + empty1 + empty2 (4 crops per frame,
3195 train / 440 val crops), 20 epochs, 29 min. Val: P 0.992 / R 0.968 / mAP50 0.988.

On held-out **empty3** (whole frames, conf 0.4): raw model wisp P 0.920 / R 0.983,
crater 1.0 / 1.0 (mAP50 0.990 / 0.995). With the live filters: P 0.940 / R 0.987.
Looking at its 65 "false positives", nearly all were real wisps, but **boxed two or
three times** (one box per orb plus one around both). The cause was duplicate boxes
in the training labels, inherited from round3's auto-labels: 25-46 overlapping wisp
pairs per session. Round3 makes 13 overlapping pairs on 63 empty3 frames, round4 36,
so training on them amplified the problem.

Fixes:
- `YoloDetector` now drops a box that overlaps a more confident box of the same class
  (IoU ≥ 0.45) or lies mostly inside it (≥ 60% of its own area). This applies live,
  in auto-labeling, in the labeler and in evaluation. YOLO26 is NMS-free, so nothing
  did this before.
- Labels were deduplicated: in each overlapping pair the larger box is kept, except
  that a big box holding two separate smaller boxes is dropped as a two-wisp box. 114
  boxes removed in 84 frames; spot-checked. Backups are in
  `data/labels/<session>_backup_predup/`.

With duplicate removal and filters, against the deduplicated empty3 labels:
round3 P 0.993 / R 0.999 and round4 P 0.981 / R 0.995. empty3's labels come from
round3, so this comparison favours round3.

**Round 5** = round3 fine-tuned on the deduplicated labels (same split, 20 epochs).
Val crops: P 0.987 / R 0.981 / mAP50 0.994 / mAP50-95 0.857 (wisp 0.988 / 0.962, crater
0.986 / 1.0). Held-out empty3 with duplicate removal and filters, against the
labels: P 0.991 / R 0.995 (wisp 0.989 / 0.994, crater 1.0 / 1.0).

**Label-free check of round3 vs round5 on empty3:** run both models and look only at
the boxes where they disagree (IoU < 0.3).
- Only round3 (12): 8 on **the player character's blue converting glow, at
  confidence 0.71-0.93**, 2 on blue energy orbs, and 2 faint orbs that may be wisps.
  At least 10 mistakes.
- Only round5 (10): all real wisps that round3 missed. Those are absent from the
  round3-made labels, which is why round5 seemed to have "false positives" there.

**Round5 is the best model** and now the live default (`latest_weights` picks the
newest run). Round3 marks the player as a wisp whenever it converts at the rift, which
in an empty world happens constantly. Lesson: when the labels come from an older
model, test scores favour that model; judge the disagreements by eye.

## 2026-10-09 · Lustrous colony: lust1-3

**Recording:** lust1 295, lust2 279, lust3 152 frames, in an empty world. A darker
forest; **Lustrous wisps are light blue** (bright pixels H 75-102 / median 91, S 69-132,
V 123-231): the same hue family as the harvest bar and the player's converting aura.
The rift looks the same as at Vibrant.

**Round5 on Lustrous** (trained only on green wisps): finds many wisps at 0.64-0.88 and
the rift at 0.88-0.95, but misses about a third. Wisp shape carries over; colour
doesn't, completely.

**Seed frames** (24, spread over lust1/lust2; lust3 untouched): candidates = round5
detections down to 0.10, plus light-blue blobs (H 78-104, S≥60, V≥120) the model
didn't box, all run through the filters. Reviewed 161 wisp candidates by eye:
- Kept 87 model boxes, including many real wisps at only 0.20-0.40.
- Rejected 16: pale yellow-green forest creatures, the player's glow, bar wisps, grass.
- Added 3 colour blobs that were real wisps the model missed. Most colour blobs were
  only bits of wisp trails, so they're no good as labels.
- Result: 90 wisps + 24 craters. All 24 frames drawn and checked: every untouched wisp
  is boxed.

**Bootstrap:** `build_dataset` now takes a per-session `tiles` (crops per frame), to
give few seed frames weight: 30 crops per seed frame against 4 per Vibrant frame.
lust_boot = round5 fine-tuned 10 epochs. On non-seed Lustrous frames it finds the
missed wisps at 0.86-0.93.

**Auto-labeling the other 702 frames** (lust_boot plus filters, conf 0.35): 3.5-4.0
wisps and 1 crater per frame, median confidence 0.91. Review:
- 1 crater per frame, all near the centre.
- Off-colour boxes (14) are hovered/clicked wisps (yellow tint): kept; 1 chronicle removed.
- Lowest-confidence boxes (50) and all 470 boxes near the player's screen position,
  checked tile by tile. Mistakes: the player's blue converting aura (often on the
  rift's bright glow) and the **blue energy orb** that flies to the player, a single
  round blob that is a little deeper blue (H 98-99). Some score 0.87-0.91.
- "Filled glow" share (H 85-105, S≥40, V≥170 covering the box): the aura boxes score
  0.33-0.37, real wisps ≤ 0.21 (p99 0.15). That caught the last two.
- 52 boxes removed in total. Backups are in `data/labels/<lust>_backup_auto/`.

**Result:** lust1 295 frames / 1010 wisps, lust2 279 / 1095, lust3 152 / 586; 1 crater
each.

**Split:** lust1 train, lust2 trainval, **lust3 test (held out)**, alongside test1,
empty1-3 as before. Crops: 3 per frame.

**Round 6** = round5 fine-tuned 20 epochs on Vibrant + Lustrous.

**Round 6 training:** val crops P 0.986 / R 0.989 / mAP50 0.989 / mAP50-95 0.854.
TensorRT engine 768x1920, same size as round 5.

## 2026-10-09 · Round 6 results; the bar filter dropped light-blue wisps

**First test on lust3** (conf 0.4, dedupe + filters): wisp recall only 0.964. 14 of
the misses were wisps that round 6 had found at 0.71-0.91 before the bar filter
dropped them. Lustrous wisps are the bar's own hue. The old `bar_share` counted every
row whose bar-coloured run covered 35% of the box width, and a row through an orb
qualifies, so Lustrous wisps scored up to 0.56 against the 0.56 cut. Their labels had
been made through the same filter, so about 2% of Lustrous wisps were missing from
lust1-3 as well.

**Fix** (`detector/filters.py`): only straight runs of at least `bar_min_len` (40 px)
count as bar. They are measured on rows 40 px wider than the box on each side, so a
box over part of a bar still sees all of it. An orb is ~12 px across, the bar ~76 px.
- All 70 bar boxes from test1 still score ≥ 0.61. Labeled wisps in every session score
  ≤ 0.34 (Lustrous before the fix: p99 0.52, max 0.56).
- Costs 0.5-1.3 ms per frame. `min_run` is gone from `capture.yaml`.

**Labels:** 55 lust_boot boxes (≥ 0.35) had been dropped only by the old rule; none
was harvested and none overlapped a label. All 55 were viewed: 50 real wisps were added
(lust1 14, lust2 27, lust3 9). The other 5 boxed only one orb of a two-orb wisp and
were left out. Backups are in `data/labels/<lust>_backup_barfix/`.

**Held-out results** (conf 0.4, dedupe + new filters, matched at IoU 0.3):

| model | lust3 P | lust3 R | empty3 P | empty3 R |
|---|---|---|---|---|
| round5 | 0.933 | 0.778 | 0.989 | 0.994 |
| lust_boot | 0.992 | 0.998 | - | - |
| **round6** | 0.969 | **0.990** | **0.996** | 0.990 |

lust_boot made the lust3 labels, so its score flatters it. Disagreements judged by eye:
- lust3, lust_boot vs round6. lust_boot alone found 6 boxes: 4 real wisps that round6
  misses (one hovered, yellow) and 2 unclear. Round6 alone found 15: about 11 real wisps
  missing from the labels and 4 boxes placed differently. Round6 finds more real wisps.
- empty3, round5 vs round6. Round5 alone found 11 boxes:
  - mostly a box on one orb instead of the whole wisp;
  - 1 wisp at the rift edge that round6 misses;
  - 1 box on the player at the rift.

  Round6 alone found 2: the blue energy orb flying to the player (0.48), and one wisp
  split into two boxes.

**Round 6 is the live default** (`latest_weights` picks its engine). A replay of lust3
through `detector.main` ran end to end at 15.8 ms mean latency. Round 6 was not
retrained on the 50 added labels, because it already finds those wisps at 0.7-0.9.
The next `tools.retrain` will include them.

## 2026-10-09 · Sparkling and Glowing colonies

**Recording** (empty worlds): spark1 179, spark2 155, spark3 88 frames; glow1 109,
glow2 38, glow3 42.

**Round 6 on them:**
- Glowing wisps, a cyan ring (bright pixels H ~78): 4.0 per frame at a median of 0.86.
  The shape carried over.
- Sparkling wisps, a yellow orb (H 29-33) with a white orb circling it: 0.2 per frame.
  These are new. Yellow is also the colour of the golden sheep and trees in the walled
  garden north of the rift.

**Glowing labels:** round 6 + filters at 0.35, 691 boxes. Review:
- The 60 least-cyan and 40 lowest-confidence boxes: 25 removed, 24 of them on green
  game text drawn over the scene.
- 11 oversized boxes fixed: 10 re-centred on the ring at the median size, 1 that held
  two wisps split.
- 71 weak model boxes (0.10-0.35) with no label: 7 real wisps added. The rest were
  trails, the green text and the player.
- All 145 boxes next to the rift viewed: all real wisps. Hovered ones get a yellow
  ring; they're kept.
- Result: glow1 431, glow2 134, glow3 109 wisps; 1 crater per frame.

**Sparkling seeds:** 24 frames, 12 each from spark1 and spark2. Candidates were compact
yellow orb cores (round, ≤ 16 px) grouped with nearby bright orbs, plus round 6 boxes.
They were picked by eye on numbered overview frames.
- Rejected: sheep, the yellow tree, harvested springs.
- Added 5 missed wisps.
- Result: 91 wisps + 24 craters.

spark_boot = round 6 + 10 epochs, with 30 crops per seed frame. It finds 3.5-4.2
Sparkling wisps per frame (median 0.77).

**Sparkling auto-labels** (spark_boot + filters, 0.35): about 1650 boxes.
- **Box convention:** one box = the yellow orb plus its white orb. The model often boxed
  just one of the two. Every box was rebuilt from the yellow orb it contains plus the
  white orbs within 20 px that are nearer to it than to any other yellow orb. The
  orb's own outline must be ≤ 18 px, so the yellow click-square around a clicked wisp
  isn't taken in.
- Boxes without a yellow orb (74, viewed):
  - 13 removed: the player at the rift (9) and the cyan energy orb (4);
  - 27 dropped as the white orb of an already-boxed wisp;
  - the rest rebuilt or kept.
- 259 unlabeled candidates (yellow cores and weak model boxes within 330 px of the
  rift), viewed:
  - mostly sheep heads, harvested springs and the player;
  - 36 real wisps added, among them clicked wisps inside the yellow click-square;
  - 5 unclear ones left out (next to a harvest bar).
- 4 boxes that covered two wisps split into one per wisp.
- Result: spark1 637, spark2 632, spark3 368 wisps; 1 crater per frame.

**Split:** spark1 / glow1 train, spark2 / glow2 trainval, **spark3 and glow3 test**.
Crops per frame: 3 for Vibrant and Lustrous, 4 for Sparkling, 6 for Glowing, so the
smaller tiers aren't drowned out.

**Round 7** = round 6 + 20 epochs on all four tiers (`tools.retrain --tiles 3`).

**Round 7 training:** val P 0.973 / R 0.971 / mAP50 0.982 / mAP50-95 0.846. There are
now 604 validation crops across all four tiers, so this isn't directly comparable to
round 6.

**Held-out results** (conf 0.4, dedupe + filters, matched at IoU 0.3):

| session | round 6 P / R | round 7 P / R |
|---|---|---|
| empty3 (Vibrant) | 0.996 / 0.990 | 0.996 / 0.989 |
| lust3 (Lustrous) | 0.969 / 0.990 | 0.978 / 0.988 |
| glow3 (Glowing) | 0.936 / 0.936 | 0.930 / 0.973 |
| spark3 (Sparkling) | - | 0.979 / 0.870 |

- **Sparkling:** many wisps score just under the 0.4 cut. Of the 48 misses, 15 score
  0.35-0.39 and 31 score 0.20-0.39. At 0.3, recall is 0.924, and at 0.2 it is 0.954.
  Some "misses" are only a box-shape mismatch: the model boxed the yellow orb, the
  label covers the orb and its white partner. Sparkling has the fewest frames and
  was labeled last, so more Sparkling recordings should raise its confidence.
- **Round-7 boxes with no label** (15, viewed):
  - 7 on Sparkling, all real wisps with a different box shape.
  - 3 on Glowing: clicked wisps boxed with the whole yellow click-square.
  - 1 wisp next to a harvest bar.
  - **4 false positives** on green game text ("Memory…") drawn over the scene in
    glow3, at 0.48-0.50. That text appears only in the glow3 frames, so training
    never saw it.

**Incident: the live app picked up a half-trained model.** The owner ran
`detector.main` at Lustrous while round 7 was training and saw far worse results.
`latest_weights` took the most recently written best.pt of any run. During training
that is the run in progress, and its best.pt is rewritten every epoch. Worse, its
infer.yaml was only written after training, so those weights ran on whole frames at
the crops' 640 instead of 1920, and wisps were a few px wide.
- `latest_weights` now takes the engine of the most recently trained run that has
  one. A run still training has no engine, and neither do the bootstrap models
  (lust_boot, spark_boot). It falls back to the newest best.pt only if no run has an
  engine. Checked on a simulated runs folder.
- `tools.train` writes infer.yaml before the first epoch (an Ultralytics callback).
  Checked with a 1-epoch CPU run.
- Round 7's finished engine is as good as round 6 on lust3 (table above), so the bad
  results came from the half-trained checkpoint, not from the new tiers.

**Round 7 is the live default.**
