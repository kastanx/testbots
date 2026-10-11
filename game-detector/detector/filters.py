"""Game-specific clean-up of detections, configured in configs/capture.yaml.

ignore      UI panels: a detection centred inside one is dropped (inventory icons,
            minimap, chat...).
bar_filter  the harvest progress bar shown over a wisp someone is harvesting: a
            thin straight horizontal strip of one fixed cyan, ~76 px long. A
            detection whose colored pixels are mostly such a strip is the bar, not
            a wisp. Only straight runs at least bar_min_len px long count as bar:
            light-blue wisps (Lustrous) are the bar's own hue, but an orb is ~12 px
            across. A real wisp under the bar keeps its own glow around it, so it
            isn't dropped either.
            With drop_harvested, a wisp that has a bar centred across its top
            (someone is harvesting it) is dropped too: only untouched wisps count.
"""

from __future__ import annotations

import cv2
import numpy as np

from detector.common import Detection, drop_ignored, load_yaml

# Measured on test1: fill H 82-98 S 104-252 V 154-255; empty part H 90 S 128-141 V 28-60; 5-6 rows.
DEFAULT_BAR = {"types": ["wisp"], "hue": [82, 98], "s_min": 100, "v_min": 25, "max_thickness": 9,
               "min_share": 0.56, "drop_harvested": True, "bar_min_len": 40}
# min_share 0.56: all 70 bar boxes in test1 score >= 0.61; labeled wisps in every session,
# Vibrant and Lustrous, score <= 0.34.


def row_runs(row: np.ndarray) -> list[tuple[int, int]]:
    """(start, end) of every run of True in a 1-D boolean array, end exclusive."""
    d = np.diff(np.concatenate(([0], row.view(np.int8), [0])))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def thin_bands(long_rows: np.ndarray, max_thickness: int) -> list[tuple[int, int]]:
    """(first, last) rows of each run of long rows that is at most max_thickness tall."""
    bands, r = [], 0
    while r < len(long_rows):
        if long_rows[r]:
            end = r
            while end + 1 < len(long_rows) and long_rows[end + 1]:
                end += 1
            if end - r + 1 <= max_thickness:
                bands.append((r, end))
            r = end + 1
        else:
            r += 1
    return bands


def longest_runs(mask: np.ndarray) -> np.ndarray:
    """Longest run of True in each row of a 2-D boolean array."""
    out = np.zeros(mask.shape[0], int)
    for r, row in enumerate(mask):
        if row.any():
            d = np.diff(np.concatenate(([0], row.view(np.int8), [0])))
            out[r] = (np.flatnonzero(d == -1) - np.flatnonzero(d == 1)).max()
    return out


class DetectionFilters:
    def __init__(self, ignore=(), bar: dict | None = None):
        self.ignore = list(ignore)
        self.bar = {**DEFAULT_BAR, **bar} if bar else None

    @classmethod
    def load(cls, capture_cfg: str = "configs/capture.yaml", game_frames: bool = True) -> "DetectionFilters":
        """Filters for frames of the game window (not for the synthetic scene)."""
        if not game_frames:
            return cls()
        cfg = load_yaml(capture_cfg)
        ignore = [tuple(int(v) for v in b) for b in (cfg.get("ignore") or {}).values()]
        return cls(ignore, cfg.get("bar_filter"))

    def apply(self, frame: np.ndarray, dets: list[Detection]) -> list[Detection]:
        dets = drop_ignored(dets, self.ignore)
        if self.bar:
            b = self.bar
            dets = [d for d in dets if d.type not in b["types"] or not (
                self.bar_share(frame, d.box) >= b["min_share"] or (b["drop_harvested"] and self.harvested(frame, d.box)))]
        return dets

    def bar_mask(self, hsv: np.ndarray) -> np.ndarray:
        b = self.bar
        h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
        return (h >= b["hue"][0]) & (h <= b["hue"][1]) & (s >= b["s_min"]) & (v >= b["v_min"])

    def harvested(self, frame: np.ndarray, box) -> bool:
        """Is there a progress bar centred across the top of this box (someone harvesting it)?"""
        b = self.bar
        x1, y1, x2, y2 = box
        w, h = x2 - x1, y2 - y1
        cx = (x1 + x2) / 2
        reach = max(90.0, 3 * w)  # wide enough to see a neighbour's bar whole, so its centre isn't misjudged
        X1, X2 = int(max(0, cx - reach)), int(min(frame.shape[1], cx + reach))
        Y1, Y2 = int(max(0, y1 - max(12.0, 0.8 * h))), int(min(frame.shape[0], y1 + 0.7 * h))
        if X2 <= X1 or Y2 <= Y1:
            return False
        m = self.bar_mask(cv2.cvtColor(frame[Y1:Y2, X1:X2], cv2.COLOR_BGR2HSV))
        long_rows = longest_runs(m) >= b["bar_min_len"]
        for first, last in thin_bands(long_rows, b["max_thickness"]):
            for r in range(first, last + 1):
                for s, e in row_runs(m[r]):
                    if e - s >= b["bar_min_len"] and abs(X1 + (s + e) / 2 - cx) <= max(20.0, 0.6 * w):
                        return True
        return False

    def bar_share(self, frame: np.ndarray, box) -> float:
        """Share of a box's colored pixels that belong to a thin horizontal bar of the bar color.

        The bar is its bright filled part plus its dark empty part (same hue,
        darker), so even a bar that has only just started filling is found. Runs
        are measured on rows wider than the box, so a box over part of a bar
        still sees the whole bar.
        """
        b = self.bar
        x1, y1, x2, y2 = (int(round(v)) for v in box)
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(frame.shape[1], x2), min(frame.shape[0], y2)
        if x2 <= x1 or y2 <= y1:
            return 0.0
        X1, X2 = max(0, x1 - b["bar_min_len"]), min(frame.shape[1], x2 + b["bar_min_len"])
        hsv = cv2.cvtColor(frame[y1:y2, X1:X2], cv2.COLOR_BGR2HSV)
        bar = self.bar_mask(hsv)
        strip = np.zeros_like(bar)  # bar-colored pixels in runs long enough to be the bar
        for r in np.flatnonzero(bar.sum(axis=1) >= b["bar_min_len"]):  # only rows that could hold one
            for s, e in row_runs(bar[r]):
                if e - s >= b["bar_min_len"]:
                    strip[r, s:e] = True
        thin = np.zeros(len(strip), bool)
        for first, last in thin_bands(strip.any(axis=1), b["max_thickness"]):  # bands thin enough to be a bar
            thin[first:last + 1] = True
        if not thin.any():
            return 0.0
        c1, c2 = x1 - X1, x2 - X1
        s, v = hsv[:, c1:c2, 1], hsv[:, c1:c2, 2]
        colored = ((s >= 80) & (v >= 120)) | bar[:, c1:c2]
        return float((strip[:, c1:c2] & thin[:, None]).sum() / max(1, colored.sum()))
