"""The v2 Phase 1 go/no-go: is HSV thresholding good enough on its own?

Samples frames spread evenly over every session and every label, draws the HSV
boxes on them, and dumps contact sheets you can flip through in 30 minutes.
Then it prints the statistics the plan asks for and a verdict against its
~2% rule: more than ~2% of frames with false positives or misses -> Option B
(train the YOLO detector) instead of Option A (ship HSV).

Nothing is written next to the frames - this tool never creates labels.

    python tools/hsv_review.py
    python tools/hsv_review.py --n 300 --grid 4x3 --expect-max 8
    python tools/hsv_review.py --interactive
"""
import argparse
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent

# Same folder, but the import has to survive being run from any cwd.
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
from propose_boxes import find_images, hsv_boxes, load_hsv   # noqa: E402

DEFAULT_CONFIG = ROOT / "server" / "config.yaml"
DEFAULT_SRC = ROOT / "ml" / "dataset" / "raw"
OUT_DIR = TOOLS / "hsv_review_out"

WINDOW = "hsv review"
BG = (32, 32, 32)
OK_COLOUR = (0, 255, 0)
ZERO_COLOUR = (0, 200, 255)     # amber: nothing found at all
BUSY_COLOUR = (0, 0, 255)       # red: implausibly many blobs
CAPTION_H = 20


def group_key(image, src):
    """session/label - the folder an image sits in, relative to src."""
    rel = image.parent.relative_to(src)
    return str(rel).replace("\\", "/") if str(rel) != "." else "."


def evenly_spaced(items, k):
    """k items spread across the whole list, not the first k.

    Consecutive frames are near-duplicates, so taking a prefix would review
    the same three seconds of footage over and over.
    """
    if k >= len(items):
        return list(items)
    if k <= 0:
        return []
    if k == 1:
        return [items[len(items) // 2]]
    return [items[round(i * (len(items) - 1) / (k - 1))] for i in range(k)]


def sample(images, src, n):
    """Fair share of n across every (session, label) folder.

    Smallest folders are served first so the leftovers of an under-sized
    folder flow to the folders that actually have frames to give.
    """
    groups = {}
    for image in images:
        groups.setdefault(group_key(image, src), []).append(image)

    picked = []
    remaining = n
    keys = sorted(groups, key=lambda k: (len(groups[k]), k))
    for i, key in enumerate(keys):
        quota = max(1, remaining // (len(keys) - i))
        take = min(quota, len(groups[key]))
        picked.extend(evenly_spaced(sorted(groups[key]), take))
        remaining -= take
    return sorted(picked), groups


def colour_for(count, expect_max):
    if count == 0:
        return ZERO_COLOUR
    if count > expect_max:
        return BUSY_COLOUR
    return OK_COLOUR


def draw(frame, boxes, colour, thickness=2):
    shown = frame.copy()
    for (x, y, w, h) in boxes:
        cv2.rectangle(shown, (x, y), (x + w, y + h), colour, thickness)
    return shown


def make_cell(frame, boxes, cell_w, cell_h, caption, count, expect_max):
    """One letterboxed thumbnail with its boxes drawn and a caption strip."""
    height, width = frame.shape[:2]
    scale = min(cell_w / width, cell_h / height)
    thumb = cv2.resize(frame, (max(1, round(width * scale)),
                               max(1, round(height * scale))),
                       interpolation=cv2.INTER_AREA)

    colour = colour_for(count, expect_max)
    for (x, y, w, h) in boxes:
        cv2.rectangle(thumb,
                      (round(x * scale), round(y * scale)),
                      (round((x + w) * scale), round((y + h) * scale)),
                      colour, 1)

    cell = np.full((cell_h + CAPTION_H, cell_w, 3), BG, np.uint8)
    y0 = (cell_h - thumb.shape[0]) // 2
    x0 = (cell_w - thumb.shape[1]) // 2
    cell[y0:y0 + thumb.shape[0], x0:x0 + thumb.shape[1]] = thumb
    cv2.rectangle(cell, (x0, y0),
                  (x0 + thumb.shape[1] - 1, y0 + thumb.shape[0] - 1), colour, 1)

    # Right-align the count so the eye can scan the column for outliers.
    tag = f"n={count}"
    (tw, _), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
    room = max(4, int((cell_w - tw - 12) / 7))
    cv2.putText(cell, caption[-room:], (4, cell_h + 14),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (200, 200, 200), 1, cv2.LINE_AA)
    cv2.putText(cell, tag, (cell_w - tw - 4, cell_h + 14),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, colour, 1, cv2.LINE_AA)
    return cell


def write_sheets(results, cols, rows, cell_w, expect_max):
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True)

    # One aspect ratio for the whole grid, taken from the first frame; frames
    # of another size get letterboxed rather than stretched.
    first = results[0]["shape"]
    cell_h = max(1, round(cell_w * first[0] / first[1]))

    per_sheet = cols * rows
    sheets = 0
    for start in range(0, len(results), per_sheet):
        chunk = results[start:start + per_sheet]
        sheet = np.full((rows * (cell_h + CAPTION_H), cols * cell_w, 3), BG, np.uint8)
        for i, item in enumerate(chunk):
            frame = cv2.imread(str(item["path"]))
            if frame is None:
                continue
            caption = f"{item['group']}/{item['path'].stem}"
            cell = make_cell(frame, item["boxes"], cell_w, cell_h,
                             caption, len(item["boxes"]), expect_max)
            r, c = divmod(i, cols)
            sheet[r * (cell_h + CAPTION_H):(r + 1) * (cell_h + CAPTION_H),
                  c * cell_w:(c + 1) * cell_w] = cell
        sheets += 1
        cv2.imwrite(str(OUT_DIR / f"sheet_{sheets:03d}.png"), sheet)
    return sheets, (cols * cell_w, rows * (cell_h + CAPTION_H))


def interactive(results, expect_max):
    """One full-size frame at a time, for when a thumbnail looks wrong."""
    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
    i = 0
    while True:
        item = results[i]
        frame = cv2.imread(str(item["path"]))
        if frame is None:
            print(f"WARNING: unreadable, skipped: {item['path']}")
            i = (i + 1) % len(results)
            continue

        count = len(item["boxes"])
        shown = draw(frame, item["boxes"], colour_for(count, expect_max))
        header = (f"[{i + 1}/{len(results)}] {item['group']}/{item['path'].name}  "
                  f"boxes={count}")
        cv2.putText(shown, header, (12, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                    (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(shown, header, (12, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                    (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(shown, "A/D prev/next   Q/Esc quit", (12, 48),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(shown, "A/D prev/next   Q/Esc quit", (12, 48),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1, cv2.LINE_AA)
        cv2.imshow(WINDOW, shown)

        key = cv2.waitKey(0) & 0xFF
        if key in (27, ord("q")):
            break
        if key == ord("d"):
            i = (i + 1) % len(results)
        elif key == ord("a"):
            i = (i - 1) % len(results)
    cv2.destroyAllWindows()


def report(results, groups, expect_max):
    counts = [len(r["boxes"]) for r in results]
    total = len(counts)
    zero = sum(1 for c in counts if c == 0)
    busy = sum(1 for c in counts if c > expect_max)

    print(f"{'group':<42} {'sampled':>8} {'of':>7} {'boxes':>7}")
    print("-" * 68)
    for key in sorted(groups):
        sampled = [r for r in results if r["group"] == key]
        print(f"{key:<42} {len(sampled):>8} {len(groups[key]):>7} "
              f"{sum(len(r['boxes']) for r in sampled):>7}")
    print("-" * 68)
    print(f"{'TOTAL':<42} {total:>8} {sum(len(v) for v in groups.values()):>7} "
          f"{sum(counts):>7}\n")

    print("box-count histogram")
    print("-" * 68)
    tally = {}
    for c in counts:
        tally[c] = tally.get(c, 0) + 1
    peak = max(tally.values())
    for value in sorted(tally):
        n = tally[value]
        flag = ""
        if value == 0:
            flag = "  <- nothing detected"
        elif value > expect_max:
            flag = f"  <- above --expect-max {expect_max}"
        bar = "#" * max(1, round(40 * n / peak))
        print(f"{value:>5} boxes {n:>5} frames  {bar}{flag}")
    print("-" * 68)
    print(f"max boxes in a single frame: {max(tally)}\n")

    zero_pct = zero / total
    busy_pct = busy / total
    suspicious_pct = (zero + busy) / total

    for label, n, pct in (("frames with ZERO boxes", zero, zero_pct),
                          (f"frames with more than {expect_max} boxes", busy, busy_pct),
                          ("suspicious (either of the above)", zero + busy,
                           suspicious_pct)):
        print(f"{label:<36} {n:>5} / {total}  ({pct:.1%})")
    print()

    print("VERDICT")
    print("-" * 68)
    print("Plan rule: false positives or misses in more than ~2% of frames -> Option B")
    print("(train the YOLO11n detector). Essentially perfect -> ship Option A (HSV),")
    print("keep Option B as the config-switchable upgrade.\n")
    if suspicious_pct > 0.02:
        print(f"  -> {suspicious_pct:.1%} of sampled frames are suspicious, above the ~2%")
        print("     line. On this evidence: GO OPTION B, and keep HSV as the label")
        print("     bootstrapper (tools/propose_boxes.py) rather than the detector.")
    else:
        print(f"  -> {suspicious_pct:.1%} of sampled frames are suspicious, under the ~2%")
        print("     line. HSV is a candidate for Option A - but only if the sheets")
        print("     back it up (see the caveat below).")
    print()
    print("CAVEAT - this percentage is a PROXY, not a measurement. It only sees")
    print("frames with zero boxes or an implausible pile of them. It cannot tell a")
    print("box on a clickable from a box on a player's green cloak, and it cannot")
    print("see a clickable that was missed in a frame where other boxes were found.")
    print("The plan's 2% is about false positives and misses, so the number above is")
    print("a LOWER BOUND. You must eyeball the contact sheets before deciding.")
    print("Amber cells = zero boxes, red cells = more than --expect-max.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="?", default=str(DEFAULT_SRC),
                    help="folder of frames, walked recursively")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("--n", type=int, default=200,
                    help="how many frames to sample in total - every folder "
                         "still contributes at least one")
    ap.add_argument("--grid", default="5x4", metavar="COLSxROWS",
                    help="thumbnails per contact sheet")
    ap.add_argument("--cell-width", type=int, default=380,
                    help="thumbnail width in px")
    ap.add_argument("--expect-max", type=int, default=12,
                    help="more boxes than this in one frame is suspicious")
    ap.add_argument("--interactive", action="store_true",
                    help="step through full-size frames instead of writing sheets")
    args = ap.parse_args()

    src = Path(args.src).resolve()
    if not src.is_dir():
        sys.exit(f"not a folder: {src}")
    if args.n < 1:
        sys.exit("--n must be at least 1")
    try:
        cols, rows = (int(v) for v in args.grid.lower().split("x"))
    except ValueError:
        sys.exit(f"--grid must look like 5x4, got {args.grid!r}")
    if cols < 1 or rows < 1:
        sys.exit("--grid needs at least 1x1")

    hsv = load_hsv(args.config)
    images = find_images(src)
    if not images:
        sys.exit(f"no .jpg/.jpeg/.png under {src}")

    picked, groups = sample(images, src, args.n)

    print(f"src:    {src}")
    print(f"config: {Path(args.config).resolve()}")
    print(f"hsv:    lo={list(int(v) for v in hsv['lo'])} "
          f"hi={list(int(v) for v in hsv['hi'])} "
          f"min_area={hsv['min_area']} morph_kernel={hsv['morph_kernel']}")
    print(f"sample: {len(picked)} of {len(images)} frames across "
          f"{len(groups)} folder(s)\n")

    results = []
    unreadable = 0
    for image in picked:
        frame = cv2.imread(str(image))
        if frame is None:
            unreadable += 1
            print(f"WARNING: unreadable, skipped: {image}")
            continue
        results.append({
            "path": image,
            "group": group_key(image, src),
            "shape": frame.shape[:2],
            "boxes": hsv_boxes(frame, hsv["lo"], hsv["hi"],
                               hsv["min_area"], hsv["morph_kernel"]),
        })
    if not results:
        sys.exit("every sampled frame was unreadable")
    if unreadable:
        print(f"{unreadable} unreadable frame(s) left out of the statistics\n")

    if args.interactive:
        interactive(results, args.expect_max)
    else:
        sheets, size = write_sheets(results, cols, rows,
                                    args.cell_width, args.expect_max)
        print(f"{sheets} contact sheet(s), {cols}x{rows} at {size[0]}x{size[1]} px")
        print(f"  {OUT_DIR}\n")

    report(results, groups, args.expect_max)


if __name__ == "__main__":
    main()
