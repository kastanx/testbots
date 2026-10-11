"""Session validation. Fails loudly on low event rate, gaps, timestamps going backwards, duplicate
events and coordinate rounding (handoff Phase 2)."""
from __future__ import annotations

import numpy as np

from . import config
from .rawio import RawSession


def motion_intervals(t, xp, yp, window_ms, speed_thr):
    """Indices i (interval i-1 -> i) where the cursor is moving at >= speed_thr px/ms."""
    n = len(t)
    if n < 2:
        return np.zeros(0, int)
    j = np.searchsorted(t, t - window_ms, side="left")
    k = np.minimum(j, np.arange(n) - 1)
    k[0] = 0
    span = t - t[k]
    with np.errstate(invalid="ignore", divide="ignore"):
        speed = np.hypot(xp - xp[k], yp - yp[k]) / span
    idx = np.flatnonzero((span > 0) & (speed >= speed_thr))
    return idx[idx >= 1]


def validate(raw: RawSession) -> dict:
    cfg = config.pipeline()
    v = cfg["validate"]
    errors, warnings = [], []
    dpr = raw.dpr
    t = raw.moves["t"]
    x = raw.moves["x"] * dpr
    y = raw.moves["y"] * dpr
    polling = raw.polling_hz or cfg["polling_hz_default"]
    n = len(t)

    dt = np.diff(t)
    backwards = int(np.sum(dt < 0))
    dup = int(np.sum((dt == 0) & (np.diff(x) == 0) & (np.diff(y) == 0)))
    idx = motion_intervals(t, x, y, cfg["motion_window_ms"], cfg["motion_speed"])
    mdt = t[idx] - t[idx - 1] if len(idx) else np.zeros(0)
    rate = len(mdt) / mdt.sum() * 1000 if mdt.sum() > 0 else float("nan")
    gap_thr = 2000.0 / polling
    gap_share = float(np.mean(mdt > gap_thr)) if len(mdt) else float("nan")
    whole = np.mean((np.abs(x - np.rint(x)) < 1e-3) & (np.abs(y - np.rint(y)) < 1e-3)) if n else float("nan")
    hits = sum(1 for tr in raw.trials if tr.get("t_hit") is not None)

    if not raw.meta.get("complete"):
        warnings.append("session was not finished cleanly (no /finish); using what was uploaded")
    if raw.bad_lines:
        errors.append(f"{raw.bad_lines} unreadable lines")
    if backwards:
        errors.append(f"{backwards} move timestamps go backwards")
    if n and dup / n > v["max_duplicate_share"]:
        errors.append(f"{dup} duplicate move events ({dup / n:.2%})")
    elif dup:
        warnings.append(f"{dup} duplicate move events")
    if not (rate >= v["min_event_rate_frac"] * polling):
        errors.append(f"event rate while moving is {rate:.0f} Hz, expected about {polling:.0f} Hz")
    if not (gap_share <= v["max_gap_share"]):
        errors.append(f"{gap_share:.1%} of intervals while moving are longer than {gap_thr:.1f} ms")
    if not (whole >= v["min_whole_pixel_share"]):
        errors.append(f"only {whole:.1%} of positions are whole physical pixels (browser rounding to CSS px?)")
    if hits < v["min_trials"]:
        errors.append(f"only {hits} completed trials")
    if not raw.meta.get("crossOriginIsolated", True):
        warnings.append("page was not cross-origin isolated: timestamps limited to 0.1 ms")

    # The recorder's hit/miss decisions should agree with the geometry.
    from .timeline import Target
    mismatches = 0
    for e in raw.markers:
        if e["k"] not in ("hit", "miss"):
            continue
        tr = raw.trials[e["trial"]] if e["trial"] < len(raw.trials) and raw.trials[e["trial"]]["trial"] == e["trial"] else None
        if tr is None:
            continue
        tg = Target(tr["shape"], tr["cx"] * dpr, tr["cy"] * dpr, tr["w"] * dpr, tr["h"] * dpr, tr.get("r", 0) * dpr)
        if bool(tg.contains(e["x"] * dpr, e["y"] * dpr)) != (e["k"] == "hit"):
            mismatches += 1
    if mismatches:
        warnings.append(f"{mismatches} hit/miss markers disagree with the target geometry")

    return {
        "session_id": raw.session_id,
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "stats": {
            "moves": n, "trials": len(raw.trials), "hits": hits,
            "event_rate_hz": rate, "gap_share": gap_share, "gap_threshold_ms": gap_thr,
            "whole_pixel_share": float(whole), "duplicates": dup, "backwards": backwards,
            "motion_intervals": int(len(mdt)), "polling_hz": polling,
        },
    }
