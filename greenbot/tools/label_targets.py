"""Click the correct platform on each frame; the rule is derived from your clicks.

Guessing a selection rule from the outside does not work - at some spots the
right platform is not any geometric extreme. So label it directly: every
detected box is outlined, you click the correct one, it saves and advances.

    python tools/label_targets.py                 # label every spot
    python tools/label_targets.py --spots spot_02 --frames 30
    python tools/label_targets.py --fit           # no labelling, just re-fit

Controls
    left click on a box   that is the target -> saves and advances
    N                     the target is NOT among the boxes (HSV missed it)
    S                     skip this frame
    U                     undo the previous frame and go back
    Q / Esc               stop and fit

Labels persist in tools/target_labels.json, so you can stop and resume. When you
quit, every strategy is scored against your clicks and the best one is printed
ready to paste into the `targets` block of server/config.yaml.
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
import yaml

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(ROOT / "server"))
from propose_boxes import hsv_boxes    # noqa: E402
from picker import pick_target         # noqa: E402

RAW = ROOT / "ml" / "dataset" / "raw"
LABELS = TOOLS / "target_labels.json"
WINDOW = "label targets"

FIT_STRATEGIES = ["largest", "smallest", "leftmost", "rightmost",
                  "topmost", "bottommost", "nearest_center"]

MISSING = "not_detected"


def load_labels():
    if LABELS.exists():
        return json.loads(LABELS.read_text(encoding="utf-8"))
    return {}


def save_labels(labels):
    LABELS.write_text(json.dumps(labels, indent=2), encoding="utf-8")


def sample_frames(label, n):
    files = sorted(f for session in RAW.iterdir()
                   if session.is_dir() and not session.name.startswith("_")
                   for f in (session / label).glob("*.jpg"))
    if not files:
        return []
    step = max(1, len(files) // n)
    return files[::step][:n]


def read(path):
    return cv2.imdecode(np.frombuffer(path.read_bytes(), np.uint8), cv2.IMREAD_COLOR)


def key(path):
    return "/".join(path.parts[-3:])


class Session:
    """One click-through pass. Holds the state the mouse callback mutates."""

    def __init__(self, labels):
        self.labels = labels
        self.click = None
        self.scale = 1.0

    def on_mouse(self, event, x, y, flags, _param):
        if event == cv2.EVENT_LBUTTONDOWN:
            self.click = (int(x / self.scale), int(y / self.scale))


def draw(img, boxes, header, note, scale):
    vis = img.copy()
    for i, (x, y, w, h) in enumerate(boxes, start=1):
        cv2.rectangle(vis, (x, y), (x + w, y + h), (0, 230, 255), 2)
        cv2.putText(vis, str(i), (x + 4, y - 6), cv2.FONT_HERSHEY_SIMPLEX,
                    0.5, (0, 0, 0), 3)
        cv2.putText(vis, str(i), (x + 4, y - 6), cv2.FONT_HERSHEY_SIMPLEX,
                    0.5, (0, 230, 255), 1)

    bar = np.zeros((56, vis.shape[1], 3), np.uint8)
    cv2.putText(bar, header, (12, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
    cv2.putText(bar, note, (12, 44), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (120, 200, 255), 1)
    out = np.vstack([bar, vis])
    if scale != 1.0:
        out = cv2.resize(out, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return out, bar.shape[0]


def label_spot(spot, files, labels, state, hsv_cfg, max_w):
    done = labels.setdefault(spot, {})
    i = 0
    while i < len(files):
        path = files[i]
        k = key(path)
        if k in done:
            i += 1
            continue

        img = read(path)
        if img is None:
            i += 1
            continue
        boxes = hsv_boxes(img, hsv_cfg["lo"], hsv_cfg["hi"],
                          hsv_cfg["min_area"], hsv_cfg["morph_kernel"])

        state.scale = min(1.0, max_w / img.shape[1])
        note = "click the correct platform   |   N none of these   S skip   U undo   Q quit"
        header = f"{spot}   {len(done)}/{len(files)} labelled   {len(boxes)} boxes   {path.name}"
        canvas, bar_h = draw(img, boxes, header, note, state.scale)
        cv2.imshow(WINDOW, canvas)

        state.click = None
        while True:
            pressed = cv2.waitKey(20) & 0xFF

            if state.click is not None:
                cx, cy = state.click
                cy -= int(bar_h)            # the header bar is above the image
                state.click = None
                if cy < 0:
                    continue
                hits = [b for b in boxes
                        if b[0] <= cx <= b[0] + b[2] and b[1] <= cy <= b[1] + b[3]]
                if not hits:
                    canvas, bar_h = draw(img, boxes,
                                         header, "no box there - press N if the target "
                                                 "is not detected at all", state.scale)
                    cv2.imshow(WINDOW, canvas)
                    continue
                chosen = min(hits, key=lambda b: b[2] * b[3])   # innermost wins
                done[k] = {"box": [int(v) for v in chosen],
                           "boxes": [[int(v) for v in b] for b in boxes],
                           "size": [int(img.shape[1]), int(img.shape[0])]}
                save_labels(labels)
                i += 1
                break

            if pressed == ord("n"):
                done[k] = {"box": MISSING,
                           "boxes": [[int(v) for v in b] for b in boxes],
                           "size": [int(img.shape[1]), int(img.shape[0])]}
                save_labels(labels)
                i += 1
                break
            if pressed == ord("s"):
                i += 1
                break
            if pressed == ord("u"):
                for prev in reversed(files[:i]):
                    if key(prev) in done:
                        del done[key(prev)]
                        save_labels(labels)
                        break
                i = max(0, i - 1)
                break
            if pressed in (ord("q"), 27):
                return False

            if cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                return False
    return True


def score_rule(entries, rule):
    """Fraction of labelled frames where this rule reproduces the human click."""
    hits = 0
    for e in entries:
        boxes = [tuple(b) for b in e["boxes"]]
        shape = (e["size"][1], e["size"][0], 3)
        got = pick_target(boxes, rule, shape)
        if got is not None and list(got) == e["box"]:
            hits += 1
    return hits / len(entries) if entries else 0.0


def verify(labels, config_path):
    """Score the rules actually in config.yaml - not the fit's recommendation.

    This is the test: does what the service will really do agree with what you
    clicked?
    """
    cfg = yaml.safe_load(Path(config_path).read_text(encoding="utf-8"))
    targets = cfg.get("targets") or {}

    print("\n" + "=" * 70)
    print(f"VERIFY - rules in {Path(config_path).name} vs your clicks")
    print("=" * 70)

    worst = 1.0
    total_hits = total_n = 0
    for spot in sorted(labels):
        entries = [e for e in labels[spot].values() if e["box"] != MISSING]
        missing = sum(1 for e in labels[spot].values() if e["box"] == MISSING)
        if not entries:
            continue
        rule = targets.get(spot)
        if not rule:
            print(f"  {spot:<10} NO RULE - target will always be null")
            worst = 0.0
            continue
        score = score_rule(entries, rule)
        worst = min(worst, score)
        total_hits += round(score * len(entries))
        total_n += len(entries)
        flag = "" if score >= 0.99 else "   <-- misses"
        desc = rule.get("pick", "?")
        if desc == "nearest_point":
            desc += f" {rule.get('point')}"
        print(f"  {spot:<10} {score:6.1%}  n={len(entries):<4} {desc}{flag}"
              + (f"   ({missing} undetected)" if missing else ""))

    if total_n:
        print("-" * 70)
        print(f"  {'OVERALL':<10} {total_hits / total_n:6.1%}  n={total_n}")
    print()
    if worst >= 0.99:
        print("PASS - every configured rule reproduces your clicks.")
        return 0
    print("Some rules disagree with your clicks. Label more frames for those "
          "spots, or try --prefer nearest_point.")
    return 1


def fit(labels, prefer=None):
    """Score every strategy against the clicks, and derive a fallback point."""
    print("\n" + "=" * 70)
    print("FIT - how well each rule reproduces your clicks")
    print("=" * 70)

    suggestions = {}
    for spot in sorted(labels):
        entries = [e for e in labels[spot].values() if e["box"] != MISSING]
        missing = sum(1 for e in labels[spot].values() if e["box"] == MISSING)
        if not entries:
            print(f"\n{spot}: nothing labelled")
            continue

        scores = {}
        for strat in FIT_STRATEGIES:
            hits = 0
            for e in entries:
                boxes = [tuple(b) for b in e["boxes"]]
                shape = (e["size"][1], e["size"][0], 3)
                got = pick_target(boxes, {"pick": strat}, shape)
                if got is not None and list(got) == e["box"]:
                    hits += 1
            scores[strat] = hits / len(entries)

        # Fallback: the median centre of the boxes you actually clicked.
        cxs = sorted((e["box"][0] + e["box"][2] / 2) / e["size"][0] for e in entries)
        cys = sorted((e["box"][1] + e["box"][3] / 2) / e["size"][1] for e in entries)
        point = [round(cxs[len(cxs) // 2], 4), round(cys[len(cys) // 2], 4)]
        hits = 0
        for e in entries:
            boxes = [tuple(b) for b in e["boxes"]]
            shape = (e["size"][1], e["size"][0], 3)
            got = pick_target(boxes, {"pick": "nearest_point", "point": point}, shape)
            if got is not None and list(got) == e["box"]:
                hits += 1
        scores["nearest_point"] = hits / len(entries)

        best = max(scores, key=lambda s: scores[s])
        # A geometric extreme that happens to fit can be luck - "smallest" wins
        # until one new distant platform appears. --prefer keeps a strategy that
        # is essentially as good but derived from where the target actually sits.
        if prefer and scores.get(prefer, 0) >= scores[best] - 1e-9:
            best = prefer

        print(f"\n{spot}   {len(entries)} labelled" +
              (f"   ({missing} with no box detected)" if missing else ""))
        for strat, score in sorted(scores.items(), key=lambda kv: -kv[1]):
            mark = " <-- best" if strat == best else ""
            print(f"  {strat:<16} {score:6.1%}{mark}")

        if scores[best] < 0.99:
            print(f"  WARNING: best rule only reproduces {scores[best]:.0%} of your clicks.")
            if missing:
                print(f"  {missing} frames had NO box on the target - that is an HSV "
                      f"problem, not a rule problem. Run tools/tune_hsv.py.")

        suggestions[spot] = ({"pick": "nearest_point", "point": point}
                             if best == "nearest_point" else {"pick": best})

    if suggestions:
        print("\n" + "=" * 70)
        print("Paste into the `targets` block of server/config.yaml:")
        print("=" * 70)
        print(yaml.safe_dump({"targets": suggestions}, sort_keys=True,
                             default_flow_style=None).rstrip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spots", nargs="*")
    ap.add_argument("--frames", type=int, default=25, help="frames to label per spot")
    ap.add_argument("--max-width", type=int, default=1600, help="window width cap")
    ap.add_argument("--fit", action="store_true", help="skip labelling, just re-fit")
    ap.add_argument("--verify", action="store_true",
                    help="score the rules already in config.yaml against your clicks")
    ap.add_argument("--prefer", metavar="STRATEGY",
                    help="when fitting, keep this strategy if it ties the best "
                         "(e.g. nearest_point, which is rarely a lucky fit)")
    ap.add_argument("--config", default=str(ROOT / "server" / "config.yaml"))
    args = ap.parse_args()

    labels = load_labels()
    if args.verify:
        sys.exit(verify(labels, args.config))
    if args.fit:
        fit(labels, args.prefer)
        return

    cfg = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
    h = cfg["hsv"]
    hsv_cfg = {"lo": np.array(h["lo"], np.uint8), "hi": np.array(h["hi"], np.uint8),
               "min_area": float(h["min_area"]), "morph_kernel": int(h["morph_kernel"])}

    spots = args.spots
    if not spots:
        found = set()
        for session in RAW.iterdir():
            if session.is_dir() and not session.name.startswith("_"):
                found.update(p.name for p in session.iterdir()
                             if p.is_dir() and p.name.startswith("spot_"))
        spots = sorted(found)
    if not spots:
        sys.exit(f"no spot_* folders under {RAW}")

    cv2.namedWindow(WINDOW, cv2.WINDOW_AUTOSIZE)
    state = Session(labels)
    cv2.setMouseCallback(WINDOW, state.on_mouse)

    print(__doc__)
    for spot in spots:
        files = sample_frames(spot, args.frames)
        if not files:
            print(f"{spot}: no frames")
            continue
        if not label_spot(spot, files, labels, state, hsv_cfg, args.max_width):
            break

    cv2.destroyAllWindows()
    save_labels(labels)
    print(f"\nlabels -> {LABELS}")
    fit(labels, args.prefer)


if __name__ == "__main__":
    main()
