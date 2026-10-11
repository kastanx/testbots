"""Label a session automatically with a trained model (Phase 5, model-assisted labeling).

    python -m tools.autolabel --session test1 --weights runs/detect/boot1/weights/best.pt

Writes YOLO labels to data/labels/<session>/ for every frame that has no label
file yet; hand-made labels are never touched. The auto-labeled frames are listed
in data/labels/<session>/auto.json. The labeler marks them "auto", and pressing
Enter on one marks it as checked. With --review N, N annotated frames spread over
the session are saved to runs/review/<session>_auto/ for a quick look.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime

import cv2
import numpy as np

from detector.capture import IMAGE_EXTS
from detector.common import ROOT, RUNS, load_yaml, save_yaml
from detector.filters import DetectionFilters
from detector.infer import YoloDetector
from tools.label import Box, write_labels


def load_auto(path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {"frames": []}


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--session", required=True)
    p.add_argument("--weights", required=True)
    p.add_argument("--conf", type=float, default=0.35, help="boxes at or above this confidence become labels")
    p.add_argument("--review", type=int, default=0, help="save this many annotated frames for a visual check")
    p.add_argument("--redo", action="store_true", help="also re-label frames this tool labeled before (never hand-made ones)")
    a = p.parse_args(argv)

    names = list(load_yaml("configs/dataset.yaml").get("names") or [])
    raw = ROOT / "data" / "raw" / a.session
    out = ROOT / "data" / "labels" / a.session
    out.mkdir(parents=True, exist_ok=True)
    meta = {"names": {i: n for i, n in enumerate(names)}}
    if load_yaml(out / "data.yaml") != meta:  # class names, read by tools.build_dataset
        save_yaml(out / "data.yaml", meta, header="# Class names for the labels in this folder\n")
    frames = sorted(f for f in raw.glob("*") if f.suffix.lower() in IMAGE_EXTS)
    auto_path = out / "auto.json"
    auto = load_auto(auto_path)
    redo = set(auto["frames"]) if a.redo else set()
    todo = [f for f in frames if not (out / f"{f.stem}.txt").exists() or f.stem in redo]
    filters = DetectionFilters.load()  # UI panels and the harvest progress bar aren't objects
    det = YoloDetector(a.weights, conf=a.conf)
    model_names = [det.names[i] for i in sorted(det.names)]
    if model_names != names:
        raise SystemExit(f"model classes {model_names} differ from configs/dataset.yaml names {names}")

    done = set(auto["frames"])
    counts = np.zeros(len(names), int)
    confs = []
    review_at = set(np.linspace(0, len(todo) - 1, a.review).round().astype(int)) if a.review and todo else set()
    review_dir = RUNS / "review" / f"{a.session}_auto"
    for k, f in enumerate(todo):
        img = cv2.imread(str(f))
        dets = filters.apply(img, det.detect(img)[0])
        boxes = [Box(names.index(d.type), *d.box) for d in dets]
        write_labels(out / f"{f.stem}.txt", boxes, img.shape[1], img.shape[0])
        done.add(f.stem)
        for d in dets:
            counts[names.index(d.type)] += 1
            confs.append(d.conf)
        if k in review_at:
            review_dir.mkdir(parents=True, exist_ok=True)
            vis = img.copy()
            for d in dets:
                x1, y1, x2, y2 = (int(v) for v in d.box)
                col = (255, 220, 0) if d.type == names[0] else (0, 150, 255)
                cv2.rectangle(vis, (x1, y1), (x2, y2), col, 2)
                cv2.putText(vis, f"{d.type} {d.conf:.2f}", (x1, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 1,
                            cv2.LINE_AA)
            cv2.imwrite(str(review_dir / f"{f.stem}.jpg"), vis, [cv2.IMWRITE_JPEG_QUALITY, 90])
    auto.update(frames=sorted(done), model=str(det.weights), conf=a.conf,
                updated=datetime.now().isoformat(timespec="seconds"))
    auto_path.write_text(json.dumps(auto, indent=1))
    per_frame = counts / max(1, len(todo))
    print(f"auto-labeled {len(todo)} frames ({len(frames) - len(todo)} kept as they were) -> {out}")
    print("boxes per frame: " + ", ".join(f"{n} {per_frame[i]:.1f}" for i, n in enumerate(names)))
    if confs:
        c = np.array(confs)
        print(f"confidence: min {c.min():.2f}, p10 {np.percentile(c, 10):.2f}, median {np.median(c):.2f}")
    if review_at:
        print(f"review images: {review_dir}")


if __name__ == "__main__":
    main()
