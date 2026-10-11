"""Phase 0: capture check. Achieved fps, grab cost, and whether colors come through intact.

    python -m tools.capture_bench                  # 30 s on the region from configs/capture.yaml
    python -m tools.capture_bench --seconds 10 --backend mss
    python -m tools.capture_bench --full           # the whole primary monitor

DXGI only delivers a frame when something on screen changed, so run this while
the game is moving; the fps it reports is capped by the game's own fps.

It saves one frame as PNG (compare it with an in-game screenshot) and also
compares the DXGI frame with an independent GDI grab of the same region taken
right after it. A mean difference near 0 means the colors are captured
faithfully; motion between the two grabs adds some difference.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime

import cv2
import numpy as np

from detector.capture import DxcamSource, Grabber, MssSource, client_rect, find_window, primary_monitor
from detector.common import RUNS, load_yaml, make_dpi_aware


class TimedSource:
    """Wraps a source and records how long each successful grab took."""

    def __init__(self, src):
        self.src = src
        self.times: list[float] = []

    def __getattr__(self, name):
        return getattr(self.src, name)

    def grab(self):
        t = time.perf_counter()
        img = self.src.grab()
        if img is not None:
            self.times.append(time.perf_counter() - t)
        return img


def configured_region(path: str, full: bool) -> tuple[tuple[int, int, int, int], str]:
    if full:
        return primary_monitor(), "primary monitor"
    cfg = load_yaml(path)
    if cfg.get("window"):
        hwnd = find_window(cfg["window"])
        rect = client_rect(hwnd) if hwnd else None
        if rect is None:
            raise SystemExit(f'window "{cfg["window"]}" not found or minimized')
        return rect, f'window "{cfg["window"]}"'
    if cfg.get("region"):
        return tuple(cfg["region"]), "configs/capture.yaml region"
    return primary_monitor(), "primary monitor"


def color_check(region) -> dict:
    """Grab the same region with DXGI and GDI back to back; keep the closest of 5 pairs."""
    dx = DxcamSource(region)
    gdi = MssSource(region)
    best = None
    try:
        for _ in range(5):
            a = dx.camera.grab(region=dx.rel, new_frame_only=False)
            b = gdi.grab()
            if a is None:
                time.sleep(0.05)
                continue
            diff = np.abs(a.astype(np.int16) - b.astype(np.int16))
            score = float(diff.mean())
            if best is None or score < best[0]:
                best = (score, diff, a, b)
            time.sleep(0.05)
    finally:
        dx.close()
        gdi.close()
    if best is None:
        return {"error": "DXGI returned no frame"}
    score, diff, a, b = best
    return {
        "mean_abs_diff_bgr": [round(float(diff[..., c].mean()), 3) for c in range(3)],
        "identical_pixels": round(float((diff.max(axis=2) == 0).mean()), 4),
        "mean_bgr_dxgi": [round(float(a[..., c].mean()), 2) for c in range(3)],
        "mean_bgr_gdi": [round(float(b[..., c].mean()), 2) for c in range(3)],
        "black_frame": bool(a.max() < 10),
    }


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--seconds", type=float, default=30)
    p.add_argument("--backend", choices=["dxcam", "mss"], default=None, help="default: from capture.yaml")
    p.add_argument("--capture-config", default="configs/capture.yaml")
    p.add_argument("--full", action="store_true", help="capture the whole primary monitor")
    args = p.parse_args(argv)
    make_dpi_aware()

    region, what = configured_region(args.capture_config, args.full)
    backend = args.backend or load_yaml(args.capture_config).get("backend", "dxcam")
    src = TimedSource(MssSource(region) if backend == "mss" else DxcamSource(region))
    print(f"capturing {what} {list(region)} with {backend} for {args.seconds:.0f} s ...", flush=True)
    g = Grabber(src)
    g.start()
    stamps, last, keep = [], 0, None
    t_end = time.perf_counter() + args.seconds
    while time.perf_counter() < t_end:
        f = g.latest(after=last, timeout=0.5)
        if f is not None:
            last = f.idx
            stamps.append(f.t)
            keep = f
    g.stop()
    if keep is None or len(stamps) < 2:
        raise SystemExit("no frames captured: is anything moving on screen?")

    gaps = np.diff(stamps) * 1e3
    grab_ms = np.array(src.times) * 1e3
    result = {
        "backend": backend,
        "region": list(region),
        "frame_size": [keep.image.shape[1], keep.image.shape[0]],
        "seconds": args.seconds,
        "frames": len(stamps),
        "fps": round((len(stamps) - 1) / (stamps[-1] - stamps[0]), 1),
        "frame_gap_ms": {"p50": round(float(np.percentile(gaps, 50)), 2), "p95": round(float(np.percentile(gaps, 95)), 2),
                         "max": round(float(gaps.max()), 2)},
        "grab_ms": {"mean": round(float(grab_ms.mean()), 2), "p95": round(float(np.percentile(grab_ms, 95)), 2)},
    }
    out = RUNS / "capture_check"
    out.mkdir(parents=True, exist_ok=True)
    stem = datetime.now().strftime("%Y%m%d_%H%M%S")
    cv2.imwrite(str(out / f"{stem}_{backend}.png"), keep.image)
    result["saved_frame"] = str(out / f"{stem}_{backend}.png")
    print("comparing DXGI with GDI for the color check ...", flush=True)
    result["color_check"] = color_check(region)
    (out / f"{stem}_{backend}.json").write_text(json.dumps(result, indent=1))
    print(json.dumps(result, indent=1))
    verdict = "OK" if result["fps"] >= 60 else "below 60 fps (was the screen changing the whole time?)"
    print(f"\ncapture rate: {verdict}")


if __name__ == "__main__":
    main()
