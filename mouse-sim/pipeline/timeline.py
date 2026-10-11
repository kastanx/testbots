"""The common currency between recordings and models: a trial on the 1 ms grid.

Real trials (from the recorder) and generated trials (from any model) are both Timelines, and both
go through the same segmentation and feature code, so they are measured identically.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import geometry


@dataclass
class Target:
    shape: str  # "circle" | "rect"
    cx: float
    cy: float
    w: float
    h: float
    r: float = 0.0

    def contains(self, x, y):
        return geometry.inside(self.shape, self.cx, self.cy, self.w, self.h, self.r, x, y)

    def as_dict(self) -> dict:
        return {"shape": self.shape, "cx": self.cx, "cy": self.cy, "w": self.w, "h": self.h, "r": self.r}


@dataclass
class Timeline:
    """Cursor positions at t = 0, 1, 2 ... ms after the target appeared, up to the release of the
    final click, in whole physical pixels. clicks[i] = (t_down, t_up) in ms after the target
    appeared. click_xy / click_hit are where each press happened and whether it hit the target."""

    pos: np.ndarray                 # (K, 2) int
    clicks: np.ndarray              # (n, 2) float
    target: Target
    screen: tuple
    click_xy: np.ndarray | None = None
    click_hit: np.ndarray | None = None
    meta: dict = field(default_factory=dict)

    def __post_init__(self):
        self.pos = np.asarray(self.pos)
        self.clicks = np.asarray(self.clicks, dtype=float).reshape(-1, 2)
        if self.click_xy is None:
            k = np.clip(np.ceil(self.clicks[:, 0]).astype(int), 0, len(self.pos) - 1)
            self.click_xy = self.pos[k].astype(float)
        if self.click_hit is None:
            self.click_hit = np.array([bool(self.target.contains(x, y)) for x, y in self.click_xy], dtype=bool)

    @property
    def start(self) -> np.ndarray:
        return self.pos[0].astype(float)

    @property
    def duration(self) -> int:
        return len(self.pos)


class TimelineStore:
    """Many timelines packed into flat arrays (what timelines.npz holds)."""

    def __init__(self, pos, offsets, clicks, click_offsets, click_xy, click_hit, targets, screens):
        self.pos = pos
        self.offsets = offsets
        self.clicks = clicks
        self.click_offsets = click_offsets
        self.click_xy = click_xy
        self.click_hit = click_hit
        self.targets = targets          # (n, 6): shape(0 circle/1 rect), cx, cy, w, h, r
        self.screens = screens          # (n, 2)

    def __len__(self):
        return len(self.offsets) - 1

    def get(self, i: int) -> Timeline:
        a, b = self.offsets[i], self.offsets[i + 1]
        c, d = self.click_offsets[i], self.click_offsets[i + 1]
        s, cx, cy, w, h, r = self.targets[i]
        return Timeline(
            pos=self.pos[a:b].astype(np.int32), clicks=self.clicks[c:d].astype(float),
            target=Target("rect" if s else "circle", float(cx), float(cy), float(w), float(h), float(r)),
            screen=(int(self.screens[i][0]), int(self.screens[i][1])),
            click_xy=self.click_xy[c:d].astype(float), click_hit=self.click_hit[c:d].astype(bool))

    @classmethod
    def pack(cls, timelines: list[Timeline]) -> "TimelineStore":
        lens = [len(t.pos) for t in timelines]
        nclk = [len(t.clicks) for t in timelines]
        return cls(
            pos=np.concatenate([t.pos for t in timelines]).astype(np.int16) if timelines else np.zeros((0, 2), np.int16),
            offsets=np.concatenate([[0], np.cumsum(lens)]).astype(np.int64),
            clicks=np.concatenate([t.clicks for t in timelines]).astype(np.float64) if timelines else np.zeros((0, 2)),
            click_offsets=np.concatenate([[0], np.cumsum(nclk)]).astype(np.int64),
            click_xy=np.concatenate([t.click_xy for t in timelines]).astype(np.float32) if timelines else np.zeros((0, 2)),
            click_hit=np.concatenate([t.click_hit for t in timelines]).astype(bool) if timelines else np.zeros(0, bool),
            targets=np.array([[t.target.shape == "rect", t.target.cx, t.target.cy, t.target.w, t.target.h, t.target.r]
                              for t in timelines], dtype=np.float64).reshape(-1, 6),
            screens=np.array([t.screen for t in timelines], dtype=np.int32).reshape(-1, 2),
        )

    def save(self, path, **extra):
        np.savez_compressed(path, pos=self.pos, offsets=self.offsets, clicks=self.clicks,
                            click_offsets=self.click_offsets, click_xy=self.click_xy, click_hit=self.click_hit,
                            targets=self.targets, screens=self.screens, **extra)

    @classmethod
    def load(cls, path) -> "TimelineStore":
        z = np.load(path)
        return cls(z["pos"], z["offsets"], z["clicks"], z["click_offsets"], z["click_xy"], z["click_hit"],
                   z["targets"], z["screens"])
