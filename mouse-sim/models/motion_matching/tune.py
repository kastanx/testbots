"""Tune motion matching on the validation sessions (never the test sessions).

1. Warp tolerance: scale every hard limit together and score each setting, plotting the harness
   score against how much rotation and scaling the replays actually used.
2. Weights: a coordinate search over the condition-distance weights, top-k and the warp low-pass.

The objective is the worst key-feature ratio (what the pass criterion uses), then the mean ratio.
`--write` stores the best setting in config/motion_matching.json.
"""
from __future__ import annotations

import copy
import json
import math

import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from eval.harness import evaluate
from pipeline import config, paths
from pipeline.dataset import Dataset

from .matcher import MotionMatching


def _score(res: dict) -> tuple[float, float]:
    vals = [v for v in res["key_ratios"].values() if np.isfinite(v)]
    return (max(vals), float(np.mean(vals))) if vals else (math.inf, math.inf)


def _scaled_limits(base: dict, lam: float) -> dict:
    lim = copy.deepcopy(base)
    lim["direction_deg"] = base["direction_deg"] * lam
    lim["distance_ratio"] = [1 - (1 - base["distance_ratio"][0]) * lam, 1 + (base["distance_ratio"][1] - 1) * lam]
    lim["size_ratio"] = [base["size_ratio"][0] ** lam, base["size_ratio"][1] ** lam]
    lim["across_ratio"] = [base["across_ratio"][0] ** lam, base["across_ratio"][1] ** lam]
    return lim


def tune(root=None, write: bool = False, role: str = "val", reports_dir=None, log=print) -> dict:
    from pathlib import Path

    from pipeline.report import _plotly_script

    ds = Dataset(root)
    reports = Path(reports_dir) if reports_dir else paths.REPORTS
    base = config.motion_matching()
    model = MotionMatching(copy.deepcopy(base)).fit(ds)
    cache: dict = {}

    def run(cfg) -> dict:
        model.cfg = cfg
        model.stats = {k: 0 for k in model.stats}
        model.last = -1
        res = evaluate(model, ds, role=role, use_cnn=False, n_ref=2, log=lambda *a: None, cache=cache)
        g = res["_sets"]["gen"]
        return {"worst": _score(res)[0], "mean": _score(res)[1], "worst_feature": res["worst_feature"],
                "auc": res["auc"]["gbm"], "floor": res["auc_floor"]["gbm"],
                "low_coverage": model.stats["low_coverage"] / max(model.stats["queries"], 1), "n": len(g)}

    # 1. warp tolerance sweep
    sweep = []
    for lam in (0.33, 0.67, 1.0, 1.67, 2.67):
        cfg = copy.deepcopy(base)
        cfg["limits"] = _scaled_limits(base["limits"], lam)
        rots, scales = [], []
        model.cfg = cfg
        rng = np.random.default_rng(0)
        from models.base import TrialConditions
        trials = ds.usable_trials(role=role)
        for tl_index in trials["tl_index"].iloc[:300]:
            tl = model.generate(TrialConditions.from_timeline(ds.timeline(tl_index)), rng)
            rots.append(abs(tl.meta.get("rotation_deg", 0.0)))
            scales.append(abs(math.log(tl.meta.get("scale", 1.0))))
        r = run(cfg)
        r.update({"lambda": lam, "limits": cfg["limits"], "mean_abs_rotation_deg": float(np.mean(rots)),
                  "mean_abs_log_scale": float(np.mean(scales))})
        sweep.append(r)
        log(f"tolerance x{lam:<4}: worst {r['worst']:.2f} ({r['worst_feature']}), mean {r['mean']:.2f}, "
            f"AUC {r['auc']:.3f}/{r['floor']:.3f}, |rot| {r['mean_abs_rotation_deg']:.1f} deg, "
            f"low coverage {100 * r['low_coverage']:.0f}%")
    best_sweep = min(sweep, key=lambda r: (r["worst"], r["mean"]))
    current = copy.deepcopy(base)
    current["limits"] = best_sweep["limits"]
    best = run(current)

    # 2. coordinate search over weights and a few knobs
    knobs = [
        (("weights", "log_distance"), [1.0, 2.0, 4.0, 8.0]),
        (("weights", "direction_rad"), [0.5, 1.0, 2.0, 4.0]),
        (("weights", "log_size_along"), [0.5, 1.5, 3.0]),
        (("weights", "start"), [0.0, 1.0, 3.0]),
        (("top_k",), [4, 8, 16]),
        (("similarity_tau",), [0.05, 0.15, 0.4]),
        (("warp_lowpass_hz",), [15, 20, 30, 50]),
    ]
    trace = []
    for path, values in knobs:
        for v in values:
            cfg = copy.deepcopy(current)
            node = cfg
            for k in path[:-1]:
                node = node[k]
            if node[path[-1]] == v:
                continue
            node[path[-1]] = v
            r = run(cfg)
            trace.append({"param": ".".join(path), "value": v, **r})
            if (r["worst"], r["mean"]) < (best["worst"], best["mean"]):
                best, current = r, cfg
                log(f"  better: {'.'.join(path)} = {v}: worst {r['worst']:.2f} mean {r['mean']:.2f}")
    log(f"best: worst {best['worst']:.2f} ({best['worst_feature']}), mean {best['mean']:.2f}, AUC {best['auc']:.3f}")

    out = {"role": role, "best": best, "config": current, "sweep": sweep, "trace": trace}
    reports.mkdir(parents=True, exist_ok=True)
    (reports / "motion_matching_tuning.json").write_text(json.dumps(out, indent=2, default=float))
    fig = make_subplots(rows=1, cols=2, subplot_titles=["score vs allowed rotation", "score vs allowed distance scaling"])
    labels = [f"used {r['mean_abs_rotation_deg']:.1f}°, ×{math.exp(r['mean_abs_log_scale']):.2f}; "
              f"{100 * r['low_coverage']:.0f}% low coverage" for r in sweep]
    for col, xs in ((1, [r["limits"]["direction_deg"] for r in sweep]),
                    (2, [r["limits"]["distance_ratio"][1] - 1 for r in sweep])):
        for key, colour, name in (("worst", "#c62828", "worst key ratio"), ("mean", "#2f6db3", "mean key ratio")):
            fig.add_trace(go.Scatter(x=xs, y=[r[key] for r in sweep], mode="lines+markers", name=name, text=labels,
                                     hovertemplate="%{y:.2f}<br>%{text}<extra></extra>", showlegend=col == 1,
                                     line=dict(color=colour)), row=1, col=col)
    fig.update_xaxes(title_text="direction limit (± deg)", row=1, col=1)
    fig.update_xaxes(title_text="distance limit (± fraction)", row=1, col=2)
    fig.update_yaxes(title_text="feature ratio (validation)", row=1, col=1)
    fig.update_layout(title="Motion matching: how much warping the data tolerates (validation sessions; hover for "
                            "the warp actually used)", template="plotly_white", height=420)
    page = (f"<!doctype html><html><head><meta charset=utf-8><title>Motion matching tuning</title>"
            f"{_plotly_script(reports)}</head><body>{fig.to_html(full_html=False, include_plotlyjs=False)}"
            f"<pre>{json.dumps({'best': best, 'config': current}, indent=2, default=float)}</pre></body></html>")
    (reports / "motion_matching_tuning.html").write_text(page, encoding="utf-8")
    if write:
        cfg_file = paths.CONFIG / "motion_matching.json"
        on_disk = json.loads(cfg_file.read_text())
        for k in ("weights", "limits", "top_k", "similarity_tau", "warp_lowpass_hz"):
            on_disk[k] = current[k]
        cfg_file.write_text(json.dumps(on_disk, indent=2) + "\n")
        log(f"wrote the tuned settings to {cfg_file}")
    return out
