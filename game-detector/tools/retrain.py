"""Retrain in one go: dataset from every labeled session, training, TensorRT engine.

    python -m tools.retrain                       # next free name: round3, round4, ...
    python -m tools.retrain --name colony2 --epochs 60

1. Labeled sessions in data/labels/ that configs/dataset.yaml doesn't list yet are
   added to it as training sessions.
2. tools.build_dataset with crops (--tiles, whole frames are detected at --infer-imgsz).
3. tools.train, continuing from the newest roundN model (20 epochs) unless
   --fresh (pretrained YOLO weights, 40 epochs).
4. TensorRT FP16 export at the whole-frame size (skip with --no-engine).

Training and the export use the GPU for roughly 15-25 minutes, so the game may
stutter meanwhile. Until the engine is exported, `python -m detector.main` keeps using
the previous model; afterwards it picks the new one by itself.
"""

from __future__ import annotations

import argparse
import math
import re

import cv2

from detector.common import CONFIGS, ROOT, RUNS, load_yaml
from tools import build_dataset, train


def next_name() -> str:
    taken = [int(m.group(1)) for d in (RUNS / "detect").glob("round*") if (m := re.fullmatch(r"round(\d+)", d.name))]
    return f"round{max(taken, default=0) + 1}"


def add_new_sessions() -> list[str]:
    """Append labeled sessions that the manifest doesn't know yet, as training sessions."""
    path = CONFIGS / "dataset.yaml"
    known = set((load_yaml(path).get("sessions") or {}))
    labeled = sorted(d.name for d in (ROOT / "data" / "labels").iterdir()
                     if d.is_dir() and (ROOT / "data" / "raw" / d.name).is_dir() and any(d.glob("*.txt")))
    new = [s for s in labeled if s not in known]
    if new:
        text = path.read_text(encoding="utf-8")
        if not text.endswith("\n"):
            text += "\n"
        text += "".join(f"  {s}: {{split: train}}   # added by tools.retrain\n" for s in new)
        path.write_text(text, encoding="utf-8")
    return new


def engine_imgsz(infer_imgsz: int) -> list[int]:
    """Whole-frame engine size (h, w) in the recorded frames' shape, multiples of 32."""
    for session in (load_yaml(CONFIGS / "dataset.yaml").get("sessions") or {}):
        frame = next((ROOT / "data" / "raw" / session).glob("*.png"), None)
        if frame is not None:
            h, w = cv2.imread(str(frame)).shape[:2]
            scale = infer_imgsz / max(h, w)
            return [math.ceil(h * scale / 32) * 32, math.ceil(w * scale / 32) * 32]
    return [infer_imgsz, infer_imgsz]


def labeled_frames() -> int:
    total = 0
    for session in (load_yaml(CONFIGS / "dataset.yaml").get("sessions") or {}):
        total += len(list((ROOT / "data" / "labels" / session).glob(f"{session}_*.txt")))
    return total


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", help="run name (default: next roundN)")
    p.add_argument("--fresh", action="store_true",
                   help="start from the pretrained YOLO weights instead of the newest trained model")
    p.add_argument("--epochs", type=int, default=None, help="default: 20 when continuing, 40 when --fresh")
    p.add_argument("--tiles", type=int, default=None,
                   help="crops per labeled frame (default: about 3500 training crops in total)")
    p.add_argument("--infer-imgsz", type=int, default=1920, help="whole frames are detected at this size")
    p.add_argument("--no-engine", action="store_true", help="skip the TensorRT export")
    a = p.parse_args(argv)
    name = a.name or next_name()

    new = add_new_sessions()
    if new:
        print(f"added to configs/dataset.yaml as training sessions: {', '.join(new)}")
    tiles = a.tiles or max(2, min(10, round(3500 / max(1, labeled_frames()))))
    build_dataset.main(["--tiles", str(tiles), "--infer-imgsz", str(a.infer_imgsz)])
    runs = sorted((RUNS / "detect").glob("round*/weights/best.pt"), key=lambda q: q.stat().st_mtime)
    start = None if a.fresh or not runs else runs[-1]
    epochs = a.epochs or (40 if start is None else 20)
    args = ["--name", name, f"epochs={epochs}", "cache=ram", "plots=False", "workers=4"]
    if start is not None:
        print(f"continuing from {start.relative_to(ROOT)}")
        args = ["--model", str(start)] + args
    train.main(args)
    best = RUNS / "detect" / name / "weights" / "best.pt"
    if not a.no_engine:
        from ultralytics import YOLO

        size = engine_imgsz(a.infer_imgsz)
        print(f"exporting TensorRT engine at {size[0]}x{size[1]} ...")
        YOLO(str(best)).export(format="engine", quantize=16, imgsz=size, device=0)
    print(f"\nnew model: runs/detect/{name}\nwatch it live: run.bat detector.main --track")


if __name__ == "__main__":
    main()
