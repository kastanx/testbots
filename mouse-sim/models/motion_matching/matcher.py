"""Motion matching (Phase 5). No training: the model is the library of the owner's real trials.

query   condition distance = weighted sum of |log D - log Di|, the direction difference,
        |log size - log size_i| along and across, the start-position difference and shape
limits  only candidates within +-15 deg, 0.85-1.15x the distance and 0.7-1.4x the size qualify
        (config/motion_matching.json). None qualify: use the fallback model if there is one,
        otherwise the nearest candidate, flagged as low coverage.
pick    randomly among the top k, weighted by similarity, never the same trial twice in a row
warp    rotate and scale the whole trial about its start so that start -> target centre lines up
        with the new start -> target centre (landing offsets and misses stay intact), stretch the
        movement part in time by the ratio of Fitts-predicted movement times, clamp to the screen
        like a real cursor. A candidate whose clicks would change hit/miss after warping is skipped.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.signal import butter, sosfiltfilt

from pipeline import config, geometry
from pipeline.features import predicted_mt
from pipeline.timeline import Timeline

from ..base import Model, TrialConditions, clamp_path, to_pixels
from . import library as libmod


class MotionMatching(Model):
    name = "motion_matching"
    version = "1"

    def __init__(self, cfg: dict | None = None, fallback: Model | None = None, role: str = "train"):
        self.cfg = cfg or config.motion_matching()
        self.fallback = fallback
        self.role = role
        self.last = -1
        self.exclude: set = set()   # library keys ("session:trial") the next queries may not use
        self.stats = {"queries": 0, "qualified": 0, "low_coverage": 0, "fallback": 0, "skipped_inconsistent": 0}

    def fit(self, ds) -> "MotionMatching":
        self.lib = libmod.build(ds, role=self.role, include_warmup=self.cfg.get("include_warmup", False))
        self.fitts = ds.fitts
        if self.fallback is not None:
            self.fallback.fit(ds)
        return self

    def describe(self) -> dict:
        return {"name": self.name, "version": self.version, "library": len(self.lib), **self.cfg}

    # ------------------------------------------------------------------ query

    @staticmethod
    def conditions(cond: TrialConditions) -> dict:
        sx, sy = cond.start
        t = cond.target
        dx, dy = t.cx - sx, t.cy - sy
        theta = float(geometry.direction_deg(dx, dy))
        along, across = (float(v) for v in geometry.sizes_along_across(t.shape, t.w, t.h, math.radians(theta)))
        return {"D": max(math.hypot(dx, dy), 1.0), "theta": theta, "along": max(along, 1.0),
                "across": max(across, 1.0), "shape": libmod.SHAPES[t.shape],
                "start_rel": np.array([sx / cond.screen[0], sy / cond.screen[1]])}

    def distances(self, q: dict) -> tuple[np.ndarray, np.ndarray]:
        lib, w, lim = self.lib, self.cfg["weights"], self.cfg["limits"]
        dth = libmod.angle_diff(lib.theta, q["theta"])
        rd = lib.D / q["D"]
        ra = lib.along / q["along"]
        rc = lib.across / q["across"]
        ok = ((np.abs(dth) <= lim["direction_deg"]) & (rd >= lim["distance_ratio"][0]) & (rd <= lim["distance_ratio"][1])
              & (ra >= lim["size_ratio"][0]) & (ra <= lim["size_ratio"][1])
              & (rc >= lim["across_ratio"][0]) & (rc <= lim["across_ratio"][1]))
        dist = (w["log_distance"] * np.abs(np.log(rd)) + w["direction_rad"] * np.abs(np.radians(dth))
                + w["log_size_along"] * np.abs(np.log(ra)) + w["log_size_across"] * np.abs(np.log(rc))
                + w["start"] * np.hypot(*(lib.start_rel - q["start_rel"]).T)
                + w["shape"] * (lib.shape != q["shape"]))
        if self.exclude:
            out = np.array([k in self.exclude for k in lib.keys])
            dist = np.where(out, np.inf, dist)
            ok = ok & ~out
        return dist, ok

    # ------------------------------------------------------------------ warp

    def _mt(self, D, along) -> float:
        return max(float(predicted_mt(self.fitts, D, along)), 50.0)

    def warp(self, i: int, cond: TrialConditions, q: dict | None = None, check: bool = True) -> Timeline | None:
        lib = self.lib
        q = q or self.conditions(cond)
        rot = math.radians(float(libmod.angle_diff(q["theta"], lib.theta[i])))
        scale = q["D"] / lib.D[i]
        c, s = math.cos(rot), math.sin(rot)
        rel = lib.path(i).astype(float)
        clicks = lib.trial_clicks(i)
        k_on = float(lib.onset[i])
        t_last = float(clicks[-1, 0])
        r = self._mt(q["D"], q["along"]) / self._mt(lib.D[i], lib.along[i])
        seg_old = max(t_last - k_on, 0.0)
        extra = seg_old * (r - 1)

        def new_t(t_old):
            t_old = np.asarray(t_old, float)
            return np.where(t_old < k_on, t_old, np.where(t_old <= t_last, k_on + (t_old - k_on) * r, t_old + extra))

        def old_t(t_new):
            t_new = np.asarray(t_new, float)
            return np.where(t_new < k_on, t_new,
                            np.where(t_new <= k_on + seg_old * r, k_on + (t_new - k_on) / r, t_new - extra))

        K_new = max(int(math.floor(new_t(len(rel) - 1))) + 1, 2)
        if abs(rot) < 1e-9 and abs(scale - 1) < 1e-9 and abs(r - 1) < 1e-9:
            rel_w = rel  # nothing to warp: replay the recording exactly
        else:
            # Warp a continuous version of the path and round once. Rotating or scaling whole-pixel
            # positions and rounding again would quantize twice, and stretching time by repeating
            # or dropping 1 ms samples would leave gaps that real fast motion never has.
            fc = self.cfg.get("warp_lowpass_hz", 0)
            src = rel
            if fc and len(rel) >= 30:
                src = sosfiltfilt(butter(2, fc, fs=1000.0, output="sos"), rel, axis=0, padlen=min(len(rel) - 1, 300))
            ts = old_t(np.arange(K_new))
            grid = np.arange(len(rel))
            cont = np.column_stack([np.interp(ts, grid, src[:, 0]), np.interp(ts, grid, src[:, 1])])
            rel_w = scale * (cont @ np.array([[c, s], [-s, c]]))
        start = np.array(cond.start, float)
        path = start + rel_w
        w, h = cond.screen
        if path[:, 0].min() < 0 or path[:, 1].min() < 0 or path[:, 0].max() > w - 1 or path[:, 1].max() > h - 1:
            path = clamp_path(start, np.diff(path, axis=0), cond.screen)
        pos = to_pixels(path, cond.screen)
        new_clicks = np.column_stack([new_t(clicks[:, 0]), new_t(clicks[:, 1])])
        new_clicks[:, 1] = np.minimum(new_clicks[:, 1], K_new - 1)
        tl = Timeline(pos=pos, clicks=new_clicks, target=cond.target, screen=cond.screen)
        if check and not np.array_equal(tl.click_hit, clicks[:, 2].astype(bool)):
            return None  # warping would turn a hit into a miss or the other way round
        tl.meta = {"source": lib.keys[i], "rotation_deg": math.degrees(rot), "scale": scale, "time_scale": r}
        return tl

    # ------------------------------------------------------------------ generate

    def generate(self, cond: TrialConditions, rng) -> Timeline:
        lib = self.lib
        q = self.conditions(cond)
        dist, ok = self.distances(q)
        self.stats["queries"] += 1
        low = not ok.any()
        if low and self.fallback is not None:
            self.stats["fallback"] += 1
            tl = self.fallback.generate(cond, rng)
            tl.meta = {**getattr(tl, "meta", {}), "fallback": True}
            return tl
        if low:
            self.stats["low_coverage"] += 1
            cand = np.arange(len(lib))
        else:
            self.stats["qualified"] += 1
            cand = np.flatnonzero(ok)
        cand = cand[np.isfinite(dist[cand])]
        order = cand[np.argsort(dist[cand], kind="stable")]
        if len(order) > 1:
            order = order[order != self.last]
        k = self.cfg["top_k"]
        tau = self.cfg["similarity_tau"]
        pool = list(order[: 6 * k])
        while pool:
            top = np.array(pool[:k])
            wts = np.exp(-(dist[top] - dist[top].min()) / tau)
            i = int(top[rng.choice(len(top), p=wts / wts.sum())])
            tl = self.warp(i, cond, q)
            if tl is not None:
                self.last = i
                tl.meta["low_coverage"] = low
                tl.meta["distance"] = float(dist[i])
                return tl
            self.stats["skipped_inconsistent"] += 1
            pool.remove(i)
        # Nothing stays consistent after warping: replay the closest one anyway.
        i = int(order[0])
        tl = self.warp(i, cond, q, check=False)
        tl.meta["low_coverage"] = True
        tl.meta["distance"] = float(dist[i])
        self.last = i
        return tl
