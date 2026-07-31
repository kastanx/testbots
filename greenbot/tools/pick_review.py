"""Show what each selection rule would click, so you can pick one per spot.

Every spot shows several identical-looking green platforms, so no rule can be
guessed from the pixels - you have to look. This renders one sheet per spot: the
same frames repeated once per strategy, with that strategy's choice highlighted.

Scan a spot's sheet, find the row where the highlighted box is the obstacle you
actually want, and put that strategy in the `targets` block of config.yaml.

    python tools/pick_review.py
    python tools/pick_review.py --spots spot_04 --frames 6
"""
import argparse
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
import yaml

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(ROOT / "server"))
from propose_boxes import hsv_boxes, is_scratch   # noqa: E402
from picker import pick_target                    # noqa: E402

RAW = ROOT / "ml" / "dataset" / "raw"
OUT = TOOLS / "pick_review_out"

STRATEGIES = ["largest", "nearest_center", "leftmost", "rightmost",
              "topmost", "bottommost", "smallest"]

CELL_W = 620


def load_frames(label, n):
    files = sorted(f for session in RAW.iterdir()
                   if session.is_dir() and not session.name.startswith("_")
                   for f in (session / label).glob("*.jpg"))
    if not files:
        return []
    # Spread across the whole label, not the first n near-identical frames.
    step = max(1, len(files) // n)
    return files[::step][:n]


def draw(img, boxes, chosen, caption):
    vis = img.copy()
    for b in boxes:
        x, y, w, h = b
        cv2.rectangle(vis, (x, y), (x + w, y + h), (110, 110, 110), 1)
    if chosen:
        x, y, w, h = chosen
        cv2.rectangle(vis, (x, y), (x + w, y + h), (0, 0, 255), 3)
        cv2.drawMarker(vis, (int(x + w / 2), int(y + h / 2)), (0, 255, 255),
                       cv2.MARKER_CROSS, 26, 2)

    scale = CELL_W / vis.shape[1]
    vis = cv2.resize(vis, (CELL_W, int(vis.shape[0] * scale)))
    bar = np.zeros((22, CELL_W, 3), np.uint8)
    cv2.putText(bar, caption, (6, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                (255, 255, 255) if chosen else (90, 90, 255), 1)
    return np.vstack([vis, bar])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spots", nargs="*", help="default: every spot_* found")
    ap.add_argument("--frames", type=int, default=4, help="frames per strategy row")
    ap.add_argument("--config", default=str(ROOT / "server" / "config.yaml"))
    args = ap.parse_args()

    cfg = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
    h = cfg["hsv"]

    labels = args.spots
    if not labels:
        found = set()
        for session in RAW.iterdir():
            if session.is_dir() and not session.name.startswith("_"):
                found.update(p.name for p in session.iterdir()
                             if p.is_dir() and p.name.startswith("spot_"))
        labels = sorted(found)
    if not labels:
        sys.exit(f"no spot_* folders under {RAW}")

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    for label in labels:
        files = load_frames(label, args.frames)
        if not files:
            print(f"{label}: no frames, skipped")
            continue

        frames = []
        for f in files:
            img = cv2.imdecode(np.frombuffer(f.read_bytes(), np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                continue
            boxes = hsv_boxes(img, np.array(h["lo"], np.uint8), np.array(h["hi"], np.uint8),
                              float(h["min_area"]), int(h["morph_kernel"]))
            frames.append((img, boxes))
        if not frames:
            continue

        rows = []
        for strat in STRATEGIES:
            cells = []
            for img, boxes in frames:
                chosen = pick_target(boxes, {"pick": strat}, img.shape)
                caption = f"{strat}   {len(boxes)} boxes" + ("" if chosen else "   NO PICK")
                cells.append(draw(img, boxes, chosen, caption))
            rows.append(np.hstack(cells))

        sheet = np.vstack(rows)
        cv2.imwrite(str(OUT / f"{label}.png"), sheet)
        counts = [len(b) for _, b in frames]
        print(f"{label}: {len(frames)} frames, {min(counts)}-{max(counts)} boxes "
              f"-> {OUT / f'{label}.png'}")

    print(f"\nOne sheet per spot in {OUT}")
    print("Each row is one strategy; red box + yellow cross is what it would click.")
    print("Find the row that is right for that spot, then set it in config.yaml:")
    print('  targets:\n    spot_04: { pick: largest }')


if __name__ == "__main__":
    main()
