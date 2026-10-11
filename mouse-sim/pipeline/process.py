"""validate -> convert -> segment -> features for every raw session; writes data/processed/."""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

from . import config, paths, rawio
from .convert import build_timelines, grid_times, speed_noise, to_physical
from .features import analyse_timeline, fitts_fit, spectrum_freqs
from .timeline import TimelineStore
from .validate import validate


def process(root: Path, allow_failures: bool = False, log=print) -> dict:
    cfg = config.pipeline()
    root = Path(root)
    splits = rawio.load_splits(root)
    out = paths.processed_dir(root)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    timelines, trial_rows, mov_rows, profiles, spectra, reports = [], [], [], [], [], []
    failed = []
    for d in rawio.session_dirs(root):
        raw = rawio.load_session(d)
        role = rawio.session_role(raw.meta, splits)
        rep = validate(raw)
        rep["role"] = role
        if role == "exclude":
            rep["used"] = False
            reports.append(rep)
            continue
        if not rep["ok"] and not allow_failures:
            rep["used"] = False
            reports.append(rep)
            failed.append(raw.session_id)
            log(f"FAIL  {raw.session_id}: " + "; ".join(rep["errors"]))
            continue
        dpr = raw.dpr
        xp = to_physical(raw.moves["x"], dpr)
        yp = to_physical(raw.moves["y"], dpr)
        period = 1000.0 / float(raw.polling_hz or cfg["polling_hz_default"])
        tg, gstats = grid_times(raw.moves["t"], period, cfg["burst_gap_ms"])
        rep["grid"] = gstats
        noise = {"raw_t": speed_noise(raw.moves["t"], xp, yp, cfg["burst_gap_ms"]),
                 "t_grid": speed_noise(tg, xp, yp, cfg["burst_gap_ms"])}
        rep["speed_noise"] = noise
        clock = cfg.get("timeline_clock", "auto")
        use_grid = clock == "grid" or (clock == "auto" and not noise["t_grid"] > noise["raw_t"])
        rep["clock"] = "t_grid" if use_grid else "raw_t"
        n_rej = 0
        for tr, tl, info in build_timelines(raw, tg if use_grid else raw.moves["t"], xp, yp):
            trial, rows, prof, spec = analyse_timeline(tl, cfg, record=tr, markers=info["markers"])
            base = {"session_id": raw.session_id, "trial": int(tr["trial"]), "role": role,
                    "setup_version": raw.meta.get("setup_version"), "warmup": bool(tr.get("warmup")),
                    "tl_index": len(timelines)}
            timelines.append(tl)
            trial_rows.append({**base, **trial, "feeling": raw.meta.get("feeling"), "cell_planned": tr.get("cell")})
            for r in rows:
                mov_rows.append({**base, "rejected": trial["rejected"], **r})
            profiles.append(prof)
            spectra.append(spec)
            n_rej += trial["rejected"]
        rep["used"] = True
        rep["rejected_trials"] = int(n_rej)
        reports.append(rep)
        status = "ok  " if rep["ok"] else "WARN"
        log(f"{status}  {raw.session_id}  {role:5s}  {len(raw.trials):4d} trials, {n_rej:3d} rejected, "
            f"{rep['stats']['event_rate_hz']:.0f} Hz, clock {rep['clock']}"
            + ("; " + "; ".join(rep["warnings"]) if rep["warnings"] else ""))

    trials = pd.DataFrame(trial_rows)
    movs = pd.DataFrame(mov_rows)
    if len(trials):
        trials["cell_planned"] = trials["cell_planned"].map(lambda c: json.dumps(c))
    trials.to_parquet(out / "trials.parquet", index=False)
    movs.to_parquet(out / "movements.parquet", index=False)
    TimelineStore.pack(timelines).save(out / "timelines.npz")
    n_spec = len(spectrum_freqs(cfg))
    np.savez_compressed(out / "profiles.npz",
                        profiles=np.concatenate(profiles) if profiles else np.zeros((0, cfg["speed_profile_points"])),
                        spectra=np.concatenate(spectra) if spectra else np.zeros((0, n_spec)),
                        freqs=spectrum_freqs(cfg))
    fitts = {}
    if len(movs):
        train = movs[(movs["role"] == "train") & ~movs["rejected"] & ~movs["warmup"]]
        fitts = fitts_fit(train if len(train) else movs[~movs["rejected"]], cfg)
    (out / "fitts.json").write_text(json.dumps(fitts, indent=2))
    (out / "sessions.json").write_text(json.dumps(reports, indent=2, default=float))
    summary = {"sessions": len(reports), "failed": failed, "trials": int(len(trials)),
               "movements": int(len(movs)), "seconds": round(time.time() - t0, 1)}
    log(f"processed {summary['trials']} trials / {summary['movements']} movements from "
        f"{len(reports) - len(failed)} sessions in {summary['seconds']} s -> {out}")
    if failed:
        log(f"{len(failed)} session(s) FAILED validation and were left out: {', '.join(failed)}")
    return summary
