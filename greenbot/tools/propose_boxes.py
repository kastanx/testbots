"""Bootstrap YOLO clickable labels from HSV green thresholding (v2 Phase 2).

Writes a sibling "<stem>.txt" next to every frame so the Electron box editor
opens with proposals to correct instead of a blank canvas. Wrong boxes are
cheap - fixing one is far faster than drawing one from scratch.

Hand-corrected labels are sacred: an image that already has a .txt is skipped
unless --overwrite is passed, so re-running this after a labelling session can
never undo the human's work.

    python tools/propose_boxes.py
    python tools/propose_boxes.py ml/dataset/raw/session_20260730_2024 --dry-run
    python tools/propose_boxes.py --overwrite --verbose
"""
import argparse
import statistics
import sys
from pathlib import Path

import cv2
import numpy as np
import yaml

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
DEFAULT_CONFIG = ROOT / "server" / "config.yaml"
DEFAULT_SRC = ROOT / "ml" / "dataset" / "raw"

IMAGE_EXTS = {".jpg", ".jpeg", ".png"}

# Single class, per the plan's Phase 1 assumption. Adding classes later means
# re-visiting every label already drawn, which is the expensive part.
CLICKABLE_CLASS = 0


def load_hsv(config_path):
    """The hsv block of server/config.yaml, as ready-to-use values.

    config.yaml is the single source of truth - nothing here re-declares a
    default that could drift away from it.
    """
    path = Path(config_path)
    if not path.exists():
        sys.exit(f"no config at {path}")
    try:
        cfg = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        sys.exit(f"{path} is not valid YAML: {exc}")

    hsv = cfg.get("hsv")
    if not isinstance(hsv, dict):
        sys.exit(f"{path} has no 'hsv:' block")
    for key in ("lo", "hi"):
        value = hsv.get(key)
        if not isinstance(value, (list, tuple)) or len(value) != 3:
            sys.exit(f"{path}: hsv.{key} must be 3 numbers [H, S, V], got {value!r}")
    for key in ("min_area", "morph_kernel"):
        if key not in hsv:
            sys.exit(f"{path}: hsv.{key} is missing")

    return {
        "lo": np.array([int(v) for v in hsv["lo"]], np.uint8),
        "hi": np.array([int(v) for v in hsv["hi"]], np.uint8),
        "min_area": int(hsv["min_area"]),
        "morph_kernel": int(hsv["morph_kernel"]),
    }


def hsv_mask(frame, lo, hi, morph_kernel):
    """The cleaned-up green mask. OPEN kills speckle, CLOSE re-joins a blob
    that an overlapping player or a UI line split in two."""
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, lo, hi)
    if morph_kernel > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                           (morph_kernel, morph_kernel))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    return mask


def hsv_boxes(frame, lo, hi, min_area, morph_kernel):
    """Green blobs -> [(x, y, w, h), ...] in pixels of the given frame.

    The single implementation shared by tune_hsv.py, hsv_review.py and this
    script. If they ever diverge, what you tuned is not what gets labelled.
    """
    mask = hsv_mask(frame, lo, hi, morph_kernel)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return [cv2.boundingRect(c) for c in contours
            if cv2.contourArea(c) >= min_area]


def clamp01(value):
    return 0.0 if value < 0.0 else (1.0 if value > 1.0 else value)


def yolo_lines(boxes, width, height):
    """YOLO rows: "<class> <cx> <cy> <w> <h>", normalized, 6 decimals.

    Clamped because a blob touching the frame edge can round to 1.000001 and
    ultralytics discards the entire label file when a single value is out of
    range - silently turning a labelled frame into an unlabelled one.
    """
    lines = []
    for (x, y, w, h) in boxes:
        if w <= 0 or h <= 0:
            continue
        cx = clamp01((x + w / 2) / width)
        cy = clamp01((y + h / 2) / height)
        nw = clamp01(w / width)
        nh = clamp01(h / height)
        lines.append(f"{CLICKABLE_CLASS} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")
    return lines


# Scratch folders that live alongside real sessions: the collector's --selftest
# writes "_selftest_*", and the bot used to dump low-confidence frames into
# "triage". ml/prepare_dataset.py skips these, so the label tools must too or
# frames that are not part of any session leak into the dataset and the reviews.
def is_scratch(path, src):
    return any(part.startswith("_") or part == "triage"
               for part in path.relative_to(src).parts[:-1])


def find_images(src):
    return sorted(p for p in src.rglob("*")
                  if p.is_file() and p.suffix.lower() in IMAGE_EXTS
                  and not is_scratch(p, src))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="?", default=str(DEFAULT_SRC),
                    help="folder of frames, walked recursively")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG),
                    help="where the hsv values come from")
    ap.add_argument("--overwrite", action="store_true",
                    help="rewrite .txt files that already exist - this DISCARDS "
                         "any hand corrections made in the box editor")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be written, touch nothing")
    ap.add_argument("--verbose", action="store_true",
                    help="one line per image instead of just the summary")
    args = ap.parse_args()

    src = Path(args.src).resolve()
    if not src.is_dir():
        sys.exit(f"not a folder: {src}")

    hsv = load_hsv(args.config)
    images = find_images(src)
    if not images:
        sys.exit(f"no .jpg/.jpeg/.png under {src}")

    print(f"src:    {src}")
    print(f"config: {Path(args.config).resolve()}")
    print(f"hsv:    lo={list(int(v) for v in hsv['lo'])} "
          f"hi={list(int(v) for v in hsv['hi'])} "
          f"min_area={hsv['min_area']} morph_kernel={hsv['morph_kernel']}")
    if args.dry_run:
        print("mode:   DRY RUN - no files are written")
    if args.overwrite:
        print("mode:   OVERWRITE - existing .txt files will be replaced")
    print()

    written = skipped = unreadable = 0
    counts = []            # boxes per processed image
    areas = []             # px^2 per box
    per_folder = {}        # relative folder -> [images, boxes, zero-box images]

    for image in images:
        label_path = image.with_suffix(".txt")
        if label_path.exists() and not args.overwrite:
            skipped += 1
            if args.verbose:
                print(f"SKIP  {image.relative_to(src)}  (.txt exists)")
            continue

        frame = cv2.imread(str(image))
        if frame is None:
            # A truncated capture must not kill a 10k-frame run.
            unreadable += 1
            print(f"WARNING: unreadable, skipped: {image}")
            continue

        height, width = frame.shape[:2]
        boxes = hsv_boxes(frame, hsv["lo"], hsv["hi"],
                          hsv["min_area"], hsv["morph_kernel"])
        lines = yolo_lines(boxes, width, height)

        counts.append(len(lines))
        areas.extend(w * h for (_, _, w, h) in boxes)

        folder = str(image.parent.relative_to(src)).replace("\\", "/")
        stats = per_folder.setdefault(folder, [0, 0, 0])
        stats[0] += 1
        stats[1] += len(lines)
        if not lines:
            stats[2] += 1

        if not args.dry_run:
            # write_bytes, not write_text: text mode on Windows silently turns
            # every "\n" into "\r\n", and the Electron editor round-trips these
            # files byte-for-byte. LF with no trailing newline is the canonical
            # form on both sides. An empty .txt (0 bytes) is a real negative
            # sample, not a missing label.
            label_path.write_bytes("\n".join(lines).encode("utf-8"))
        written += 1
        if args.verbose:
            verb = "WOULD WRITE" if args.dry_run else "WRITE"
            print(f"{verb}  {image.relative_to(src)}  {len(lines)} box(es)")

    if args.verbose and per_folder:
        print()

    if per_folder:
        print(f"{'folder':<42} {'imgs':>6} {'boxes':>7} {'zero':>6}")
        print("-" * 64)
        for folder in sorted(per_folder):
            imgs, boxes_n, zero = per_folder[folder]
            print(f"{folder:<42} {imgs:>6} {boxes_n:>7} {zero:>6}")
        print("-" * 64 + "\n")

    zero = sum(1 for c in counts if c == 0)
    total_boxes = sum(counts)
    verb = "would write" if args.dry_run else "written"
    print(f"{'images scanned':<22} {len(images):>8}")
    print(f"{'.txt ' + verb:<22} {written:>8}")
    print(f"{'skipped (.txt exists)':<22} {skipped:>8}")
    print(f"{'unreadable':<22} {unreadable:>8}")
    print(f"{'images with 0 boxes':<22} {zero:>8}"
          f"{f'   ({zero / len(counts):.1%})' if counts else ''}")
    print(f"{'total boxes':<22} {total_boxes:>8}")
    if counts:
        print(f"{'boxes per image':<22} {statistics.mean(counts):>8.2f} mean, "
              f"{statistics.median(counts):.1f} median")
    if areas:
        print(f"{'mean box area':<22} {statistics.mean(areas):>8.1f} px^2")

    if skipped and not args.overwrite:
        print(f"\n{skipped} image(s) already had labels and were left alone. "
              f"Pass --overwrite only if you mean to discard them.")


if __name__ == "__main__":
    main()
