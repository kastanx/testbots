"""Phase 3: assemble the YOLO dataset from the labeled sessions.

    python -m tools.build_dataset

Reads configs/dataset.yaml (which session goes into which split, and where its
labels are), takes the frames from data/raw/<session>/, and writes
datasets/game/{images,labels}/{train,val,test} plus configs/data.yaml. Labels
come from data/labels/<session>/ (tools.label) unless the session names a CVAT
export ("Ultralytics YOLO Detection" or "YOLO 1.1", zipped or unpacked). Frames
are hard-linked rather than copied where the disk allows it. datasets/game/ is
rebuilt from scratch on every run.
"""

from __future__ import annotations

import argparse
import os
import shutil
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np
import yaml
from PIL import Image

from detector.common import load_yaml, resolve, save_yaml

SPLITS = ("train", "val", "test")
NOT_LABELS = {"train.txt", "val.txt", "valid.txt", "test.txt"}


def read_export(path: Path) -> tuple[list[str], dict[str, str]]:
    """(class names, {frame stem: YOLO label text}) from a CVAT export."""
    files: dict[str, bytes] = {}
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as z:
            for n in z.namelist():
                if n.endswith((".txt", ".yaml", ".yml", ".names")):
                    files[n] = z.read(n)
    elif path.is_dir():
        for f in path.rglob("*"):
            if f.suffix in (".txt", ".yaml", ".yml", ".names"):
                files[f.relative_to(path).as_posix()] = f.read_bytes()
    else:
        raise SystemExit(f"{path}: not found")
    names = None
    for n, data in files.items():
        base = n.rsplit("/", 1)[-1]
        if base == "obj.names":
            names = [line.strip() for line in data.decode().splitlines() if line.strip()]
        elif base in ("data.yaml", "data.yml"):
            nm = (yaml.safe_load(data) or {}).get("names")
            names = [nm[k] for k in sorted(nm)] if isinstance(nm, dict) else list(nm or [])
    if not names:
        raise SystemExit(f"{path}: no obj.names or data.yaml. Was it exported in a YOLO format?")
    labels = {}
    for n, data in files.items():
        base = n.rsplit("/", 1)[-1]
        if base.endswith(".txt") and base not in NOT_LABELS:
            labels[base[:-4]] = data.decode()
    return names, labels


def link_or_copy(src: Path, dst: Path) -> None:
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def write_tiles(img_path: Path, boxes: list[tuple], n: int, crop_px: int, tile_px: int, img_dir: Path,
                lbl_dir: Path, rng) -> list[list[int]]:
    """Square crops of a frame, mostly centred near objects, saved at tile_px.

    crop_px full-resolution pixels become tile_px, which is the same shrink a
    whole frame gets when it is detected at the inference size. Objects keep the
    size they will have live, and training sees many object-dense samples instead
    of a few huge mostly-empty frames. A crop that would cut an object badly
    (5-60% inside) is re-drawn, so no half-visible object becomes "background".
    Returns the class ids in each written tile.
    """
    img = cv2.imread(str(img_path))
    H, W = img.shape[:2]
    c = min(crop_px, W, H)
    px = [(cl, (cx - w / 2) * W, (cy - h / 2) * H, (cx + w / 2) * W, (cy + h / 2) * H) for cl, cx, cy, w, h in boxes]
    written = []
    for t in range(n):
        for _ in range(30):
            if px and rng.random() < 0.8:  # put a random object somewhere inside the crop
                _, x1, y1, x2, y2 = px[rng.integers(len(px))]
                ox = (x1 + x2) / 2 - rng.uniform(0.1, 0.9) * c
                oy = (y1 + y2) / 2 - rng.uniform(0.1, 0.9) * c
            else:
                ox, oy = rng.uniform(0, W - c), rng.uniform(0, H - c)
            ox, oy = int(np.clip(ox, 0, W - c)), int(np.clip(oy, 0, H - c))
            keep, clean = [], True
            for cl, x1, y1, x2, y2 in px:
                ix1, iy1, ix2, iy2 = max(x1, ox), max(y1, oy), min(x2, ox + c), min(y2, oy + c)
                inside = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1) / max(1e-6, (x2 - x1) * (y2 - y1))
                if 0.05 < inside < 0.6:
                    clean = False
                    break
                if inside >= 0.6:
                    keep.append((cl, ix1 - ox, iy1 - oy, ix2 - ox, iy2 - oy))
            if clean:
                break
        else:
            continue
        name = f"{img_path.stem}_t{t:03d}"
        tile = cv2.resize(img[oy:oy + c, ox:ox + c], (tile_px, tile_px), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(img_dir / f"{name}.png"), tile)
        lines = [f"{cl} {(x1 + x2) / 2 / c:.6f} {(y1 + y2) / 2 / c:.6f} {(x2 - x1) / c:.6f} {(y2 - y1) / c:.6f}"
                 for cl, x1, y1, x2, y2 in keep]
        (lbl_dir / f"{name}.txt").write_text("\n".join(lines) + ("\n" if lines else ""))
        written.append([k[0] for k in keep])
    return written


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--manifest", default="configs/dataset.yaml")
    p.add_argument("--out", default="datasets/game")
    p.add_argument("--raw", default="data/raw", help="where the session folders are")
    p.add_argument("--data-yaml", default="configs/data.yaml", help="where to write the Ultralytics dataset config")
    p.add_argument("--tiles", type=int, default=0,
                   help="train/val on this many crops per frame instead of whole frames (test stays whole)")
    p.add_argument("--infer-imgsz", type=int, default=1920, help="with --tiles: whole frames are detected at this size")
    p.add_argument("--tile-imgsz", type=int, default=640, help="with --tiles: crop size after shrinking (train imgsz)")
    a = p.parse_args(argv)
    rng = np.random.default_rng(0)

    man = load_yaml(a.manifest)
    names = list(man.get("names") or [])
    sessions = man.get("sessions") or {}
    if not names or not sessions:
        raise SystemExit(f"{a.manifest} needs `names` and at least one entry under `sessions`")
    out = resolve(a.out)
    if out.exists():
        if not (out / ".generated").exists():
            raise SystemExit(f"{out} exists but was not written by this tool; move it away first")
        shutil.rmtree(out)
    for split in SPLITS:
        (out / "images" / split).mkdir(parents=True)
        (out / "labels" / split).mkdir(parents=True)
    (out / ".generated").write_text("Written by tools/build_dataset.py and rebuilt from scratch on every run.\n")

    stats: dict[str, Counter] = defaultdict(Counter)
    split_sessions: dict[str, list[str]] = defaultdict(list)
    problems: list[str] = []
    for sid, s in sessions.items():
        s = s or {}
        split = s.get("split")
        if split not in SPLITS + ("trainval",):
            raise SystemExit(f"session {sid}: split must be one of {SPLITS + ('trainval',)}")
        for sp in ("train", "val") if split == "trainval" else (split,):
            split_sessions[sp].append(sid)
        ex_names, labels = read_export(resolve(s["labels"]) if s.get("labels") else resolve("data/labels") / sid)
        remap = {i: names.index(n) for i, n in enumerate(ex_names) if n in names}
        for n in ex_names:
            if n not in names:
                problems.append(f"{sid}: class '{n}' is not in names; its boxes are dropped")
        raw = resolve(a.raw) / sid
        stems = sorted(labels)
        n_train = round(len(stems) * 0.8)  # trainval: split in recording order, never at random
        for k, stem in enumerate(stems):
            text = labels[stem]
            split = s["split"] if s["split"] != "trainval" else ("train" if k < n_train else "val")
            img = next((raw / f"{stem}{ext}" for ext in (".png", ".jpg", ".jpeg") if (raw / f"{stem}{ext}").exists()),
                       None)
            if img is None:
                problems.append(f"{sid}: no frame {stem}.* in {raw}")
                continue
            boxes = []
            for line in text.splitlines():
                parts = line.split()
                if len(parts) != 5:
                    continue
                c = int(float(parts[0]))
                if c not in remap:
                    stats[split]["dropped boxes"] += 1
                    continue
                boxes.append((remap[c], *(min(1.0, max(0.0, float(v))) for v in parts[1:])))
            if a.tiles and split != "test":
                with Image.open(img) as im:
                    crop_px = round(a.tile_imgsz * max(im.size) / a.infer_imgsz)
                n_tiles = int(s.get("tiles", a.tiles))  # a session can ask for more crops (few labeled frames)
                for tile in write_tiles(img, boxes, n_tiles, crop_px, a.tile_imgsz, out / "images" / split,
                                        out / "labels" / split, rng):
                    stats[split]["images"] += 1
                    stats[split]["empty"] += not tile
                    for cl in tile:
                        stats[split][names[cl]] += 1
                continue
            lines = [f"{cl} " + " ".join(f"{v:.6f}" for v in vals) for cl, *vals in boxes]
            link_or_copy(img, out / "images" / split / img.name)
            (out / "labels" / split / f"{stem}.txt").write_text("\n".join(lines) + ("\n" if lines else ""))
            stats[split]["images"] += 1
            stats[split]["empty"] += not lines
            for cl, *_ in boxes:
                stats[split][names[cl]] += 1

    data = {"path": str(out), "train": "images/train", "val": "images/val", "test": "images/test",
            "names": {i: n for i, n in enumerate(names)}}
    if a.tiles:  # tools.train records this, so the live app detects whole frames at the matching size
        data["infer_imgsz"] = a.infer_imgsz
    save_yaml(resolve(a.data_yaml), data, header=f"# Written by tools/build_dataset.py from {a.manifest}\n")

    print(f"{'split':6s} {'sessions':24s} {'images':>7s} {'empty':>6s}  " + "  ".join(f"{n:>10s}" for n in names))
    for split in SPLITS:
        st = stats[split]
        empty = f"{st['empty'] / st['images']:.0%}" if st["images"] else "-"
        print(f"{split:6s} {','.join(split_sessions[split]) or '-':24s} {st['images']:7d} {empty:>6s}  "
              + "  ".join(f"{st[n]:10d}" for n in names))
        if st["images"] and st["empty"] / st["images"] > 0.25:
            problems.append(f"{split}: {st['empty']} of {st['images']} frames have no boxes. Unlabeled frames "
                            f"teach the model that objects are background; only export fully labeled frames.")
        if not st["images"]:
            problems.append(f"{split}: no frames")
    for msg in problems:
        print("warning:", msg)
    print(f"\nwrote {out} and {resolve(a.data_yaml)}")


if __name__ == "__main__":
    main()
