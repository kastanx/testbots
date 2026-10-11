"""The motion-matching library: every usable training trial with its conditions and full timeline
(target appears -> button up), positions relative to where the cursor was when the target appeared.
Mirrored by web/src/shared/models/motionMatching.ts, which loads the exported files."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pipeline import geometry
from pipeline.dataset import Dataset

SHAPES = {"circle": 0, "rect": 1}


@dataclass
class Library:
    D: np.ndarray            # (n,) start -> target centre distance (px)
    theta: np.ndarray        # (n,) direction (deg, screen coordinates)
    along: np.ndarray        # (n,) target size along the direction
    across: np.ndarray       # (n,) target size across it
    shape: np.ndarray        # (n,) 0 circle / 1 rect
    start_rel: np.ndarray    # (n, 2) start position / screen size
    target_wh: np.ndarray    # (n, 3) w, h, r of the recorded target
    onset: np.ndarray        # (n,) movement onset (ms after target appeared)
    rel: np.ndarray          # (sum K, 2) int16 positions relative to the start
    offsets: np.ndarray      # (n + 1,)
    clicks: np.ndarray       # (sum clicks, 3) t_down, t_up, hit
    click_offsets: np.ndarray
    keys: list               # "session:trial"

    def __len__(self):
        return len(self.D)

    def path(self, i: int) -> np.ndarray:
        return self.rel[self.offsets[i]:self.offsets[i + 1]]

    def trial_clicks(self, i: int) -> np.ndarray:
        return self.clicks[self.click_offsets[i]:self.click_offsets[i + 1]]


def build(ds: Dataset, role: str = "train", include_warmup: bool = False) -> Library:
    trials = ds.usable_trials(role=role, include_warmup=include_warmup)
    prim = ds.movements[(ds.movements["mov"] == 0)].set_index(["session_id", "trial"])
    D, th, al, ac, sh, sr, wh, on, rels, offs, clk, coffs, keys = [], [], [], [], [], [], [], [], [], [0], [], [0], []
    for row in trials.itertuples():
        tl = ds.timeline(row.tl_index)
        start = tl.pos[0].astype(np.int32)
        rel = (tl.pos - start).astype(np.int16)
        D.append(row.trial_D)
        th.append(row.trial_theta)
        al.append(row.trial_size_along)
        ac.append(row.trial_size_across)
        sh.append(SHAPES[tl.target.shape])
        sr.append((start[0] / tl.screen[0], start[1] / tl.screen[1]))
        wh.append((tl.target.w, tl.target.h, tl.target.r))
        on.append(float(prim.loc[(row.session_id, row.trial), "t_onset"]))
        rels.append(rel)
        offs.append(offs[-1] + len(rel))
        clk.append(np.column_stack([tl.clicks, tl.click_hit.astype(float)]))
        coffs.append(coffs[-1] + len(tl.clicks))
        keys.append(f"{row.session_id}:{row.trial}")
    return Library(np.array(D), np.array(th), np.array(al), np.array(ac), np.array(sh, np.int8),
                   np.array(sr).reshape(-1, 2), np.array(wh).reshape(-1, 3), np.array(on),
                   np.concatenate(rels) if rels else np.zeros((0, 2), np.int16), np.array(offs, np.int64),
                   np.concatenate(clk) if clk else np.zeros((0, 3)), np.array(coffs, np.int64), keys)


def export(lib: Library, out_dir: Path, fitts: dict, cfg: dict, screen) -> dict:
    """library.json (columns) + library.bin (int16 x/y pairs) for the simulator."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "library.bin").write_bytes(np.ascontiguousarray(lib.rel, dtype="<i2").tobytes())
    meta = {
        "format": 1, "n": len(lib), "screen": list(screen),
        "fitts": {"a_nominal": fitts["a_nominal"], "b_nominal": fitts["b_nominal"]},
        "config": cfg,
        "D": lib.D.round(3).tolist(), "theta": lib.theta.round(4).tolist(),
        "along": lib.along.round(3).tolist(), "across": lib.across.round(3).tolist(),
        "shape": lib.shape.tolist(), "start_rel": lib.start_rel.round(5).ravel().tolist(),
        "target": lib.target_wh.round(3).ravel().tolist(), "onset": lib.onset.round(2).tolist(),
        "offsets": lib.offsets.tolist(), "clicks": lib.clicks.round(3).ravel().tolist(),
        "click_offsets": lib.click_offsets.tolist(), "keys": lib.keys,
    }
    (out_dir / "library.json").write_text(json.dumps(meta, separators=(",", ":")))
    return {"entries": len(lib), "bytes": int(lib.rel.nbytes)}


def angle_diff(a, b):
    return np.mod(np.asarray(a) - b + 180.0, 360.0) - 180.0


def chord_dirs(shape, w, h, theta_deg):
    return geometry.sizes_along_across(shape, w, h, math.radians(theta_deg))
