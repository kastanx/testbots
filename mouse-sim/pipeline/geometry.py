"""Target geometry and coverage cells. Mirrors web/src/shared/geometry.ts; keep the two in step.

Angles are measured in screen coordinates (x right, y down), so 90 degrees is straight down.
"Along" and "across" are relative to the movement direction (start -> target centre); a positive
"across" value is on the right-hand side of the direction of travel as seen on screen.
"""
from __future__ import annotations

import math

import numpy as np

from . import config

_CELLS = config.load("cells")
DIST_EDGES = [math.inf if e is None else float(e) for e in _CELLS["distance_edges"]]
N_DIST = len(DIST_EDGES) - 1
N_DIR = int(_CELLS["direction_bins"])
DIR_WIDTH = 360.0 / N_DIR
SIZE_CENTERS = [float(s) for s in _CELLS["size_centers"]]
N_SIZE = len(SIZE_CENTERS)
SIZE_EDGES = (
    [SIZE_CENTERS[0] / math.sqrt(2)]
    + [math.sqrt(a * b) for a, b in zip(SIZE_CENTERS, SIZE_CENTERS[1:])]
    + [SIZE_CENTERS[-1] * math.sqrt(2)]
)
GOAL_PER_CELL = int(_CELLS["goal_per_cell"])


def direction_deg(dx, dy):
    return np.mod(np.degrees(np.arctan2(dy, dx)), 360.0)


def angle_diff_deg(a, b):
    """Smallest signed difference a - b in degrees, in [-180, 180)."""
    return np.mod(np.asarray(a) - np.asarray(b) + 180.0, 360.0) - 180.0


def dist_bin(d):
    """Distance bin index, or -1 below the first edge."""
    d = np.asarray(d, dtype=float)
    idx = np.searchsorted(DIST_EDGES, d, side="right") - 1
    return np.where(d < DIST_EDGES[0], -1, np.minimum(idx, N_DIST - 1))


def dir_bin(theta_deg):
    t = np.mod(np.asarray(theta_deg, dtype=float) + DIR_WIDTH / 2, 360.0)
    return np.minimum((t // DIR_WIDTH).astype(int), N_DIR - 1)


def size_bin(s):
    """Size bin index, clamped into [0, N_SIZE - 1]."""
    s = np.asarray(s, dtype=float)
    idx = np.searchsorted(SIZE_EDGES, s, side="right") - 1
    return np.clip(idx, 0, N_SIZE - 1)


def chord(shape, w, h, theta_rad):
    """Length of the chord through the target centre in direction theta (the target's extent
    along that direction). Circles: the diameter. Rectangles: min(w/|cos|, h/|sin|)."""
    w = np.asarray(w, dtype=float)
    h = np.asarray(h, dtype=float)
    c = np.abs(np.cos(theta_rad))
    s = np.abs(np.sin(theta_rad))
    with np.errstate(divide="ignore"):
        along_rect = np.minimum(np.where(c > 1e-12, w / np.maximum(c, 1e-12), np.inf),
                                np.where(s > 1e-12, h / np.maximum(s, 1e-12), np.inf))
    is_circle = np.asarray(shape) == "circle"
    return np.where(is_circle, w, along_rect)


def sizes_along_across(shape, w, h, theta_rad):
    return chord(shape, w, h, theta_rad), chord(shape, w, h, np.asarray(theta_rad) + math.pi / 2)


def corner_radius(w, h, max_radius):
    return np.minimum(max_radius, 0.25 * np.minimum(w, h))


def inside(shape, cx, cy, w, h, r, x, y):
    """Hit test (vectorised over x, y). Rectangles have rounded corners of radius r."""
    dx = np.asarray(x, dtype=float) - cx
    dy = np.asarray(y, dtype=float) - cy
    if shape == "circle":
        return dx * dx + dy * dy <= (w / 2.0) ** 2
    qx = np.abs(dx) - w / 2.0 + r
    qy = np.abs(dy) - h / 2.0 + r
    outside = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r
    return outside <= 1e-9


def cell_of(d, theta_deg, size_along):
    return int(dist_bin(d)), int(dir_bin(theta_deg)), int(size_bin(size_along))
