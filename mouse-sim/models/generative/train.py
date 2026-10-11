"""Train the generative model (conditional flow matching).

    python -m models.generative train [--data DIR] [--steps 30000] [--session-embedding]

x1 = a real movement (normalised), x0 ~ N(0, I), x_t = (1 - t) x0 + t x1; the network predicts the
velocity x1 - x0. Sampling integrates from noise to data with plain Euler steps. No classifier-free
guidance and no lowered temperature: both make samples more "typical", which averages away the
owner's quirks. Checkpoints go to models/generative/runs/<timestamp>/ (runs/latest.txt points at the
newest); validation sessions pick the best EMA checkpoint.
"""
from __future__ import annotations

import copy
import json
import math
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import torch

from pipeline import config, paths
from pipeline.dataset import Dataset

from . import data
from .net import UNet1D, count_params

RUNS = paths.GEN_RUNS


def normaliser(ts: data.TrainingSet) -> dict:
    return {
        "traj_mean": ts.X.mean(axis=0).tolist(),                       # (2, 256)
        "traj_std": [float(ts.X[:, 0].std()), float(ts.X[:, 1].std())],
        "logdur_mean": float(ts.logdur.mean()), "logdur_std": float(ts.logdur.std()),
        "end_mean": ts.end.mean(axis=0).tolist(), "end_std": (ts.end.std(axis=0) + 1e-6).tolist(),
        "cond_mean": ts.C.mean(axis=0).tolist(), "cond_std": (ts.C.std(axis=0) + 1e-6).tolist(),
    }


def to_tensors(ts: data.TrainingSet, norm: dict):
    tm = np.array(norm["traj_mean"], np.float32)
    tsd = np.array(norm["traj_std"], np.float32)[:, None]
    X = (ts.X - tm[None]) / tsd[None]
    ones = np.ones((1, 1, data.N_POINTS), np.float32)
    L = ((ts.logdur - norm["logdur_mean"]) / norm["logdur_std"])[:, None, None] * ones
    E = ((ts.end - np.array(norm["end_mean"], np.float32)) / np.array(norm["end_std"], np.float32))[:, :, None] * ones
    x1 = np.concatenate([X, L, E], axis=1).astype(np.float32)
    c = ((ts.C - np.array(norm["cond_mean"], np.float32)) / np.array(norm["cond_std"], np.float32)).astype(np.float32)
    return torch.tensor(x1), torch.tensor(c), torch.tensor(ts.session)


class SessionCond(torch.nn.Module):
    """Network + optional per-session embedding appended to the condition vector."""

    def __init__(self, cond_dim: int, n_sessions: int, sess_dim: int, **kw):
        super().__init__()
        self.sess_dim = sess_dim
        self.net = UNet1D(cond_dim + sess_dim, in_ch=data.IN_CHANNELS, **kw)
        self.sess = torch.nn.Embedding(max(n_sessions, 1), sess_dim) if sess_dim else None

    def forward(self, x, t, c, s=None):
        if self.sess is not None:
            c = torch.cat([c, self.sess(s)], dim=1)
        return self.net(x, t, c)


def fm_loss(model, x1, c, s, gen=None):
    x0 = torch.randn(x1.shape, device=x1.device, generator=gen)
    t = torch.rand(x1.shape[0], device=x1.device, generator=gen)
    xt = (1 - t)[:, None, None] * x0 + t[:, None, None] * x1
    v = model(xt, t, c, s)
    return torch.mean((v - (x1 - x0)) ** 2)


def train(root=None, steps: int = 30000, batch: int = 256, lr: float = 3e-4, base: int = 32, mults=(1, 2, 4, 8),
          session_embedding: int = 0, seed: int = 0, log=print, out_dir: Path | None = None) -> Path:
    torch.manual_seed(seed)
    np.random.seed(seed)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    ds = Dataset(root)
    tr = data.build(ds, "train", include_warmup=config.generative().get("include_warmup", False))
    va = data.build(ds, "val")
    if len(tr.X) < 100:
        raise SystemExit(f"only {len(tr.X)} training movements; record more sessions first")
    norm = normaliser(tr)
    x1, c, s = (t.to(dev) for t in to_tensors(tr, norm))
    if len(va.X):
        vx1, vc, _ = (t.to(dev) for t in to_tensors(va, norm))
        vs = torch.full((len(va.X),), len(tr.sessions) - 1, dtype=torch.long, device=dev)
    torch.backends.cudnn.benchmark = True
    model = SessionCond(c.shape[1], len(tr.sessions), session_embedding, base=base, mults=tuple(mults)).to(dev)
    ema = copy.deepcopy(model).eval()
    for p in ema.parameters():
        p.requires_grad_(False)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    warm = 500
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda k: min(1.0, (k + 1) / warm) * (0.03 + 0.97 * 0.5 * (1 + math.cos(math.pi * min(k / steps, 1.0)))))
    run = out_dir or RUNS / datetime.now().strftime("%Y%m%d-%H%M%S")
    run.mkdir(parents=True, exist_ok=True)
    cfg = {"steps": steps, "batch": batch, "lr": lr, "base": base, "mults": list(mults), "session_embedding": session_embedding,
           "seed": seed, "n_train": int(len(tr.X)), "n_val": int(len(va.X)), "sessions": tr.sessions,
           "params": count_params(model), "data_root": str(ds.root), "cond_names": data.COND_NAMES,
           "n_points": data.N_POINTS, "d_min": data.D_MIN, "in_ch": data.IN_CHANNELS,
           "representation": "onset->last stop, log duration, end offset in target units"}
    (run / "config.json").write_text(json.dumps(cfg, indent=2))
    (run / "norm.json").write_text(json.dumps(norm))
    log(f"training on {len(tr.X)} movements ({len(va.X)} validation), {cfg['params'] / 1e6:.1f} M parameters, {dev}")
    gen = torch.Generator(device=dev).manual_seed(seed)
    vgen = torch.Generator(device=dev)
    best = math.inf
    hist = []
    t0 = time.time()
    n = len(x1)
    use_amp = dev == "cuda"
    for step in range(1, steps + 1):
        idx = torch.randint(0, n, (min(batch, n),), device=dev, generator=gen)
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=use_amp):
            loss = fm_loss(model, x1[idx], c[idx], s[idx], gen)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        with torch.no_grad():
            d = min(0.999, (1 + step) / (10 + step))
            for pe, pm in zip(ema.parameters(), model.parameters()):
                pe.mul_(d).add_(pm.detach(), alpha=1 - d)
        if step % 1000 == 0 or step == steps:
            vl = float("nan")
            if len(va.X):
                vgen.manual_seed(1234)
                with torch.no_grad():
                    vl = float(np.mean([fm_loss(ema, vx1[i:i + 512], vc[i:i + 512], vs[i:i + 512], vgen).item()
                                        for i in range(0, len(vx1), 512)]))
            hist.append({"step": step, "train": float(loss.item()), "val": vl, "seconds": round(time.time() - t0)})
            log(f"step {step:6d}  train {loss.item():.4f}  val {vl:.4f}  ({time.time() - t0:.0f} s)")
            score = vl if np.isfinite(vl) else -step
            if score <= best:
                best = score
                torch.save({"ema": ema.state_dict(), "step": step, "val": vl}, run / "ckpt.pt")
    (run / "history.json").write_text(json.dumps(hist, indent=2))
    (run.parent / "latest.txt").write_text(run.name)
    log(f"done: {run} (best validation loss {best:.4f})")
    return run


def load(run_dir: Path | str | None = None, device: str = "cpu"):
    """(model, config, norm) for a run directory (default: the latest run)."""
    if run_dir is None:
        latest = RUNS / "latest.txt"
        if not latest.exists():
            raise FileNotFoundError("no trained generative model yet: run `python -m models.generative train`")
        run_dir = RUNS / latest.read_text().strip()
    run_dir = Path(run_dir)
    if not run_dir.is_absolute() and not run_dir.exists():
        run_dir = RUNS / run_dir
    cfg = json.loads((run_dir / "config.json").read_text())
    norm = json.loads((run_dir / "norm.json").read_text())
    model = SessionCond(len(cfg["cond_names"]), len(cfg["sessions"]), cfg["session_embedding"], base=cfg["base"],
                        mults=tuple(cfg.get("mults", (1, 2, 4, 4))))
    state = torch.load(run_dir / "ckpt.pt", map_location=device, weights_only=True)
    model.load_state_dict(state["ema"])
    model.to(device).eval()
    cfg["run_dir"] = str(run_dir)
    cfg["ckpt_step"] = state["step"]
    return model, cfg, norm
