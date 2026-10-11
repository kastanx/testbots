"""Export everything the simulator loads (served at /bundle/):

    manifest.json          what is available
    baselines.json         Fitts fit and median timings for the three baselines
    mm/library.{json,bin}  motion-matching library (training sessions)
    gen/model.onnx, gen/gen.json   generative network + sampler settings + timing banks (if trained)
    test/library.{json,bin}        held-out test trials, for the blind test
    cursor.{png,json}      the owner's Windows arrow cursor and hotspot

    python -m models.export [--data DIR] [--out DIR] [--run GEN_RUN_DIR]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

from pipeline import config, paths
from pipeline.dataset import Dataset


def export_bundle(root=None, out=None, run=None, log=print) -> Path:
    ds = Dataset(root)
    out = Path(out) if out else paths.EXPORT
    out.mkdir(parents=True, exist_ok=True)
    setup = json.loads((ds.root / "setup.json").read_text()) if (ds.root / "setup.json").exists() else {}
    screen = Counter(zip(ds.trials["screen_w"], ds.trials["screen_h"])).most_common(1)[0][0]
    manifest = {"created": datetime.now().isoformat(timespec="seconds"),
                "data": "synthetic" if setup.get("synthetic") else "owner", "data_root": str(ds.root),
                "screen": [int(screen[0]), int(screen[1])], "setup_version": setup.get("setup_version"),
                "components": {}}

    from .baselines import Baseline
    params = Baseline("line").fit(ds).params
    (out / "baselines.json").write_text(json.dumps(params, indent=2))
    manifest["components"]["baselines"] = "baselines.json"

    from .motion_matching import library
    mm_cfg = config.motion_matching()
    lib = library.build(ds, role="train", include_warmup=mm_cfg.get("include_warmup", False))
    info = library.export(lib, out / "mm", ds.fitts, mm_cfg, manifest["screen"])
    manifest["components"]["mm"] = {"json": "mm/library.json", "bin": "mm/library.bin", **info}
    log(f"motion matching: {info['entries']} trials")

    test = library.build(ds, role="test")
    if len(test):
        info = library.export(test, out / "test", ds.fitts, mm_cfg, manifest["screen"])
        manifest["components"]["test"] = {"json": "test/library.json", "bin": "test/library.bin", **info}
        log(f"test trials for the blind test: {info['entries']}")
    else:
        log("no usable test trials yet: the blind test needs recorded test sessions")

    try:
        from .generative.export_onnx import export as export_gen
        export_gen(run, out / "gen", str(ds.root))
        manifest["components"]["gen"] = {"onnx": "gen/model.onnx", "json": "gen/gen.json"}
    except FileNotFoundError as e:
        log(f"generative model not exported: {e}")

    if sys.platform == "win32":
        try:
            from tools.extract_cursor import extract
            manifest["components"]["cursor"] = {"png": "cursor.png", **extract(out)}
        except OSError as e:
            log(f"cursor not extracted ({e}); the simulator draws a default arrow")

    reports = paths.REPORTS / "harness"
    manifest["reports"] = {p.stem: f"/reports/harness/{p.name}" for p in sorted(reports.glob("*.html"))} if reports.is_dir() else {}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    log(f"bundle written to {out}")
    return out


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", help="data root (default: mouse-sim/data or $MOUSESIM_DATA)")
    ap.add_argument("--out", help="bundle directory (default: models/export)")
    ap.add_argument("--run", help="generative run directory (default: the latest)")
    args = ap.parse_args()
    export_bundle(args.data, args.out, args.run)


if __name__ == "__main__":
    main()
