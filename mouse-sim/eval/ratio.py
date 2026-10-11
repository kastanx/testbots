"""Metric 1: feature fidelity ratio.

    ratio = W1(generated, real test) / W1(real reference, real test)

per feature and condition group. 1.0 means the model is as close to the test sessions as the owner's
own other sessions are. The denominator gets a small floor (a fraction of the feature's spread) so
near-constant features can't blow up.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import wasserstein_distance

EPS_FRAC = 0.02


def _w1(a: np.ndarray, b: np.ndarray) -> float:
    a = a[np.isfinite(a)]
    b = b[np.isfinite(b)]
    if len(a) == 0 or len(b) == 0:
        return float("nan")
    return float(wasserstein_distance(a, b))


def weighted_median(values, weights) -> float:
    v = np.asarray(values, float)
    w = np.asarray(weights, float)
    ok = np.isfinite(v) & (w > 0)
    if not ok.any():
        return float("nan")
    v, w = v[ok], w[ok]
    o = np.argsort(v)
    c = np.cumsum(w[o])
    return float(v[o][np.searchsorted(c, c[-1] / 2)])


def feature_ratios(real: pd.DataFrame, gens: list[pd.DataFrame], refs: list[pd.DataFrame],
                   features: list[str], min_n: int) -> dict:
    out = {}
    for f in features:
        if f not in real:
            continue
        vals = real[f].to_numpy(float)
        spread = np.nanstd(vals)
        eps = EPS_FRAC * spread if spread > 0 else 1e-9
        per_group = []
        for g, rg in real.groupby("group"):
            if len(rg) < min_n:
                continue
            r = rg[f].to_numpy(float)
            wg = np.nanmean([_w1(gd.loc[gd["group"] == g, f].to_numpy(float), r) for gd in gens])
            wr = np.nanmean([_w1(rd.loc[rd["group"] == g, f].to_numpy(float), r) for rd in refs])
            per_group.append({"group": g, "n": int(len(rg)), "w1_model": wg, "w1_ref": wr,
                              "ratio": wg / max(wr, eps) if np.isfinite(wg) else float("nan")})
        overall_g = np.nanmean([_w1(gd[f].to_numpy(float), vals) for gd in gens])
        overall_r = np.nanmean([_w1(rd[f].to_numpy(float), vals) for rd in refs])
        overall = overall_g / max(overall_r, eps) if np.isfinite(overall_g) else float("nan")
        pg = pd.DataFrame(per_group)
        binary = set(np.unique(vals[np.isfinite(vals)])) <= {0.0, 1.0}
        out[f] = {
            # rare binary events (misses) are too sparse per group; use the pooled ratio for them
            "median": overall if binary else (weighted_median(pg["ratio"], pg["n"]) if len(pg) else float("nan")),
            "worst": pg.sort_values("ratio", ascending=False).head(3).to_dict("records") if len(pg) else [],
            "overall": overall,
            "groups": pg.to_dict("records"),
        }
    return out
