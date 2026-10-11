"""Phase 4: train the detector (a thin wrapper around Ultralytics).

    python -m tools.train --name first
    python -m tools.train --name anycolor hsv_h=0.5
    python -m tools.train --name noflip fliplr=0 imgsz=960

Runs land in runs/detect/<name>/ inside this folder. Ultralytics' global
runs_dir setting on this PC points elsewhere, so the path is passed explicitly.
Uses YOLO26s if this Ultralytics version has it, otherwise YOLO11s. Extra
key=value arguments go straight to Ultralytics and override the defaults.

Hue: Ultralytics' default (hsv_h=0.015) keeps color as a cue. hsv_h=0.5 would
make the detector ignore color, but RuneScape has look-alikes that differ from
wisps mostly by color (golden chronicles, green inventory memories, the cyan
progress bar), so colors are covered by recording at different colonies instead.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import yaml

from detector.common import RUNS, load_yaml, resolve, save_yaml


def default_model() -> str:
    try:
        from ultralytics.utils.downloads import GITHUB_ASSETS_STEMS

        if "yolo26s" in GITHUB_ASSETS_STEMS:
            return "yolo26s.pt"
    except ImportError:
        pass
    return "yolo11s.pt"


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", required=True, help="run name; output goes to runs/detect/<name>")
    p.add_argument("--data", default="configs/data.yaml")
    p.add_argument("--model", default=None, help="default: yolo26s.pt, or yolo11s.pt on older Ultralytics")
    p.add_argument("extra", nargs="*", help="more Ultralytics train arguments as key=value")
    a = p.parse_args(argv)

    from ultralytics import YOLO

    kwargs = {"imgsz": 640, "epochs": 100, "batch": 16, "device": 0}
    for kv in a.extra:
        k, v = kv.split("=", 1)
        kwargs[k] = yaml.safe_load(v)
    model_name = a.model or default_model()
    weights = resolve("weights") / model_name
    model = YOLO(str(weights) if weights.exists() else model_name)
    print(f"model {model_name}, data {a.data}, {kwargs}")
    infer_imgsz = load_yaml(a.data).get("infer_imgsz")
    if infer_imgsz:  # trained on crops: whole frames must be detected at this size (detector.infer reads it)
        # Written before the first epoch, so weights taken from a run that is still
        # training are run at the right size too (not at the 640 of the crops).
        model.add_callback("on_pretrain_routine_start", lambda trainer: save_yaml(
            Path(trainer.save_dir) / "infer.yaml", {"imgsz": infer_imgsz},
            header="# Trained on crops; detect whole frames at this size (written by tools.train)\n"))
    model.train(data=str(resolve(a.data)), project=str(RUNS / "detect"), name=a.name, **kwargs)


if __name__ == "__main__":
    main()
