"""Tune the generative model's post-processing on the validation sessions (never the test sessions):
the low-pass cut-off applied to the continuous path before rounding, and the start ramp.

The network leaves a little wobble in its paths; a lower cut-off removes more of it but also removes
real tremor. Which side wins depends on the owner's data, so the harness decides. `--write` stores
the best setting in config/generative.json.
"""
from __future__ import annotations

import json
import math

import numpy as np

from eval.harness import evaluate
from pipeline import config, paths
from pipeline.dataset import Dataset

from .sample import GenerativeModel


def tune(root=None, run=None, write: bool = False, log=print) -> dict:
    ds = Dataset(root)
    gm = GenerativeModel(run).fit(ds)
    base = config.generative()
    cache: dict = {}
    results = []
    for fc in (6, 8, 10, 12, 15, 20):
        for ramp in (0.1, 0.2):
            gm.cfg_sampling = dict(base, lowpass_hz=fc, start_ramp=ramp)
            res = evaluate(gm, ds, role="val", use_cnn=False, n_ref=2, log=lambda *a: None, cache=cache)
            vals = [v for v in res["key_ratios"].values() if np.isfinite(v)]
            r = {"lowpass_hz": fc, "start_ramp": ramp, "worst": max(vals) if vals else math.inf,
                 "mean": float(np.mean(vals)) if vals else math.inf, "worst_feature": res["worst_feature"],
                 "auc": res["auc"]["gbm"], "floor": res["auc_floor"]["gbm"]}
            results.append(r)
            log(f"low-pass {fc:2d} Hz, start ramp {ramp}: worst {r['worst']:.2f} ({r['worst_feature']}), "
                f"mean {r['mean']:.2f}, AUC {r['auc']:.3f} (floor {r['floor']:.3f})")
    best = min(results, key=lambda r: (r["worst"], r["mean"]))
    log(f"best: low-pass {best['lowpass_hz']} Hz, start ramp {best['start_ramp']}")
    if write:
        f = paths.CONFIG / "generative.json"
        cfg = json.loads(f.read_text())
        cfg["lowpass_hz"] = best["lowpass_hz"]
        cfg["start_ramp"] = best["start_ramp"]
        f.write_text(json.dumps(cfg, indent=2) + "\n")
        log(f"wrote {f}")
    return {"best": best, "results": results}
