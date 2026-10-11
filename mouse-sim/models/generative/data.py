"""Training data for the generative model, and the banks it samples timings from.

Representation (handoff Phase 6): the movement in a canonical frame (start at the origin, target
centre on +x, distance scaled to 1; distances under D_MIN are scaled by D_MIN instead so tiny
corrections don't blow up pixel noise), 256 points evenly spaced in time, plus:

    log duration     generated together with the path
    end along/across where the movement ends relative to the target, in target-size units, so landing
                     precision on small targets doesn't depend on the movement distance

The path runs from movement onset to the cursor's last stop. Reaction phase, pause before click,
click hold/slip and the re-reaction after a miss are sampled from the owner's own recorded ones, by
target size (handoff: "Other timings"). Nothing is rotated or mirrored as augmentation: direction is a
model input.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from pipeline import geometry
from pipeline.dataset import Dataset

N_POINTS = 256
D_MIN = 20.0
MIN_DURATION_MS = 20
IN_CHANNELS = 5  # x, y, log duration, end along, end across
COND_NAMES = ["log_D", "sin_theta", "cos_theta", "log_along", "log_across", "rect", "start_rel_x",
              "start_rel_y", "after_miss"]


def cond_vector(D, theta_deg, along, across, rect, start_rel_x, start_rel_y, after_miss) -> np.ndarray:
    th = math.radians(theta_deg)
    return np.array([math.log(max(D, 1.0)), math.sin(th), math.cos(th), math.log(max(along, 1.0)),
                     math.log(max(across, 1.0)), float(rect), start_rel_x, start_rel_y, float(after_miss)],
                    dtype=np.float32)


def frame(start, target_xy):
    """Rotation (canonical -> screen), scale, distance and direction for start -> target centre."""
    v = np.asarray(target_xy, float) - np.asarray(start, float)
    D = float(np.hypot(*v))
    th = math.atan2(v[1], v[0])
    c, s = math.cos(th), math.sin(th)
    return np.array([[c, -s], [s, c]]), max(D, D_MIN), D, math.degrees(th) % 360


def canonical_trajectory(pos: np.ndarray, k0: int, t_end: float, start, target_xy, n: int = N_POINTS) -> np.ndarray:
    rot, scale, _, _ = frame(start, target_xy)
    k1 = min(int(math.floor(t_end)), len(pos) - 1)
    seg = pos[k0:k1 + 1].astype(float)
    if len(seg) < 2:
        seg = np.vstack([seg, seg])
    dur = max(t_end - k0, 1.0)
    ts = np.linspace(0, dur, n)
    idx = np.arange(len(seg))
    p = np.column_stack([np.interp(ts, idx, seg[:, 0]), np.interp(ts, idx, seg[:, 1])])
    return ((p - np.asarray(start, float)) @ rot) / scale  # rot is orthonormal: p @ rot = rot.T @ p


def to_screen(traj: np.ndarray, start, target_xy) -> np.ndarray:
    rot, scale, _, _ = frame(start, target_xy)
    return np.asarray(start, float) + (traj * scale) @ rot.T


def end_offset(p_end, start, target, along: float, across: float) -> np.ndarray:
    """Where a movement ended relative to the target centre, in target-size units (along, across)."""
    rot, _, _, _ = frame(start, (target.cx, target.cy))
    off = (np.asarray(p_end, float) - np.array([target.cx, target.cy])) @ rot
    return np.array([off[0] / max(along, 1.0), off[1] / max(across, 1.0)], np.float32)


@dataclass
class TrainingSet:
    X: np.ndarray          # (N, 2, 256) canonical paths, onset -> last stop
    logdur: np.ndarray     # (N,)
    end: np.ndarray        # (N, 2) end offset in target-size units
    C: np.ndarray          # (N, 9) conditions
    session: np.ndarray    # (N,) session index
    sessions: list         # session ids, in index order (chronological)


def build(ds: Dataset, role: str = "train", include_warmup: bool = False) -> TrainingSet:
    movs = ds.usable_movements(role=role, include_warmup=include_warmup)
    movs = movs[movs["moved"] & (movs["t_last_stop"] - movs["t_onset"] >= MIN_DURATION_MS)]
    sessions = sorted(movs["session_id"].unique())
    sidx = {s: i for i, s in enumerate(sessions)}
    X, L, E, C, S = [], [], [], [], []
    cache: dict = {}
    for r in movs.itertuples():
        tl = cache.get(r.tl_index)
        if tl is None:
            cache.clear()
            tl = cache[r.tl_index] = ds.timeline(r.tl_index)
        start = (r.start_x, r.start_y)
        k0, k1 = int(r.t_onset), int(r.t_last_stop)
        X.append(canonical_trajectory(tl.pos, k0, float(k1), start, (tl.target.cx, tl.target.cy)).T)
        L.append(math.log(k1 - k0))
        E.append(end_offset(tl.pos[k1], start, tl.target, r.size_along, r.size_across))
        C.append(cond_vector(r.D, r.theta, r.size_along, r.size_across, r.shape == "rect",
                             r.start_rel_x, r.start_rel_y, r.after_miss))
        S.append(sidx[r.session_id])
    return TrainingSet(np.array(X, np.float32).reshape(-1, 2, N_POINTS), np.array(L, np.float32),
                       np.array(E, np.float32).reshape(-1, 2), np.array(C, np.float32).reshape(-1, len(COND_NAMES)),
                       np.array(S, np.int64), sessions)


def _changes(rel: np.ndarray) -> list:
    """Compact (t, dx, dy) list of the moments a relative path changes."""
    if len(rel) == 0:
        return []
    d = np.flatnonzero(np.any(np.diff(rel, axis=0) != 0, axis=1)) + 1
    return [[int(k), int(rel[k][0]), int(rel[k][1])] for k in d]


BANKS = ("reaction", "after_miss", "dwell", "dwell_after_miss", "click")


def build_banks(ds: Dataset, role: str = "train", include_warmup: bool = False) -> dict:
    """The owner's real reaction phases (duration + drift), re-reactions after a miss, pauses before
    clicking (duration + drift), and click holds (duration + slip), by target size bin."""
    trials = ds.usable_trials(role=role, include_warmup=include_warmup)
    movs = ds.movements.set_index(["session_id", "trial", "mov"])
    banks = {name: [[] for _ in range(geometry.N_SIZE)] for name in BANKS}
    for t in trials.itertuples():
        tl = ds.timeline(t.tl_index)
        si = int(t.trial_cell_s)
        for m in range(len(tl.clicks)):
            mv = movs.loc[(t.session_id, t.trial, m)]
            k_ref = int(math.ceil(mv.t_ref))
            k_on = int(mv.t_onset)
            k_stop = int(mv.t_last_stop)
            kd = int(math.floor(mv.t_down))
            ku = min(int(math.floor(mv.t_up)), len(tl.pos) - 1)
            banks["reaction" if m == 0 else "after_miss"][si].append(
                [k_on - k_ref, _changes(tl.pos[k_ref:k_on + 1] - tl.pos[k_ref])])
            banks["dwell" if m == 0 else "dwell_after_miss"][si].append(
                [round(float(mv.t_down - k_stop), 2), _changes(tl.pos[k_stop:kd + 1] - tl.pos[k_stop])])
            banks["click"][si].append([round(float(mv.t_up - mv.t_down), 2), _changes(tl.pos[kd:ku + 1] - tl.pos[kd])])
    for name in ("dwell_after_miss", "after_miss"):  # rare: fall back to the primary-movement bank
        for si in range(geometry.N_SIZE):
            if len(banks[name][si]) < 5:
                banks[name][si] = banks[name][si] + banks["dwell" if name.startswith("dwell") else "reaction"][si]
    for name, bins in banks.items():  # sparse size bins borrow from their neighbours
        for si in range(geometry.N_SIZE):
            if len(bins[si]) < 20:
                pool = []
                for j in sorted(range(geometry.N_SIZE), key=lambda j: abs(j - si)):
                    pool += bins[j]
                    if len(pool) >= 20:
                        break
                banks[name][si] = pool
    return banks


def expand(changes: list, length: int) -> np.ndarray:
    """Inverse of _changes: relative path of `length` + 1 samples."""
    out = np.zeros((length + 1, 2), np.int32)
    for k, dx, dy in changes:
        if k <= length:
            out[k:] = (dx, dy)
    return out
