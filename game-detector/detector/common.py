"""Shared helpers: project paths, config files, DPI awareness, the detection record."""

from __future__ import annotations

import ctypes
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CONFIGS = ROOT / "configs"
RUNS = ROOT / "runs"


def make_dpi_aware() -> None:
    """Per-monitor DPI awareness, so every coordinate is a physical screen pixel.

    Call it before anything touches windows or the screen. dxcam sets a weaker
    mode on import, and the first call wins.
    """
    if sys.platform != "win32":
        return
    try:
        # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
        if ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return
    except (AttributeError, OSError):
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except (AttributeError, OSError):
        ctypes.windll.user32.SetProcessDPIAware()


def resolve(path: str | Path) -> Path:
    """Relative paths are taken from the project root, whatever the cwd."""
    p = Path(path)
    return p if p.is_absolute() else ROOT / p


def load_yaml(path: str | Path) -> dict:
    p = resolve(path)
    if not p.exists():
        return {}
    with open(p, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def save_yaml(path: str | Path, data: dict, header: str = "") -> Path:
    """Write a config, keeping the previous version as <name>.bak."""
    p = resolve(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        shutil.copy2(p, p.with_name(p.name + ".bak"))
    text = yaml.safe_dump(data, sort_keys=False, allow_unicode=True, default_flow_style=None, width=120)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(header + text, encoding="utf-8")
    tmp.replace(p)
    return p


def drop_ignored(dets: list, regions: list[tuple[int, int, int, int]]) -> list:
    """Detections whose center is not inside any ignore region."""
    if not regions:
        return dets
    return [d for d in dets
            if not any(x1 <= d.center[0] <= x2 and y1 <= d.center[1] <= y2 for x1, y1, x2, y2 in regions)]


@dataclass
class Detection:
    """One object in one frame. `box` is x1, y1, x2, y2 in frame pixels."""

    box: tuple[float, float, float, float]
    type: str
    conf: float
    color: str = "unknown"
    color_conf: float = 0.0
    id: int | None = None

    @property
    def center(self) -> tuple[float, float]:
        x1, y1, x2, y2 = self.box
        return (x1 + x2) / 2, (y1 + y2) / 2

    @property
    def size(self) -> tuple[float, float]:
        x1, y1, x2, y2 = self.box
        return x2 - x1, y2 - y1
