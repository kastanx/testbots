"""Assemble dataset/raw/session_*/<label>/*.jpg into dataset/{train,val}/<label>/.

Validation is always whole held-out sessions. Random per-frame splits leak
near-duplicate consecutive frames across the split and report a fake 99.9%.

    python ml/prepare_dataset.py --val session_20260801_1900
    python ml/prepare_dataset.py --val-newest 1
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

ML = Path(__file__).resolve().parent
RAW = ML / "dataset" / "raw"
OUT = ML / "dataset"
LABELS_FILE = ML.parent / "collector" / "labels.json"
# Records how train/val were built so evaluate.py knows how far to trust a score.
SPLIT_INFO = OUT / "split_info.json"

# Not spots - a scratch folder for frames dumped by the bot's triage mode.
# Anything starting with "_" is scratch too (the collector's --selftest).
IGNORED_SESSIONS = {"triage"}


def sessions():
    if not RAW.exists():
        sys.exit(f"no raw data at {RAW} - run the collector first")
    found = sorted(
        d for d in RAW.iterdir()
        if d.is_dir()
        and d.name not in IGNORED_SESSIONS
        and not d.name.startswith("_")
        and any(d.iterdir())
    )
    if not found:
        sys.exit(f"no session folders under {RAW}")
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


def prepare_tail_split(all_sessions, args):
    """Single-session diagnostic: train on the earlier frames of each label,
    validate on the later ones.

    This is NOT the real evaluation. Frames minutes apart in the same session
    still share lighting, player positions and weather, so the score comes out
    optimistic. It is only good for answering 'can the model separate these
    spots at all' before you invest in more sessions.
    """
    if not 0 < args.holdout_tail < 1:
        sys.exit("--holdout-tail must be between 0 and 1 (e.g. 0.3)")

    for split in ("train", "val"):
        d = OUT / split
        if d.exists():
            shutil.rmtree(d)

    by_label = {}
    for session in all_sessions:
        for label_dir in sorted(p for p in session.iterdir() if p.is_dir()):
            for f in label_dir.glob("*.jpg"):
                by_label.setdefault(label_dir.name, []).append((session.name, f))

    counts = {"train": {}, "val": {}}
    for label, entries in by_label.items():
        entries.sort(key=lambda e: (e[0], frame_time(e[1])))
        cut = int(len(entries) * (1 - args.holdout_tail))
        cut = min(max(cut, 1), len(entries) - 1) if len(entries) > 1 else len(entries)
        for split, chunk in (("train", entries[:cut]), ("val", entries[cut:])):
            if not chunk:
                continue
            dst_dir = OUT / split / label
            dst_dir.mkdir(parents=True, exist_ok=True)
            for session_name, f in chunk:
                link_or_copy(f, dst_dir / f"{session_name}_{f.name}", args.copy)
            counts[split][label] = len(chunk)

    print("=" * 62)
    print("DIAGNOSTIC SPLIT - not a real evaluation.")
    print(f"Train on the first {1 - args.holdout_tail:.0%} of each label by capture")
    print(f"time, validate on the last {args.holdout_tail:.0%}. Same session means")
    print("shared lighting and player positions, so accuracy will read high.")
    print("Record a second session and use --val-newest 1 before trusting a number.")
    print("=" * 62 + "\n")

    print(f"{'label':<12} {'train':>7} {'val':>7}")
    print("-" * 28)
    for label in sorted(by_label):
        print(f"{label:<12} {counts['train'].get(label, 0):>7} {counts['val'].get(label, 0):>7}")
    print("-" * 28)
    print(f"{'TOTAL':<12} {sum(counts['train'].values()):>7} {sum(counts['val'].values()):>7}")

    SPLIT_INFO.write_text(json.dumps({
        "mode": "holdout_tail",
        "fraction": args.holdout_tail,
        "sessions": [s.name for s in all_sessions],
        "trustworthy": False,
    }, indent=2), encoding="utf-8")

    if "transit" not in by_label:
        print("\nWARNING: no 'transit' class. Without it the bot has no way to know")
        print("it is mid-move, and will click while you are walking between spots.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--val", nargs="*", default=[], metavar="SESSION",
                    help="session folder names to hold out for validation")
    ap.add_argument("--val-newest", type=int, default=0, metavar="N",
                    help="hold out the N newest sessions by name")
    ap.add_argument("--copy", action="store_true",
                    help="copy files instead of hardlinking")
    ap.add_argument("--drop-incomplete", action="store_true",
                    help="exclude labels that are missing from either split, so a "
                         "spot you have only recorded once does not block training "
                         "on the ones you have recorded twice")
    ap.add_argument("--holdout-tail", type=float, default=0, metavar="FRACTION",
                    help="DIAGNOSTIC ONLY: no session split, hold out the last "
                         "FRACTION of each label by capture time. Use when you "
                         "have a single session and want an early go/no-go read.")
    args = ap.parse_args()

    all_sessions = sessions()

    if args.holdout_tail:
        return prepare_tail_split(all_sessions, args)
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

    for split in ("train", "val"):
        d = OUT / split
        if d.exists():
            shutil.rmtree(d)

    # Which labels each split can actually supply, decided before anything is
    # copied. A label recorded in only one session is val-only or train-only,
    # and ultralytics would silently build a model whose class indices no longer
    # match what the service reports.
    available = {"train": set(), "val": set()}
    for session in all_sessions:
        split = "val" if session.name in val_names else "train"
        for label_dir in (p for p in session.iterdir() if p.is_dir()):
            if any(label_dir.glob("*.jpg")):
                available[split].add(label_dir.name)

    incomplete = sorted(available["train"] ^ available["val"])
    usable = available["train"] & available["val"]
    if incomplete and args.drop_incomplete:
        print("dropping labels that are missing from a split (--drop-incomplete):")
        for label in incomplete:
            side = "val" if label in available["val"] else "train"
            print(f"  {label}: only in {side} - record it in another session to include it")
        print()

    counts = {"train": {}, "val": {}}
    for session in all_sessions:
        split = "val" if session.name in val_names else "train"
        for label_dir in sorted(p for p in session.iterdir() if p.is_dir()):
            if args.drop_incomplete and label_dir.name not in usable:
                continue
            files = sorted(label_dir.glob("*.jpg"))
            if not files:
                continue
            dst_dir = OUT / split / label_dir.name
            dst_dir.mkdir(parents=True, exist_ok=True)
            for f in files:
                link_or_copy(f, dst_dir / f"{session.name}_{f.name}", args.copy)
            counts[split][label_dir.name] = counts[split].get(label_dir.name, 0) + len(files)

    print(f"train sessions: {', '.join(s.name for s in all_sessions if s.name not in val_names)}")
    print(f"val   sessions: {', '.join(sorted(val_names))}\n")

    labels = sorted(set(counts["train"]) | set(counts["val"]))
    print(f"{'label':<12} {'train':>7} {'val':>7}")
    print("-" * 28)
    for label in labels:
        print(f"{label:<12} {counts['train'].get(label, 0):>7} {counts['val'].get(label, 0):>7}")
    print("-" * 28)
    print(f"{'TOTAL':<12} {sum(counts['train'].values()):>7} {sum(counts['val'].values()):>7}\n")

    # Ultralytics silently drops classes missing from a split; the resulting
    # class indices then differ from what the bot expects at runtime.
    problems = []
    for label in labels:
        if not counts["train"].get(label):
            problems.append(f"  {label}: 0 train images")
        if not counts["val"].get(label):
            problems.append(f"  {label}: 0 val images")

    if LABELS_FILE.exists():
        expected = set(json.loads(LABELS_FILE.read_text()))
        dropped = set(incomplete) if args.drop_incomplete else set()
        for missing in sorted(expected - set(labels) - dropped):
            problems.append(f"  {missing}: never recorded")
        for extra in sorted(set(labels) - expected):
            problems.append(f"  {extra}: not in labels.json")

    SPLIT_INFO.write_text(json.dumps({
        "mode": "held_out_sessions",
        "val_sessions": sorted(val_names),
        "trustworthy": True,
    }, indent=2), encoding="utf-8")

    if problems:
        print("WARNINGS:")
        print("\n".join(problems))
        print("\nEvery label needs images in BOTH splits before training.")
    else:
        print("OK - ready to train.")


if __name__ == "__main__":
    main()
