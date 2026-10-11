"""Reads raw sessions (data/raw/<session_id>/). Read-only: raw data is never edited."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import paths

MARKER_KINDS = {"target_on", "target_off", "hit", "miss", "pause", "resume", "blur", "focus", "leave", "enter"}


@dataclass
class RawSession:
    session_id: str
    dir: Path
    meta: dict
    moves: dict                       # t, x, y, b arrays (CSS px, as delivered)
    buttons: list = field(default_factory=list)   # down/up events
    markers: list = field(default_factory=list)   # everything else
    trials: list = field(default_factory=list)
    bad_lines: int = 0

    @property
    def dpr(self) -> float:
        return float(self.meta.get("devicePixelRatio") or 1.0)

    @property
    def screen(self) -> tuple[int, int]:
        s = self.meta.get("canvas_phys") or self.meta.get("screen_phys")
        return (int(s[0]), int(s[1]))

    @property
    def polling_hz(self) -> float | None:
        return ((self.meta.get("setup") or {}).get("mouse") or {}).get("polling_hz")


def _read_jsonl(path: Path):
    good, bad = [], 0
    if not path.exists():
        return good, bad
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                good.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1
    return good, bad


def load_session(d: Path) -> RawSession:
    d = Path(d)
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    events, bad = _read_jsonl(d / "events.jsonl")
    trials, bad_t = _read_jsonl(d / "trials.jsonl")
    t, x, y, b = [], [], [], []
    buttons, markers = [], []
    for e in events:
        k = e.get("k")
        if k == "move":
            t.append(e["t"])
            x.append(e["x"])
            y.append(e["y"])
            b.append(e.get("b", 0))
        elif k in ("down", "up"):
            buttons.append(e)
        else:
            markers.append(e)
    moves = {"t": np.asarray(t, float), "x": np.asarray(x, float), "y": np.asarray(y, float),
             "b": np.asarray(b, np.int16)}
    trials.sort(key=lambda r: r["trial"])
    return RawSession(meta.get("session_id", d.name), d, meta, moves, buttons, markers, trials, bad + bad_t)


def session_dirs(root: Path) -> list[Path]:
    base = paths.raw_dir(root)
    if not base.is_dir():
        return []
    return sorted(p for p in base.iterdir() if (p / "meta.json").exists())


def load_splits(root: Path) -> dict:
    """Optional data/splits.json: {"<session_id>": "train" | "val" | "test" | "exclude"} overrides."""
    f = paths.splits_file(root)
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def session_role(meta: dict, splits: dict) -> str:
    return splits.get(meta.get("session_id"), meta.get("role") or "train")
