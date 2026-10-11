"""Generation over HTTP (docs/http-api.md): POST /api/generate returns one trial as JSON: the cursor
path and the clicks, nothing else (docs/output-spec.md). GET /api/models says which models can answer.

Models are fitted on first use and kept. Each request first checks whether the processed data, the
config or the latest generative run has changed, and refits if so: re-running the pipeline or
training a model doesn't need a server restart. Requests are served one at a time, because models
keep a little state between them (motion matching never uses the same recorded trial twice in a row).
"""
from __future__ import annotations

import json
import math
import threading
import traceback
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from pipeline import config, geometry, paths
from pipeline.timeline import Target

MODELS = ("mm", "hybrid", "gen", "line", "minjerk", "bezier", "strokes")
NEEDS_RUN = ("hybrid", "gen")


# ---------------------------------------------------------------------- request


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")  # a misspelt option is an error, not silently ignored


class Point(Strict):
    x: float
    y: float


class ScreenSize(Strict):
    w: int = Field(gt=0)
    h: int = Field(gt=0)


class TargetIn(Strict):
    shape: Literal["rect", "circle"] = "rect"
    cx: float | None = Field(None, description="centre x (give cx and cy, or left and top)")
    cy: float | None = Field(None, description="centre y")
    left: float | None = Field(None, description="left edge (with top, instead of cx and cy)")
    top: float | None = Field(None, description="top edge")
    w: float = Field(gt=0, description="width; for a circle, its diameter")
    h: float | None = Field(None, gt=0, description="height; required for a rect, not needed for a circle")
    r: float | None = Field(None, ge=0, description="corner radius of a rect; default min(6, w/4, h/4), "
                                                     "like the recorder's buttons")

    @model_validator(mode="after")
    def _check(self) -> "TargetIn":
        given = [v is not None for v in (self.cx, self.cy, self.left, self.top)]
        if given not in ([True, True, False, False], [False, False, True, True]):
            raise ValueError("give either the centre (cx, cy) or the top-left corner (left, top)")
        if self.shape == "rect" and self.h is None:
            raise ValueError("a rect needs h")
        if self.shape == "circle" and self.h not in (None, self.w):
            raise ValueError("a circle has one size: w, its diameter")
        return self

    def to_target(self) -> Target:
        w = self.w
        h = w if self.shape == "circle" else self.h
        cx = self.cx if self.cx is not None else self.left + w / 2
        cy = self.cy if self.cy is not None else self.top + h / 2
        if self.shape == "circle":
            r = 0.0
        elif self.r is not None:
            r = min(self.r, w / 2, h / 2)
        else:
            r = float(geometry.corner_radius(w, h, config.load("recorder")["corner_radius_px"]))
        return Target(self.shape, float(cx), float(cy), float(w), float(h), float(r))


class GenerateRequest(Strict):
    start: Point = Field(description="cursor position when the target appears (screen px)")
    target: TargetIn
    screen: ScreenSize | None = Field(None, description="screen size in px; default: the screen of your recordings")
    model: Literal["auto", "mm", "hybrid", "gen", "line", "minjerk", "bezier", "strokes"] = Field(
        "auto", description="auto: motion matching, the model that scored best on your data; "
                            "strokes: new movements built from your strokes, never the same twice")
    seed: int | None = Field(None, ge=0, description="the same request with the same seed returns the same trial")
    format: Literal["dense", "changes"] = Field(
        "dense", description="dense: pos for every ms; changes: [t, x, y] only where the position changes")
    skip_reaction: bool = Field(False, description="start moving right away: leave out the reaction time, about "
                                                   "250 ms of the cursor standing still before it moves")
    no_misses: bool = Field(False, description="exactly one click, on the target: no simulated misclicks")


EXAMPLES = {  # shown on the /docs page
    "remote": {"summary": "start moving at once, one click, changes only", "value": {
        "start": {"x": 1200, "y": 640}, "target": {"left": 1738, "top": 396, "w": 96, "h": 32},
        "format": "changes", "skip_reaction": True, "no_misses": True}},
    "button": {"summary": "96 x 32 button, by its centre", "value": {
        "start": {"x": 1200, "y": 640}, "target": {"shape": "rect", "cx": 1786, "cy": 412, "w": 96, "h": 32}}},
    "box": {"summary": "the same button as a bounding box, changes only", "value": {
        "start": {"x": 1200, "y": 640}, "target": {"left": 1738, "top": 396, "w": 96, "h": 32},
        "format": "changes"}},
    "circle": {"summary": "16 px circle across the screen", "value": {
        "start": {"x": 300, "y": 1200}, "target": {"shape": "circle", "cx": 2900, "cy": 200, "w": 16}}},
}


# ---------------------------------------------------------------------- response (for the API docs)


class Click(BaseModel):
    down: int = Field(description="button press, ms after the target appeared (an index into pos)")
    up: int = Field(description="button release, ms after the target appeared (an index into pos)")


class GenerateResponse(BaseModel):
    pos: list[list[int]] | None = Field(None, description="format dense: [x, y] for every ms, from 0 to the last release")
    changes: list[list[int]] | None = Field(None, description="format changes: [t, x, y] where the position changes")
    clicks: list[Click]


# ---------------------------------------------------------------------- models


class Generator:
    def __init__(self, root: Path, runs_dir: Path | None = None):
        self.root = Path(root)
        self.runs = Path(runs_dir) if runs_dir else paths.GEN_RUNS
        self.lock = threading.Lock()
        self.stamp = None
        self.ds = None
        self.screen: tuple | None = None
        self.n_train: int | None = None
        self.models: dict = {}

    def run(self) -> tuple[Path | None, str | None]:
        """The latest generative run, or None and the reason it can't be used."""
        latest = self.runs / "latest.txt"
        if not latest.exists():
            return None, "no trained generative model yet: run `python -m models.generative train`"
        run = self.runs / latest.read_text().strip()
        if not (run / "ckpt.pt").exists() or not (run / "config.json").exists():
            return None, f"the latest generative run {run} is incomplete"
        trained_on = json.loads((run / "config.json").read_text()).get("data_root")
        if trained_on and Path(trained_on).resolve() != self.root.resolve():
            return None, f"the latest generative model was trained on {trained_on}, not on {self.root}"
        return run, None

    @staticmethod
    def resolve(name: str) -> str:
        # On the owner's data motion matching beat the hybrid and the generative model on a held-out
        # session (classifier AUC 0.725 vs 0.829 vs 0.983, 2026-10-09), so it answers by default.
        return "mm" if name == "auto" else name

    # Everything below runs under self.lock.

    def _refresh(self):
        """Forget fitted models when anything they were fitted on has changed."""
        proc = paths.processed_dir(self.root)
        files = [proc / f for f in ("trials.parquet", "movements.parquet", "timelines.npz", "fitts.json")]
        files += sorted(paths.CONFIG.glob("*.json")) + [self.runs / "latest.txt"]
        stamp = tuple(f.stat().st_mtime_ns if f.exists() else None for f in files)
        if stamp != self.stamp:
            self.stamp, self.ds, self.screen, self.n_train, self.models = stamp, None, None, None, {}

    def _dataset(self):
        if self.ds is None:
            from pipeline.dataset import Dataset
            try:
                ds = Dataset(self.root)
            except FileNotFoundError:
                raise HTTPException(503, "no processed recordings yet: record sessions, then run `python -m pipeline all`")
            except Exception as e:
                raise HTTPException(503, f"could not read the processed recordings: {type(e).__name__}: {e}")
            train = ds.usable_trials(role="train", include_warmup=config.motion_matching().get("include_warmup", False))
            if train.empty:
                raise HTTPException(503, "the processed recordings have no usable training trials")
            w, h = train.groupby(["screen_w", "screen_h"]).size().idxmax()
            self.ds, self.screen, self.n_train = ds, (int(w), int(h)), len(train)
        return self.ds

    def _model(self, name: str):
        if name not in self.models:
            ds = self._dataset()
            spec = name
            if name in NEEDS_RUN:
                run, why = self.run()
                if run is None:
                    raise HTTPException(503, f"model {name} is not available: {why}")
                spec = f"{name}:{run}"
            from models import registry
            try:
                self.models[name] = registry.build(spec).fit(ds)
            except Exception as e:
                traceback.print_exc()
                raise HTTPException(503, f"could not load model {name}: {type(e).__name__}: {e}")
        return self.models[name]

    # ------------------------------------------------------------------ endpoints

    def preload(self, name: str = "auto") -> str:
        with self.lock:
            self._refresh()
            name = self.resolve(name)
            self._model(name)
            return name

    def status(self) -> dict:
        with self.lock:
            self._refresh()
            run, no_run = self.run()
            try:
                self._dataset()
                no_data = None
            except HTTPException as e:
                no_data = e.detail
            models = {}
            for name in MODELS:
                why = no_data or (no_run if name in NEEDS_RUN else None)
                models[name] = {"available": why is None, "loaded": name in self.models, **({"reason": why} if why else {})}
            return {
                "auto": self.resolve("auto"),
                "models": models,
                "data_root": str(self.root),
                "training_trials": self.n_train,
                "screen": dict(zip("wh", self.screen)) if self.screen else None,
                "generative_run": str(run) if run else None,
            }

    def generate(self, req: GenerateRequest) -> dict:
        from models.base import TrialConditions
        with self.lock:
            self._refresh()
            model = self._model(self.resolve(req.model))
            screen = (req.screen.w, req.screen.h) if req.screen else self.screen
            target = req.target.to_target()
            start = (float(np.rint(req.start.x)), float(np.rint(req.start.y)))
            _check_on_screen(start, target, screen)
            cond = TrialConditions(start=start, target=target, screen=screen)
            try:
                tl = _run(model, cond, np.random.default_rng(req.seed), seeded=req.seed is not None,
                          no_misses=req.no_misses)
            except Exception as e:
                traceback.print_exc()
                raise HTTPException(500, f"generation failed: {type(e).__name__}: {e}")
        pos, clicks = on_ms_grid(tl.pos, tl.clicks)
        pos, clicks = end_at_first_hit(pos, clicks, target)
        if req.no_misses:
            clicks = clicks[-1:]  # the earlier ones were misses
        pos, clicks = land_last_press(pos, clicks, target, screen)
        if req.skip_reaction:
            pos, clicks = skip_reaction(tl, pos, clicks)
        out = {"pos": pos.tolist()} if req.format == "dense" else {"changes": changes(pos)}
        out["clicks"] = clicks
        return out


def _check_on_screen(start, target: Target, screen):
    w, h = screen
    if not (0 <= start[0] <= w - 1 and 0 <= start[1] <= h - 1):
        raise HTTPException(422, f"start ({start[0]:.0f}, {start[1]:.0f}) is off the {w}x{h} screen")
    if not (0 <= target.cx < w and 0 <= target.cy < h):
        raise HTTPException(422, f"the target centre ({target.cx:g}, {target.cy:g}) is off the {w}x{h} screen")


MAX_TRIES = 10  # no_misses: new draws until the only click hits


def _run(model, cond, rng, seeded: bool, no_misses: bool = False):
    from models.motion_matching.matcher import MotionMatching
    from models.strokes.model import StrokeModel
    mm = model if isinstance(model, MotionMatching) else getattr(model, "mm", None)
    last, exclude = (mm.last, mm.exclude) if mm is not None else (None, None)
    # The stroke model also remembers the recording it used last (so it doesn't use it twice in a row).
    strokes = model if isinstance(model, StrokeModel) else None
    strokes_last = strokes.last if strokes is not None else None
    if strokes is not None and seeded:
        strokes.last = -1
    if mm is not None:
        # A seeded request must not depend on the requests before it: it ignores which recorded
        # trial was used last, and leaves that as it was for the unseeded requests that follow.
        if seeded:
            mm.last = -1
        # Recorded trials with a missed click can't be picked; warping keeps hits as hits.
        if no_misses:
            mm.exclude = exclude | _miss_keys(mm)
    try:
        for _ in range(MAX_TRIES if no_misses else 1):
            tl = model.generate(cond, rng)
            if len(tl.clicks) == 1 and tl.click_hit[0]:
                break
        return tl
    finally:
        if mm is not None:
            mm.exclude = exclude
            if seeded:
                mm.last = last
        if strokes is not None and seeded:
            strokes.last = strokes_last


def _miss_keys(mm) -> set:
    """Library entries ("session:trial") whose recording has a missed click, cached on the model."""
    keys = getattr(mm, "_miss_keys", None)
    if keys is None:
        lib = mm.lib
        keys = set()
        for i, key in enumerate(lib.keys):
            c = lib.trial_clicks(i)
            if len(c) != 1 or not c[0, 2]:
                keys.add(key)
        mm._miss_keys = keys
    return keys


# ---------------------------------------------------------------------- output


def on_ms_grid(pos: np.ndarray, clicks: np.ndarray) -> tuple[np.ndarray, list]:
    """Click times as whole milliseconds that index into pos, and pos ending at the last release.

    A press at a fractional time lands on the first sample at or after it, which is the sample the
    models' hit test uses (Timeline.click_xy). Rounding never lets a press and a release, or two
    clicks, fall on the same millisecond."""
    pos = np.asarray(pos, dtype=np.int64)
    out, prev = [], -1
    for down, up in clicks:
        d = max(math.ceil(down), prev + 1)
        u = max(math.ceil(up), d + 1)
        out.append({"down": d, "up": u})
        prev = u
    if out:
        if prev >= len(pos):
            pos = np.vstack([pos, np.repeat(pos[-1:], prev + 1 - len(pos), axis=0)])
        pos = pos[:prev + 1]
    return pos, out


def end_at_first_hit(pos: np.ndarray, clicks: list, target: Target) -> tuple[np.ndarray, list]:
    """A trial ends with the first press on the target, as in the recorder, where the target goes
    away on release. Motion matching can otherwise replay a recording whose miss was on a smaller
    target: warped onto a bigger one, both presses land on it, which would be a double click."""
    for i, c in enumerate(clicks):
        if target.contains(*(int(v) for v in pos[c["down"]])):
            return pos[:c["up"] + 1], clicks[:i + 1]
    return pos, clicks


def land_last_press(pos: np.ndarray, clicks: list, target: Target, screen) -> tuple[np.ndarray, list]:
    """The last press lands on the target: a trial goes on until the target is clicked. It can land
    beside it when no recorded trial fitted the request and motion matching bent the nearest one,
    a few pixels off a small or narrow target. Then the final approach is bent onto the target over
    its last 120 ms, ending at the last stop, so the pause before the press stays still. Earlier
    presses (misses) and their holds stay where they were."""
    from models.base import to_pixels
    if not clicks:
        return pos, clicks
    d = clicks[-1]["down"]
    x, y = (int(v) for v in pos[d])
    if target.contains(x, y):
        return pos, clicks
    gx, gy = _inside_point(target, x, y)
    off = np.array([gx - x, gy - y], float)
    first = clicks[-2]["up"] + 1 if len(clicks) > 1 else 1  # after the release of the miss before
    moved = np.flatnonzero(np.any(np.diff(pos[first - 1:d + 1], axis=0) != 0, axis=1)) + first
    k1 = int(moved[-1]) if len(moved) else d
    k0 = max(first, k1 - 120)
    u = (np.arange(k0, k1 + 1) - k0) / max(k1 - k0, 1)
    new = pos.astype(float)
    new[k0:k1 + 1] += (u * u * (3 - 2 * u))[:, None] * off
    new[k1 + 1:] += off
    return to_pixels(new, screen).astype(np.int64), clicks


def _inside_point(t: Target, x: int, y: int) -> tuple[int, int]:
    """The whole pixel inside the target nearest to (x, y), kept 1 px (or the corner radius) in from the edge."""
    if t.shape == "circle":
        vx, vy = x - t.cx, y - t.cy
        dist, room = math.hypot(vx, vy), t.w / 2 - 1
        k = min(1.0, room / dist) if dist > 0 and room > 0 else 0.0
        qx, qy = t.cx + vx * k, t.cy + vy * k
    else:
        m = max(1.0, t.r)
        hx, hy = max(t.w / 2 - m, 0.0), max(t.h / 2 - m, 0.0)
        qx, qy = min(max(x, t.cx - hx), t.cx + hx), min(max(y, t.cy - hy), t.cy + hy)
    qx, qy = round(qx), round(qy)
    if not t.contains(qx, qy):
        qx, qy = round(t.cx), round(t.cy)
    return qx, qy


MAX_STILL_MS = 40  # skip_reaction: longest pause kept before the main movement


def skip_reaction(tl, pos: np.ndarray, clicks: list) -> tuple[np.ndarray, list]:
    """Start moving right away by taking time out, never by moving the cursor (so no jumps).

    The still reaction time before the first pixel of movement goes, and so does any pause longer
    than MAX_STILL_MS before the main movement starts (a pixel of drift, then waiting, or a slow
    creep with gaps). The main movement's start is the onset the pipeline measures; a creep can
    begin long before it."""
    from pipeline.features import analyse_timeline
    if not clicks:
        return pos, clicks
    down = clicks[0]["down"]
    change = np.flatnonzero(np.any(np.diff(pos[:down + 1], axis=0) != 0, axis=1)) + 1
    drop = np.zeros(len(pos), bool)
    if len(change) == 0:
        drop[1:down] = True  # no movement before the press: press at once
    else:
        onset = int(change[0])
        try:
            _, rows, _, _ = analyse_timeline(tl)
            if rows and np.isfinite(rows[0]["t_onset"]):
                onset = max(onset, int(rows[0]["t_onset"]))
        except Exception:
            pass
        drop[1:change[0]] = True
        for a, b in zip(change, np.append(change[1:], down)):
            if a >= min(onset, down):
                break
            if b - a > MAX_STILL_MS:
                drop[a + MAX_STILL_MS:b] = True
    n = int(drop.sum())
    return pos[~drop], [{"down": c["down"] - n, "up": c["up"] - n} for c in clicks]


def changes(pos: np.ndarray) -> list:
    """Dense positions -> [[t, x, y], ...] at t = 0 and wherever the position changes."""
    k = np.concatenate([[0], np.flatnonzero(np.any(np.diff(pos, axis=0) != 0, axis=1)) + 1])
    return np.column_stack([k, pos[k]]).tolist()
