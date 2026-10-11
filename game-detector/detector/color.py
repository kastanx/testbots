"""Colors: the color reader (Phase 6) and the color-filter detector (Phase 1).

Both read the calibrated table in configs/colors.yaml. Everything uses OpenCV's
HSV scale: hue 0-179 (it wraps, so red sits at both ends), saturation and
value 0-255.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from detector.common import CONFIGS, Detection, load_yaml, resolve, save_yaml

COLORS_PATH = CONFIGS / "colors.yaml"

COLORS_HEADER = """\
# Calibrated object colors. Written by `tools.color_filter pick` and
# `tools.calibrate_colors`; safe to edit by hand (every save keeps a .bak).
# OpenCV HSV scale: hue 0-179 (wraps; red sits at both ends), saturation and value 0-255.
#
#   colors.<name>: {hue: center, hue_tol: +/- range, s: [lo, hi], v: [lo, hi]}
#   colors.<name>: {achromatic: true, s: [lo, hi], v: [lo, hi]}    for white / gray / black
#
# reader: how the color of a detected box is read (Phase 6)
#   center_frac      only this central share of the box's width and height is read (skips background, outlines)
#   min_s, min_v     darker or greyer pixels are ignored as shading, outline or background
#   min_chroma_frac  below this share of colored pixels the object is white, gray or black
# filter: the color-filter detector (Phase 1 baseline)
#   scale            the frame is shrunk by this factor first, for speed
#   open_px/close_px morphology clean-up, in full-resolution pixels
#   min_area/max_area blob size limits, in full-resolution pixels
"""

DEFAULT_READER = {"center_frac": 0.55, "min_s": 60, "min_v": 50, "min_chroma_frac": 0.12}
DEFAULT_FILTER = {"scale": 0.5, "open_px": 3, "close_px": 5, "min_area": 60, "max_area": 200000}


def hue_distance(a, b):
    """Distance on the hue circle (0-179 wraps)."""
    d = np.abs(np.asarray(a, dtype=np.float64) - b) % 180
    return np.minimum(d, 180 - d)


def circular_mean_hue(hues) -> float:
    ang = np.asarray(hues, dtype=np.float64) * (2 * np.pi / 180)
    m = np.arctan2(np.sin(ang).mean(), np.cos(ang).mean())
    return float((m * 180 / (2 * np.pi)) % 180)


@dataclass
class ColorSpec:
    name: str
    hue: float = 0.0
    hue_tol: float = 8.0
    s: tuple[int, int] = (0, 255)
    v: tuple[int, int] = (0, 255)
    achromatic: bool = False

    @classmethod
    def from_dict(cls, name: str, d: dict) -> "ColorSpec":
        return cls(
            name=name,
            hue=float(d.get("hue", 0)),
            hue_tol=float(d.get("hue_tol", 8)),
            s=tuple(int(x) for x in d.get("s", (0, 255))),
            v=tuple(int(x) for x in d.get("v", (0, 255))),
            achromatic=bool(d.get("achromatic", False)),
        )

    def to_dict(self) -> dict:
        if self.achromatic:
            return {"achromatic": True, "s": list(self.s), "v": list(self.v)}
        return {"hue": round(self.hue, 1), "hue_tol": round(self.hue_tol, 1), "s": list(self.s), "v": list(self.v)}

    def mask(self, hsv: np.ndarray) -> np.ndarray:
        """255 where a pixel of an HSV image falls inside this color's range."""
        (s_lo, s_hi), (v_lo, v_hi) = self.s, self.v
        if self.achromatic:
            return cv2.inRange(hsv, np.array([0, s_lo, v_lo]), np.array([179, s_hi, v_hi]))
        lo, hi = self.hue - self.hue_tol, self.hue + self.hue_tol
        if lo < 0:
            spans = [(lo + 180, 179), (0, hi)]
        elif hi > 179:
            spans = [(lo, 179), (0, hi - 180)]
        else:
            spans = [(lo, hi)]
        out = None
        for a, b in spans:
            m = cv2.inRange(hsv, np.array([int(np.ceil(a)), s_lo, v_lo]), np.array([int(np.floor(b)), s_hi, v_hi]))
            out = m if out is None else cv2.bitwise_or(out, m)
        return out

    def bgr(self) -> tuple[int, int, int]:
        """A representative BGR color, for drawing."""
        if self.achromatic:
            v = int((self.v[0] + self.v[1]) / 2)
            return (v, v, v)
        hsv = np.uint8([[[int(round(self.hue)) % 180, max(self.s[0], 180), max(self.v[0], 220)]]])
        return tuple(int(c) for c in cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)[0, 0])


def spec_from_samples(name: str, hsv_samples: np.ndarray, tol_extra: float = 0.0) -> ColorSpec:
    """Fit a color range to sampled HSV pixels (N x 3)."""
    hsv_samples = np.asarray(hsv_samples).reshape(-1, 3)
    h, s, v = (hsv_samples[:, i].astype(np.float64) for i in range(3))
    if np.median(s) < 45:  # grey-ish: white, gray or black
        return ColorSpec(
            name,
            achromatic=True,
            s=(0, int(min(255, np.percentile(s, 98) + 25))),
            v=(int(max(0, np.percentile(v, 2) - 30)), int(min(255, np.percentile(v, 98) + 30))),
        )
    center = circular_mean_hue(h)
    spread = float(np.percentile(hue_distance(h, center), 98))
    tol = float(np.clip(spread * 1.3 + 2 + tol_extra, 3, 30))
    return ColorSpec(
        name,
        hue=center,
        hue_tol=tol,
        s=(int(max(0, np.percentile(s, 2) - 30)), 255),
        v=(int(max(0, np.percentile(v, 2) - 40)), 255),
    )


class ColorTable:
    """configs/colors.yaml in memory."""

    def __init__(self, data: dict | None = None):
        data = data or {}
        self.reader = {**DEFAULT_READER, **(data.get("reader") or {})}
        self.filter = {**DEFAULT_FILTER, **(data.get("filter") or {})}
        self.colors = {n: ColorSpec.from_dict(n, d) for n, d in (data.get("colors") or {}).items()}

    @classmethod
    def load(cls, path: str | Path = COLORS_PATH) -> "ColorTable":
        return cls(load_yaml(path))

    def save(self, path: str | Path = COLORS_PATH) -> Path:
        data = {
            "reader": self.reader,
            "filter": self.filter,
            "colors": {n: c.to_dict() for n, c in self.colors.items()},
        }
        return save_yaml(resolve(path), data, header=COLORS_HEADER)


def central_crop(frame: np.ndarray, box, frac: float) -> np.ndarray:
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    hw, hh = max(1.0, w * frac / 2), max(1.0, h * frac / 2)
    H, W = frame.shape[:2]
    a, b = int(max(0, cx - hw)), int(min(W, cx + hw + 0.5))
    c, d = int(max(0, cy - hh)), int(min(H, cy + hh + 0.5))
    return frame[c:d, a:b]


def box_pixels_hsv(frame: np.ndarray, box, frac: float) -> np.ndarray:
    """HSV pixels (N x 3) of the central part of a box."""
    crop = central_crop(frame, box, frac)
    if crop.size == 0:
        return np.zeros((0, 3), np.uint8)
    return cv2.cvtColor(np.ascontiguousarray(crop), cv2.COLOR_BGR2HSV).reshape(-1, 3)


def dominant_hue(h: np.ndarray) -> tuple[float, np.ndarray]:
    """Dominant hue of integer hues (0-179), and the mask of pixels within 10 of it.

    The histogram is smoothed circularly, so a peak split across 179/0 (red)
    still wins.
    """
    hist = np.bincount(h, minlength=180).astype(np.float32)
    smooth = hist + 0.5 * (np.roll(hist, 1) + np.roll(hist, -1)) + 0.25 * (np.roll(hist, 2) + np.roll(hist, -2))
    peak = int(np.argmax(smooth))
    offset = ((h - peak + 90) % 180) - 90  # signed distance from the peak
    near = np.abs(offset) <= 10
    return float((peak + offset[near].mean()) % 180), near


def calibrate(samples: dict[str, list[np.ndarray]], reader: dict) -> dict[str, ColorSpec]:
    """Fit every color from labeled boxes (handoff Phase 6).

    samples: color name -> one HSV pixel array (N x 3) per labeled box, taken
    from the box's central part (box_pixels_hsv). The hue range comes from the
    spread of the per-box dominant hues, i.e. from what the reader will see.
    """
    min_s, min_v = reader["min_s"], reader["min_v"]
    specs = {}
    for name, boxes in samples.items():
        boxes = [b for b in boxes if len(b)]
        if not boxes:
            continue
        allpix = np.concatenate(boxes)
        chroma_all = (allpix[:, 1] >= min_s) & (allpix[:, 2] >= min_v)
        if chroma_all.mean() < 0.5:  # mostly grey pixels: white, gray or black
            s, v = allpix[:, 1].astype(np.float64), allpix[:, 2].astype(np.float64)
            specs[name] = ColorSpec(name, achromatic=True,
                                    s=(0, int(min(255, np.percentile(s, 90) + 20))),
                                    v=(int(max(0, np.percentile(v, 10) - 20)), int(min(255, np.percentile(v, 95) + 20))))
            continue
        doms = []
        for b in boxes:
            c = (b[:, 1] >= min_s) & (b[:, 2] >= min_v)
            if c.sum() >= 3:
                doms.append(dominant_hue(b[c, 0].astype(np.int64))[0])
        center = circular_mean_hue(doms)
        spread = float(np.percentile(hue_distance(doms, center), 98))
        chroma = allpix[chroma_all].astype(np.float64)
        specs[name] = ColorSpec(name, hue=center, hue_tol=float(np.clip(spread * 1.5 + 3, 3, 25)),
                                s=(int(max(0, np.percentile(chroma[:, 1], 2) - 20)), 255),
                                v=(int(max(0, np.percentile(chroma[:, 2], 2) - 30)), 255))
    return specs


def hsv_hex(h: float, s: float, v: float) -> str:
    """One OpenCV-scale HSV color as "#rrggbb"."""
    b, g, r = cv2.cvtColor(np.uint8([[[int(round(h)) % 180, int(s), int(v)]]]), cv2.COLOR_HSV2BGR)[0, 0]
    return f"#{r:02x}{g:02x}{b:02x}"


def hex_bgr(color: str) -> tuple[int, int, int] | None:
    if len(color) == 7 and color.startswith("#"):
        try:
            return int(color[5:7], 16), int(color[3:5], 16), int(color[1:3], 16)
        except ValueError:
            return None
    return None


class ColorReader:
    """Reads the dominant color inside a box (handoff Phase 6).

    Takes the central part of the box, drops grey/dark pixels and finds the
    dominant hue on a circular histogram. If configs/colors.yaml has calibrated
    colors, the nearest one within tolerance gives the name; boxes with too few
    colored pixels are matched against the white/gray/black entries by
    saturation and brightness. Without a fitting name, the color is reported as
    it is, "#rrggbb", so no calibration is needed when names don't matter.
    """

    def __init__(self, table: ColorTable):
        r = table.reader
        self.frac = float(r["center_frac"])
        self.min_s = int(r["min_s"])
        self.min_v = int(r["min_v"])
        self.min_chroma = float(r["min_chroma_frac"])
        self.chromatic = [c for c in table.colors.values() if not c.achromatic]
        self.achromatic = [c for c in table.colors.values() if c.achromatic]

    def read(self, frame: np.ndarray, box) -> tuple[str, float]:
        """(color name or "#rrggbb", share of the read pixels that agree)."""
        hsv = box_pixels_hsv(frame, box, self.frac)
        if len(hsv) == 0:
            return "unknown", 0.0
        h, s, v = hsv[:, 0].astype(np.int64), hsv[:, 1], hsv[:, 2]
        chroma = (s >= self.min_s) & (v >= self.min_v)
        if chroma.sum() >= max(3, self.min_chroma * len(h)):
            hc, sc, vc = h[chroma], s[chroma], v[chroma]
            dominant, near = dominant_hue(hc)
            ms, mv = float(np.median(sc[near])), float(np.median(vc[near]))
            name, share = self._chromatic(hc, dominant, ms, mv)
            return (name, share) if name else (hsv_hex(dominant, ms, mv), float(near.mean()))
        name, share = self._achromatic(s, v)
        return (name, share) if name else (hsv_hex(0, np.median(s), np.median(v)), 1.0)

    def _chromatic(self, h, dominant: float, ms: float, mv: float) -> tuple[str | None, float]:
        best, best_score = None, None
        for c in self.chromatic:
            d = float(hue_distance(dominant, c.hue))
            if d > c.hue_tol:
                continue
            # Same hue, different shade (e.g. dark vs light blue): prefer the
            # entry whose saturation/brightness range fits.
            fits = c.s[0] <= ms <= c.s[1] and c.v[0] <= mv <= c.v[1]
            score = (0 if fits else 1, d / max(c.hue_tol, 1e-6))
            if best_score is None or score < best_score:
                best, best_score = c, score
        if best is None:
            return None, 0.0
        agree = hue_distance(h, best.hue) <= best.hue_tol
        return best.name, float(agree.mean())

    def _achromatic(self, s, v) -> tuple[str | None, float]:
        best, best_share = None, 0.0
        for c in self.achromatic:
            inside = (s >= c.s[0]) & (s <= c.s[1]) & (v >= c.v[0]) & (v <= c.v[1])
            share = float(inside.mean())
            if share > best_share:
                best, best_share = c, share
        if best is None or best_share < 0.3:
            return None, 0.0
        return best.name, best_share


class ColorFilterDetector:
    """Phase 1 baseline: find objects purely by color, without any learning.

    Each calibrated color is thresholded, cleaned up and split into blobs, and
    every blob becomes a box. It cannot tell the two object types apart, so
    `type` is always "object"; `conf` is how much of the box the blob fills.
    """

    names = {0: "object"}

    def __init__(self, table: ColorTable, colors: list[str] | None = None):
        f = table.filter
        self.scale = float(f["scale"])
        self.min_area = float(f["min_area"])
        self.max_area = float(f["max_area"])
        k_open = max(1, round(f["open_px"] * self.scale))
        k_close = max(1, round(f["close_px"] * self.scale))
        self.k_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k_open, k_open)) if f["open_px"] else None
        self.k_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k_close, k_close)) if f["close_px"] else None
        wanted = colors or list(table.colors)
        self.specs = [table.colors[n] for n in wanted if n in table.colors]
        if not self.specs:
            raise ValueError("no colors calibrated yet; run `python -m tools.color_filter pick --color <name>` first")
        self.conf = 0.0

    def masks(self, frame: np.ndarray) -> tuple[np.ndarray, dict[str, np.ndarray]]:
        s = self.scale
        small = cv2.resize(frame, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s != 1 else frame
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        out = {}
        for spec in self.specs:
            m = spec.mask(hsv)
            if self.k_open is not None:
                m = cv2.morphologyEx(m, cv2.MORPH_OPEN, self.k_open)
            if self.k_close is not None:
                m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, self.k_close)
            out[spec.name] = m
        return small, out

    def detect(self, frame: np.ndarray) -> tuple[list[Detection], dict]:
        s = self.scale
        _, masks = self.masks(frame)
        dets = []
        for name, m in masks.items():
            n, _, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
            for i in range(1, n):
                x, y, w, h, area = (int(v) for v in stats[i])
                full_area = area / (s * s)
                if not self.min_area <= full_area <= self.max_area:
                    continue
                fill = area / float(w * h)
                if fill < self.conf:
                    continue
                box = (x / s, y / s, (x + w) / s, (y + h) / s)
                dets.append(Detection(box=box, type="object", conf=fill, color=name, color_conf=1.0))
        return dets, {}
