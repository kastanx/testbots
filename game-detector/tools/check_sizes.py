"""Phase 4, before training: how big are the objects once frames are shrunk to imgsz?

    python -m tools.check_sizes                          # configs/data.yaml at 640, 960, 1280
    python -m tools.check_sizes --imgsz 640 --data datasets/synth/data.yaml

Training shrinks every frame so that its longer side is imgsz. Objects that end
up smaller than about 10-12 px are hard to learn: train at 960 or 1280, or
capture a smaller region.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

from detector.capture import IMAGE_EXTS, label_path_for
from detector.common import load_yaml


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default="configs/data.yaml")
    p.add_argument("--imgsz", type=int, nargs="+", default=[640, 960, 1280])
    a = p.parse_args(argv)

    data = load_yaml(a.data)
    if not data:
        raise SystemExit(f"{a.data} not found; run tools.build_dataset first")
    names = data["names"]
    names = [names[k] for k in sorted(names)] if isinstance(names, dict) else list(names)
    root = Path(data["path"])
    sides = defaultdict(list)  # class -> shorter box side relative to the frame's longer side
    for split in ("train", "val", "test"):
        if not data.get(split):
            continue
        for img in (root / data[split]).rglob("*"):
            if img.suffix.lower() not in IMAGE_EXTS:
                continue
            lp = label_path_for(img)
            if not lp.exists():
                continue
            with Image.open(img) as im:
                w, h = im.size
            for line in lp.read_text().splitlines():
                parts = line.split()
                if len(parts) == 5:
                    c, bw, bh = int(parts[0]), float(parts[3]) * w, float(parts[4]) * h
                    sides[names[c]].append(min(bw, bh) / max(w, h))
    if not sides:
        raise SystemExit("no labeled boxes found")

    for size in a.imgsz:
        print(f"\nimgsz {size}: shorter box side in px after resizing")
        print(f"  {'class':14s} {'boxes':>6s} {'p5':>6s} {'p50':>6s} {'p95':>6s} {'<10px':>7s} {'<12px':>7s}")
        for name in names:
            v = np.array(sides.get(name, [])) * size
            if not len(v):
                continue
            print(f"  {name:14s} {len(v):6d} {np.percentile(v, 5):6.1f} {np.percentile(v, 50):6.1f} "
                  f"{np.percentile(v, 95):6.1f} {(v < 10).mean():7.1%} {(v < 12).mean():7.1%}")
    allv = np.concatenate([np.array(v) for v in sides.values()])
    for size in sorted(a.imgsz):
        if (allv * size < 12).mean() <= 0.05:
            print(f"\nsuggestion: imgsz {size} keeps 95% of the boxes at 12 px or more")
            break
    else:
        print("\nsuggestion: even the largest imgsz leaves many tiny boxes; capture a smaller region")


if __name__ == "__main__":
    main()
