# mouse-sim

A personal mouse-movement model and browser simulator, built from the handoff
"Personal Mouse-Movement Model and Browser Simulator" (2026-10-08). You record yourself clicking
targets in the browser; the pipeline learns how you move; a simulator page shows a cursor moving to
any target the way you would, and the local server returns the same trials as JSON over HTTP. Nothing
here moves the real cursor or injects input.

```
recorder page ─► data/raw/<session>/ (never edited)
                  │
                  ▼
   python -m pipeline all        validate → convert → segment → features → fingerprint report
                  │
     ┌────────────┼─────────────────────────────┐
     ▼            ▼                             ▼
 baselines   motion matching (v1)      generative model (v2, PyTorch → ONNX)
     └────────────┴──────────────┬──────────────┘
                                 ▼
   python -m eval run            harness: feature ratios, C2ST, drift floor, leaderboard
                                 ▼
   python -m models.export  ──►  simulator page (WebGPU / WASM in the browser) + blind test
```

## Status

Everything in phases 0–7 was built and run end to end first on a **synthetic test owner**: fake
sessions in the exact raw format, with a personal signature and day-to-day drift. Then it was run on
your recordings: 5 training sessions on 8–9 October, 1,242 trials. Recording is finished; no more
sessions are planned.

| Phase | Built | Checked on synthetic data | On your data |
|---|---|---|---|
| 0 Skeleton | server, layout, settings lock | session saves (tests, headless browser run) | – |
| 1 Recorder | `/recorder/` | 12-trial headless run: targets, misses, pause, save | 5 sessions at 995–997 Hz |
| 2 Pipeline + fingerprint | `python -m pipeline all` | 14 sessions validate and process, report renders | all 5 sessions validate |
| 3 Harness | `python -m eval run` | report + leaderboard, baselines fail (AUC 1.00) | run on one held-out session |
| 4 Baselines | line, minimum jerk, Bézier | fail clearly | – |
| 5 Motion matching | `mm` | 18/18 features ≤ 1.25, AUC 0.59 vs drift floor 0.64 | **in use:** 17/18 features ≤ 1.25 (path efficiency 1.26), AUC 0.725 vs your own 0.728 |
| 6 Generative | `gen`, ONNX export | alone: 10/18, worst ratio 2.9 (2.25 after `tune`), AUC 0.95; hybrid: 18/18, AUC 0.58 | not used: alone 7/18, AUC 0.983; hybrid 9/18, AUC 0.829 |
| 7 Simulator | `/simulator/` | all 7 modes and the blind test run in headless Chrome; browser sampler matches PyTorch to 3e-7 | 1,234 trials in the bundle; no blind test (it needs test sessions) |
| 8 Everyday logger | not built | – | you chose "not now" |
| HTTP API | `POST /api/generate` | 12 tests | answers with motion matching, about 4 ms per request |

## First steps for you

1. **Settings lock.** Open `data/setup.json`. I filled in what Windows reports (pointer speed 10/20,
   Enhance pointer precision on, AOC 3440×1440 at 144 Hz, 100% scaling, default cursor) and the
   SteelSeries mouse you picked. Add the mouse's **DPI** and **polling rate**, then set
   `"confirmed": true`. The recorder refuses real sessions until you do, and again later if Windows
   settings drift from the file.
2. **Start the server:** double-click `start.bat` (or run `.venv\Scripts\python serve.py`), then open
   <http://localhost:8765/>.
3. **Check the event rate** on the recorder page ("Check event rate (5 s)", then move the mouse around
   quickly). It should be close to your polling rate with few gaps. If it isn't, try
   `/recorder/?source=raw` (pointerrawupdate). If that is low too, the handoff's fallback is a native
   helper (a low-level mouse hook streaming to the page). It isn't built yet; ask for it if you need it.
4. **Record.** 10–15 minutes per session, at most 2–3 a day, on different days and at different times of day.
   Mark each session's role in the form:
   - **training** sessions until about 2,000 movements (roughly 5–6 sessions of 12 minutes; the coverage
     map shows the gaps). The handoff asks for 6,000, but a learning curve on the first 506 movements
     showed diminishing returns. The test sessions decide whether more is worth it.
   - 1–2 **validation** sessions
   - **2 test sessions on separate days**, never used for training or tuning
   Space pauses, Esc ends. The session ends by itself after 12 minutes (`config/recorder.json`).

## Commands

All Python commands run from `mouse-sim/` with the project's venv (`.venv\Scripts\python`). Every one
takes `--data DIR` to point at another data folder.

```bash
.venv/Scripts/python serve.py [--preload] [--host 0.0.0.0]   # the server: pages + HTTP API on :8765
.venv/Scripts/python -m pipeline validate             # check raw sessions (fails loudly)
.venv/Scripts/python -m pipeline all                  # process + reports/fingerprint.html
.venv/Scripts/python -m eval run --model line --model minjerk --model bezier
.venv/Scripts/python -m models.motion_matching tune --write   # tune on validation sessions
.venv/Scripts/python -m eval run --model mm
.venv/Scripts/python -m models.generative train       # 30k steps by default; on your ~1,200 movements it overfits after ~2k
.venv/Scripts/python -m models.generative tune --write  # low-pass/start ramp, on validation sessions
.venv/Scripts/python -m eval run --model gen --model hybrid
.venv/Scripts/python -m models.export                 # bundle for the simulator
.venv/Scripts/python -m eval blind                    # score saved blind tests
.venv/Scripts/python -m pytest                        # Python tests
```

Web: `cd web && npm run build` (pages), `npm run dev` (Vite on :5173 with hot reload, proxying the
API to :8765), `npm test` (unit tests and Python/TypeScript parity tests).

Try everything without recordings: `python -m tools.synth --out ../synth --sessions train:10,val:2,test:2 --trials 450`,
then pass `--data ../synth` to the commands above. Synthetic folders are refused if they point at
`data/`, and the harness labels their reports "SYNTHETIC".

## HTTP API and output format

- [docs/http-api.md](docs/http-api.md): run the server, then `POST /api/generate` with the cursor position
  and the target (its bounding box, or its centre and size). It returns one trial as JSON.
- [docs/output-spec.md](docs/output-spec.md): how to read the response: the cursor position every
  millisecond (`pos`) and the press and release times (`clicks`).

## Layout

```
config/          shared settings (Python and the web pages read the same JSON)
  cells.json       coverage cells: 7 distance × 12 direction × 5 size bins
  recorder.json    pauses, warm-up, session length, target shapes, colours
  pipeline.json    validation and segmentation thresholds, feature settings
  harness.json     condition groups, key features, pass criteria
  motion_matching.json  weights, hard limits, warp low-pass
data/            setup.json (tracked); raw/, processed/, dryrun/, blindtests/ (ignored by git)
server/          FastAPI: serves web/dist, stores sessions, coverage, blind-test results, /api/generate
docs/            http-api.md (calling the API), output-spec.md (reading the response)
pipeline/        rawio, validate, convert (physical px, 1 ms polling grid), segment, features, report
eval/            samples, ratio, c2st, harness, blind, leaderboard
models/          base (interface), baselines/, motion_matching/, generative/, hybrid, export
web/src/         recorder/, simulator/, shared/ (geometry, placement, timeline, models/ runtimes)
tools/           synth (synthetic owner), extract_cursor, e2e_recorder.mjs, shot.mjs, parity fixture
reports/         fingerprint.html, harness/<model>.html, leaderboard.md
```

## Decisions and deviations from the handoff

These choices weren't spelled out in the handoff, or I changed something after testing. Each one
lives in config or in one clearly marked place.

- **Units.** Raw events and trials are stored in CSS pixels as delivered. Everything downstream (cells,
  features, models) uses physical pixels.
- **Target size** along/across the movement is the chord through the target centre (MacKenzie &
  Buxton's W′). For circles it is the diameter.
- **Placement.** Training sessions steer towards sparse cells (weight 1/(1+n)²). Validation and test
  sessions draw cells uniformly, so they stay a balanced sample. Targets keep 16 px from the screen
  edge, and the cursor never starts inside a target.
- **Clicks.** A press inside the target is a hit; the target disappears on release, like a button.
  A press outside is a miss, and the target stays.
- **Timestamps.** Pages are cross-origin isolated (5 µs timers). `target_on` is the timestamp of
  the frame that first draws the target. The simulator uses the same convention, so the offset
  cancels.
- **Event-rate check** only counts intervals where the cursor moves at least 1.5 px/ms. When the
  cursor moves less than about a pixel per poll, the mouse legitimately skips reports.
- **t_grid.** Events are snapped onto the 1 ms polling grid per burst: phase from the circular mean,
  slots from a small dynamic programme that keeps them strictly increasing. Both clocks are kept, and
  per session the pipeline builds timelines from whichever gives the lower speed noise
  (`timeline_clock: auto`). On synthetic data the grid won. On your first real session Chrome's own
  timestamps were already clean (0.1 ms jitter) and raw won.
- **Submovements** are counted on a Gaussian-smoothed speed (σ 8 ms). A new one must reach 10% of
  the movement's top speed and cover at least 2 px; otherwise pixel steps and tremor were counted.
- **Generative representation.** The network generates the movement from onset to the cursor's
  last stop: 256 canonical points, log duration, and where it ends relative to the target in
  target-size units. The path is bent onto that end point, so landing precision on small targets
  doesn't depend on distance. The pause before clicking, the reaction phase, click hold/slip and the
  after-miss re-reaction are drawn from banks of the owner's real ones, by target size (the handoff's
  "Other timings"). A first version that generated the pause inside the path failed the harness: tiny
  residual motion erased the pause (dwell ratio 7) and endpoints were too loose (14% misses vs 3%).
- **Motion-matching warp.** The recorded path is low-passed at 30 Hz, warped in continuous time, then
  rounded to whole pixels once. Rotating already-rounded pixels and rounding again doubled the
  20–50 Hz pixel-step noise. Stretching time by repeating 1 ms samples added hiccups real motion
  doesn't have. Both failed the harness (20–50 Hz band ratio about 7). A candidate whose clicks would
  change between hit and miss after warping is skipped.
- **Generative network.** 1D U-Net (base 32, 5.3 M parameters) with FiLM, trained with flow matching
  and sampled with 32 Euler steps (`config/generative.json`). No guidance, no temperature. It is
  smaller than the handoff's default sketch so it stays near the ~300 ms budget on WASM; WebGPU is
  used when available. Like motion matching, the continuous path is low-passed (20 Hz) and rounded to
  whole pixels once.
- **Ratio denominator floor.** It is 2% of the feature's spread. Rare binary features (misses) use
  the pooled ratio, because they are too sparse per group.

Synthetic results, for scale (`python -m tools.synth`, 10 training sessions × 450 trials; test = 2 held-out sessions):

| model | key features ≤ 1.25 | worst ratio | C2ST AUC (drift floor 0.64) |
|---|---|---|---|
| hybrid (default) | 18/18 | 1.03 | 0.58 |
| motion matching | 18/18 | 1.13 | 0.59 |
| generative alone | 10/18 | 2.9 | 0.95 |
| baselines | 0/18 | 8–10 | 1.00 |

The generative model alone is not there yet even on synthetic data: its paths are slightly wobblier
than real ones (path efficiency, submovements, 10–50 Hz jitter). The handoff budgets 1–2 weeks for v2;
the levers are more data (yours), longer training, `tune`, and the GRU/MDN fallback the handoff names.
The hybrid uses it only where motion matching has no qualifying recorded trial.

## Training on your data (9 October)

You stopped at 5 training sessions, so the evaluation uses one of them instead of separate test sessions:

- `data/splits.json` temporarily marked `20261008-220713-3654` (318 usable trials) as `val`. The models
  were built from the other 4 sessions and scored on that one with `python -m eval run --role val`.
  Afterwards the file was removed and the data re-processed, so all 5 sessions are training data again.
- **Warm-up trials are used** (`include_warmup` in `config/motion_matching.json` and
  `config/generative.json`). Yours couldn't be told apart from the rest (classifier AUC 0.54). That gives
  1,234 trials instead of 985.
- **The motion-matching warp low-pass is 40 Hz** instead of 30. At 30 Hz, motion matching had too little
  20–50 Hz jitter: ratio 1.55 on a day-1-library, day-2-test split; 40 Hz gave 0.87. The cutoff was chosen
  on that split, not on the held-out session.
- **The generative model overfits** about 900 movements after 2,000 steps (validation loss 0.14 there,
  0.93 by step 12,000). Even at its best checkpoint it is far worse than motion matching (table above),
  and it makes the hybrid worse. So motion matching answers by default (`auto`), and no generative model
  is installed. The test run is kept in `models/generative/runs/20261009-095630` (trained without the
  held-out session) but isn't marked as the latest.

Not done: the blind test (it needs recorded test sessions), the Phase 1 "feels natural" check, and the
options you deferred (a hurried mode, the everyday logger).
