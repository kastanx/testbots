"""Assemble dataset-detect/{images,labels}/{train,val} from the labelled frames.

Only frames that already have a sibling .txt are taken. An EMPTY .txt is not a
mistake and not "unlabelled" - it is a frame the labeller confirmed has no
clickables in it, which is exactly the hard negative that stops the detector
boxing players. It is copied through like any other sample.

Validation is always whole held-out sessions. Random per-frame splits leak
near-duplicate consecutive frames across the split and report a fake 99.9%.

    python ml/prepare_detect_dataset.py --val session_20260801_1900
    python ml/prepare_detect_dataset.py --val-newest 1
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

ML = Path(__file__).resolve().parent
RAW = ML / "dataset" / "raw"
OUT = ML / "dataset-detect"

# Single class for now. Adding one later means relabelling, so the validator
# below refuses any class index this list does not cover.
CLASS_NAMES = ["clickable"]

# Not spots - a scratch folder for frames dumped by the bot's triage mode.
# Anything starting with "_" is scratch too (the collector's --selftest).
IGNORED_SESSIONS = {"triage"}

DATA_YAML = """\
# Written by ml/prepare_detect_dataset.py - regenerate it, do not hand-edit.
# 'path' is absolute: ultralytics resolves it against the CWD otherwise, and
# training is launched from all sorts of places.
path: {path}
train: images/train
val: images/val
names:
{names}
"""


def sessions(raw):
    if not raw.exists():
        sys.exit(f"no raw data at {raw} - run the collector first")
    found = sorted(
        d for d in raw.iterdir()
        if d.is_dir()
        and d.name not in IGNORED_SESSIONS
        and not d.name.startswith("_")
        and any(d.iterdir())
    )
    if not found:
        sys.exit(f"no session folders under {raw}")
    return found


def link_or_copy(src: Path, dst: Path, copy: bool):
    if dst.exists():
        return
    if not copy:
        try:
            os.link(src, dst)      # same volume, NTFS: instant and no extra disk
            return
        except OSError:
            pass
    shutil.copy2(src, dst)


def frame_time(path: Path):
    """Capture ms out of frame_<ms>_<seq>.jpg; falls back to filename order."""
    try:
        return int(path.stem.split("_")[1])
    except (IndexError, ValueError):
        return 0


def box_count(txt):
    """Validate one YOLO label file and return how many boxes it holds.

    A malformed line trains the detector on garbage without ever raising, so
    it stops the run instead. Zero boxes is legal and returns 0.
    """
    n = 0
    for lineno, raw_line in enumerate(txt.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 5:
            sys.exit(f"{txt}:{lineno}: expected '<class> <cx> <cy> <w> <h>', "
                     f"got {len(parts)} field(s): {line}")
        try:
            cls = int(parts[0])
            coords = [float(v) for v in parts[1:]]
        except ValueError:
            sys.exit(f"{txt}:{lineno}: non-numeric label line: {line}")
        if not 0 <= cls < len(CLASS_NAMES):
            sys.exit(f"{txt}:{lineno}: class {cls}, but data.yaml only defines "
                     f"{', '.join(f'{i}={c}' for i, c in enumerate(CLASS_NAMES))}")
        if any(not 0.0 <= v <= 1.0 for v in coords):
            sys.exit(f"{txt}:{lineno}: coordinates must be normalized 0-1: {line}")
        if coords[2] <= 0 or coords[3] <= 0:
            sys.exit(f"{txt}:{lineno}: box has zero width or height: {line}")
        n += 1
    return n


def collect(all_sessions):
    """Walk the raw tree and pair every .jpg with its label file.

    Returns (entries, skipped, total) where an entry is
    (session_name, label, jpg, txt, n_boxes).
    """
    entries = []
    skipped = 0
    total = 0
    for session in all_sessions:
        for label_dir in sorted(p for p in session.iterdir() if p.is_dir()):
            for jpg in sorted(label_dir.glob("*.jpg")):
                total += 1
                txt = jpg.with_suffix(".txt")
                if not txt.exists():
                    skipped += 1
                    continue
                entries.append((session.name, label_dir.name, jpg,
                                txt, box_count(txt)))
    return entries, skipped, total


def split_by_session(entries, val_names):
    out = {"train": [], "val": []}
    for entry in entries:
        out["val" if entry[0] in val_names else "train"].append(entry)
    return out


def split_by_tail(entries, fraction):
    """Single-session diagnostic: earlier frames train, later frames validate.

    Split per label so both halves still see every location. This is NOT the
    real evaluation - see the banner printed for it below.
    """
    by_label = {}
    for entry in entries:
        by_label.setdefault(entry[1], []).append(entry)

    out = {"train": [], "val": []}
    for label, group in sorted(by_label.items()):
        group.sort(key=lambda e: (e[0], frame_time(e[2])))
        cut = int(len(group) * (1 - fraction))
        cut = min(max(cut, 1), len(group) - 1) if len(group) > 1 else len(group)
        out["train"].extend(group[:cut])
        out["val"].extend(group[cut:])
    return out


def write_dataset(split, out_dir, copy):
    """Wipe and rebuild images/ and labels/. Returns per-split counters."""
    for sub in ("images", "labels"):
        d = out_dir / sub
        if d.exists():
            shutil.rmtree(d)

    stats = {}
    for name in ("train", "val"):
        img_dir = out_dir / "images" / name
        lbl_dir = out_dir / "labels" / name
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)

        seen = {}
        counter = {"images": 0, "boxes": 0, "empty": 0}
        for session_name, _label, jpg, txt, n in split[name]:
            stem = f"{session_name}_{jpg.stem}"
            if stem in seen:
                sys.exit(f"two raw frames map to the same name '{stem}.jpg':\n"
                         f"  {seen[stem]}\n  {jpg}")
            seen[stem] = jpg
            link_or_copy(jpg, img_dir / f"{stem}.jpg", copy)
            link_or_copy(txt, lbl_dir / f"{stem}.txt", copy)
            counter["images"] += 1
            counter["boxes"] += n
            counter["empty"] += 1 if n == 0 else 0
        stats[name] = counter
    return stats


def write_data_yaml(out_dir):
    names = "\n".join(f"  {i}: {c}" for i, c in enumerate(CLASS_NAMES))
    path = out_dir / "data.yaml"
    path.write_text(DATA_YAML.format(path=out_dir.as_posix(), names=names),
                    encoding="utf-8")
    return path


def print_table(stats):
    print(f"{'split':<8} {'images':>8} {'boxes':>8} {'empty':>8}")
    print("-" * 35)
    for name in ("train", "val"):
        c = stats[name]
        print(f"{name:<8} {c['images']:>8} {c['boxes']:>8} {c['empty']:>8}")
    print("-" * 35)
    print(f"{'TOTAL':<8} {sum(c['images'] for c in stats.values()):>8} "
          f"{sum(c['boxes'] for c in stats.values()):>8} "
          f"{sum(c['empty'] for c in stats.values()):>8}\n")
    print("'empty' = frames labelled as containing no clickable. Those are real")
    print("negatives and are meant to be there.\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--val", nargs="*", default=[], metavar="SESSION",
                    help="session folder names to hold out for validation")
    ap.add_argument("--val-newest", type=int, default=0, metavar="N",
                    help="hold out the N newest sessions by name")
    ap.add_argument("--copy", action="store_true",
                    help="copy files instead of hardlinking")
    ap.add_argument("--holdout-tail", type=float, default=0, metavar="FRACTION",
                    help="DIAGNOSTIC ONLY: no session split, hold out the last "
                         "FRACTION of each label by capture time. Use when you "
                         "have a single session and want an early go/no-go read.")
    ap.add_argument("--raw", default=str(RAW), metavar="DIR",
                    help="raw session tree to read (default ml/dataset/raw)")
    ap.add_argument("--out", default=str(OUT), metavar="DIR",
                    help="dataset to build (default ml/dataset-detect)")
    args = ap.parse_args()

    raw = Path(args.raw).resolve()
    out_dir = Path(args.out).resolve()
    all_sessions = sessions(raw)

    entries, skipped, total = collect(all_sessions)
    print(f"raw frames: {total}   labelled: {len(entries)}   "
          f"skipped (no .txt): {skipped}")
    if not entries:
        sys.exit(f"none of the {total} raw frames has a sibling .txt - "
                 f"label some frames in the collector's box mode first")

    if args.holdout_tail:
        if not 0 < args.holdout_tail < 1:
            sys.exit("--holdout-tail must be between 0 and 1 (e.g. 0.3)")
        split = split_by_tail(entries, args.holdout_tail)
        info = {
            "mode": "holdout_tail",
            "fraction": args.holdout_tail,
            "sessions": [s.name for s in all_sessions],
            "trustworthy": False,
        }
        banner = [
            "=" * 62,
            "DIAGNOSTIC SPLIT - not a real evaluation.",
            f"Train on the first {1 - args.holdout_tail:.0%} of each label by capture",
            f"time, validate on the last {args.holdout_tail:.0%}. Same session means",
            "shared lighting and player positions, so precision/recall read high.",
            "Record a second session and use --val-newest 1 before trusting a number.",
            "=" * 62 + "\n",
        ]
    else:
        val_names = set(args.val)
        if args.val_newest:
            val_names |= {s.name for s in all_sessions[-args.val_newest:]}

        unknown = val_names - {s.name for s in all_sessions}
        if unknown:
            sys.exit(f"unknown session(s): {', '.join(sorted(unknown))}\n"
                     f"available: {', '.join(s.name for s in all_sessions)}")
        if not val_names:
            sys.exit("no validation sessions selected - pass --val <name> or --val-newest 1")
        if val_names == {s.name for s in all_sessions}:
            sys.exit("every session was selected for validation - nothing left to train on")

        split = split_by_session(entries, val_names)
        info = {
            "mode": "held_out_sessions",
            "val_sessions": sorted(val_names),
            "trustworthy": True,
        }
        train_names = [s.name for s in all_sessions if s.name not in val_names]
        banner = [
            f"train sessions: {', '.join(train_names)}",
            f"val   sessions: {', '.join(sorted(val_names))}\n",
        ]

    # Check before touching the output tree: a bad split must not destroy the
    # dataset that is already sitting there.
    for name in ("train", "val"):
        if not split[name]:
            sys.exit(f"the {name} split came out empty - "
                     f"{len(entries)} labelled frame(s) all landed in the other split")

    stats = write_dataset(split, out_dir, args.copy)
    data_yaml = write_data_yaml(out_dir)
    (out_dir / "split_info.json").write_text(json.dumps(info, indent=2),
                                             encoding="utf-8")

    print()
    for line in banner:
        print(line)
    print_table(stats)

    if not stats["train"]["boxes"]:
        print("WARNING: not one box in the train split. The detector has nothing")
        print("positive to learn from - check that the labels really saved.\n")

    print(f"data.yaml: {data_yaml}")
    print("OK - ready to train:  python ml/train_detector.py")


if __name__ == "__main__":
    main()
