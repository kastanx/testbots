"""Physical pixels, the polling-grid timeline, and per-trial timelines on the 1 ms grid.

Browser timestamps record when each event arrived, which jitters by a fraction of a millisecond.
The mouse itself reports on a fixed polling grid, so t_grid snaps each event onto that grid: per burst
of continuous motion, estimate the grid phase (circular mean), then assign every event a strictly
increasing slot with a small dynamic programme. Raw t is kept as well.
"""
from __future__ import annotations

import math

import numpy as np

from .rawio import RawSession
from .timeline import Target, Timeline


def to_physical(v_css, dpr: float) -> np.ndarray:
    return np.rint(np.asarray(v_css, float) * dpr).astype(np.int32)


def _assign_slots(x: np.ndarray) -> np.ndarray:
    """Strictly increasing integers n (each within +-1 of round(x)) minimising sum (x - n)^2."""
    n0 = np.rint(x)
    if len(x) < 2 or (np.all(np.diff(n0) > 0) and np.max(np.abs(x - n0)) < 0.4):
        return n0
    xs = x.tolist()
    base = n0.tolist()
    m = len(xs)
    inf = math.inf
    acc = [(xs[0] - (base[0] + d)) ** 2 for d in (-1, 0, 1)]
    back = [[0, 0, 0] for _ in range(m)]
    for i in range(1, m):
        new = [inf, inf, inf]
        bi = back[i]
        for j, d in enumerate((-1, 0, 1)):
            cand = base[i] + d
            best, arg = inf, 0
            for jj, dd in enumerate((-1, 0, 1)):
                if base[i - 1] + dd < cand and acc[jj] < best:
                    best, arg = acc[jj], jj
            if best < inf:
                new[j] = best + (xs[i] - cand) ** 2
                bi[j] = arg
        acc = new
    j = int(np.argmin(acc))
    out = np.empty(m)
    for i in range(m - 1, -1, -1):
        out[i] = base[i] + (j - 1)
        j = back[i][j]
    return out


def grid_times(t: np.ndarray, period: float, burst_gap: float) -> tuple[np.ndarray, dict]:
    t = np.asarray(t, float)
    out = t.copy()
    if len(t) == 0:
        return out, {"bursts": 0}
    breaks = np.flatnonzero(np.diff(t) > burst_gap) + 1
    starts = np.concatenate([[0], breaks])
    ends = np.concatenate([breaks, [len(t)]])
    changed = 0
    n_fit = 0
    for a, b in zip(starts, ends):
        if b - a < 3:
            continue
        x = t[a:b] / period
        ang = 2 * np.pi * x
        phi = math.atan2(np.mean(np.sin(ang)), np.mean(np.cos(ang))) / (2 * np.pi)
        slots = _assign_slots(x - phi)
        changed += int(np.sum(slots != np.rint(x - phi)))
        out[a:b] = (slots + phi) * period
        n_fit += b - a
    resid = t - out
    return out, {
        "bursts": int(len(starts)),
        "events_on_grid": int(n_fit),
        "slots_moved_by_dp": int(changed),
        "residual_std_ms": float(np.std(resid)) if n_fit else None,
        "residual_p99_ms": float(np.percentile(np.abs(resid), 99)) if n_fit else None,
    }


def speed_noise(t: np.ndarray, x: np.ndarray, y: np.ndarray, burst_gap: float) -> float:
    """Median |change in speed| between consecutive intervals inside bursts (lower = cleaner)."""
    dt = np.diff(t)
    ok = (dt > 0) & (dt <= burst_gap)
    v = np.hypot(np.diff(x), np.diff(y)) / np.where(dt > 0, dt, np.nan)
    dv = np.abs(np.diff(v))
    both = ok[1:] & ok[:-1]
    return float(np.nanmedian(dv[both])) if both.any() else float("nan")


def build_timelines(raw: RawSession, t_grid: np.ndarray, xp: np.ndarray, yp: np.ndarray) -> list[tuple[dict, Timeline, dict]]:
    """One Timeline per trial: t = 0 at target_on, until the release of the final click."""
    dpr = raw.dpr
    screen = raw.screen
    order = np.argsort(t_grid, kind="stable")
    tg, xs, ys = t_grid[order], xp[order], yp[order]
    downs = [e for e in raw.buttons if e["k"] == "down" and e.get("btn", 0) == 0]
    ups = [e for e in raw.buttons if e["k"] == "up" and e.get("btn", 0) == 0]
    down_t = np.array([e["t"] for e in downs])
    up_t = np.array([e["t"] for e in ups])
    hit_t = {round(m["t"], 3) for m in raw.markers if m["k"] == "hit"}
    miss_t = {round(m["t"], 3) for m in raw.markers if m["k"] == "miss"}
    markers = sorted(raw.markers, key=lambda m: m["t"])
    mk_t = np.array([m["t"] for m in markers])

    out = []
    for tr in raw.trials:
        t_on = float(tr["t_on"])
        t_end = float(tr["t_up"] if tr.get("t_up") is not None else (tr.get("t_off") or t_on))
        K = int(math.ceil(t_end - t_on)) + 1
        grid = t_on + np.arange(K)
        idx = np.searchsorted(tg, grid, side="right") - 1
        start = (to_physical(tr["start_x"], dpr), to_physical(tr["start_y"], dpr))
        pos = np.empty((K, 2), np.int32)
        have = idx >= 0
        pos[have, 0] = xs[idx[have]]
        pos[have, 1] = ys[idx[have]]
        pos[~have] = start
        # clicks inside the trial
        di = np.flatnonzero((down_t >= t_on) & (down_t <= t_end + 1e-6))
        clicks, cxy, chit = [], [], []
        for i in di:
            d = downs[i]
            later = np.flatnonzero(up_t >= d["t"])
            u = float(up_t[later[0]]) if len(later) else t_end
            clicks.append((d["t"] - t_on, min(u, t_end) - t_on))
            cxy.append((d["x"] * dpr, d["y"] * dpr))
            key = round(d["t"], 3)
            chit.append(key in hit_t and key not in miss_t)
        tgt = Target(tr["shape"], tr["cx"] * dpr, tr["cy"] * dpr, tr["w"] * dpr, tr["h"] * dpr, tr.get("r", 0) * dpr)
        tl = Timeline(pos=pos, clicks=np.array(clicks, float).reshape(-1, 2), target=tgt, screen=screen,
                      click_xy=np.array(cxy, float).reshape(-1, 2), click_hit=np.array(chit, bool))
        a, b = np.searchsorted(mk_t, [t_on, t_end + 1e-6])
        in_trial = [markers[j]["k"] for j in range(a, b)]
        info = {"markers": in_trial}
        out.append((tr, tl, info))
    return out
