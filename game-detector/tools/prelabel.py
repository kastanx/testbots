"""Phase 5, and the Phase 1 shortcut: pre-draw boxes for CVAT, so labeling becomes fixing.

    python -m tools.prelabel --name round1 --frames data/raw/s01 data/raw/s02 --n 300 --filter
    python -m tools.prelabel --name round2 --frames data/raw/s03 --n 400 \\
        --weights runs/detect/first/weights/best.pt --select uncertain

Writes data/to_label/<name>/:
    images/          the chosen frames (hard links): create the CVAT task from these
    prelabels.zip    their boxes in YOLO 1.1 format: in CVAT, task > Actions > Upload annotations > YOLO 1.1
    frames.txt       which frames were chosen and why

--select even       spread evenly over the given frames (default)
--select uncertain  frames where the model is least sure: most boxes with confidence 0.2-0.6
Frames already in datasets/game are skipped. Color-filter boxes all get the
first class name; set the right type while fixing them.
"""

from __future__ import annotations

import argparse
import zipfile

import cv2
import numpy as np

from detector.color import ColorFilterDetector, ColorTable
from detector.common import ROOT, load_yaml
from detector.filters import DetectionFilters
from tools.build_dataset import link_or_copy
from tools.color_filter import list_frames


def yolo_lines(dets, class_ids: dict[str, int], w: int, h: int) -> list[str]:
    lines = []
    for d in dets:
        x1, y1, x2, y2 = d.box
        x1, y1, x2, y2 = max(0.0, x1), max(0.0, y1), min(float(w), x2), min(float(h), y2)
        if x2 <= x1 or y2 <= y1:
            continue
        c = class_ids.get(d.type, 0)
        lines.append(f"{c} {(x1 + x2) / 2 / w:.6f} {(y1 + y2) / 2 / h:.6f} {(x2 - x1) / w:.6f} {(y2 - y1) / h:.6f}")
    return lines


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", required=True, help="batch name, output goes to data/to_label/<name>")
    p.add_argument("--frames", nargs="+", required=True, help="session folders or glob patterns")
    p.add_argument("--n", type=int, default=300, help="how many frames to pick")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--filter", action="store_true", help="boxes from the color filter")
    g.add_argument("--weights", help="boxes from a trained model")
    p.add_argument("--select", choices=["even", "uncertain"], default="even")
    p.add_argument("--conf", type=float, default=0.4, help="model boxes at or above this go into the pre-labels")
    p.add_argument("--imgsz", default=None, help="default: the model's own size")
    p.add_argument("--colors", default="configs/colors.yaml")
    a = p.parse_args(argv)

    out = ROOT / "data" / "to_label" / a.name
    if out.exists():
        raise SystemExit(f"{out} exists; pick another --name")
    labeled = {f.stem for f in (ROOT / "datasets" / "game" / "images").rglob("*")} \
        if (ROOT / "datasets" / "game").exists() else set()
    frames = [f for f in list_frames(a.frames, 0) if f.stem not in labeled]
    if not frames:
        raise SystemExit("no unlabeled frames found")

    if a.filter:
        det = ColorFilterDetector(ColorTable.load(a.colors))
        names = list(load_yaml("configs/dataset.yaml").get("names") or ["object_a", "object_b"])
        class_ids = {"object": 0}
    else:
        from detector.infer import YoloDetector

        det = YoloDetector(a.weights, imgsz=a.imgsz, conf=0.2 if a.select == "uncertain" else a.conf)
        names = [det.names[i] for i in sorted(det.names)]
        class_ids = {n: i for i, n in enumerate(names)}

    filters = DetectionFilters.load()
    if a.select == "uncertain":
        if a.filter:
            raise SystemExit("--select uncertain needs --weights")
        scored = []
        for i, f in enumerate(frames):
            img = cv2.imread(str(f))
            dets = filters.apply(img, det.detect(img)[0])
            scored.append((sum(0.2 <= d.conf < 0.6 for d in dets), i))
            if (i + 1) % 200 == 0:
                print(f"  scored {i + 1}/{len(frames)}", flush=True)
        scored.sort(key=lambda s: (-s[0], s[1]))
        chosen = sorted(i for _, i in scored[:a.n])
        reasons = {i: f"uncertain boxes: {s}" for s, i in scored[:a.n]}
        det.conf = a.conf
    else:
        idx = np.linspace(0, len(frames) - 1, min(a.n, len(frames))).round().astype(int)
        chosen = sorted(set(int(i) for i in idx))
        reasons = {i: "even" for i in chosen}

    (out / "images").mkdir(parents=True)
    zpath = out / "prelabels.zip"
    n_boxes = 0
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("obj.names", "\n".join(names) + "\n")
        z.writestr("obj.data", f"classes = {len(names)}\ntrain = data/train.txt\nnames = data/obj.names\n"
                               f"backup = backup/\n")
        listing = []
        for i in chosen:
            f = frames[i]
            img = cv2.imread(str(f))
            dets = filters.apply(img, det.detect(img)[0])
            lines = yolo_lines(dets, class_ids, img.shape[1], img.shape[0])
            n_boxes += len(lines)
            z.writestr(f"obj_train_data/{f.stem}.txt", "\n".join(lines) + ("\n" if lines else ""))
            listing.append(f"data/obj_train_data/{f.name}")
            link_or_copy(f, out / "images" / f.name)
        z.writestr("train.txt", "\n".join(listing) + "\n")
    (out / "frames.txt").write_text("\n".join(f"{frames[i]}\t{reasons[i]}" for i in chosen) + "\n")
    print(f"{len(chosen)} frames, {n_boxes} pre-drawn boxes -> {out}\n"
          f"In CVAT: create a task from {out / 'images'} with labels {names} (+ the color attribute),\n"
          f"then Actions > Upload annotations > YOLO 1.1 > {zpath}")


if __name__ == "__main__":
    main()
