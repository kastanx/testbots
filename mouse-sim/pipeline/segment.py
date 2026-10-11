"""Splits a trial timeline into movements and phases (handoff Phase 2).

    reaction    target appears (or the previous click is released)  -> movement starts
    trajectory  movement starts -> button down (corrections and the pause before clicking included)
    dwell       cursor stops for the last time -> button down
    click       button down -> button up

A trial with misses becomes several movements: the first up to the first click, then one
`after_miss` movement per extra click. Thresholds live in config/pipeline.json.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import savgol_filter

from . import config
from .timeline import Timeline


@dataclass
class Kinematics:
    pos: np.ndarray    # (K, 2) float, raw whole-pixel positions
    sm: np.ndarray     # (K, 2) lightly smoothed positions
    vel: np.ndarray    # (K, 2) px/ms
    speed: np.ndarray  # (K,) px/ms


@dataclass
class Movement:
    index: int
    after_miss: bool
    t_ref: float       # what the reaction is measured from: 0 (target appeared) or the previous release
    k_onset: int
    k_down: int
    k_last_stop: int
    t_down: float
    t_up: float
    hit: bool
    down_xy: np.ndarray
    moved: bool        # False when no movement onset was found before the click


def _window(w: int, n: int, polyorder: int) -> int | None:
    w = min(w, n if n % 2 else n - 1)
    return w if w > polyorder else None


def kinematics(tl: Timeline, cfg: dict | None = None) -> Kinematics:
    cfg = cfg or config.pipeline()
    p = tl.pos.astype(float)
    w = _window(cfg["smooth"]["window_ms"], len(p), cfg["smooth"]["polyorder"])
    if w is None:
        sm = p.copy()
        vel = np.gradient(p, axis=0) if len(p) > 1 else np.zeros_like(p)
    else:
        sm = savgol_filter(p, w, cfg["smooth"]["polyorder"], axis=0, mode="interp")
        vel = savgol_filter(p, w, cfg["smooth"]["polyorder"], deriv=1, delta=1.0, axis=0, mode="interp")
    return Kinematics(p, sm, vel, np.hypot(vel[:, 0], vel[:, 1]))


def find_onset(speed: np.ndarray, k0: int, k1: int, cfg: dict) -> int | None:
    """First sustained rise above the onset threshold, walked back to where motion began."""
    s = speed[k0:k1 + 1]
    if len(s) == 0:
        return None
    oc = cfg["onset"]
    above = s > oc["speed"]
    m = oc["min_ms"]
    idx = np.zeros(0, int)
    if len(s) >= m:
        idx = np.flatnonzero(np.convolve(above.astype(np.int32), np.ones(m, np.int32), "valid") == m)
    if len(idx) == 0:
        idx = np.flatnonzero(above)  # short corrections can be briefer than min_ms
        if len(idx) == 0:
            return None
    i = int(idx[0])
    while i > 0 and s[i - 1] > oc["backtrack_speed"]:
        i -= 1
    return k0 + i


def find_last_stop(speed: np.ndarray, k_onset: int, k_down: int, cfg: dict) -> int:
    """Start of the final stationary stretch before the click (k_down if still moving)."""
    stop = cfg["stop_speed"]
    i = k_down
    while i > k_onset and speed[i] < stop:
        i -= 1
    return k_down if i == k_down and speed[k_down] >= stop else i + 1


def longest_still_ms(speed: np.ndarray, k0: int, k1: int, stop: float) -> int:
    s = speed[k0:k1 + 1] < stop
    if not s.any():
        return 0
    d = np.diff(np.concatenate([[0], s.astype(np.int8), [0]]))
    return int(np.max(np.flatnonzero(d == -1) - np.flatnonzero(d == 1)))


def segment(tl: Timeline, kin: Kinematics, cfg: dict | None = None) -> list[Movement]:
    cfg = cfg or config.pipeline()
    out = []
    K = len(kin.speed)
    t_ref = 0.0
    for i, (td, tu) in enumerate(tl.clicks):
        k_ref = min(int(np.ceil(t_ref)), K - 1)
        k_down = max(min(int(np.floor(td)), K - 1), k_ref)
        onset = find_onset(kin.speed, k_ref, k_down, cfg)
        moved = onset is not None
        onset = k_down if onset is None else onset
        out.append(Movement(
            index=i, after_miss=i > 0, t_ref=t_ref, k_onset=onset, k_down=k_down,
            k_last_stop=find_last_stop(kin.speed, onset, k_down, cfg), t_down=float(td), t_up=float(tu),
            hit=bool(tl.click_hit[i]), down_xy=np.asarray(tl.click_xy[i], float), moved=moved))
        t_ref = float(tu)
    return out


MARKER_REASONS = {"leave": "pointer_left", "blur": "focus_lost", "pause": "paused"}


def rejections(tl: Timeline, kin: Kinematics, movements: list[Movement], cfg: dict | None = None,
               record: dict | None = None, markers: list | None = None) -> list[str]:
    """Why a trial can't be used (empty list = usable). Applies to real and generated trials alike;
    the recorder flags and in-trial markers only exist for real ones."""
    cfg = cfg or config.pipeline()
    reasons = []
    if record is not None:
        if record.get("invalid"):
            reasons += list(record.get("invalid_reasons") or ["invalid"])
        if record.get("t_hit") is None:
            reasons.append("no_hit")
    for k in markers or []:
        if k in MARKER_REASONS:
            reasons.append(MARKER_REASONS[k])
    if not movements:
        reasons.append("no_click")
    else:
        if not movements[0].moved:
            reasons.append("no_movement")
        if not movements[-1].hit and "no_hit" not in reasons:
            reasons.append("no_hit")
        for mv in movements:
            if longest_still_ms(kin.speed, mv.k_onset, mv.k_last_stop, cfg["stop_speed"]) > cfg["max_pause_mid_movement_ms"]:
                reasons.append("pause_mid_movement")
                break
    if len(tl.clicks) > cfg["max_clicks_per_trial"]:
        reasons.append("too_many_clicks")
    return list(dict.fromkeys(reasons))
