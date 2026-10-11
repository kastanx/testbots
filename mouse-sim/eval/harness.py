"""The evaluation harness (Phase 3): scores any model on the held-out test sessions.

For every usable test trial the model generates one trial with the same start, target and target
size. Generated, real test and matched real reference movements are all measured with the same
pipeline code, then compared with feature fidelity ratios and classifier two-sample tests.
"""
from __future__ import annotations

import html
import json
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from models.base import Model, TrialConditions
from pipeline import config, paths
from pipeline.dataset import Dataset
from pipeline.report import FingerprintData, render

from . import blind, leaderboard
from .c2st import c2st
from .ratio import feature_ratios
from .samples import MovementSet, analyse_many, attach_groups, matched_reference, real_set, test_trials


def generate_set(model: Model, ds: Dataset, trials: pd.DataFrame, rng, name: str) -> MovementSet:
    conds = [TrialConditions.from_timeline(ds.timeline(i), sid) for i, sid in zip(trials["tl_index"], trials["session_id"])]
    if hasattr(model, "generate_batch"):
        tls = model.generate_batch(conds, rng)
    else:
        tls = [model.generate(c, rng) for c in conds]
    pair = [f"{s}:{t}" for s, t in zip(trials["session_id"], trials["trial"])]
    return analyse_many(name, tls, pair, [{"session_id": s} for s in trials["session_id"]])


def evaluate(model: Model, ds: Dataset, role: str = "test", limit: int | None = None, seed: int = 0,
             use_cnn: bool = True, n_ref: int | None = None, n_gen: int | None = None, log=print,
             cache: dict | None = None) -> dict:
    """cache: pass the same dict to repeated calls (tuning) to reuse the real and reference sets."""
    hc = config.harness()
    t0 = time.time()
    rng = np.random.default_rng(seed)
    key = (role, limit, seed, n_ref)
    if cache is not None and key in cache:
        trials, real, refs, floor_cached = cache[key]
    else:
        trials = test_trials(ds, role=role, limit=limit, seed=seed)
        if len(trials) == 0:
            raise SystemExit(f"no usable {role} trials; record {role} sessions first")
        real = real_set(ds, trials, f"owner: {role} sessions")
        refs = [matched_reference(ds, trials, rng, "owner: other sessions, same conditions")
                for _ in range(n_ref or hc["n_ref_draws"])]
        floor_cached = None
    gens = [generate_set(model, ds, trials, rng, model.name) for _ in range(n_gen or hc["n_gen_draws"])]
    attach_groups(trials, real, *refs, *gens)
    feats = list(hc["key_features"])
    ratios = feature_ratios(real.rows, [g.rows for g in gens], [r.rows for r in refs], feats + ["miss"],
                            hc["min_group_n"])
    log(f"  ratios done ({time.time() - t0:.0f} s)")
    auc = c2st(real, gens[0], use_cnn)
    floor = floor_cached if floor_cached is not None and ("cnn" in floor_cached) == use_cnn else c2st(real, refs[0], use_cnn)
    if cache is not None:
        cache[key] = (trials, real, refs, floor)
    log(f"  C2ST done ({time.time() - t0:.0f} s)")

    key = {f: ratios[f]["median"] for f in feats if f in ratios}
    worst = max(key, key=lambda f: -np.inf if not np.isfinite(key[f]) else key[f])
    n_pass = sum(1 for v in key.values() if np.isfinite(v) and v <= hc["ratio_pass"])
    bt = blind.latest(ds.root, model.name)
    ratio_ok = n_pass == len(key)
    auc_ok = auc["max"] <= floor["max"] + hc["auc_margin"]
    blind_ok = bt is not None and bt["pass"]
    g = gens[0]
    gen_trials = g.trials
    return {
        "model": model.describe(), "role": role, "n_test": int(len(trials)), "seconds": round(time.time() - t0, 1),
        "ratios": ratios, "key_ratios": key, "worst_feature": worst, "worst_ratio": key[worst], "n_pass": n_pass,
        "n_features": len(key), "auc": auc, "auc_floor": floor, "blind": bt,
        "pass": {"ratios": ratio_ok, "c2st": auc_ok, "blind": blind_ok, "all": ratio_ok and auc_ok and blind_ok},
        "generated": {
            "rejected_share": float(gen_trials["rejected"].mean()),
            "rejection_reasons": gen_trials.loc[gen_trials["rejected"], "reasons"].value_counts().head(5).to_dict(),
            "first_click_miss_rate": float(g.rows["miss"].mean()),
            "clicks_per_trial": float(gen_trials["n_clicks"].mean()),
        },
        "real": {"first_click_miss_rate": float(real.rows["miss"].mean()),
                 "clicks_per_trial": float(real.trials["n_clicks"].mean())},
        "_sets": {"real": real, "gen": g, "ref": refs[0]},
    }


def _verdict_html(res: dict) -> str:
    hc = config.harness()
    p = res["pass"]
    mark = lambda ok: '<b style="color:#2e7d32">PASS</b>' if ok else '<b style="color:#c62828">FAIL</b>'
    bt = res["blind"]
    blind_txt = (f"{bt['correct']}/{bt['n']} correct (pass: ≤ {hc['blind']['pass_max_correct']} of 100)"
                 if bt else "not run yet (simulator → Blind test)")
    rows = [
        (p["ratios"], f"Feature ratios: {res['n_pass']}/{res['n_features']} key features ≤ {hc['ratio_pass']} "
                      f"(worst: {res['worst_feature']} {res['worst_ratio']:.2f})"),
        (p["c2st"], f"Classifier AUC {res['auc']['max']:.3f} vs drift floor {res['auc_floor']['max']:.3f} "
                    f"(pass: within {hc['auc_margin']})"),
        (p["blind"], f"Owner blind test: {blind_txt}"),
    ]
    return "<div class=card><h2 style='margin-top:0'>Verdict</h2>" + "".join(
        f"<p>{mark(ok)} &nbsp; {html.escape(t)}</p>" for ok, t in rows) + "</div>"


def _ratio_table(res: dict) -> str:
    rows = []
    for f, r in res["ratios"].items():
        w = r["worst"][0] if r["worst"] else None
        med = r["median"]
        style = "" if not np.isfinite(med) else (" style='color:#2e7d32'" if med <= config.harness()["ratio_pass"] else " style='color:#c62828'")
        rows.append(f"<tr><td>{f}</td><td{style}>{med:.2f}</td><td>{r['overall']:.2f}</td><td>"
                    + (f"{w['ratio']:.2f} <span class=dim>({w['group']}, n={w['n']})</span>" if w else "–") + "</td></tr>")
    a, fl = res["auc"], res["auc_floor"]
    c2 = (f"<table class=summary><tr><th>C2ST (ROC AUC)</th><th>gradient boosting</th><th>1D CNN</th><th>max</th></tr>"
          f"<tr><td>model vs test</td><td>{a['gbm']:.3f}</td><td>{a.get('cnn', float('nan')):.3f}</td><td>{a['max']:.3f}</td></tr>"
          f"<tr><td>drift floor (other sessions vs test)</td><td>{fl['gbm']:.3f}</td><td>{fl.get('cnn', float('nan')):.3f}</td><td>{fl['max']:.3f}</td></tr></table>")
    gen, real = res["generated"], res["real"]
    extra = (f"<p>First-click miss rate: model {100 * gen['first_click_miss_rate']:.1f}% vs owner "
             f"{100 * real['first_click_miss_rate']:.1f}% · clicks per trial {gen['clicks_per_trial']:.2f} vs "
             f"{real['clicks_per_trial']:.2f} · generated trials the pipeline would reject: "
             f"{100 * gen['rejected_share']:.1f}% {html.escape(str(gen['rejection_reasons'] or ''))}</p>")
    return ("<div class=card><table class=summary><tr><th>feature</th><th>ratio (weighted median over groups)</th>"
            "<th>ratio (all pooled)</th><th>worst group</th></tr>" + "".join(rows) + "</table>"
            "<p class=dim>1.0 = the model is as close to the test sessions as the owner's own other sessions are.</p>"
            + extra + c2 + "</div>")


def write_report(res: dict, out: Path, data_label: str) -> Path:
    sets = res["_sets"]
    freqs = np.load(paths.processed_dir(Path(res["data_root"])) / "profiles.npz")["freqs"]
    fps = [FingerprintData(sets[k].name, sets[k].rows, sets[k].profiles, sets[k].spectra, freqs)
           for k in ("real", "gen", "ref")]
    intro = (f"<p class=dim>data: {html.escape(data_label)} · {res['n_test']} {res['role']} trials · "
             f"model: {html.escape(json.dumps(res['model']))}</p>" + _verdict_html(res) + _ratio_table(res))
    return render(fps, out, f"Harness report: {res['model']['name']}", intro)


def is_synthetic(root: Path) -> bool:
    f = Path(root) / "setup.json"
    return f.exists() and bool(json.loads(f.read_text()).get("synthetic"))


def run(spec_or_model, root=None, limit=None, seed=0, use_cnn=True, role="test", reports_dir=None,
        update_board=True, log=print) -> dict:
    """Score one model; writes <reports>/harness/<model>.html + .json and a leaderboard row."""
    from models import registry

    ds = Dataset(root)
    reports_dir = Path(reports_dir) if reports_dir else paths.REPORTS
    model = registry.build(spec_or_model) if isinstance(spec_or_model, str) else spec_or_model
    log(f"fitting {model.name} …")
    model.fit(ds)
    log(f"generating and scoring on {role} sessions …")
    res = evaluate(model, ds, role=role, limit=limit, seed=seed, use_cnn=use_cnn, log=log)
    res["data_root"] = str(ds.root)
    synthetic = is_synthetic(ds.root)
    data_label = ("SYNTHETIC test owner" if synthetic else "owner recordings") + f" ({ds.root})"
    suffix = "" if role == "test" else f"_{role}"
    out = reports_dir / "harness" / f"{model.name}{suffix}.html"
    write_report(res, out, data_label)
    res["report"] = str(out)
    summary = {k: v for k, v in res.items() if k != "_sets"}
    out.with_suffix(".json").write_text(json.dumps(summary, indent=2, default=float))
    if update_board and role == "test":
        bt = res["blind"]
        leaderboard.update({
            "date": datetime.now().strftime("%Y-%m-%d %H:%M"), "data": "synthetic" if synthetic else "owner",
            "model": model.name, "params": res["model"], "n_test": res["n_test"],
            "worst_feature": res["worst_feature"], "worst_ratio": res["worst_ratio"], "n_pass": res["n_pass"],
            "n_features": res["n_features"], "auc": res["auc"]["max"], "auc_floor": res["auc_floor"]["max"],
            "blind": f"{bt['correct']}/{bt['n']}" if bt else "–", "pass": res["pass"]["all"],
            "report": str(out),
        }, reports_dir)
    log(f"worst key feature {res['worst_feature']} ratio {res['worst_ratio']:.2f}; {res['n_pass']}/{res['n_features']} ≤ "
        f"{config.harness()['ratio_pass']}; AUC {res['auc']['max']:.3f} vs floor {res['auc_floor']['max']:.3f}"
        f" -> report {out}")
    return res
