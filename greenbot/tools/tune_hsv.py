"""Dial in hsv lo / hi / min_area / morph_kernel with live trackbars.

    python tools/tune_hsv.py                          # live screen capture
    python tools/tune_hsv.py --image ml/dataset/raw/session_20260730_2024/spot_01/frame_1785435874724_000000.jpg

Left pane: detected boxes. Right pane: the raw mask.
S writes the four values back into server/config.yaml - only those four lines
change, every other key and comment survives. Q or Esc quits.
"""
import argparse
import re
import sys
from pathlib import Path

import cv2
import numpy as np
import yaml

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent

# Same folder, but the import has to survive being run from any cwd.
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
from propose_boxes import hsv_boxes, hsv_mask, load_hsv   # noqa: E402

DEFAULT_CONFIG = ROOT / "server" / "config.yaml"
WINDOW = "tune"

SLIDERS = [
    ("H lo", 179), ("S lo", 255), ("V lo", 255),
    ("H hi", 179), ("S hi", 255), ("V hi", 255),
    ("min area", 20000),
    ("kernel", 15),
]

HSV_KEYS = ("lo", "hi", "min_area", "morph_kernel")


def write_hsv(path, lo, hi, min_area, morph_kernel):
    """Replace the four hsv values in config.yaml, in place.

    A yaml.safe_dump round-trip would silently delete every comment in the
    file, and config.yaml is the document people read to understand the
    service - so the four value lines are edited as text instead.
    """
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    values = {
        "lo": "[" + ", ".join(str(int(v)) for v in lo) + "]",
        "hi": "[" + ", ".join(str(int(v)) for v in hi) + "]",
        "min_area": str(int(min_area)),
        "morph_kernel": str(int(morph_kernel)),
    }

    start = next((i for i, ln in enumerate(lines)
                  if re.match(r"^hsv:\s*(#.*)?$", ln)), None)
    if start is None:
        sys.exit(f"{path}: no top-level 'hsv:' block to update")

    # The block ends where the next top-level key begins.
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].strip() and not lines[i][:1].isspace():
            end = i
            break

    out = lines[:start + 1]
    seen = set()
    indent = "  "
    i = start + 1
    while i < end:
        match = re.match(r"^(\s+)(lo|hi|min_area|morph_kernel)\s*:(.*)$", lines[i])
        if not match:
            out.append(lines[i])
            i += 1
            continue

        indent, key, rest = match.groups()
        # A block-style list puts its items on the following lines; they are
        # part of this key's value and must go when the value is replaced.
        j = i + 1
        while j < end and lines[j].strip():
            depth = len(lines[j]) - len(lines[j].lstrip())
            item = lines[j].lstrip().startswith("- ")
            if depth > len(indent) or (item and depth >= len(indent)):
                j += 1
                continue
            break

        comment = f"  #{rest.split('#', 1)[1]}" if "#" in rest else ""
        out.append(f"{indent}{key}: {values[key]}{comment}")
        seen.add(key)
        i = j

    missing = [k for k in HSV_KEYS if k not in seen]
    if missing:
        # Land above the blank line that separates the block from the next
        # top-level key, not below it.
        blanks = []
        while out and not out[-1].strip():
            blanks.append(out.pop())
        out += [f"{indent}{key}: {values[key]}" for key in missing]
        out += reversed(blanks)
    out += lines[end:]

    new_text = "\n".join(out) + ("\n" if text.endswith("\n") else "")

    # Never hand back a config the service cannot read: parse the edit and
    # prove it says what was intended and changed nothing else.
    before = yaml.safe_load(text) or {}
    try:
        after = yaml.safe_load(new_text) or {}
    except yaml.YAMLError as exc:
        sys.exit(f"refusing to write {path}: the edit is not valid YAML: {exc}")
    expected = dict(before.get("hsv", {}))
    expected.update({"lo": [int(v) for v in lo], "hi": [int(v) for v in hi],
                     "min_area": int(min_area), "morph_kernel": int(morph_kernel)})
    if after.get("hsv") != expected:
        sys.exit(f"refusing to write {path}: hsv read back as "
                 f"{after.get('hsv')!r}, expected {expected!r}")
    if {k: v for k, v in after.items() if k != "hsv"} != \
       {k: v for k, v in before.items() if k != "hsv"}:
        sys.exit(f"refusing to write {path}: the edit changed keys outside hsv")

    path.write_text(new_text, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", help="tune against a saved frame instead of live capture")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("--monitor", type=int, default=0)
    ap.add_argument("--scale", type=float, default=0.5)
    args = ap.parse_args()

    cfg_path = Path(args.config).resolve()
    cfg = load_hsv(cfg_path)

    still = None
    camera = None
    if args.image:
        still = cv2.imread(args.image)
        if still is None:
            sys.exit(f"could not read {args.image}")
    else:
        try:
            import bettercam
        except ImportError:
            sys.exit("bettercam not installed - pass --image instead")
        camera = bettercam.create(output_idx=args.monitor, output_color="BGR")
        if camera is None:
            sys.exit("could not open the monitor for capture")
        camera.start(target_fps=30, video_mode=True)

    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
    for name, maximum in SLIDERS:
        cv2.createTrackbar(name, WINDOW, 0, maximum, lambda _v: None)

    for name, value in zip(
        [s[0] for s in SLIDERS],
        [*cfg["lo"], *cfg["hi"], cfg["min_area"], cfg["morph_kernel"]],
    ):
        cv2.setTrackbarPos(name, WINDOW, int(value))

    print(__doc__)
    print(f"config: {cfg_path}")
    last = None
    while True:
        frame = still if still is not None else camera.get_latest_frame()
        if frame is None:
            frame = last
            if frame is None:
                continue
        last = frame

        g = lambda n: cv2.getTrackbarPos(n, WINDOW)   # noqa: E731
        lo = np.array([g("H lo"), g("S lo"), g("V lo")], np.uint8)
        hi = np.array([g("H hi"), g("S hi"), g("V hi")], np.uint8)
        min_area = g("min area")
        k = g("kernel")

        # The same call propose_boxes.py makes, so what you see here is
        # exactly what gets written as labels.
        boxes = hsv_boxes(frame, lo, hi, min_area, k)

        shown = cv2.resize(frame, None, fx=args.scale, fy=args.scale)
        s = args.scale
        for (x, y, w, h) in boxes:
            cv2.rectangle(shown, (int(x * s), int(y * s)),
                          (int((x + w) * s), int((y + h) * s)), (0, 255, 0), 2)
        cv2.putText(shown, f"blobs={len(boxes)}", (14, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)

        mask = hsv_mask(frame, lo, hi, k)
        mask_small = cv2.cvtColor(cv2.resize(mask, None, fx=s, fy=s), cv2.COLOR_GRAY2BGR)
        cv2.imshow(WINDOW, np.hstack([shown, mask_small]))

        key = cv2.waitKey(30) & 0xFF
        if key in (27, ord("q")):
            break
        if key == ord("s"):
            write_hsv(cfg_path, lo, hi, min_area, k)
            print(f"saved lo={[int(v) for v in lo]} hi={[int(v) for v in hi]} "
                  f"min_area={int(min_area)} morph_kernel={int(k)} -> {cfg_path}")

    if camera is not None:
        camera.stop()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
