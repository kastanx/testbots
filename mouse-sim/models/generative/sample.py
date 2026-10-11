"""Generating whole trials with the trained generative model (Python reference; the simulator runs
the same steps in web/src/shared/models/generative.ts with the exported ONNX network).

    reaction      a real reaction phase (duration + drift) from the owner's bank, by target size
    movement      flow-matching sample: canonical path + log duration + where it ends relative to the
                  target; the path is bent onto that end point, mapped onto the screen, resampled on
                  the 1 ms grid, low-passed, rounded to whole pixels once, clamped like a real cursor
    pause, click  a real pause before clicking (duration + drift) and a real click hold (+ slip)
    misses        a press outside the target is a miss: re-react, then an after_miss movement and
                  another click, up to max_attempts
"""
from __future__ import annotations

import math

import numpy as np
import torch
from scipy.signal import butter, sosfiltfilt

from pipeline import config, geometry
from pipeline.timeline import Timeline

from ..base import Model, TrialConditions, clamp_path, to_pixels
from . import data
from .train import load


def fit_end(pts: np.ndarray, start: np.ndarray, goal: np.ndarray, cfg: dict) -> np.ndarray:
    """Pin the path to the cursor at onset and make it end on the predicted end point.

    The network's first point is never exactly the start; pinning it there in one step would be a
    1 ms jump (a speed spike real movements don't have), so the offset fades out over the first
    start_ramp of the movement. For the end, "similarity" rotates and scales the whole path about its
    start (shape and speed profile stay the same); "ramp" bends the last part of it; "none" leaves it.
    Similarity falls back to the ramp when the path barely leaves its start."""
    tau = np.linspace(0, 1, len(pts))
    r = cfg.get("start_ramp", 0.15)
    u = np.clip(tau / r, 0, 1) if r > 0 else np.ones_like(tau)
    pts = pts - np.outer(1 - u * u * (3 - 2 * u), pts[0] - start)
    mode = cfg.get("end_fit", "similarity")
    if mode == "none":
        return pts
    a = pts[-1] - start
    b = goal - start
    na, nb = float(np.hypot(*a)), float(np.hypot(*b))
    if mode == "similarity" and na > 5.0 and nb > 0.5 * na:
        k = nb / na
        ang = math.atan2(b[1], b[0]) - math.atan2(a[1], a[0])
        c, s = math.cos(ang), math.sin(ang)
        return start + k * ((pts - start) @ np.array([[c, s], [-s, c]]))
    r0 = cfg["end_ramp_start"]
    u = np.clip((tau - r0) / (1 - r0), 0, 1)
    return pts + np.outer(u * u * (3 - 2 * u), goal - pts[-1])


class GenerativeModel(Model):
    name = "generative"
    version = "2"

    def __init__(self, run_dir: str | None = None, cfg: dict | None = None, device: str | None = None):
        self.run_dir = run_dir
        self.cfg_sampling = cfg or config.generative()
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")

    def fit(self, ds) -> "GenerativeModel":
        self.net, self.cfg, self.norm = load(self.run_dir, self.device)
        self.banks = data.build_banks(ds, include_warmup=self.cfg_sampling.get("include_warmup", False))
        self._tm = torch.tensor(np.array(self.norm["traj_mean"], np.float32), device=self.device)
        self._cm = np.array(self.norm["cond_mean"], np.float32)
        self._cs = np.array(self.norm["cond_std"], np.float32)
        self._sess = None
        if self.cfg["session_embedding"]:
            self._sess = torch.tensor([len(self.cfg["sessions"]) - 1], device=self.device)  # most recent
        return self

    def describe(self) -> dict:
        return {"name": self.name, "version": self.version, "run": self.cfg.get("run_dir"),
                "step": self.cfg.get("ckpt_step"), "params": self.cfg.get("params"), **self.cfg_sampling}

    # ------------------------------------------------------------------ pieces

    @torch.no_grad()
    def sample_movements(self, conds: np.ndarray, noise: np.ndarray):
        """Integrate from noise (B, 5, 256) to (paths (B, 256, 2), log durations (B,), ends (B, 2))."""
        c = torch.tensor((conds - self._cm) / self._cs, dtype=torch.float32, device=self.device)
        x = torch.tensor(noise, dtype=torch.float32, device=self.device)
        s = self._sess.expand(len(x)) if self._sess is not None else None
        steps = self.cfg_sampling["steps"]
        dt = 1.0 / steps
        for i in range(steps):
            t = torch.full((len(x),), i * dt, device=self.device)
            v = self.net(x, t, c, s)
            if self.cfg_sampling["sampler"] == "heun" and i < steps - 1:
                x2 = x + dt * v
                v = 0.5 * (v + self.net(x2, t + dt, c, s))
            x = x + dt * v
        n = self.norm
        tsd = torch.tensor(n["traj_std"], device=self.device)[None, :, None]
        traj = x[:, :2] * tsd + self._tm[None]
        logdur = x[:, 2].mean(dim=1) * n["logdur_std"] + n["logdur_mean"]
        end = x[:, 3:5].mean(dim=2) * torch.tensor(n["end_std"], device=self.device) + torch.tensor(n["end_mean"], device=self.device)
        return traj.permute(0, 2, 1).cpu().numpy(), logdur.cpu().numpy(), end.cpu().numpy()

    def movement_path(self, traj: np.ndarray, dur: float, end: np.ndarray, start, target, screen) -> np.ndarray:
        """Canonical path -> whole-pixel positions at t = 0, 1, ... K ms after onset."""
        txy = (target.cx, target.cy)
        K = max(int(round(dur)), 1)
        pts = data.to_screen(traj, start, txy)
        # bend the path onto the predicted end point (target-size units -> px)
        rot, _, _, theta = data.frame(start, txy)
        along, across = (float(v) for v in geometry.sizes_along_across(target.shape, target.w, target.h, math.radians(theta)))
        goal = np.array(txy) + rot @ np.array([end[0] * max(along, 1.0), end[1] * max(across, 1.0)])
        pts = fit_end(pts, np.asarray(start, float), goal, self.cfg_sampling)
        ts = np.linspace(0, K, data.N_POINTS)
        grid = np.arange(K + 1)
        path = np.column_stack([np.interp(grid, ts, pts[:, 0]), np.interp(grid, ts, pts[:, 1])])
        fc = self.cfg_sampling["lowpass_hz"]
        if fc and len(path) >= 30:
            path = sosfiltfilt(butter(2, fc, fs=1000.0, output="sos"), path, axis=0, padlen=min(len(path) - 1, 300))
        path[0] = start
        return to_pixels(clamp_path(start, np.diff(path, axis=0), screen), screen)

    def _bank(self, name: str, si: int, rng):
        b = self.banks[name][si]
        return b[rng.integers(len(b))]

    def _size_bin(self, cond: TrialConditions) -> int:
        tgt = cond.target
        th0 = math.atan2(tgt.cy - cond.start[1], tgt.cx - cond.start[0])
        return int(geometry.size_bin(geometry.chord(tgt.shape, tgt.w, tgt.h, th0)))

    def _cond(self, cur, cond: TrialConditions, after_miss: bool) -> np.ndarray:
        tgt = cond.target
        _, _, D, theta = data.frame(cur, (tgt.cx, tgt.cy))
        along, across = (float(v) for v in geometry.sizes_along_across(tgt.shape, tgt.w, tgt.h, math.radians(theta)))
        return data.cond_vector(D, theta, along, across, tgt.shape == "rect", cur[0] / cond.screen[0],
                                cur[1] / cond.screen[1], after_miss)

    def _reaction(self, cond: TrialConditions, rng):
        rt, drift = self._bank("reaction", self._size_bin(cond), rng)
        return rt, np.array(cond.start, float).astype(np.int32) + data.expand(drift, rt)

    def _noise(self, rng, n: int = 1) -> np.ndarray:
        return rng.standard_normal((n, data.IN_CHANNELS, data.N_POINTS))

    # ------------------------------------------------------------------ generate

    def _finish(self, cond: TrialConditions, rng, rt: int, reaction: np.ndarray, first) -> Timeline:
        """Assemble a trial from its reaction phase and first sampled movement; misses get
        after_miss corrections sampled one at a time."""
        tgt = cond.target
        si = self._size_bin(cond)
        chunks = [reaction]
        cur = reaction[-1].astype(float)
        t = rt
        clicks = []
        for attempt in range(self.cfg_sampling["max_attempts"]):
            if attempt == 0 and first is not None:
                traj, logdur, end = first
            else:
                tr, ld, en = self.sample_movements(self._cond(cur, cond, attempt > 0)[None], self._noise(rng))
                traj, logdur, end = tr[0], ld[0], en[0]
            path = self.movement_path(traj, float(np.exp(logdur)), end, cur, tgt, cond.screen)
            chunks.append(path[1:])
            t += len(path) - 1
            stop = path[-1]
            dwell, drift = self._bank("dwell" if attempt == 0 else "dwell_after_miss", si, rng)
            k_dwell = max(int(round(dwell)), 0)
            pause = stop + data.expand(drift, k_dwell)
            chunks.append(pause[1:])
            t_down = t + k_dwell
            down_xy = pause[-1].astype(float)
            hold, slip = self._bank("click", si, rng)
            k_hold = max(int(round(hold)), 1)
            hold_path = down_xy.astype(np.int32) + data.expand(slip, k_hold)
            chunks.append(hold_path[1:])
            clicks.append((float(t_down), float(t_down + k_hold)))
            t = t_down + k_hold
            cur = hold_path[-1].astype(float)
            if tgt.contains(down_xy[0], down_xy[1]):
                break
            rr, d2 = self._bank("after_miss", si, rng)
            if rr > 0:
                chunks.append(cur.astype(np.int32) + data.expand(d2, rr)[1:])
                cur = chunks[-1][-1].astype(float)
            t += rr
        pos = np.concatenate(chunks)
        pos[:, 0] = np.clip(pos[:, 0], 0, cond.screen[0] - 1)
        pos[:, 1] = np.clip(pos[:, 1], 0, cond.screen[1] - 1)
        return Timeline(pos=pos, clicks=np.array(clicks), target=tgt, screen=cond.screen)

    def generate(self, cond: TrialConditions, rng) -> Timeline:
        rt, reaction = self._reaction(cond, rng)
        return self._finish(cond, rng, rt, reaction, None)

    def generate_batch(self, conds: list, rng, chunk: int = 512) -> list:
        """Same as generate() for many trials, with the first movements sampled in batches."""
        react = [self._reaction(c, rng) for c in conds]
        C = np.stack([self._cond(r[1][-1].astype(float), c, False) for c, r in zip(conds, react)])
        noise = self._noise(rng, len(conds))
        out = [[], [], []]
        for i in range(0, len(conds), chunk):
            for lst, arr in zip(out, self.sample_movements(C[i:i + chunk], noise[i:i + chunk])):
                lst.append(arr)
        trajs, lds, ends = (np.concatenate(a) for a in out)
        return [self._finish(c, rng, rt, rea, (trajs[i], lds[i], ends[i])) for i, (c, (rt, rea)) in enumerate(zip(conds, react))]
