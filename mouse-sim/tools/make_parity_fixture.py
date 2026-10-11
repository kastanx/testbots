"""Write web/test/fixtures/parity.json: inputs and Python outputs that the TypeScript ports must
reproduce (motion-matching warp, the Butterworth filter). Uses whatever processed data you point it
at (the synthetic owner is fine).

    python -m tools.make_parity_fixture --data DIR
"""
from __future__ import annotations

import argparse
import json
import math

import numpy as np
from scipy.signal import butter, sosfiltfilt

from models.base import TrialConditions
from models.motion_matching import library
from models.motion_matching.matcher import MotionMatching
from pipeline import paths
from pipeline.dataset import Dataset
from pipeline.timeline import Target


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    args = ap.parse_args()
    ds = Dataset(args.data)
    mm = MotionMatching().fit(ds)
    lib = mm.lib
    rng = np.random.default_rng(3)
    picks = rng.choice(len(lib), 10, replace=False).tolist()
    sub = library.Library(
        lib.D[picks], lib.theta[picks], lib.along[picks], lib.across[picks], lib.shape[picks], lib.start_rel[picks],
        lib.target_wh[picks], lib.onset[picks],
        np.concatenate([lib.path(i) for i in picks]),
        np.concatenate([[0], np.cumsum([len(lib.path(i)) for i in picks])]),
        np.concatenate([lib.trial_clicks(i) for i in picks]),
        np.concatenate([[0], np.cumsum([len(lib.trial_clicks(i)) for i in picks])]),
        [lib.keys[i] for i in picks])
    mm.lib = sub
    screen = (3440, 1440)
    cases = []
    for j in range(len(sub)):
        sx, sy = sub.start_rel[j] * screen
        th = math.radians(sub.theta[j])
        for rot, scale, shift in ((0.0, 1.0, (0, 0)), (6.0, 1.08, (13, -7)), (-11.0, 0.9, (-40, 25))):
            start = (round(sx + shift[0]), round(sy + shift[1]))
            a = th + math.radians(rot)
            D = sub.D[j] * scale
            w, h, r = sub.target_wh[j]
            tgt = Target("rect" if sub.shape[j] else "circle", start[0] + D * math.cos(a), start[1] + D * math.sin(a), w, h, r)
            cond = TrialConditions(start, tgt, screen)
            tl = mm.warp(j, cond, check=False)
            cases.append({"entry": j, "start": list(start), "target": tgt.as_dict(), "screen": list(screen),
                          "pos": tl.pos.ravel().tolist(), "clicks": tl.clicks.tolist(),
                          "hit": tl.click_hit.astype(int).tolist()})
    filt = []
    for n in (30, 120, 700):
        x = np.cumsum(rng.normal(0, 2, n)).round()
        y = sosfiltfilt(butter(2, 30, fs=1000.0, output="sos"), x, padlen=min(n - 1, 300))
        filt.append({"x": x.tolist(), "y": y.tolist()})
    from models.generative import data as gdata
    from models.generative.sample import GenerativeModel
    from pipeline import config
    gm = GenerativeModel.__new__(GenerativeModel)
    gm.cfg_sampling = config.generative()
    gen_cases = []
    for k in range(8):
        tau = np.linspace(0, 1, gdata.N_POINTS)
        prog = 10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5
        traj = np.column_stack([prog * rng.uniform(0.85, 1.05), 0.05 * rng.normal() * np.sin(np.pi * tau)])
        traj += rng.normal(0, 0.003, traj.shape)
        start = (float(rng.integers(100, 3300)), float(rng.integers(100, 1300)))
        ang = rng.uniform(0, 2 * np.pi)
        D = float(np.exp(rng.uniform(np.log(25), np.log(1500))))
        shape = "rect" if k % 2 else "circle"
        w = float(rng.integers(6, 120))
        h = float(rng.integers(6, 60)) if shape == "rect" else w
        tgt = Target(shape, start[0] + D * np.cos(ang), start[1] + D * np.sin(ang), w, h, min(6.0, 0.25 * min(w, h)) if shape == "rect" else 0.0)
        logdur = float(np.log(rng.uniform(80, 1200)))
        end = rng.normal(0, 0.4, 2)
        pos = gm.movement_path(traj, float(np.exp(logdur)), end, start, tgt, screen)
        gen_cases.append({"traj": traj.ravel().tolist(), "logdur": logdur, "end": end.tolist(), "start": list(start),
                          "target": tgt.as_dict(), "pos": pos.ravel().tolist()})
    gen_meta = {"n_points": gdata.N_POINTS, "d_min": gdata.D_MIN, "sampling": config.generative()}
    lib_json = {
        "n": len(sub), "screen": list(screen), "fitts": {"a_nominal": ds.fitts["a_nominal"], "b_nominal": ds.fitts["b_nominal"]},
        "config": mm.cfg, "D": sub.D.tolist(), "theta": sub.theta.tolist(), "along": sub.along.tolist(),
        "across": sub.across.tolist(), "shape": sub.shape.tolist(), "start_rel": sub.start_rel.ravel().tolist(),
        "target": sub.target_wh.ravel().tolist(), "onset": sub.onset.tolist(), "offsets": sub.offsets.tolist(),
        "clicks": sub.clicks.ravel().tolist(), "click_offsets": sub.click_offsets.tolist(), "keys": sub.keys,
        "rel": sub.rel.ravel().tolist(),
    }
    out = paths.PROJECT / "web" / "test" / "fixtures" / "parity.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"library": lib_json, "cases": cases, "filtfilt": filt,
                               "gen": {"meta": gen_meta, "cases": gen_cases, "screen": list(screen)}}))
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB, {len(cases)} warp cases)")


if __name__ == "__main__":
    main()
