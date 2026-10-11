"""Zoomable view of a large frame, shared by the interactive tools (picker, labeler)."""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt

import cv2
import numpy as np


def work_area() -> tuple[int, int]:
    """Usable screen size (without the taskbar), in physical pixels when DPI aware."""
    r = wt.RECT()
    if ctypes.windll.user32.SystemParametersInfoW(0x30, 0, ctypes.byref(r), 0):  # SPI_GETWORKAREA
        return r.right - r.left, r.bottom - r.top
    return 1600, 900


def wheel_up(flags: int) -> bool:
    """Mouse-wheel direction from an OpenCV mouse event (delta is the signed high word)."""
    delta = (flags >> 16) & 0xFFFF
    return 0 < delta < 0x8000


class Viewport:
    """Fit-to-window view of an image: wheel zoom around the cursor, panning.

    view = (full - offset) * zoom, exactly, so boxes drawn in the view land on
    the right full-resolution pixels.
    """

    def __init__(self, w: int, h: int, max_w: int = 1600, max_h: int = 880):
        self.W, self.H = w, h
        self.fit = min(1.0, max_w / w, max_h / h)
        self.vw, self.vh = int(w * self.fit), int(h * self.fit)
        self.reset()

    def reset(self) -> None:
        self.zoom, self.ox, self.oy = self.fit, 0.0, 0.0

    def to_full(self, x: float, y: float) -> tuple[float, float]:
        return self.ox + x / self.zoom, self.oy + y / self.zoom

    def to_view(self, fx: float, fy: float) -> tuple[float, float]:
        return (fx - self.ox) * self.zoom, (fy - self.oy) * self.zoom

    def _clamp(self) -> None:
        self.ox = float(np.clip(self.ox, 0, max(0.0, self.W - self.vw / self.zoom)))
        self.oy = float(np.clip(self.oy, 0, max(0.0, self.H - self.vh / self.zoom)))

    def wheel(self, x: int, y: int, zoom_in: bool) -> None:
        fx, fy = self.to_full(x, y)
        self.zoom = float(np.clip(self.zoom * (1.25 if zoom_in else 0.8), self.fit, 12.0))
        self.ox, self.oy = fx - x / self.zoom, fy - y / self.zoom
        self._clamp()

    def pan(self, dx: float, dy: float) -> None:
        """Move the picture by (dx, dy) view pixels."""
        self.ox -= dx / self.zoom
        self.oy -= dy / self.zoom
        self._clamp()

    def render(self, img: np.ndarray) -> np.ndarray:
        if self.zoom == self.fit and self.ox == 0 and self.oy == 0:
            return cv2.resize(img, (self.vw, self.vh), interpolation=cv2.INTER_AREA)
        m = np.float32([[self.zoom, 0, -self.ox * self.zoom], [0, self.zoom, -self.oy * self.zoom]])
        interp = cv2.INTER_NEAREST if self.zoom >= 1 else cv2.INTER_LINEAR
        return cv2.warpAffine(img, m, (self.vw, self.vh), flags=interp)
