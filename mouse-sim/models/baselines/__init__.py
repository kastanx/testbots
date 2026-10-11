"""Three deliberately naive models (Phase 4). They prove the metrics work (they must fail clearly)
and serve as comparison modes in the simulator.

    line      straight line at constant speed
    minjerk   minimum-jerk path (Flash & Hogan 1985)
    bezier    cubic Bezier curve with ease-in-out timing

All three move for the owner's Fitts-predicted movement time, land exactly on the target centre and
use the owner's median reaction time, pause before clicking and click hold.
"""
from __future__ import annotations

import math

import numpy as np

from pipeline.dataset import Dataset
from pipeline.features import predicted_mt
from pipeline.timeline import Timeline

from ..base import Model, TrialConditions, to_pixels


class Baseline(Model):
    kind = "line"
    version = "1"

    def __init__(self, kind: str = "line"):
        self.kind = kind
        self.name = f"baseline_{kind}"
        self.params: dict = {}

    def fit(self, ds: Dataset) -> "Baseline":
        prim = ds.usable_movements(role="train", primary_only=True)
        f = ds.fitts
        self.params = {
            "a_nominal": f["a_nominal"], "b_nominal": f["b_nominal"],
            "rt": float(prim["rt"].median()), "dwell": float(prim["dwell"].median()),
            "hold": float(prim["hold"].median()),
        }
        return self

    def describe(self) -> dict:
        return {"name": self.name, "version": self.version, **self.params}

    def path(self, s: np.ndarray, start: np.ndarray, end: np.ndarray, rng) -> np.ndarray:
        d = end - start
        if self.kind == "line":
            prog = s
        elif self.kind == "minjerk":
            prog = 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5
        else:
            prog = None
        if prog is not None:
            return start + np.outer(prog, d)
        # Cubic Bezier: control points pushed sideways by a random amount, ease-in-out timing.
        e = 0.5 - 0.5 * np.cos(np.pi * s)
        n = np.array([-d[1], d[0]])
        bend = rng.uniform(0.05, 0.25) * rng.choice([-1, 1])
        p1 = start + d / 3 + n * bend
        p2 = start + 2 * d / 3 + n * bend * rng.uniform(0.3, 1.0)
        u = 1 - e
        return (np.outer(u ** 3, start) + np.outer(3 * u ** 2 * e, p1) + np.outer(3 * u * e ** 2, p2)
                + np.outer(e ** 3, end))

    def generate(self, cond: TrialConditions, rng) -> Timeline:
        p = self.params
        start = np.array(cond.start, float)
        end = np.array([cond.target.cx, cond.target.cy])
        D = float(np.hypot(*(end - start)))
        theta = math.atan2(end[1] - start[1], end[0] - start[0])
        from pipeline import geometry
        along = float(geometry.chord(cond.target.shape, cond.target.w, cond.target.h, theta))
        mt = float(predicted_mt(p, D, max(along, 1.0)))
        move = max(int(round(mt - p["dwell"])), 40)
        rt, dwell, hold = int(round(p["rt"])), int(round(p["dwell"])), int(round(p["hold"]))
        s = np.linspace(0, 1, move + 1)
        moving = self.path(s, start, end, rng)
        pos = np.concatenate([np.repeat(start[None], rt, 0), moving, np.repeat(end[None], dwell + hold, 0)])
        t_down = rt + move + dwell
        return Timeline(pos=to_pixels(pos, cond.screen), clicks=np.array([[t_down, t_down + hold]], float),
                        target=cond.target, screen=cond.screen)
