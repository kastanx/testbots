"""Write <bundle>/gen/parity.json: fixed noise and conditions with the Python sampler's output, so the
browser can check that its ONNX sampling loop reproduces it (tools/e2e_simulator.mjs runs the check).

    python -m tools.make_gen_parity --data DIR --run RUN_DIR --bundle BUNDLE_DIR
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from models.generative import data
from models.generative.sample import GenerativeModel
from pipeline.dataset import Dataset


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--run", required=True)
    ap.add_argument("--bundle", required=True)
    args = ap.parse_args()
    ds = Dataset(args.data)
    gm = GenerativeModel(args.run, device="cpu").fit(ds)
    rng = np.random.default_rng(11)
    tr = data.build(ds, "test")
    idx = rng.choice(len(tr.C), 4, replace=False)
    conds = tr.C[idx]
    noise = rng.standard_normal((len(idx), data.IN_CHANNELS, data.N_POINTS)).astype(np.float32)
    traj, logdur, end = gm.sample_movements(conds, noise)
    out = Path(args.bundle) / "gen" / "parity.json"
    out.write_text(json.dumps({"conds": conds.tolist(), "noise": noise.ravel().tolist(), "traj": traj.tolist(),
                               "logdur": logdur.tolist(), "end": end.tolist(), "steps": gm.cfg_sampling["steps"]}))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
