"""Run the plan's Phase 4 gate on the clickable detector and say pass or fail.

The gate is precision >= 0.95 AND recall >= 0.95 on the held-out split. This
script exits non-zero when that is not met, so it can sit in front of the
service in a build script and stop a bad detector from being wired up.

Numbers alone cannot see the failure that actually matters - a box drawn on a
player - so it also renders val frames into ml/detect_review/ with predictions
and ground truth in different colours. Files are named worst-first by false
positive count: open the top of the folder and the offenders are already there.

    python ml/evaluate_detector.py
    python ml/evaluate_detector.py --weights runs/detect/greenbot-det/weights/best.pt
    python ml/evaluate_detector.py --review 100 --conf 0.4
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

ML = Path(__file__).resolve().parent
ROOT = ML.parent
DATA = ML / "dataset-detect"
REVIEW = ML / "detect_review"
CONFIG = ROOT / "server" / "config.yaml"


def service_defaults():
    """Weights path, imgsz and conf as the SERVICE will use them.

    The review renders are only meaningful if they were produced with the same
    settings the service runs at, so they come from config.yaml rather than
    being re-declared here where they could quietly drift.
    """
    fallback = (ROOT / "server" / "models" / "clickable_det.pt", 640, 0.25)
    try:
        import yaml
        cfg = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
        weights = (CONFIG.parent / cfg["models"]["detector"]).resolve()
        return weights, int(cfg["detect_imgsz"]), float(cfg["detect_conf"])
    except Exception as err:                                # noqa: BLE001
        print(f"warning: could not read {CONFIG} ({err}); using built-in defaults")
        return fallback


WEIGHTS, DETECT_IMGSZ, DETECT_CONF = service_defaults()

CHUNK = 16

# BGR. Ground truth is blue on purpose - the targets themselves are green.
GT_COLOR = (255, 128, 0)
PRED_COLOR = (0, 0, 255)


def iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (area_a + area_b - inter)


def match(preds, gts, iou_thr):
    """Greedy, most-confident prediction first. Returns (pred_ok, gt_ok)."""
    pred_ok = [False] * len(preds)
    gt_ok = [False] * len(gts)
    for pi in sorted(range(len(preds)), key=lambda i: -preds[i][4]):
        best, best_iou = -1, iou_thr
        for gi, g in enumerate(gts):
            if gt_ok[gi]:
                continue
            v = iou(preds[pi], g)
            if v >= best_iou:
                best, best_iou = gi, v
        if best >= 0:
            pred_ok[pi] = True
            gt_ok[best] = True
    return pred_ok, gt_ok


def read_gt(txt, w, h):
    """YOLO normalized cx cy w h -> pixel x1 y1 x2 y2 in this image."""
    boxes = []
    if not txt.exists():
        return boxes
    for line in txt.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) != 5:
            continue
        cx, cy, bw, bh = (float(v) for v in parts[1:])
        boxes.append((round((cx - bw / 2) * w), round((cy - bh / 2) * h),
                      round((cx + bw / 2) * w), round((cy + bh / 2) * h)))
    return boxes


def dashed_rect(cv2, image, box, color, thickness=2, dash=7):
    """A good prediction lands within a pixel of its label, so a solid truth
    box would be completely hidden by the prediction box (or vice versa).
    Dashes stay readable through the overlap without nudging any coordinate."""
    x1, y1, x2, y2 = box
    for x in range(x1, x2, dash * 2):
        cv2.line(image, (x, y1), (min(x + dash, x2), y1), color, thickness)
        cv2.line(image, (x, y2), (min(x + dash, x2), y2), color, thickness)
    for y in range(y1, y2, dash * 2):
        cv2.line(image, (x1, y), (x1, min(y + dash, y2)), color, thickness)
        cv2.line(image, (x2, y), (x2, min(y + dash, y2)), color, thickness)


def draw_review(cv2, image, gts, gt_ok, preds, pred_ok):
    for i, ((x1, y1, x2, y2, conf), ok) in enumerate(zip(preds, pred_ok)):
        cv2.rectangle(image, (int(x1), int(y1)), (int(x2), int(y2)), PRED_COLOR, 2)
        tag = f"{conf:.2f}" if ok else f"FP {conf:.2f}"
        # Stagger the captions or two boxes on one target overprint each other.
        y = min(int(y2) + 16 + (i % 3) * 15, image.shape[0] - 4)
        cv2.putText(image, tag, (int(x1), y),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, PRED_COLOR, 2)
    for box, ok in zip(gts, gt_ok):
        dashed_rect(cv2, image, box, GT_COLOR)
        if not ok:
            cv2.putText(image, "MISS", (box[0], max(box[1] - 6, 12)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, GT_COLOR, 2)
    cv2.putText(image, "dashed blue = labelled truth   solid red = prediction",
                (10, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)


def build_review(model, cv2, images, labels, args):
    """Score every val frame, then render the worst offenders. Returns totals."""
    records = []
    for i in range(0, len(images), CHUNK):
        chunk = images[i:i + CHUNK]
        results = model.predict([str(f) for f in chunk], imgsz=args.imgsz,
                                device=args.device, conf=args.conf, verbose=False)
        for f, r in zip(chunk, results):
            h, w = r.orig_shape
            preds = [(*map(float, b.xyxy[0]), float(b.conf[0])) for b in r.boxes]
            gts = read_gt(labels / f"{f.stem}.txt", w, h)
            pred_ok, gt_ok = match(preds, gts, args.iou)
            records.append((sum(1 for ok in pred_ok if not ok),
                            sum(1 for ok in gt_ok if not ok),
                            f, gts, gt_ok, preds, pred_ok))
        print(f"\r  {min(i + CHUNK, len(images))}/{len(images)}", end="", flush=True)
    print("\r" + " " * 30 + "\r", end="")

    if REVIEW.exists():
        shutil.rmtree(REVIEW)
    REVIEW.mkdir(parents=True, exist_ok=True)

    records.sort(key=lambda rec: (-rec[0], -rec[1], rec[2].name))
    for rank, (fp, fn, f, gts, gt_ok, preds, pred_ok) in enumerate(records[:args.review]):
        image = cv2.imread(str(f))
        if image is None:
            continue
        draw_review(cv2, image, gts, gt_ok, preds, pred_ok)
        cv2.imwrite(str(REVIEW / f"{rank:03d}_fp{fp}_fn{fn}_{f.stem}.jpg"), image)

    return sum(rec[0] for rec in records), sum(rec[1] for rec in records)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default=str(WEIGHTS))
    ap.add_argument("--data", default=str(DATA / "data.yaml"))
    ap.add_argument("--imgsz", type=int, default=DETECT_IMGSZ,
                    help="defaults to detect_imgsz from server/config.yaml")
    ap.add_argument("--device", default="0")
    ap.add_argument("--conf", type=float, default=DETECT_CONF,
                    help="defaults to detect_conf from server/config.yaml, so the "
                         "review renders match what the service will actually see")
    ap.add_argument("--iou", type=float, default=0.5,
                    help="IoU at which a prediction counts as matching a label")
    ap.add_argument("--review", type=int, default=50, metavar="N",
                    help="how many val frames to render into ml/detect_review/")
    ap.add_argument("--gate", type=float, default=0.95,
                    help="the plan's precision/recall bar")
    args = ap.parse_args()

    weights = Path(args.weights)
    data = Path(args.data).resolve()
    if not weights.exists():
        sys.exit(f"no weights at {weights} - run ml/train_detector.py first")
    if not data.exists():
        sys.exit(f"missing {data} - run ml/prepare_detect_dataset.py first")

    images_dir = data.parent / "images" / "val"
    labels_dir = data.parent / "labels" / "val"
    images = sorted(images_dir.glob("*.jpg"))
    if not images:
        sys.exit(f"no images under {images_dir} - run ml/prepare_detect_dataset.py first")

    import cv2
    from ultralytics import YOLO

    model = YOLO(str(weights))
    print(f"weights: {weights}")
    print(f"val:     {len(images)} images from {images_dir}\n")

    metrics = model.val(data=str(data), imgsz=args.imgsz, device=args.device,
                        split="val", project=str(ROOT / "runs" / "detect"),
                        name="val", exist_ok=True, plots=True, verbose=False)
    precision, recall, map50, map5095 = metrics.box.mean_results()

    fp, fn = build_review(model, cv2, images, labels_dir, args)

    print(f"{'metric':<12} {'value':>8}   gate")
    print("-" * 34)
    print(f"{'precision':<12} {precision:>8.3f}   >= {args.gate:.2f}"
          f"{'' if precision >= args.gate else '   <<'}")
    print(f"{'recall':<12} {recall:>8.3f}   >= {args.gate:.2f}"
          f"{'' if recall >= args.gate else '   <<'}")
    print(f"{'mAP50':<12} {map50:>8.3f}   -")
    print(f"{'mAP50-95':<12} {map5095:>8.3f}   -")
    print("-" * 34)
    print("precision and recall are ultralytics' values at the best-F1 confidence.\n")
    print(f"at conf {args.conf} (the service's detect_conf), over {len(images)} val frames:")
    print(f"  {fp} false positive box(es), {fn} missed label(s)")
    print(f"  renders: {REVIEW}  (worst first)\n")

    # A score is only as good as the split it came from.
    info_path = data.parent / "split_info.json"
    info = json.loads(info_path.read_text()) if info_path.exists() else {}
    if not info.get("trustworthy", True):
        print("VERDICT: none - this was a DIAGNOSTIC split "
              f"({info.get('mode', 'unknown')}), not held-out sessions.")
        print("  Train and val frames come from the same session, so they share")
        print("  lighting, player positions and weather. A high score here means")
        print("  'the detector can find a clickable at all', nothing more - it")
        print("  cannot clear a gate, so this run does not pass.")
        print("  Record another session, then:")
        print("    python ml/prepare_detect_dataset.py --val-newest 1")
        sys.exit(2)

    if precision >= args.gate and recall >= args.gate:
        print(f"VERDICT: PASS - precision {precision:.3f} and recall {recall:.3f} "
              f"both clear {args.gate:.2f}")
        print("  The numbers cannot see a box drawn on a player. Before you wire")
        print("  the detector into the service, open the review folder and check")
        print(f"  ~50 frames with players in view:  {REVIEW}")
        return

    print(f"VERDICT: FAIL - the gate is precision >= {args.gate:.2f} AND "
          f"recall >= {args.gate:.2f}")
    print(f"  got precision {precision:.3f}, recall {recall:.3f}")
    print("  Label more frames that CONTAIN PLAYERS and keep them as hard")
    print("  negatives, then retrain - per the plan this fixes player false")
    print("  positives almost every time.")
    print("  Start from the top of the review folder - those frames are the")
    print(f"  ones costing you the most precision:  {REVIEW}")
    if recall < args.gate <= precision:
        print("  Recall is the weak side here, so it is missed clickables, not")
        print("  players: label more frames where the target is small, dim or")
        print("  partly occluded.")
    sys.exit(1)


if __name__ == "__main__":
    main()
