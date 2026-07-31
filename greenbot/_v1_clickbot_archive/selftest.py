"""Offline checks for the bot's perception and decision logic.

No GPU, no screen capture, no model - just the parts that decide whether and
where to click. Run it after editing config.json or picker.py.

    python bot/selftest.py
"""
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from main import DEFAULTS, Clicker, GreenDetector, ZoneTracker, load_config
from picker import filter_boxes, pick_target

HERE = Path(__file__).resolve().parent
FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print(f"  ok    {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        FAILURES.append(name)


def synthetic_frame():
    """1920x1080 dark frame with three green rectangles of known size/position."""
    frame = np.full((1080, 1920, 3), 30, dtype=np.uint8)
    # (x, y, w, h) - left small, middle large, right medium
    for x, y, w, h in [(100, 500, 60, 60), (900, 300, 200, 160), (1600, 800, 100, 90)]:
        cv2.rectangle(frame, (x, y), (x + w, y + h), (60, 200, 60), -1)
    return frame


def test_detection(cfg):
    print("green detection")
    boxes = GreenDetector(cfg).detect(synthetic_frame())
    check("finds three blobs", len(boxes) == 3, f"(got {len(boxes)})")
    if len(boxes) != 3:
        return []
    areas = sorted(w * h for _, _, w, h in boxes)
    check("areas are about right", 3000 < areas[0] < 4200 and 30000 < areas[-1] < 34000,
          f"(got {areas})")
    check("nothing detected on a blank frame",
          GreenDetector(cfg).detect(np.full((200, 200, 3), 30, np.uint8)) == [])
    return boxes


def test_picker(boxes):
    print("target picking")
    shape = (1080, 1920, 3)
    x_of = lambda b: b[0]   # noqa: E731

    check("leftmost", x_of(pick_target(boxes, {"pick": "leftmost"}, shape)) == 100)
    check("rightmost", x_of(pick_target(boxes, {"pick": "rightmost"}, shape)) == 1600)
    check("largest", x_of(pick_target(boxes, {"pick": "largest"}, shape)) == 900)
    check("smallest", x_of(pick_target(boxes, {"pick": "smallest"}, shape)) == 100)
    check("topmost", pick_target(boxes, {"pick": "topmost"}, shape)[1] == 300)
    check("bottommost", pick_target(boxes, {"pick": "bottommost"}, shape)[1] == 800)
    check("nearest_center", x_of(pick_target(boxes, {"pick": "nearest_center"}, shape)) == 900)

    check("index 1 sorted by x",
          x_of(pick_target(boxes, {"pick": "index", "sort": "x", "index": 1}, shape)) == 900)
    check("index -1 sorted by area",
          x_of(pick_target(boxes, {"pick": "index", "sort": "area", "index": -1}, shape)) == 900)
    check("index out of range yields no target",
          pick_target(boxes, {"pick": "index", "index": 9}, shape) is None)

    check("roi filters to one blob",
          len(filter_boxes(boxes, {"roi": [0, 0, 500, 1080]})) == 1)
    check("roi with no match yields no target",
          pick_target(boxes, {"pick": "largest", "roi": [0, 0, 10, 10]}, shape) is None)
    check("per-zone min_area filters",
          len(filter_boxes(boxes, {"min_area": 20000})) == 1)

    check("no boxes yields no target", pick_target([], {"pick": "largest"}, shape) is None)
    check("no rule yields no target", pick_target(boxes, None, shape) is None)

    try:
        pick_target(boxes, {"pick": "nonsense"}, shape)
        check("unknown strategy raises", False)
    except ValueError:
        check("unknown strategy raises", True)


def feed(tracker, label, times, conf=0.95):
    """One observe + one resolve per classifier tick, as the real loop does."""
    zone = None
    for _ in range(times):
        tracker.observe(label, conf)
        zone = tracker.resolve()
    return zone


def test_tracker(cfg):
    print("zone tracking")
    cfg = dict(cfg, adjacency_enabled=False)
    t = ZoneTracker(cfg)

    zones = []
    for _ in range(4):
        t.observe("spot_01", 0.95)
        zones.append(t.resolve())
    check("needs a majority before any zone", zones[:2] == [None, None], f"(got {zones[:2]})")
    check("anti-flap holds one more window", zones[2] is None, f"(got {zones[2]})")
    check("confirms after the streak", zones[3] == "spot_01", f"(got {zones[3]})")

    check("low confidence stops clicking", feed(t, "spot_02", 5, conf=0.50) is None)
    check("last confirmed zone is remembered", t.last_confirmed == "spot_01")
    check("returning to the same zone resumes at once", feed(t, "spot_01", 4) == "spot_01")

    print("adjacency veto")
    adj = {"spot_01": ["spot_02"], "spot_02": ["spot_01", "spot_03"], "spot_03": ["spot_02"]}
    t = ZoneTracker(dict(cfg, adjacency_enabled=True), adj)
    check("baseline zone confirmed", feed(t, "spot_01", 4) == "spot_01")

    # spot_09 is not reachable from spot_01, and 3/5 is not unanimous.
    check("unreachable jump is vetoed", feed(t, "spot_09", 3) is None)
    check("veto is reported", t.vetoed == "spot_09", f"(got {t.vetoed})")
    check("unanimous vote overrides the veto", feed(t, "spot_09", 3) == "spot_09")

    t = ZoneTracker(dict(cfg, adjacency_enabled=True), adj)
    feed(t, "spot_01", 4)
    check("transit is reachable from anywhere", feed(t, "transit", 4) == "transit")


def test_config():
    print("config")
    cfg_path = HERE / "config.json"
    cfg = load_config(cfg_path)
    check("defaults are merged", set(DEFAULTS) <= set(cfg))
    check("vote_needed fits the window", cfg["vote_needed"] <= cfg["vote_window"])
    check("conf_threshold in range", 0 < cfg["conf_threshold"] <= 1)

    labels = json.loads((HERE.parent / "collector" / "labels.json").read_text())
    check("every zone is a real label", set(cfg["zones"]) <= set(labels),
          f"(stray: {sorted(set(cfg['zones']) - set(labels))})")
    check("transit has no click rule", "transit" not in cfg["zones"])

    from picker import STRATEGIES
    bad = [z for z, r in cfg["zones"].items() if r.get("pick", "largest") not in STRATEGIES]
    check("every zone uses a known strategy", not bad, f"(bad: {bad})")

    adj = json.loads((HERE / "adjacency.json").read_text())
    adj.pop("_comment", None)
    stray = {n for targets in adj.values() for n in targets} - set(labels)
    check("adjacency references real labels", not stray, f"(stray: {sorted(stray)})")
    asym = [(a, b) for a, bs in adj.items() for b in bs if a not in adj.get(b, [])]
    check("adjacency is symmetric", not asym, f"(one-way: {asym})")

    return cfg


def test_clicker(cfg):
    print("click timing and jitter")
    box = (100, 200, 60, 40)
    x, y, w, h = box

    c = Clicker(dict(cfg, idle_pause_chance=0.0), dry_run=True)
    aims = [c.click(box) for _ in range(300)]
    check("jitter stays inside the target box",
          all(x < ax < x + w and y < ay < y + h for ax, ay in aims))
    check("jitter is not always dead centre", len({a for a in aims}) > 50,
          f"(got {len(set(aims))} distinct points)")

    thin = Clicker(dict(cfg, idle_pause_chance=0.0), dry_run=True)
    try:
        thin.click((10, 10, 1, 1))
        check("a degenerate box does not crash", True)
    except Exception as err:
        check("a degenerate box does not crash", False, f"({err})")

    c = Clicker(dict(cfg, idle_pause_chance=0.0, click_cooldown_ms=1500), dry_run=True)
    check("first click is allowed", c.ready(time.time()))
    c.click(box)
    check("cooldown blocks the next click", not c.ready(time.time()))
    check("cooldown expires", c.ready(time.time() + 2))

    c = Clicker(dict(cfg, idle_pause_chance=1.0, idle_pause_ms=[1000, 1000],
                     click_cooldown_ms=0), dry_run=True)
    c.click(box)
    check("idle pause suspends clicking", not c.ready(time.time()))
    check("idle pause ends", c.ready(time.time() + 1.5))


def main():
    print(f"opencv {cv2.__version__}  numpy {np.__version__}\n")
    cfg = test_config()
    print()
    boxes = test_detection(cfg)
    print()
    if boxes:
        test_picker(boxes)
        print()
    test_tracker(cfg)
    print()
    test_clicker(cfg)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
