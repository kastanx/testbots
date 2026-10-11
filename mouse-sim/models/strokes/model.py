"""Stroke model: new movements, not replays.

    reaction      a real reaction phase (duration + drift) from the owner's bank, by target size
    movement      1. the owner's recorded movements nearest the request (distance, direction, target
                     size, start position - motion matching's weights) are the candidates; one is the
                     template, picked at random, weighted by similarity
                  2. its strokes are scaled to the new distance and to Fitts-predicted time, and its main
                     stroke - size, speed, timing, curve - is redrawn around the template from the
                     spread of the candidates' main strokes (a smoothed bootstrap), so it's a movement
                     the owner could have made but didn't
                  3. where it ends is drawn the same way from the candidates' own endings (in
                     target-size units), and the corrections - the strokes after the main one - are
                     re-aimed so the movement ends there (no corrections: the main stroke is)
                  4. the strokes are integrated on the 1 ms grid (a smooth plan), and the hand texture of
                     another candidate, stretched to the new duration, is added: rounded to whole pixels
                     once, clamped like a real cursor
    pause, click  a real pause before clicking (duration + drift) and a real click hold (+ slip)
    misses        a press outside the target is a miss: re-react, then another movement and click,
                  up to max_attempts

To try it (it isn't registered with the server or the harness):

    from models.strokes.model import StrokeModel
    model = StrokeModel().fit(Dataset())
    timeline = model.generate(TrialConditions(start, target, screen), np.random.default_rng())
"""
from __future__ import annotations

import math

import numpy as np

from pipeline import config, geometry
from pipeline.features import predicted_mt
from pipeline.timeline import Timeline

from ..base import Model, TrialConditions, clamp_path, to_pixels
from ..generative import data as banks_mod
from ..motion_matching.library import angle_diff
from . import library as libmod
from . import lognormal

# The defaults are what scored best on a held-out session (README.md in this folder has the numbers);
# the other choices are kept for trying.
DEFAULTS = {
    "include_warmup": True,
    "plan_hz": 10.0,             # strokes are fitted to the movement below this
    "texture_hz": [0.0, 60.0],   # the texture carried over: all the strokes don't explain, up to here
                                 # (above: pixel-rounding noise, which rounding the new path recreates)
    "top_k": 16,                 # candidates per request
    "similarity_tau": 0.5,       # how much nearer candidates are preferred (motion matching: 0.15)
    "variation": "interpolate",  # "interpolate": part of the way toward another candidate's main stroke
                                 # and ending - a real difference, so what varies together in the owner's
                                 # movements varies together here; "kde": independent random redraws
                                 # (a smoothed bootstrap), which cost more realism for the same novelty
    "lam_max": 1.0,              # interpolate: at most this far toward the other candidate (uniform)
    "bandwidth": 0.6,            # kde: kernel width in candidate standard deviations
    "perturb": ["size", "direction", "turn", "end"],   # what varies: the main stroke's size, direction
                                 # and curve, and where it ends; "time" and "sigma" can be added, but
                                 # they cost the most realism
    "reaim": "similarity",       # who makes up for a different ending: "corrections" (the strokes after
                                 # the main one), "similarity" (the whole plan, scaled and turned as one),
                                 # or "mixed" (half each)
    "max_correction_scale": 2.5, # a correction may grow at most this much when re-aimed
    "end_at": "template",        # the movement stops when the template stopped (stretched in time like
                                 # it); "rest": when the stroke plan comes to rest (below end_speed)
    "end_speed": 0.02,
    "texture_from": "template",  # whose texture: the template's own, or "candidate" (any of them)
    "texture_scale": 1.0,
    "texture_warp": True,        # stretch the texture in time with the movement (else: real time)
    "max_attempts": 4,
}
FEATURES = ["size", "time", "sigma", "direction", "turn"]
# A recording whose strokes add up to more than this times the distance the hand travelled is
# explained by strokes cancelling each other: varying one of them would undo that. Such a recording
# is still used, but as it is - its strokes aren't varied, and nothing is varied toward it.
RIGID_RATIO = 1.5

# What can vary of the main stroke: log(size / distance), log(peak time / Fitts time), log(sigma),
# its mean direction against the target's, and how much it turns.
N_FEAT = 5


def _primary(P: np.ndarray) -> int:
    return int(np.argmax(P[:, 0]))


def _features(P: np.ndarray, D: float, mt_pred: float) -> np.ndarray:
    j = _primary(P)
    p = P[j]
    peak = max(lognormal.mode_time(p), 5.0)
    return np.array([math.log(max(p[0], 0.05) / max(D, 1.0)), math.log(peak / max(mt_pred, 50.0)),
                     math.log(p[3]), 0.5 * (p[4] + p[5]), p[5] - p[4]])


def _retarget(p: np.ndarray, have: np.ndarray, want: np.ndarray) -> np.ndarray:
    """The stroke scaled and turned so the distance it covers (`have` by some time) becomes `want`;
    its curve and timing stay."""
    p = p.copy()
    lc, ln = float(np.hypot(*have)), float(np.hypot(*want))
    if lc < 1e-6:
        return p
    p[0] = max(p[0] * ln / lc, 0.05)
    turn = math.atan2(want[1], want[0]) - math.atan2(have[1], have[0])
    p[4] += turn
    p[5] += turn
    return p


def similarity(P: np.ndarray, goal: np.ndarray, T: float) -> np.ndarray:
    """The whole plan scaled and turned about its start so it has covered `goal` by time T."""
    P = P.copy()
    have = np.sum([lognormal.contribution(p, T) for p in P], axis=0)
    lh, lg = float(np.hypot(*have)), float(np.hypot(*goal))
    if lh < 1e-6:
        return P
    P[:, 0] *= lg / lh
    turn = math.atan2(goal[1], goal[0]) - math.atan2(have[1], have[0])
    P[:, 4] += turn
    P[:, 5] += turn
    return P


def reaim(P: np.ndarray, goal: np.ndarray, max_scale: float, T: float, how: str = "corrections") -> np.ndarray:
    """Make the strokes have covered `goal` by time T. "corrections": the strokes peaking after the main
    one take the difference, each in proportion to its size, as far as they can grow, and the main
    stroke takes the rest; "similarity": the whole plan is scaled and turned as one; "mixed": the
    plan as one goes half way, the corrections do the rest."""
    if how == "similarity":
        return similarity(P, goal, T)
    if how == "mixed":
        have = np.sum([lognormal.contribution(p, T) for p in P], axis=0)
        P = similarity(P, have + 0.5 * (goal - have), T)
    P = P.copy()
    j = _primary(P)
    have = [lognormal.contribution(p, T) for p in P]
    delta = goal - np.sum(have, axis=0)
    later = [k for k in range(len(P)) if k != j and lognormal.mode_time(P[k]) > lognormal.mode_time(P[j])
             and float(np.hypot(*have[k])) > 0.5]
    if later:
        sizes = np.array([float(np.hypot(*have[k])) for k in later])
        share = sizes / sizes.sum()
        for k, w in zip(later, share):
            c = have[k]
            want = c + w * delta
            lc = float(np.hypot(*c))
            lw = float(np.hypot(*want))
            if lw > max_scale * max(lc, 2.0):   # too much for this correction: it grows only so far
                want = c + (w * delta) * (max_scale * max(lc, 2.0) - lc) / max(lw - lc, 1e-9)
            P[k] = _retarget(P[k], c, want)
        have = [lognormal.contribution(p, T) for p in P]
        delta = goal - np.sum(have, axis=0)
    if float(np.hypot(*delta)) > 1e-6:
        P[j] = _retarget(P[j], have[j], have[j] + delta)
    return P


class StrokeModel(Model):
    name = "strokes"
    version = "1"

    def __init__(self, cfg: dict | None = None, role: str = "train", workers: int | None = None, cache: bool = True):
        self.cfg = {**DEFAULTS, **(cfg or {})}
        self.role = role
        self.workers = workers
        self.cache = cache
        self.last = -1

    def fit(self, ds, log=None) -> "StrokeModel":
        c = self.cfg
        self.lib = libmod.build(ds, role=self.role, include_warmup=c["include_warmup"], plan_hz=c["plan_hz"],
                                texture_hz=tuple(c["texture_hz"]), workers=self.workers, cache=self.cache, log=log)
        self.banks = banks_mod.build_banks(ds, role=self.role, include_warmup=c["include_warmup"])
        self.fitts = ds.fitts
        self.weights = config.motion_matching()["weights"]
        lib = self.lib
        self.mt_pred = np.array([self._mt(d, a) for d, a in zip(lib.D, lib.along)])
        self.feats = np.array([_features(P, d, m) for P, d, m in zip(lib.strokes, lib.D, self.mt_pred)])
        self.rigid = np.array([P[:, 0].sum() > RIGID_RATIO * max(tr, 1.0) for P, tr in zip(lib.strokes, lib.travelled)])
        return self

    def describe(self) -> dict:
        return {"name": self.name, "version": self.version, "library": len(self.lib),
                "median_fit_snr_db": float(np.median(self.lib.snr)), **self.cfg}

    def _mt(self, D, along) -> float:
        return max(float(predicted_mt(self.fitts, D, max(along, 1.0))), 50.0)

    # ------------------------------------------------------------------ candidates

    def _candidates(self, D, theta_deg, along, across, shape, start_rel):
        lib, w = self.lib, self.weights
        dist = (w["log_distance"] * np.abs(np.log(lib.D / D)) + w["direction_rad"] * np.abs(np.radians(angle_diff(lib.theta, theta_deg)))
                + w["log_size_along"] * np.abs(np.log(lib.along / along)) + w["log_size_across"] * np.abs(np.log(lib.across / across))
                + w["start"] * np.hypot(*(lib.start_rel - start_rel).T) + w["shape"] * (lib.shape != shape))
        order = np.argsort(dist, kind="stable")[: self.cfg["top_k"]]
        wts = np.exp(-(dist[order] - dist[order].min()) / self.cfg["similarity_tau"])
        return order, wts / wts.sum()

    # ------------------------------------------------------------------ movement

    def movement(self, cur, target, screen, rng, info: dict | None = None) -> np.ndarray:
        """Whole-pixel positions, onset -> the cursor's last stop, starting at `cur`."""
        lib, c = self.lib, self.cfg
        cur = np.asarray(cur, float)
        dx, dy = target.cx - cur[0], target.cy - cur[1]
        D = max(math.hypot(dx, dy), 1.0)
        th = math.atan2(dy, dx)
        theta_deg = math.degrees(th) % 360.0
        along, across = (max(float(v), 1.0) for v in geometry.sizes_along_across(target.shape, target.w, target.h, th))
        shape = 1 if target.shape == "rect" else 0
        idx, wts = self._candidates(D, theta_deg, along, across, shape, cur / np.asarray(screen, float))
        if len(idx) > 1 and self.last in idx:
            keep = idx != self.last
            idx, wts = idx[keep], wts[keep] / wts[keep].sum()
        i = int(rng.choice(idx, p=wts))
        self.last = i

        # 2. scale the template, redraw its main stroke from the candidates' spread
        h = c["bandwidth"]
        F = self.feats[idx]
        mask = np.array([1.0 if f in c["perturb"] and not self.rigid[i] else 0.0 for f in FEATURES])
        if c["variation"] == "interpolate":
            # toward another candidate that ended the same way (hit or miss), so misses stay as common
            same = (idx != i) & (lib.hit[idx] == lib.hit[i]) & ~self.rigid[idx]
            if not same.any():
                same = (idx != i) & ~self.rigid[idx]
            if not same.any():
                same = idx != i
            others = idx[same]
            pb = wts[same] / wts[same].sum() if same.any() else wts
            b = int(rng.choice(others, p=pb)) if len(others) else i
            lam = float(rng.uniform(0.0, c["lam_max"]))
            d = lam * (self.feats[b] - self.feats[i]) * mask
        else:
            m, sd = F.mean(axis=0), F.std(axis=0) + 1e-6
            f_new = m + (self.feats[i] - m + h * sd * rng.standard_normal(N_FEAT)) / math.sqrt(1 + h * h)
            d = (f_new - self.feats[i]) * mask
        mt_new = self._mt(D, along)
        tempo = mt_new / self.mt_pred[i] * math.exp(d[1])
        P = lib.strokes[i].copy()
        P[:, 0] *= D / lib.D[i]
        P[:, 1] *= tempo
        P[:, 2] += math.log(tempo)
        j = _primary(P)
        P[j, 0] *= math.exp(d[0])
        s_old = P[j, 3]
        s_new = float(np.clip(s_old * math.exp(d[2]), lognormal.LO[3], lognormal.HI[3]))
        P[j, 2] += s_new ** 2 - s_old ** 2          # keeps the stroke's peak time
        P[j, 3] = s_new
        P[j, 4] += d[3] - d[4] / 2
        P[j, 5] += d[3] + d[4] / 2

        # 3. where it ends, and the corrections re-aimed to get there
        E = lib.end[idx]
        em, esd = E.mean(axis=0), E.std(axis=0) + 1e-6
        if "end" not in c["perturb"] or not lib.hit[i]:
            e = lib.end[i].copy()          # a miss stays the miss it was
        elif c["variation"] == "interpolate":
            e = lib.end[i] + lam * (lib.end[b] - lib.end[i])
        else:
            e = em + (lib.end[i] - em + h * esd * rng.standard_normal(2)) / math.sqrt(1 + h * h)
        rot = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
        if lib.hit[i]:
            for _ in range(20):    # it hit: so does this one
                gx, gy = cur + rot @ np.array([D + e[0] * along, e[1] * across])
                if target.contains(gx, gy):
                    break
                e *= 0.8
        goal = np.array([D + e[0] * along, e[1] * across])
        # It stops where the plan comes to rest (slower than the pipeline's stop speed for good) -
        # looked for up to 200 ms past when the template stopped, stretched like its strokes - and
        # the strokes are aimed so it is at the goal then. The movement ends there.
        k_tpl = max(int(round(lib.mt[i] * tempo)), 10)
        k_end = k_tpl
        p0 = np.zeros(2)
        for _ in range(3 if c["end_at"] == "rest" else 1):
            P = reaim(P, goal + p0, c["max_correction_scale"], k_end, c["reaim"])
            p0 = lognormal.position(np.array([0.0]), P)[0]   # the plan starts at the onset
            if c["end_at"] == "rest":
                t = np.arange(0, k_tpl + 201, dtype=float)
                spd = np.hypot(*lognormal.velocity(t, P).T)
                moving = np.flatnonzero(spd >= c["end_speed"])
                k_end = max(int(moving[-1]) + 1 if len(moving) else 10, 10)
        P = reaim(P, goal + p0, c["max_correction_scale"], k_end, c["reaim"])
        p0 = lognormal.position(np.array([0.0]), P)[0]
        t = np.arange(0, k_end + 1, dtype=float)
        plan = lognormal.position(t, P) - p0

        # 4. the texture
        dn = i if c["texture_from"] == "template" else int(rng.choice(idx))
        tex = lib.texture[dn]
        if c["texture_warp"]:
            td = np.arange(k_end + 1) * (len(tex) - 1) / k_end
        else:      # tremor keeps its frequency: real time, mirrored on if the movement is longer
            n = len(tex) - 1
            k = np.arange(k_end + 1) % (2 * n) if n > 0 else np.zeros(k_end + 1, int)
            td = np.where(k <= n, k, 2 * n - k).astype(float)
        tx = np.column_stack([np.interp(td, np.arange(len(tex)), tex[:, 0]), np.interp(td, np.arange(len(tex)), tex[:, 1])])
        tx *= c["texture_scale"]
        if c["texture_hz"][0] > 0:
            # band-passed texture: faded in and out, it carries no drift of its own
            ramp = np.ones(k_end + 1)
            a, b = min(15, k_end // 4), min(25, k_end // 3)
            if a > 0:
                u = np.arange(a) / a
                ramp[:a] = u * u * (3 - 2 * u)
            if b > 0:
                u = np.arange(b)[::-1] / b
                ramp[-b:] = u * u * (3 - 2 * u)
            tx *= ramp[:, None]
        else:
            # everything the strokes don't explain, slow drift included: the strokes are aimed short
            # of the goal by where the texture ends, so the two together end on it
            P = reaim(P, goal + p0 - tx[-1], c["max_correction_scale"], k_end, c["reaim"])
            p0 = lognormal.position(np.array([0.0]), P)[0]
            plan = lognormal.position(t, P) - p0
        path = cur + (plan + tx) @ rot.T
        path[0] = cur
        if info is not None:
            info.update({"template": lib.keys[i], "texture_from": lib.keys[dn], "strokes": len(P),
                         "tempo": tempo, "end": e.tolist(), "change": dict(zip(FEATURES, np.round(d, 3).tolist()))})
            if c["variation"] == "interpolate":
                info.update({"toward": lib.keys[b], "lam": round(lam, 3)})
        return to_pixels(clamp_path(cur, np.diff(path, axis=0), screen), screen)

    # ------------------------------------------------------------------ trials

    def _bank(self, name: str, si: int, rng):
        b = self.banks[name][si]
        return b[rng.integers(len(b))]

    def _size_bin(self, cond: TrialConditions) -> int:
        tgt = cond.target
        th0 = math.atan2(tgt.cy - cond.start[1], tgt.cx - cond.start[0])
        return int(geometry.size_bin(geometry.chord(tgt.shape, tgt.w, tgt.h, th0)))

    def generate(self, cond: TrialConditions, rng) -> Timeline:
        tgt = cond.target
        si = self._size_bin(cond)
        rt, drift = self._bank("reaction", si, rng)
        reaction = np.array(cond.start, float).astype(np.int32) + banks_mod.expand(drift, rt)
        chunks = [reaction]
        cur = reaction[-1].astype(float)
        t = rt
        clicks = []
        meta = []
        for attempt in range(self.cfg["max_attempts"]):
            info: dict = {}
            path = self.movement(cur, tgt, cond.screen, rng, info)
            meta.append(info)
            chunks.append(path[1:])
            t += len(path) - 1
            stop = path[-1]
            dwell, d2 = self._bank("dwell" if attempt == 0 else "dwell_after_miss", si, rng)
            k_dwell = max(int(round(dwell)), 0)
            pause = stop + banks_mod.expand(d2, k_dwell)
            chunks.append(pause[1:])
            t_down = t + k_dwell
            down_xy = pause[-1].astype(float)
            hold, slip = self._bank("click", si, rng)
            k_hold = max(int(round(hold)), 1)
            hold_path = down_xy.astype(np.int32) + banks_mod.expand(slip, k_hold)
            chunks.append(hold_path[1:])
            clicks.append((float(t_down), float(t_down + k_hold)))
            t = t_down + k_hold
            cur = hold_path[-1].astype(float)
            if tgt.contains(down_xy[0], down_xy[1]):
                break
            rr, d3 = self._bank("after_miss", si, rng)
            if rr > 0:
                chunks.append(cur.astype(np.int32) + banks_mod.expand(d3, rr)[1:])
                cur = chunks[-1][-1].astype(float)
            t += rr
        pos = np.concatenate(chunks)
        pos[:, 0] = np.clip(pos[:, 0], 0, cond.screen[0] - 1)
        pos[:, 1] = np.clip(pos[:, 1], 0, cond.screen[1] - 1)
        tl = Timeline(pos=pos, clicks=np.array(clicks), target=tgt, screen=cond.screen)
        tl.meta = {"movements": meta}
        return tl
