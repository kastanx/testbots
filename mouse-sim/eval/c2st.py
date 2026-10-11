"""Metric 2: classifier two-sample tests (Lopez-Paz & Oquab 2017).

Two classifiers try to tell set A (real test movements) from set B (model output, or real movements
from other sessions for the drift floor): gradient boosting on the features, and a small 1D CNN on
the canonical path and speed profile with the conditions as extra inputs. 5-fold cross-validation
keeps each pair (same test trial) in one fold. ROC AUC 0.5 = indistinguishable.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold

from pipeline import config

from .samples import MovementSet

FEATURES = ["rt", "mt", "dwell", "hold", "peak_speed", "t_peak_frac", "path_len", "path_eff", "curv_px",
            "curv_norm", "curv_pos", "overshoot_px", "overshoot_norm", "passed_far_edge", "n_sub", "end_along",
            "end_across", "end_along_norm", "end_across_norm", "slip", "slip_max", "ldlj", "jit_rms", "jit_b1",
            "jit_b2", "jit_b3", "miss"]


def condition_matrix(rows: pd.DataFrame) -> np.ndarray:
    th = np.radians(rows["theta"].to_numpy(float))
    return np.stack([
        np.log(np.maximum(rows["D"].to_numpy(float), 1.0)), np.cos(th), np.sin(th),
        np.log(np.maximum(rows["size_along"].to_numpy(float), 1.0)),
        np.log(np.maximum(rows["size_across"].to_numpy(float), 1.0)),
        (rows["shape"] == "rect").to_numpy(float),
        rows["start_rel_x"].to_numpy(float), rows["start_rel_y"].to_numpy(float),
    ], 1)


def _folds(groups: np.ndarray, k: int):
    n_groups = len(np.unique(groups))
    return GroupKFold(n_splits=min(k, n_groups)).split(np.zeros(len(groups)), groups=groups)


def gbm_auc(a: MovementSet, b: MovementSet, folds: int, seed: int) -> float:
    cols = [c for c in FEATURES if c in a.rows and c in b.rows]
    X = np.vstack([np.hstack([a.rows[cols].to_numpy(float), condition_matrix(a.rows)]),
                   np.hstack([b.rows[cols].to_numpy(float), condition_matrix(b.rows)])])
    y = np.concatenate([np.zeros(len(a)), np.ones(len(b))])
    g = np.concatenate([a.rows["pair_id"].to_numpy(), b.rows["pair_id"].to_numpy()])
    oof = np.zeros(len(y))
    for tr, te in _folds(g, folds):
        clf = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.06, max_leaf_nodes=15,
                                             l2_regularization=1.0, random_state=seed)
        clf.fit(X[tr], y[tr])
        oof[te] = clf.predict_proba(X[te])[:, 1]
    return float(roc_auc_score(y, oof))


def cnn_auc(a: MovementSet, b: MovementSet, folds: int, seed: int) -> float:
    import torch
    from torch import nn

    cfg = config.harness()["c2st"]
    torch.manual_seed(seed)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    P = np.concatenate([a.paths, b.paths]).astype(np.float32)
    P[:, 2] = np.log1p(np.clip(P[:, 2], 0, None))
    S = np.vstack([
        np.hstack([condition_matrix(a.rows), np.log(np.maximum(a.rows[["mt"]].to_numpy(float), 1.0))]),
        np.hstack([condition_matrix(b.rows), np.log(np.maximum(b.rows[["mt"]].to_numpy(float), 1.0))]),
    ]).astype(np.float32)
    y = np.concatenate([np.zeros(len(a)), np.ones(len(b))]).astype(np.float32)
    g = np.concatenate([a.rows["pair_id"].to_numpy(), b.rows["pair_id"].to_numpy()])
    oof = np.zeros(len(y))

    class Net(nn.Module):
        def __init__(self, n_scalar):
            super().__init__()
            self.conv = nn.Sequential(
                nn.Conv1d(3, 32, 5, padding=2), nn.GELU(),
                nn.Conv1d(32, 64, 5, stride=2, padding=2), nn.GELU(),
                nn.Conv1d(64, 64, 5, stride=2, padding=2), nn.GELU(),
                nn.AdaptiveAvgPool1d(1))
            self.head = nn.Sequential(nn.Linear(64 + n_scalar, 64), nn.GELU(), nn.Linear(64, 1))

        def forward(self, p, s):
            return self.head(torch.cat([self.conv(p).squeeze(-1), s], 1)).squeeze(-1)

    for tr, te in _folds(g, folds):
        pm = P[tr].mean(axis=(0, 2), keepdims=True)
        ps = P[tr].std(axis=(0, 2), keepdims=True) + 1e-6
        sm, ss = S[tr].mean(0), S[tr].std(0) + 1e-6
        Ptr = torch.tensor((P[tr] - pm) / ps, device=dev)
        Str = torch.tensor((S[tr] - sm) / ss, device=dev)
        ytr = torch.tensor(y[tr], device=dev)
        net = Net(S.shape[1]).to(dev)
        opt = torch.optim.AdamW(net.parameters(), lr=cfg["cnn_lr"], weight_decay=1e-4)
        lossf = nn.BCEWithLogitsLoss()
        n = len(tr)
        for _ in range(cfg["cnn_epochs"]):
            perm = torch.randperm(n, device=dev)
            for i in range(0, n, cfg["cnn_batch"]):
                idx = perm[i:i + cfg["cnn_batch"]]
                opt.zero_grad()
                lossf(net(Ptr[idx], Str[idx]), ytr[idx]).backward()
                opt.step()
        net.eval()
        with torch.no_grad():
            Pte = torch.tensor((P[te] - pm) / ps, device=dev)
            Ste = torch.tensor((S[te] - sm) / ss, device=dev)
            oof[te] = torch.sigmoid(net(Pte, Ste)).cpu().numpy()
    return float(roc_auc_score(y, oof))


def c2st(a: MovementSet, b: MovementSet, use_cnn: bool = True) -> dict:
    cfg = config.harness()["c2st"]
    out = {"gbm": gbm_auc(a, b, cfg["folds"], cfg["seed"])}
    if use_cnn:
        out["cnn"] = cnn_auc(a, b, cfg["folds"], cfg["seed"])
    out["max"] = max(out.values())
    return out
