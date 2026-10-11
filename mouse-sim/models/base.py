"""What every model looks like to the harness and the simulator export.

A model gets the trial conditions (where the cursor is when the target appears, the target, the
screen) and returns a whole trial as a Timeline: reaction, movement, corrections, pause, click(s).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from pipeline.dataset import Dataset
from pipeline.timeline import Target, Timeline


@dataclass
class TrialConditions:
    start: tuple            # cursor position (physical px) when the target appears
    target: Target
    screen: tuple
    session_id: str | None = None

    @classmethod
    def from_timeline(cls, tl: Timeline, session_id: str | None = None) -> "TrialConditions":
        return cls(start=(float(tl.pos[0][0]), float(tl.pos[0][1])), target=tl.target, screen=tl.screen,
                   session_id=session_id)


class Model:
    name = "model"
    version = "1"

    def fit(self, ds: Dataset) -> "Model":
        return self

    def generate(self, cond: TrialConditions, rng: np.random.Generator) -> Timeline:
        raise NotImplementedError

    def describe(self) -> dict:
        return {"name": self.name, "version": self.version}


def clamp_path(start, deltas, screen) -> np.ndarray:
    """Integrate per-ms displacements like a real cursor: stuck at the screen edges, and movement
    'lost' against an edge stays lost."""
    w, h = screen
    out = np.empty((len(deltas) + 1, 2))
    x, y = float(start[0]), float(start[1])
    out[0] = (x, y)
    for i, (dx, dy) in enumerate(deltas, start=1):
        x = min(max(x + dx, 0.0), w - 1.0)
        y = min(max(y + dy, 0.0), h - 1.0)
        out[i] = (x, y)
    return out


def to_pixels(path, screen) -> np.ndarray:
    """Whole physical pixels, clamped to the screen."""
    p = np.rint(np.asarray(path, float))
    p[:, 0] = np.clip(p[:, 0], 0, screen[0] - 1)
    p[:, 1] = np.clip(p[:, 1], 0, screen[1] - 1)
    return p.astype(np.int32)
