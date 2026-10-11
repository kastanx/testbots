"""The stroke library: every usable primary movement of the owner, decomposed.

For each recorded movement (onset -> the cursor's last stop), in a frame where the movement starts at
the origin and the target centre lies on +x:

    strokes   sigma-lognormal strokes fitted to its slow part (low-passed at plan_hz), times in ms
              from the movement onset
    texture   what the strokes don't explain - the hand's tremor and small wobbles - between
              texture_hz[0] and texture_hz[1] (below: slow misfit; above: pixel-rounding noise, which
              rounding a new path recreates anyway), onset -> last stop
    end       where it stopped, relative to the target centre, in target-size units (along, across)

Fitting all ~1,200 movements takes about half a minute on all cores; the result is cached in
models/strokes/cache/, keyed by the movements it was fitted on and the settings.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import pickle
from dataclasses import dataclass, field
from multiprocessing import get_context
from pathlib import Path

import numpy as np

from . import lognormal

CACHE_DIR = Path(__file__).resolve().parent / "cache"
PRE_MS = 40     # recorded context before the onset the strokes are fitted on (they start early)
POST_MS = 20    # and after the last stop
VERSION = 4


@dataclass
class StrokeLibrary:
    keys: list
    D: np.ndarray            # (n,) start -> target centre (px)
    theta: np.ndarray        # (n,) direction (deg, screen coordinates)
    along: np.ndarray        # (n,) target size along the direction
    across: np.ndarray       # (n,) target size across it
    shape: np.ndarray        # (n,) 0 circle / 1 rect
    start_rel: np.ndarray    # (n, 2) start position / screen size
    mt: np.ndarray           # (n,) onset -> last stop (ms)
    end: np.ndarray          # (n, 2) where it stopped, target-size units (along, across)
    hit: np.ndarray          # (n,) its click hit the target
    snr: np.ndarray          # (n,) how well the strokes fit its slow part (dB)
    travelled: np.ndarray    # (n,) how far the hand went along its slow part (px)
    strokes: list = field(default_factory=list)   # (k, 6) each
    texture: list = field(default_factory=list)   # (mt + 1, 2) each

    def __len__(self):
        return len(self.keys)


def canonical(pos: np.ndarray, start, target_xy) -> np.ndarray:
    """Positions relative to `start`, rotated so the target centre lies on +x."""
    th = math.atan2(target_xy[1] - start[1], target_xy[0] - start[0])
    c, s = math.cos(th), math.sin(th)
    return (np.asarray(pos, float) - np.asarray(start, float)) @ np.array([[c, -s], [s, c]])


def _work(args):
    q, plan_hz = args
    return lognormal.fit_movement(q, plan_hz)


def build(ds, role: str = "train", include_warmup: bool = True, plan_hz: float = 10.0,
          texture_hz=(4.0, 40.0), workers: int | None = None, cache: bool = True, log=None) -> StrokeLibrary:
    movs = ds.usable_movements(role=role, include_warmup=include_warmup, primary_only=True)
    movs = movs[movs["moved"] & (movs["t_last_stop"] - movs["t_onset"] >= 20)]
    keys = [f"{s}:{t}" for s, t in zip(movs["session_id"], movs["trial"])]
    settings = {"v": VERSION, "plan_hz": plan_hz, "texture_hz": list(texture_hz), "pre": PRE_MS, "post": POST_MS,
                "keys": keys, "data": str(ds.dir), "stamp": (ds.dir / "timelines.npz").stat().st_mtime_ns}
    digest = hashlib.sha1(json.dumps(settings, sort_keys=True).encode()).hexdigest()[:16]
    path = CACHE_DIR / f"library-{digest}.pkl"
    if cache and path.exists():
        return pickle.loads(path.read_bytes())

    windows, rows = [], []
    for r in movs.itertuples():
        tl = ds.timeline(r.tl_index)
        k_on, k_stop = int(r.t_onset), int(r.t_last_stop)
        a = max(k_on - PRE_MS, 0)
        b = min(k_stop + POST_MS, len(tl.pos) - 1)
        q = canonical(tl.pos[a:b + 1], (r.start_x, r.start_y), (tl.target.cx, tl.target.cy))
        windows.append(q)
        rows.append((r, tl, a, k_on, k_stop))
    if log:
        log(f"fitting strokes to {len(windows)} recorded movements …")
    n_proc = workers or max(1, (os.cpu_count() or 2) - 1)
    if n_proc > 1 and len(windows) > 20:
        with get_context("spawn").Pool(n_proc) as pool:
            fits = pool.map(_work, [(q, plan_hz) for q in windows], chunksize=8)
    else:
        fits = [_work((q, plan_hz)) for q in windows]

    lib = StrokeLibrary(keys=[], D=[], theta=[], along=[], across=[], shape=[], start_rel=[], mt=[], end=[],
                        hit=[], snr=[], travelled=[])
    for (r, tl, a, k_on, k_stop), q, (P, s) in zip(rows, windows, fits):
        if len(P) == 0:
            continue
        t = np.arange(len(q), dtype=float)
        plan = lognormal.position(t, P)
        resid = q - plan
        resid -= resid[0]
        tex = lognormal.highpass(lognormal.lowpass(resid, texture_hz[1]), texture_hz[0])
        on, stop = k_on - a, k_stop - a
        tex = tex - tex[on]                 # starts from nothing at the onset
        P = P.copy()
        P[:, 1] -= on                       # times from the onset
        along, across = max(r.size_along, 1.0), max(r.size_across, 1.0)
        q_stop = q[stop]
        lib.keys.append(f"{r.session_id}:{r.trial}")
        lib.D.append(r.D)
        lib.theta.append(r.theta)
        lib.along.append(along)
        lib.across.append(across)
        lib.shape.append(1 if r.shape == "rect" else 0)
        lib.start_rel.append((r.start_rel_x, r.start_rel_y))
        lib.mt.append(stop - on)
        lib.end.append(((q_stop[0] - r.D) / along, q_stop[1] / across))
        lib.hit.append(bool(r.hit))
        lib.snr.append(s)
        lp_v = np.gradient(lognormal.lowpass(q, plan_hz), axis=0)
        lib.travelled.append(float(np.sum(np.hypot(lp_v[:, 0], lp_v[:, 1]))))
        lib.strokes.append(P)
        lib.texture.append(tex[on:stop + 1].astype(np.float32))
    for name in ("D", "theta", "along", "across", "mt", "snr", "travelled"):
        setattr(lib, name, np.array(getattr(lib, name), float))
    lib.shape = np.array(lib.shape, np.int8)
    lib.start_rel = np.array(lib.start_rel, float).reshape(-1, 2)
    lib.end = np.array(lib.end, float).reshape(-1, 2)
    lib.hit = np.array(lib.hit, bool)
    if cache:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_bytes(pickle.dumps(lib))
    return lib
