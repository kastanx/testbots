"""Phase 1: color-filter test and HSV picker.

Before labeling anything, check whether plain color filtering already finds the objects.

    python -m tools.color_filter pick --color red             # grabs the screen after 3 s
    python -m tools.color_filter pick --color red --frame data/raw/s01/s01_00042.png
    python -m tools.color_filter run --frames data/raw/s01 --limit 50
    python -m detector.main --filter                          # the same filter, live

pick: left-click pixels of objects that have this color (each click samples
5x5 pixels), right-click undoes the last click, the mouse wheel zooms. Everything
the current range catches is tinted magenta, and the boxes the filter would
report are drawn in green, so false hits on the background show up straight
away. Keys: s save into configs/colors.yaml and quit, [ and ] narrow / widen the
hue range, c clear, q or Esc quit without saving.

run: applies every calibrated color to a set of frames and saves annotated
copies plus a summary under runs/color_filter/. When the frames have YOLO
labels next to them (a dataset split), precision and recall are reported too.
"""

from __future__ import annotations

import argparse
import glob
import json
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from detector.capture import IMAGE_EXTS, label_path_for, read_yolo_labels
from detector.color import ColorFilterDetector, ColorTable, spec_from_samples
from detector.common import RUNS, make_dpi_aware, resolve
from detector.metrics import Tally
from tools.view import Viewport, wheel_up

WINDOW = "color picker"


def grab_screen(delay: float, capture_cfg: str) -> np.ndarray:
    from detector.capture import open_capture

    for i in range(int(delay), 0, -1):
        print(f"grabbing the capture region in {i} s - bring the game to the front", flush=True)
        time.sleep(1)
    g = open_capture("screen", capture_cfg)
    g.start()
    try:
        f = g.latest(timeout=3)
    finally:
        g.stop()
    if f is None:
        raise SystemExit("no frame captured")
    return f.image


def pick(a) -> None:
    make_dpi_aware()
    frame = cv2.imread(str(resolve(a.frame))) if a.frame else grab_screen(a.delay, a.capture_config)
    if frame is None:
        raise SystemExit(f"cannot read {a.frame}")
    table = ColorTable.load(a.colors)
    existing = table.colors.get(a.color)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    H, W = frame.shape[:2]
    vp = Viewport(W, H)
    samples: list[np.ndarray] = []
    st = {"tol": 0.0, "dirty": True, "spec": existing, "mouse": (0, 0), "overlay": frame, "info": ""}

    def on_mouse(event, x, y, flags, _):
        st["mouse"] = (x, y)
        fx, fy = (int(v) for v in vp.to_full(x, y))
        if event == cv2.EVENT_LBUTTONDOWN and 0 <= fx < W and 0 <= fy < H:
            samples.append(hsv[max(0, fy - 2):fy + 3, max(0, fx - 2):fx + 3].reshape(-1, 3))
            st["dirty"] = True
        elif event == cv2.EVENT_RBUTTONDOWN and samples:
            samples.pop()
            st["dirty"] = True
        elif event == cv2.EVENT_MOUSEWHEEL:
            vp.wheel(x, y, wheel_up(flags))

    cv2.namedWindow(WINDOW, cv2.WINDOW_AUTOSIZE)
    cv2.setMouseCallback(WINDOW, on_mouse)
    print(f"picking '{a.color}': left-click its pixels, right-click undo, wheel zoom, [ ] hue range, "
          f"s save, q quit")
    while True:
        if st["dirty"]:
            spec = spec_from_samples(a.color, np.concatenate(samples), st["tol"]) if samples else existing
            st["spec"] = spec
            overlay = frame.copy()
            if spec is not None:
                m = spec.mask(hsv) > 0
                overlay[m] = (overlay[m] * 0.35 + np.array([255, 0, 255]) * 0.65).astype(np.uint8)
                one = ColorTable({"filter": table.filter})
                one.colors = {spec.name: spec}
                dets, _ = ColorFilterDetector(one).detect(frame)
                for d in dets:
                    x1, y1, x2, y2 = (int(v) for v in d.box)
                    cv2.rectangle(overlay, (x1, y1), (x2, y2), (0, 255, 0), max(1, round(2 / vp.fit)))
                rng = (f"hue {spec.hue:.0f} +/- {spec.hue_tol:.0f}" if not spec.achromatic else "achromatic")
                st["info"] = f"{a.color}: {len(samples)} clicks | {rng} S {list(spec.s)} V {list(spec.v)} | {len(dets)} boxes"
            else:
                st["info"] = f"{a.color}: click pixels of a {a.color} object"
            st["overlay"] = overlay
            st["dirty"] = False

        view = vp.render(st["overlay"])
        mx, my = st["mouse"]
        fx, fy = (int(v) for v in vp.to_full(mx, my))
        if 0 <= fx < W and 0 <= fy < H:  # magnifier, top-right: 21x21 real pixels
            patch = frame[max(0, fy - 10):fy + 11, max(0, fx - 10):fx + 11]
            if patch.size:
                mag = cv2.resize(patch, (patch.shape[1] * 8, patch.shape[0] * 8), interpolation=cv2.INTER_NEAREST)
                mh, mw = mag.shape[:2]
                view[8:8 + mh, view.shape[1] - mw - 8:view.shape[1] - 8] = mag
                c = (view.shape[1] - mw - 8 + mw // 2, 8 + mh // 2)
                cv2.rectangle(view, (c[0] - 4, c[1] - 4), (c[0] + 4, c[1] + 4), (0, 255, 255), 1)
                h_, s_, v_ = hsv[fy, fx]
                cv2.putText(view, f"HSV {h_} {s_} {v_}", (view.shape[1] - mw - 8, mh + 26),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1, cv2.LINE_AA)
        cv2.rectangle(view, (0, 0), (view.shape[1], 24), (0, 0, 0), -1)
        cv2.putText(view, st["info"] + "   (s save, q quit)", (6, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                    (255, 255, 255), 1, cv2.LINE_AA)
        cv2.imshow(WINDOW, view)
        key = cv2.waitKey(15) & 0xFF
        if key in (ord("q"), 27) or cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
            print("quit without saving")
            break
        if key == ord("s") and st["spec"] is not None:
            table = ColorTable.load(a.colors)  # reload: keep anything saved meanwhile
            table.colors[a.color] = st["spec"]
            path = table.save(a.colors)
            print(f"saved {a.color}: {st['spec'].to_dict()} -> {path}")
            break
        if key == ord("["):
            st["tol"] -= 1
            st["dirty"] = bool(samples)
        elif key == ord("]"):
            st["tol"] += 1
            st["dirty"] = bool(samples)
        elif key == ord("c"):
            samples.clear()
            st["dirty"] = True
    cv2.destroyAllWindows()


def list_frames(patterns: list[str], limit: int) -> list[Path]:
    files: list[Path] = []
    for pat in patterns:
        p = resolve(pat)
        if p.is_dir():
            files += sorted(f for f in p.rglob("*") if f.suffix.lower() in IMAGE_EXTS)
        else:
            files += sorted(Path(f) for f in glob.glob(str(p)) if Path(f).suffix.lower() in IMAGE_EXTS)
    if limit and len(files) > limit:  # spread evenly over the whole set
        idx = np.linspace(0, len(files) - 1, limit).round().astype(int)
        files = [files[i] for i in idx]
    return files


def run(a) -> None:
    table = ColorTable.load(a.colors)
    det = ColorFilterDetector(table)
    files = list_frames(a.frames, a.limit)
    if not files:
        raise SystemExit("no frames found")
    out = resolve(a.out) if a.out else RUNS / "color_filter" / datetime.now().strftime("%Y%m%d_%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    tally = Tally()
    rows, times = [], []
    for f in files:
        img = cv2.imread(str(f))
        t = time.perf_counter()
        dets, _ = det.detect(img)
        times.append((time.perf_counter() - t) * 1e3)
        lp = label_path_for(f)
        if lp.exists():
            truths = read_yolo_labels(lp, img.shape[1], img.shape[0])
            for t_ in truths:
                t_.type = "object"
            tally.update(dets, truths)
        vis = img.copy()
        for d in dets:
            x1, y1, x2, y2 = (int(v) for v in d.box)
            col = table.colors[d.color].bgr()
            cv2.rectangle(vis, (x1, y1), (x2, y2), (0, 255, 0), 2)
            cv2.putText(vis, d.color, (x1, max(12, y1 - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 1, cv2.LINE_AA)
        cv2.imwrite(str(out / f"{f.stem}.jpg"), vis, [cv2.IMWRITE_JPEG_QUALITY, 90])
        counts: dict[str, int] = {}
        for d in dets:
            counts[d.color] = counts.get(d.color, 0) + 1
        rows.append({"frame": str(f), "boxes": len(dets), "per_color": counts})
    summary = {
        "frames": len(files),
        "colors": list(table.colors),
        "boxes_per_frame_mean": round(float(np.mean([r["boxes"] for r in rows])), 2),
        "ms_per_frame_mean": round(float(np.mean(times)), 2),
    }
    if tally.frames:
        s = tally.summary()
        summary["vs_labels"] = {"frames": s["frames"], **s["boxes"]}
    (out / "summary.json").write_text(json.dumps({"summary": summary, "frames": rows}, indent=1))
    print(json.dumps(summary, indent=1))
    print(f"annotated frames in {out}\nLook through them, then write the result and the decision "
          f"(keep as baseline / YOLO needed) into docs/experiments.md.")


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--colors", default="configs/colors.yaml")
    sub = p.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("pick", help="calibrate one color by clicking its pixels")
    k.add_argument("--color", required=True, help="color name, e.g. red")
    k.add_argument("--frame", help="a saved frame; default: grab the capture region now")
    k.add_argument("--delay", type=float, default=3)
    k.add_argument("--capture-config", default="configs/capture.yaml")
    r = sub.add_parser("run", help="run the filter on saved frames")
    r.add_argument("--frames", nargs="+", required=True, help="folders or glob patterns")
    r.add_argument("--limit", type=int, default=50, help="frames to use, spread evenly (0 = all)")
    r.add_argument("--out", help="default: runs/color_filter/<timestamp>")
    a = p.parse_args(argv)
    pick(a) if a.cmd == "pick" else run(a)


if __name__ == "__main__":
    main()
