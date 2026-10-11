"""Phase 4: evaluate a model on the test session and save its mistakes.

    python -m tools.evaluate --weights runs/detect/first/weights/best.pt
    python -m tools.evaluate --weights ... --split val --conf 0.3

Prints mAP50, mAP50-95 and per-class precision/recall (Ultralytics val; its
plots, including the confusion matrix, go to runs/eval/<name>/). Then runs the
model at --conf on every frame of the split and saves each frame with a
mistake to runs/eval/<name>/errors/: false positives red, missed objects
yellow, right box but wrong type orange.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2

from detector.capture import IMAGE_EXTS, label_path_for, read_yolo_labels
from detector.common import RUNS, load_yaml, resolve
from detector.infer import YoloDetector
from detector.metrics import Tally, iou_matrix, match


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--weights", required=True)
    p.add_argument("--data", default="configs/data.yaml")
    p.add_argument("--split", default="test")
    p.add_argument("--imgsz", default=None, help="default: the model's own size")
    p.add_argument("--conf", type=float, default=0.25, help="threshold for the error review")
    p.add_argument("--name", help="default: <run name>_<split>")
    a = p.parse_args(argv)

    weights = resolve(a.weights)
    name = a.name or f"{weights.parent.parent.name}_{a.split}"
    out = RUNS / "eval" / name
    det = YoloDetector(weights, imgsz=a.imgsz, conf=a.conf)
    m = det.model.val(data=str(resolve(a.data)), split=a.split, imgsz=det.imgsz, batch=8, plots=True,
                      project=str(RUNS / "eval"), name=name, exist_ok=True, verbose=False)
    names = det.names
    per_class = {}
    for i, c in enumerate(m.box.ap_class_index):
        per_class[names[int(c)]] = {"precision": round(float(m.box.p[i]), 4), "recall": round(float(m.box.r[i]), 4),
                                    "mAP50": round(float(m.box.ap50[i]), 4)}
    result = {"weights": str(weights), "split": a.split, "mAP50": round(float(m.box.map50), 4),
              "mAP50-95": round(float(m.box.map), 4), "per_class": per_class}

    data = load_yaml(a.data)
    root = Path(data["path"]) / data[a.split]
    errors = out / "errors"
    errors.mkdir(parents=True, exist_ok=True)
    tally = Tally()
    n_err = 0
    label_names = [names[k] for k in sorted(names)]
    for img_path in sorted(f for f in root.rglob("*") if f.suffix.lower() in IMAGE_EXTS):
        img = cv2.imread(str(img_path))
        truths = read_yolo_labels(label_path_for(img_path), img.shape[1], img.shape[0], label_names)
        dets, _ = det.detect(img)
        tally.update(dets, truths)
        pairs = match(dets, truths, same_type=True)
        fp = [d for i, d in enumerate(dets) if i not in {p[0] for p in pairs}]
        fn = [t for i, t in enumerate(truths) if i not in {p[1] for p in pairs}]
        if not fp and not fn:
            continue
        n_err += 1
        vis = img.copy()
        ious = iou_matrix(fp, fn)
        for i, d in enumerate(fp):
            wrong_type = len(fn) and ious[i].max() >= 0.5
            col = (0, 140, 255) if wrong_type else (0, 0, 255)
            x1, y1, x2, y2 = (int(v) for v in d.box)
            cv2.rectangle(vis, (x1, y1), (x2, y2), col, 2)
            cv2.putText(vis, f"{d.type} {d.conf:.2f}", (x1, max(12, y1 - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 1,
                        cv2.LINE_AA)
        for t in fn:
            x1, y1, x2, y2 = (int(v) for v in t.box)
            cv2.rectangle(vis, (x1, y1), (x2, y2), (0, 255, 255), 2)
            cv2.putText(vis, f"missed {t.type}", (x1, min(vis.shape[0] - 4, y2 + 14)), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                        (0, 255, 255), 1, cv2.LINE_AA)
        cv2.imwrite(str(errors / f"{img_path.stem}.jpg"), vis, [cv2.IMWRITE_JPEG_QUALITY, 90])
    s = tally.summary()
    result["at_conf"] = {"conf": a.conf, **s["boxes"], "type_accuracy": s["type_accuracy"], "per_type": s["per_type"],
                         "frames_with_mistakes": n_err, "frames": s["frames"]}
    (out / "summary.json").write_text(json.dumps(result, indent=1))
    print(json.dumps(result, indent=1))
    print(f"\nmistakes: {errors}  (plots and confusion matrix: {out})")


if __name__ == "__main__":
    main()
