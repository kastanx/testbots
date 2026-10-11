# Labeling guide

Two types: **wisp** (key `1`) and **crater** (key `2`). Apply these rules the same
way every time; inconsistent labels are the most common cause of a weak model.
When a new case comes up, decide a rule, add it here, and apply it everywhere,
including frames that are already labeled.

## Rules

- **Box:** the tightest rectangle around the object's visible pixels.
  - **Wisp:** only **untouched** wisps, the ones nobody is harvesting. Box both orbs
    plus the white arc. A wisp with the cyan progress bar across it, small or the big
    teal kind, is being harvested: don't label it (decided 2026-10-08).
  - **Crater** (the energy rift): only the bright glowing center, not the dark rocky
    rim. That's how the first frames were labeled.
- **Not wisps, never label them:** the cyan progress bar over a harvested wisp,
  golden chronicles, the green memories in the inventory, and anything in the UI
  panels. Those panels are also listed as `ignore` regions in `configs/capture.yaml`.
- A wisp next to the player's red dragon counts too, as long as it has no bar. It's
  easy to miss because the wing covers part of it.
- **Label every untouched wisp and every crater** in a frame. An unlabeled object teaches the
  model that it is background.
- **Partly hidden:** label it if roughly 30% or more is visible and recognizable.
  The box covers only the visible part.
- **Cut off by the window edge:** label the visible part.
- **Too small to recognize by eye:** don't label it, and accept that the model
  won't find it either.
- **Empty frames:** about 10% of training frames should contain no objects at
  all. Press Enter on them so they count as labeled ("nothing here").
- **Colors don't matter:** a wisp is a wisp in any color. Don't label colors.

## The labeler

`run.bat tools.label --session <session>` opens the session's frames at the
first unlabeled one. Labels are saved in `data/labels/<session>/`, one YOLO text
file per frame. A frame counts as labeled once it has a file, even an empty one.

| Do | How |
|---|---|
| Draw a box | drag with the left mouse button (it gets the current type) |
| Choose the type | `1` wisp, `2` crater; with a box selected, this also changes that box |
| Select a box | click inside it |
| Delete a box | right-click it, or select it and press `X` / `Delete` |
| Undo | `Z` |
| Save and go to the next frame | `Enter` or `Space` (also for a frame with nothing in it) |
| Previous / next frame | `A` / `D`, or the arrow keys (edits are saved) |
| Next unlabeled frame | `N` |
| Zoom / pan | mouse wheel at the cursor / middle-drag; `F` fits the frame again |
| Hide boxes to see what's under them | `H` |
| Save and quit | `Q` or `Esc` |

You don't have to label every frame of a session. Skipped frames (no label file)
are simply left out of the dataset.

With a trained model, `--weights runs\detect\<run>\weights\best.pt` pre-draws its
boxes on frames that have no labels yet: fix them and press Enter.

**Auto-labeling a whole session:** `run.bat tools.autolabel --session <s> --weights <model>`
labels every frame that has no labels yet; hand-made labels are never touched. The
labeler marks those frames "auto, not checked", `N` jumps to the next one, and Enter
marks one as checked.

## Splits

Split by recording session, never at random (`configs/dataset.yaml`). One session
is the **test** session: never train or tune on it. One is the **validation**
session; the rest are training sessions. For a single quick test session there is
`split: trainval`: the first 80% of its labeled frames train, the last 20% validate.

## Spot check

Before training on a new batch, flip through about 10% of the labeled frames
(`A`/`D`) and check them against these rules.

## CVAT instead (optional)

The plan's original tool still works: create one task per session from the
frames, labels `wisp` and `crater`, then export "Ultralytics YOLO Detection" (or
"YOLO 1.1") and point the session's `labels:` in `configs/dataset.yaml` at the
export.
