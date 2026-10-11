"""Phase 6: calibrate the color reader from labeled boxes, and measure it.

    python -m tools.calibrate_colors fit --cvat exports/s01_cvat.zip exports/s02_cvat.zip
    python -m tools.calibrate_colors test --cvat exports/s05_cvat.zip     # the test session

Input: CVAT exports in "CVAT for images 1.1" format (annotations.xml, zipped or
not) from tasks whose boxes have the `color` attribute filled in. The YOLO
formats don't carry attributes, so export this format as well. Frames are
looked up by file name in data/raw/*/.

fit   fits each color's hue center and spread, saturation and brightness range
      from the boxes and writes them into configs/colors.yaml; reader and
      filter settings, and colors without samples, are kept.
test  runs the color reader on every labeled box and prints the accuracy and a
      confusion matrix. Target: at least 98%.
"""

from __future__ import annotations

import argparse
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import cv2

from detector.color import ColorReader, ColorTable, box_pixels_hsv, calibrate
from detector.common import resolve


def read_cvat_xml(path: Path) -> list[tuple[str, tuple[float, float, float, float], str, str]]:
    """(image file name, box, label, color) for every box that has a color attribute."""
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as z:
            xml = z.read(next(n for n in z.namelist() if n.endswith(".xml")))
    else:
        xml = path.read_bytes()
    out = []
    for image in ET.fromstring(xml).iter("image"):
        name = Path(image.get("name")).name
        for box in image.iter("box"):
            color = next((a.text for a in box.iter("attribute") if a.get("name") == "color"), None)
            if color:
                b = tuple(float(box.get(k)) for k in ("xtl", "ytl", "xbr", "ybr"))
                out.append((name, b, box.get("label"), color.strip()))
    return out


def find_frame(name: str, cache: dict[str, Path], frames_dir: Path) -> Path | None:
    if not cache:
        for f in frames_dir.rglob("*"):
            cache[f.name] = f
    return cache.get(name)


def load_boxes(paths: list[str], frames_dir: Path):
    cache: dict[str, Path] = {}
    by_image = defaultdict(list)
    missing = set()
    for p in paths:
        for name, box, label, color in read_cvat_xml(resolve(p)):
            f = find_frame(name, cache, frames_dir)
            if f is None:
                missing.add(name)
            else:
                by_image[f].append((box, label, color))
    if missing:
        print(f"warning: {len(missing)} frames not found under {frames_dir}, e.g. {sorted(missing)[:3]}")
    if not by_image:
        raise SystemExit("no boxes with a color attribute found")
    return by_image


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("cmd", choices=["fit", "test"])
    p.add_argument("--cvat", nargs="+", required=True, help="CVAT for images 1.1 exports")
    p.add_argument("--colors", default="configs/colors.yaml")
    p.add_argument("--frames-dir", default="data/raw", help="where to look for the frames, by file name")
    a = p.parse_args(argv)

    table = ColorTable.load(a.colors)
    by_image = load_boxes(a.cvat, resolve(a.frames_dir))
    if a.cmd == "fit":
        samples = defaultdict(list)
        for f, boxes in by_image.items():
            img = cv2.imread(str(f))
            for box, _, color in boxes:
                samples[color].append(box_pixels_hsv(img, box, table.reader["center_frac"]))
        specs = calibrate(samples, table.reader)
        table.colors.update(specs)
        path = table.save(a.colors)
        for name, spec in specs.items():
            print(f"  {name:10s} {len(samples[name]):5d} boxes  {spec.to_dict()}")
        print(f"saved {path}")
        return

    reader = ColorReader(table)
    confusion = Counter()
    for f, boxes in by_image.items():
        img = cv2.imread(str(f))
        for box, _, color in boxes:
            read = reader.read(img, box)[0]
            confusion[(color, "unknown" if read.startswith("#") else read)] += 1
    total = sum(confusion.values())
    ok = sum(n for (t, r), n in confusion.items() if t == r)
    names = sorted({t for t, _ in confusion} | {r for _, r in confusion})
    print(f"color accuracy {ok / total:.2%} on {total} boxes (target 98%)\n")
    print("truth \\ read " + "".join(f"{n[:8]:>9s}" for n in names))
    for t in names:
        if any(tt == t for tt, _ in confusion):
            print(f"{t[:12]:12s} " + "".join(f"{confusion[(t, r)]:9d}" for r in names))


if __name__ == "__main__":
    main()
