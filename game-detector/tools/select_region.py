"""Phase 0: choose what to capture and save it in configs/capture.yaml.

    python -m tools.select_region --list                  # visible windows and their client areas
    python -m tools.select_region --window "RuneScape"    # follow a window's client area (recommended)
    python -m tools.select_region                         # drag a rectangle on a screenshot
    python -m tools.select_region --region 0,0,1920,1080

Following a window is the safest choice: the region moves with the window and
capture pauses while it is minimized. Coordinates are physical screen pixels.
"""

from __future__ import annotations

import argparse
import time

import cv2

from detector.capture import DxcamSource, client_rect, find_window, list_windows, primary_monitor
from detector.common import CONFIGS, load_yaml, make_dpi_aware, save_yaml

CAPTURE_PATH = CONFIGS / "capture.yaml"
CAPTURE_HEADER = """\
# Where and how to capture. Written by `python -m tools.select_region`; safe to edit by hand.
# Coordinates are physical screen pixels: [left, top, right, bottom].
#
# window    part of a window title (an exact title match wins). Its client area is captured
#           and followed if the window moves. Takes precedence over region; null = use region.
# region    fixed capture rectangle, used when window is null
# backend   dxcam (DXGI desktop duplication, default) or mss (GDI, slower fallback)
# max_fps   cap on captured frames per second, 0 = every new frame the screen produces
# record    Phase 2 recorder (tools.capture_frames): interval, bursts, duplicate filter, hotkeys
# ignore    UI panels as frame-pixel boxes [x1, y1, x2, y2] (frame = the window's client area):
#           detections centred inside are dropped (live app, auto-labeling, labeler suggestions).
#           They assume this window size; redo them if the window size or UI layout changes.
# bar_filter  drops wisp detections that are mostly the cyan harvest progress bar: a thin
#           (<= max_thickness rows) straight horizontal strip of hue in `hue`, at least
#           bar_min_len px long, which covers at least min_share of the box's colored
#           pixels (detector/filters.py).
#           drop_harvested: also drop wisps that have such a bar (>= bar_min_len px long)
#           centred across their top, i.e. someone is harvesting them: only untouched count.
"""

DEFAULT_CAPTURE = {
    "window": None,
    "region": None,
    "backend": "dxcam",
    "max_fps": 0,
    "record": {
        "interval_ms": 1000,
        "burst_count": 5,
        "burst_gap_ms": 200,
        "dedup_max_distance": 4,
        "hotkeys": {"toggle": "L", "burst": "K", "quit": "J"},
    },
}


def save_capture(**changes) -> None:
    cfg = {**DEFAULT_CAPTURE, **load_yaml(CAPTURE_PATH), **changes}
    save_yaml(CAPTURE_PATH, cfg, header=CAPTURE_HEADER)
    print(f"saved {CAPTURE_PATH}: window={cfg['window']!r} region={cfg['region']}")


def drag_region(delay: float) -> tuple[int, int, int, int] | None:
    for i in range(int(delay), 0, -1):
        print(f"screenshot in {i} s - bring the game to the front", flush=True)
        time.sleep(1)
    src = DxcamSource(primary_monitor())
    try:
        img = None
        for _ in range(50):
            img = src.camera.grab(region=src.rel, new_frame_only=False)
            if img is not None:
                break
            time.sleep(0.05)
    finally:
        src.close()
    if img is None:
        raise SystemExit("could not grab the screen")
    scale = min(1.0, 1600 / img.shape[1], 900 / img.shape[0])
    view = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    title = "drag the capture region, Enter to accept, c to cancel"
    x, y, w, h = cv2.selectROI(title, view, showCrosshair=False)
    cv2.destroyAllWindows()
    if w == 0 or h == 0:
        return None
    ox, oy = primary_monitor()[:2]
    return (ox + round(x / scale), oy + round(y / scale), ox + round((x + w) / scale), oy + round((y + h) / scale))


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--list", action="store_true", help="list visible windows")
    g.add_argument("--window", help="follow the window with this title (or part of it)")
    g.add_argument("--region", help="left,top,right,bottom in screen pixels")
    p.add_argument("--delay", type=float, default=3, help="seconds before the screenshot (drag mode)")
    a = p.parse_args(argv)
    make_dpi_aware()

    if a.list:
        for hwnd, title in list_windows():
            rect = client_rect(hwnd)
            if rect:
                print(f"{str(list(rect)):28s} {rect[2] - rect[0]}x{rect[3] - rect[1]:<6} {title}")
        return
    if a.window:
        hwnd = find_window(a.window)
        if hwnd is None:
            raise SystemExit(f'no visible window with "{a.window}" in its title (try --list)')
        rect = client_rect(hwnd)
        matched = dict(list_windows()).get(hwnd, "?")
        print(f'matched window "{matched}", client area {list(rect) if rect else "minimized"}')
        save_capture(window=a.window, region=list(rect) if rect else None)
        return
    if a.region:
        region = [int(v) for v in a.region.split(",")]
        if len(region) != 4 or region[2] <= region[0] or region[3] <= region[1]:
            raise SystemExit("--region needs left,top,right,bottom")
        save_capture(window=None, region=region)
        return
    region = drag_region(a.delay)
    if region is None:
        print("cancelled, nothing saved")
        return
    save_capture(window=None, region=list(region))


if __name__ == "__main__":
    main()
