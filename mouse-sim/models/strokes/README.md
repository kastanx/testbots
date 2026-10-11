# Stroke model - new movements instead of replays

`models/strokes/` is a separate model, asked for by name: `"model": "strokes"` in `/api/generate`.
`auto` is still motion matching, so anything that doesn't ask for it works exactly as before.
pixelwatch/mouseover2.js uses it by default (`--model replay` for motion matching). The compare page
(below) shows it next to motion matching and your own movement.

## Why

Motion matching replays the owner's recorded movements, rotated, scaled and stretched to fit. It's
realistic, but with 1,234 recordings the same request keeps getting the same few movements back: for
a 120 px move or a 900 px move to a small target only one recording qualifies, so every answer is
the *identical* movement. The generative network (`models/generative`) made new movements, but they
were easy to tell from the owner's (classifier AUC 0.983): it drew 256 positions per movement, and
speed and shake - what gives a hand away - come out of those positions as noisy derivatives.

## How

A quick aimed movement is a sum of *strokes* (the kinematic theory of rapid human movements): pushes
whose speed has a lognormal shape - fast rise, early peak, long tail - each along a slight arc.
`lognormal.py` fits strokes to every recorded movement (about 2 per movement, 23 dB median fit, all
1,234 in ~15 s on all cores, cached in `cache/`). The fit is kept physical: no stroke starts more than
300 ms before the movement or is narrower than sigma 0.1, and the strokes' sizes may add up to at most
1.15x the distance the hand travelled. Without that, a fifth of the fits explained detail with two
huge strokes pulling in opposite directions, which came apart when one was varied: the movement
headed off the wrong way and looped. A fit that still did that would be used unvaried; none does. What the strokes don't explain - tremor, small
wobbles, the way the hand settles - is kept as that movement's *texture*.

For a request (`model.py`):

1. **Candidates**: the 16 recorded movements nearest in distance, direction, target size and start
   position (motion matching's weights). One is the template, picked at random, nearer ones favoured.
2. **A new main stroke**: the template's strokes are scaled to the new distance and to the
   Fitts-predicted time. Then its main stroke's size, direction and curve, and where the movement
   ends, are moved a random part of the way toward another candidate's (one that also hit, or also
   missed). The variation is always a difference between two real movements, so what varies together
   in the owner's movements varies together here; independent random noise cost more realism for
   the same novelty (table below).
3. **Re-aimed**: the whole stroke plan is scaled and turned as one, so it ends at the new end point
   when the template stopped (stretched like it).
4. **Texture**: the template's own, stretched like the strokes, added on top; rounded to whole
   pixels once, clamped like a real cursor.
5. **Around it**, as in the generative model: a real reaction (with drift), a real pause before the
   click, a real hold and slip from the owner's banks; a miss leads to another movement and click.

So a generated movement is a recorded one plus a smooth, stroke-shaped change toward another recorded
one - with the owner's speed profile, corrections and texture, but never the same twice.

## Results

Scored with mouse-sim's own harness (`eval.harness.evaluate`) on the session the earlier reports held
out (`20261008-220713-3654`, 318 trials) - the session marked held out in memory only, every model
fitted on the other four, averaged over 5 runs:

| | generative (network) | motion matching (`auto`) | **strokes** |
|---|---|---|---|
| classifier AUC, features (floor 0.744, pass ≤ 0.794) | 0.983 | 0.710 | **0.777** |
| classifier AUC, path shape (CNN; floor ~0.66) | 0.956 | 0.644 | **0.618** |
| key features within 1.25 of the owner's drift | 7 / 18 | 17.2 / 18 | **16.6 / 18** |
| first click missed (owner: 7.9 %) | – | 5.9 % | **6.5 %** |
| novelty: to the nearest recording (new real movement: 0.054) | – | 0.004 | **0.038** |
| same request twice: how far apart | – | 0.019 | **0.117** |
| exact copies of a recording | – | 8 % | **0 %** |

(The generative row is from its earlier report, one run on the same held-out session.) The feature it
fails most often is path efficiency (1.29 in the run shown in the harness table; motion matching:
1.26) - its paths are a little less straight than the owner's; now and then a tremor band or the
slip (from the same click bank as the generative model) lands just over 1.25.

Unnatural single movements - heading off the wrong way, loops - were checked separately, 300 per
move: none on a 600 px move or a crater-to-wisp move; on a 120 px wisp-to-wisp move 1 % headed
more than 30 degrees off (the owner's own recordings: 4 %).

- **Classifier AUC**: how well a classifier tells generated from real (0.5 = can't). The floor is how
  well it tells the owner's other sessions from the held-out one; the harness passes within +0.05.
- **Key features**: 18 measures (speed peak, path efficiency, curvature, submovements, overshoot,
  smoothness, tremor bands, dwell, hold ...); pass = within 1.25x of the owner's own day-to-day drift.
- **Novelty**: RMS distance between paths (onset to press, as a fraction of the distance) - a
  generated one to the nearest of the 16 recordings it could have come from. A held-out real movement
  is 0.054 from its nearest recording: that's how new a genuinely new movement is.
- **Same request twice**: mean distance between two answers to the same request.

On the moves mouseover2 makes (same request 100 times):

| move | motion matching: different answers of 100 | strokes: different answers of 100 (templates used) |
|---|---|---|
| crater -> wisp, 430 px, 15 px target | 8 | 100 (17) |
| wisp -> crater, 430 px, 60 px target | 8 | 100 (16) |
| wisp -> nearby wisp, 120 px | **1** - the same movement every time | 100 (16) |
| long move, 900 px | **1** - the same movement every time | 100 (13) |

What each kind of variation costs (3 runs each, on top of no variation; AUC pass line ~0.797):

| varied | AUC | features | novelty |
|---|---|---|---|
| nothing (template rescaled, own ending) | 0.788 | 17.0 | 0.030 |
| where it ends | 0.768 | 17.0 | 0.033 |
| main stroke size | 0.802 | 16.7 | 0.045 |
| main stroke direction + curve | 0.816 | 16.3 | 0.041 |
| main stroke shape (sigma) | 0.815 | 13.0 | 0.049 |
| speed (tempo) | 0.800 | 16.3 | 0.029 |
| size + direction + curve + end, toward another candidate (default) | 0.777 | 17.0 | 0.040 |

(Those used random noise, except the last; the table above it has the final numbers.) Speed and
stroke-shape variation are left out: they break how the main stroke and its corrections line up.

## Try it

**The compare page**: `compare.bat` in mouse-sim (or `python mouse-sim/compare.py --open`) opens
http://localhost:8771/. Drag a start dot and a target; Space, then move from the dot to the target and
click it as you would; your movement is drawn with samples from motion matching and the stroke model
for the same start and target, with their speed and distance curves, a real-time playback (P) and the
harness's measures for each. It loads the recordings and both models itself, next to any running
mouse-sim server. Your attempt is turned into a 1 ms timeline exactly as recordings are.

From HTTP: `"model": "strokes"` in `POST /api/generate` (docs/http-api.md). From Python:

```python
import numpy as np
from models.base import TrialConditions
from models.strokes.model import StrokeModel
from pipeline.dataset import Dataset
from pipeline.timeline import Target

model = StrokeModel().fit(Dataset())          # ~15 s the first time, then cached
tl = model.generate(TrialConditions(start=(1715, 715), target=Target("rect", 1600, 760, 15, 15, 3.75),
                                    screen=(3440, 1440)), np.random.default_rng())
tl.pos, tl.clicks                             # positions per ms, (down, up) per click
```

## Files

- `lognormal.py` - stroke maths and fitting (exact Jacobian)
- `library.py` - the decomposed recordings, cached in `cache/` (safe to delete; rebuilt on demand)
- `model.py` - the generator; `DEFAULTS` holds every setting, the other choices are kept for trying
- `tests/test_strokes.py` - stroke maths, fitting, re-aiming, generation and the server on a synthetic owner
- `tools/compare.py`, `tools/compare.html`, `compare.py`, `compare.bat` - the compare page

## Limits

- It is built from the same 1,234 recordings: new combinations and variations of them, not movements
  of a kind the owner never made.
- Path efficiency is its weakest feature (around the pass limit): its paths are a little less straight
  than the owner's.
- Not tried in the game or through the Pi yet.
