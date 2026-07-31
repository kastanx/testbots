"""Score server/models/location_cls.pt on the held-out val split, and say what
to do about it.

Prints overall top-1, per-class accuracy, the confusion pairs that actually
matter, and writes every mistake to ml/misclassified.csv for triage.

    python ml/evaluate.py
    python ml/evaluate.py --weights runs/classify/greenbot2/weights/best.pt
"""
import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

ML = Path(__file__).resolve().parent
ROOT = ML.parent
VAL = ML / "dataset" / "val"

CHUNK = 64


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default=str(ROOT / "server" / "models" / "location_cls.pt"))
    ap.add_argument("--imgsz", type=int, default=224)
    ap.add_argument("--device", default="0")
    ap.add_argument("--conf", type=float, default=0.70,
                    help="the bot's conf_threshold, for the abstain-rate report")
    args = ap.parse_args()

    weights = Path(args.weights)
    if not weights.exists():
        sys.exit(f"no weights at {weights} - run ml/train.py first")
    if not VAL.exists():
        sys.exit(f"no val split at {VAL} - run ml/prepare_dataset.py first")

    from ultralytics import YOLO

    model = YOLO(str(weights))
    names = model.names

    items = []
    for label_dir in sorted(p for p in VAL.iterdir() if p.is_dir()):
        for f in sorted(label_dir.glob("*.jpg")):
            items.append((f, label_dir.name))
    if not items:
        sys.exit(f"no images under {VAL}")

    print(f"weights: {weights}")
    print(f"val:     {len(items)} images, {len(set(t for _, t in items))} classes\n")

    confusion = defaultdict(int)          # (truth, pred) -> n
    per_class = defaultdict(lambda: [0, 0])   # truth -> [correct, total]
    low_conf = defaultdict(int)           # truth -> n below the bot's threshold
    mistakes = []

    for i in range(0, len(items), CHUNK):
        chunk = items[i:i + CHUNK]
        results = model.predict([str(f) for f, _ in chunk], imgsz=args.imgsz,
                                device=args.device, verbose=False)
        for (path, truth), r in zip(chunk, results):
            pred = names[int(r.probs.top1)]
            conf = float(r.probs.top1conf)
            confusion[(truth, pred)] += 1
            per_class[truth][1] += 1
            if pred == truth:
                per_class[truth][0] += 1
            else:
                mistakes.append((truth, pred, f"{conf:.3f}", str(path)))
            if conf < args.conf:
                low_conf[truth] += 1
        print(f"\r  {min(i + CHUNK, len(items))}/{len(items)}", end="", flush=True)
    print("\r" + " " * 30 + "\r", end="")

    correct = sum(c for c, _ in per_class.values())
    total = sum(t for _, t in per_class.values())
    top1 = correct / total

    labels = sorted(per_class)
    print(f"{'class':<12} {'acc':>7} {'n':>6} {'<conf':>7}   worst confusion")
    print("-" * 62)
    for label in labels:
        c, t = per_class[label]
        wrong = [(n, p) for (tr, p), n in confusion.items() if tr == label and p != label]
        worst_s = "-"
        if wrong:
            n, p = max(wrong)
            worst_s = f"{p} ({n}x)"
        flag = "  <<" if c / t < 0.95 else ""
        print(f"{label:<12} {c / t:>7.3f} {t:>6} {low_conf[label]:>7}   {worst_s}{flag}")
    print("-" * 62)
    print(f"{'TOP-1':<12} {top1:>7.3f} {total:>6} {sum(low_conf.values()):>7}\n")

    if mistakes:
        out = ML / "misclassified.csv"
        with open(out, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["truth", "predicted", "confidence", "path"])
            w.writerows(sorted(mistakes))
        print(f"{len(mistakes)} mistakes written to {out}\n")

    pairs = sorted(((n, tr, p) for (tr, p), n in confusion.items() if tr != p), reverse=True)
    if pairs:
        print("top confusion pairs:")
        for n, tr, p in pairs[:8]:
            print(f"  {tr} -> {p}: {n}")
        print()

    # A score is only as good as the split it came from.
    info_path = ML / "dataset" / "split_info.json"
    info = json.loads(info_path.read_text()) if info_path.exists() else {}
    if not info.get("trustworthy", True):
        print("VERDICT: none - this was a DIAGNOSTIC split "
              f"({info.get('mode', 'unknown')}), not held-out sessions.")
        print("  Train and val frames come from the same session, so they share")
        print("  lighting, player positions and weather. A high score here means")
        print("  'the spots are separable at all', nothing more.")
        print("  Record another session, then: python ml/prepare_dataset.py --val-newest 1")
        return

    if top1 >= 0.97 and all(c / t >= 0.90 for c, t in per_class.values()):
        print("VERDICT: ship it. best.pt is deployed at server/models/location_cls.pt,")
        print("  which is what server/config.yaml loads.")
    elif pairs and pairs[0][0] > 0.25 * per_class[pairs[0][1]][1]:
        a, b = pairs[0][1], pairs[0][2]
        print(f"VERDICT: '{a}' and '{b}' are being confused.")
        print("  1. retrain at higher resolution:  python ml/train.py --imgsz 320")
        print(f"  2. if it persists, they may be near-identical from where you")
        print(f"     stand - record more frames at '{a}' and '{b}' from angles that")
        print("     actually differ. The service reports top3 honestly either way;")
        print("     voting between them is the consumer's job, not the model's.")
    else:
        print("VERDICT: broad weakness, not a specific pair - this is a data problem.")
        print("  Record more sessions at different times/densities, and check that")
        print("  labels were not mis-keyed during recording.")


if __name__ == "__main__":
    main()
