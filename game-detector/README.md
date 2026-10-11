# game-detector

Real-time detection of two object types in RuneScape, read from screen pixels
only. For every object on screen it reports the type, its actual color
(`#rrggbb`), the box and center in screen pixels, and a confidence. The results
show in a live preview window and can optionally be streamed as JSON. It never
sends input to the game.

This is the proof-of-concept build of the [handoff plan](docs/handoff.md). All
phases have their tools. What's still missing is game-specific: the game itself,
its colors and labeled frames. Until then a synthetic scene stands in for the game.
Results are in [docs/experiments.md](docs/experiments.md).

```
detector/   capture.py   capture thread (DXGI via dxcam), keeps only the newest frame
            infer.py     YOLO wrapper (.pt or TensorRT .engine) + ByteTrack
            color.py     color reader (Phase 6) + color-filter detector (Phase 1)
            output.py    preview drawing, JSON over UDP / to a file
            metrics.py   matching against ground truth
            main.py      the live app
tools/      check_env, capture_bench, select_region            Phase 0
            color_filter (HSV picker + batch test)             Phase 1
            capture_frames (hotkey recorder)                   Phase 2
            label (labeler), prelabel, build_dataset           Phase 3 / 5
            check_sizes, train, evaluate                       Phase 4
            calibrate_colors                                   Phase 6
            synth (synthetic self-test scene), view (zoom/pan for the GUIs)
configs/    capture.yaml, game.yaml, colors.yaml, dataset.yaml, data.yaml (generated)
docs/       handoff.md, labeling-guide.md, experiments.md
data/ datasets/ runs/ weights/ exports/   local only (git-ignored)
```

Run everything from this folder with the project's Python:
`.venv\Scripts\python.exe -m <module> ...`, or `run.bat <module> ...` from anywhere.

## See it working now (synthetic scene)

```bash
run.bat detector.main --source synth --weights runs\detect\synth\weights\best.engine --track
```

The synthetic scene has gems and slimes in seven colors, plus look-alikes that
must be ignored: coins, shards, colored flowers and HUD icons. Objects get
partly hidden and the lighting changes. Each detection shows its track id,
type, confidence, color and screen-pixel center. The thin grey boxes are the
ground truth. When the app exits it prints speed and accuracy. Measured here:
up to 60 detections/s (fewer while something else loads the GPU), 99% of
objects found, types 99.9% correct, colors 99% correct.

## Proof of concept on RuneScape

Already done: capture follows the `RuneScape` window's client area (3440×1369,
`configs/capture.yaml`), and the capture check passed (60 fps, colors exact).
Colors need no setup: the objects can be any color, so training ignores color
and the live app reports each object's actual color.

The two object types are **wisp** (only untouched ones: a wisp with the cyan harvest
progress bar across it is ignored) and **crater** (`configs/dataset.yaml`).

1. **Record** while playing where the objects show up:
   `run.bat tools.capture_frames --session s01 --notes "what this session covers"`.
   In the game, **L** starts/stops (one frame per second), **K** takes a burst of
   5, **J** ends. The keys only act while the game window has focus. Record 4-6
   sessions of 5-10 minutes covering different places, crowded and empty scenes,
   near/far, partly hidden objects, and the camera zooms you'll use. Nothing is
   saved while another window is in front of the game.
2. **Label:** `run.bat tools.label --session s01`. Drag a box, `1` wisp / `2` crater,
   Enter saves and moves on. Every key is listed at the bottom of the window. Rules
   are in [docs/labeling-guide.md](docs/labeling-guide.md). Then add the session to
   `configs/dataset.yaml`. Once a first model exists, `--weights ...` pre-draws its
   boxes and you only fix them.
3. **Train:** the frames are 3440 px wide and wisps only ~30 px, so training uses crops
   that keep objects at the size they'll have when whole frames are detected at 1920:
   ```bash
   run.bat tools.build_dataset --tiles 10 --infer-imgsz 1920
   run.bat tools.train --name first epochs=40 cache=ram
   run.bat tools.evaluate --weights runs\detect\first\weights\best.pt
   ```
   `tools.check_sizes` (on a build without `--tiles`) shows how big the objects get at
   each size.
4. **Live:** `run.bat detector.main --weights runs\detect\first\weights\best.pt --track`,
   then a TensorRT engine for less GPU time per frame:
   ```bash
   .venv\Scripts\yolo export model=runs\detect\first\weights\best.pt format=engine quantize=16 imgsz=768,1920 device=0
   run.bat detector.main --weights runs\detect\first\weights\best.engine --track
   ```
   The engine's `imgsz` (height,width, multiples of 32) is the whole-frame detection
   size in the window's shape: 3440×1369 at 1920 wide is `768,1920`. The live app
   reads the size from the engine. The build takes several minutes.

### Adding a session and retraining (what you'll usually do)

1. `run.bat tools.capture_frames --session vib2 --notes "..."`, then L / L / J in the game.
2. `run.bat tools.autolabel --session vib2 --weights runs\detect\round2\weights\best.pt --review 12`
   lets the current model label every frame. It saves 12 annotated frames to
   `runs\review\vib2_auto\` for a quick check.
3. Optionally skim it: `run.bat tools.label --session vib2`. `N` jumps to the next
   unchecked frame; fix it or press Enter.
4. `run.bat tools.retrain` does steps 3-4 above in one go. It adds new labeled sessions
   to `configs/dataset.yaml`, builds the crops, trains `roundN`, and exports the
   engine. That's about 20-25 min of GPU time, so the game may stutter. Until the
   engine is exported, `run.bat detector.main` keeps using the previous model (it
   only loads models that have an engine); restart it afterwards to get the new one.

`test1` (the first session) is `split: trainval`: its first 80% trains and its last 20%
validates.

## The live app

`run.bat detector.main [options]`; see `--help` for the full list.

| Option | |
|---|---|
| `--weights PATH` | `.pt` or `.engine`; default: the newest `runs/detect/*/weights/best.*` |
| `--filter` | color filter instead of a model |
| `--source` | `screen` (configs/capture.yaml), `window:<title>`, `synth`, or a folder of frames |
| `--track` | ByteTrack ids; each track's color is a vote over its last frames, so it doesn't flicker |
| `--conf`, `--imgsz` | detection threshold; inference size (default: the model's own) |
| `--max-rate N` | detections per second, default 30 (0 = every frame); fewer leaves more GPU for the game |
| `--udp HOST:PORT`, `--jsonl PATH` | one JSON message per frame |
| `--http PORT`, `--http-host` | current boxes at `GET http://127.0.0.1:8790/` ([API.md](API.md)); `--http 0` turns it off, `--http-host 0.0.0.0` makes it reachable from other devices |
| `--no-preview --duration S --stats-json PATH` | headless runs and measurements |

Preview keys: `q`/`Esc` quit, `space` pause, `s` snapshot, `+`/`-` confidence.
A snapshot puts the raw frame, an annotated copy and the JSON into
`runs/snapshots/`, and the raw frame can go straight into labeling.

The preview window stays on top and is **excluded from screen capture**. You
can place it over part of the game and the detector still sees the game
underneath it.

JSON, one message per frame, with coordinates in screen pixels and `t` in Unix
seconds at capture:

```json
{"t": 1791480871.885, "frame": 102, "latency_ms": 18.4,
 "objects": [{"id": 1, "type": "slime", "color": "red", "conf": 0.955,
              "box": [923, 418, 1002, 488], "center": [962, 453]}]}
```

## Notes

- **The GPU is shared with the game,** which keeps the 4070 about 70% busy by
  itself. At the default 30 detections/s every processed frame is fresh, and 99% of
  results arrive within 20 ms of the frame being captured. Lower `--max-rate`
  (10 is plenty) or use the nano model (`--model yolo26n.pt` in `tools.train`) to
  leave the game more GPU.
- Detection and recording pause while another window covers the game (the
  preview window doesn't count: it's invisible to the capture).
- Two game-specific filters in `configs/capture.yaml` drop detections in the UI
  panels (`ignore`) and on the cyan harvest progress bar (`bar_filter`). They apply
  live, when auto-labeling and in the labeler's suggestions. `--no-filters` turns
  them off in the live app.
- Ultralytics' global settings on this PC point `runs_dir` at `testbots/runs`.
  `tools.train` passes the project path explicitly so runs stay in `game-detector/runs/`.
- On Windows, Ultralytics does not install TensorRT itself. `requirements.txt`
  pins 10.7, which matches the installed driver (560, CUDA 12.6). `half=True` is
  deprecated in this Ultralytics; use `quantize=16`.
- Full-screen 3440×1440 PNGs are about 7 MB each; capturing only the game window
  saves disk space and time.
- The recorder's keys (L/K/J) also reach the game. If they clash with a
  RuneScape keybind, change them in `configs/capture.yaml` (`record.hotkeys`).
- `datasets/synth` (2 GB) is only needed to retrain the synthetic model, so it
  can be deleted.
- License: Ultralytics is AGPL-3.0. That's fine for personal use, but
  distributing the app or offering it as a service requires open-sourcing it or
  an enterprise license.
