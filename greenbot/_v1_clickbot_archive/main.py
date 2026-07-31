"""Green-click runtime bot.

Fast loop (~30 Hz): capture -> HSV green detection -> click decision.
Slow lane  (~4 Hz): YOLO11n-cls says which spot we are standing on.

Starts in dry-run: it draws where it *would* click and touches nothing.
F10 quits. So does Esc/q on the overlay window, or slamming the mouse into
the top-left corner (pydirectinput failsafe).
"""
import ctypes
import sys


def _enable_dpi_awareness():
    """Must happen before anything measures pixels or clicks land offset."""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)   # PER_MONITOR_DPI_AWARE
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        print("warning: could not set DPI awareness; clicks may be offset")


if sys.platform == "win32":
    _enable_dpi_awareness()

import argparse           # noqa: E402
import collections        # noqa: E402
import json               # noqa: E402
import random             # noqa: E402
import time               # noqa: E402
from pathlib import Path  # noqa: E402

import cv2                # noqa: E402
import numpy as np        # noqa: E402

from picker import pick_target   # noqa: E402

HERE = Path(__file__).resolve().parent

DEFAULTS = {
    "monitor": 0,
    "target_fps": 30,
    "hsv_lo": [40, 60, 60],
    "hsv_hi": [85, 255, 255],
    "min_area": 400,
    "max_area": 0,
    "morph_kernel": 3,
    "conf_threshold": 0.70,
    "vote_window": 5,
    "vote_needed": 3,
    "classify_every_n": 8,
    "classify_imgsz": 224,
    "classify_max_width": 1280,
    "click_cooldown_ms": 1500,
    "stable_windows_required": 2,
    "adjacency_enabled": False,
    "adjacency_unanimous_override": True,
    "pre_click_delay_ms": [30, 120],
    "idle_pause_chance": 0.02,
    "idle_pause_ms": [2000, 6000],
    "triage_enabled": True,
    "triage_conf_below": 0.60,
    "triage_max_per_minute": 20,
    "overlay_enabled": True,
    "overlay_scale": 0.5,
    "zones": {},
}


def load_config(path: Path):
    cfg = dict(DEFAULTS)
    cfg.update(json.loads(path.read_text(encoding="utf-8")))
    return cfg


# --------------------------------------------------------------- perception

class GreenDetector:
    def __init__(self, cfg):
        self.lo = np.array(cfg["hsv_lo"], dtype=np.uint8)
        self.hi = np.array(cfg["hsv_hi"], dtype=np.uint8)
        k = int(cfg["morph_kernel"])
        self.kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)) if k > 0 else None
        self.min_area = cfg["min_area"]
        self.max_area = cfg["max_area"] or float("inf")

    def detect(self, frame):
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, self.lo, self.hi)
        if self.kernel is not None:
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, self.kernel)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, self.kernel)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        boxes = []
        for c in contours:
            if self.min_area <= cv2.contourArea(c) <= self.max_area:
                boxes.append(cv2.boundingRect(c))
        return boxes


class ZoneTracker:
    """Majority vote over recent predictions, plus anti-flap and adjacency veto.

    Returns a zone only when it is confident *and* stable. Everything else
    returns None, which the caller treats as 'do not click'.
    """

    def __init__(self, cfg, adjacency=None):
        self.cfg = cfg
        self.votes = collections.deque(maxlen=cfg["vote_window"])
        self.adjacency = adjacency or {}
        self.zone = None             # what we act on right now
        self.last_confirmed = None   # survives brief unstable stretches
        self.candidate = None
        self.streak = 0
        self.vetoed = None

    def observe(self, label, conf):
        # Low-confidence frames still enter the window as None so that stale
        # confident votes age out instead of lingering forever.
        self.votes.append(label if conf >= self.cfg["conf_threshold"] else None)

    def _reachable(self, src, dst):
        if not self.cfg["adjacency_enabled"] or not self.adjacency:
            return True
        if src is None or src == dst:
            return True
        if "transit" in (src, dst):
            return True
        return dst in self.adjacency.get(src, [])

    def resolve(self):
        counts = collections.Counter(v for v in self.votes if v is not None)
        top, n = counts.most_common(1)[0] if counts else (None, 0)
        unanimous = n == self.votes.maxlen

        if top is None or n < self.cfg["vote_needed"]:
            self.zone = self.candidate = None
            self.streak = 0
            return None

        if not self._reachable(self.last_confirmed, top) and not (
            unanimous and self.cfg["adjacency_unanimous_override"]
        ):
            self.vetoed = top
            self.zone = None
            return None
        self.vetoed = None

        if top == self.last_confirmed:
            self.candidate = None
            self.streak = 0
            self.zone = top
            return top

        # A new zone must win several consecutive windows before we act on it.
        if top == self.candidate:
            self.streak += 1
        else:
            self.candidate = top
            self.streak = 1

        if self.streak >= self.cfg["stable_windows_required"]:
            self.last_confirmed = top
            self.zone = top
            return top

        self.zone = None
        return None


# ------------------------------------------------------------------ acting

class Clicker:
    def __init__(self, cfg, dry_run):
        self.cfg = cfg
        self.dry_run = dry_run
        self.last_click = 0.0
        self.blocked_until = 0.0
        self.count = 0
        if not dry_run:
            import pydirectinput
            pydirectinput.PAUSE = 0
            pydirectinput.FAILSAFE = True
            self.input = pydirectinput
        else:
            self.input = None

    def ready(self, now):
        return now >= self.blocked_until and \
            (now - self.last_click) * 1000 >= self.cfg["click_cooldown_ms"]

    def click(self, box):
        x, y, w, h = box
        # Aim for the middle but never exactly the middle, and stay in the box.
        cx = int(np.clip(x + w / 2 + random.gauss(0, w / 6), x + 1, x + w - 1))
        cy = int(np.clip(y + h / 2 + random.gauss(0, h / 6), y + 1, y + h - 1))

        if not self.dry_run:
            lo, hi = self.cfg["pre_click_delay_ms"]
            time.sleep(random.uniform(lo, hi) / 1000)
            self.input.moveTo(cx, cy)
            self.input.click()

        now = time.time()
        self.last_click = now
        self.count += 1

        # Occasionally just... stop for a bit. Metronomic clicking is the
        # single most obvious tell there is.
        if random.random() < self.cfg["idle_pause_chance"]:
            lo, hi = self.cfg["idle_pause_ms"]
            pause = random.uniform(lo, hi) / 1000
            self.blocked_until = now + pause
            print(f"  idle pause {pause:.1f}s")

        return cx, cy


class Triage:
    """Dump frames the classifier was unsure about, for the retraining loop."""

    def __init__(self, cfg, out_dir: Path):
        self.enabled = cfg["triage_enabled"]
        self.below = cfg["triage_conf_below"]
        self.limit = cfg["triage_max_per_minute"]
        self.dir = out_dir
        self.window_start = 0.0
        self.written = 0
        self.total = 0

    def maybe_dump(self, frame, conf, predicted):
        if not self.enabled or conf >= self.below:
            return
        now = time.time()
        if now - self.window_start > 60:
            self.window_start = now
            self.written = 0
        if self.written >= self.limit:
            return
        self.dir.mkdir(parents=True, exist_ok=True)
        name = f"{int(now * 1000)}_{predicted}_{conf:.2f}.jpg"
        cv2.imwrite(str(self.dir / name), frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        self.written += 1
        self.total += 1


# ------------------------------------------------------------------ overlay

def draw_overlay(frame, boxes, target, aim, zone, tracker, fps, dry_run, scale):
    small = cv2.resize(frame, None, fx=scale, fy=scale) if scale != 1.0 else frame.copy()

    def s(v):
        return int(v * scale)

    for (x, y, w, h) in boxes:
        cv2.rectangle(small, (s(x), s(y)), (s(x + w), s(y + h)), (0, 200, 0), 1)
    if target:
        x, y, w, h = target
        cv2.rectangle(small, (s(x), s(y)), (s(x + w), s(y + h)), (0, 255, 255), 2)
    if aim:
        cv2.drawMarker(small, (s(aim[0]), s(aim[1])), (0, 0, 255), cv2.MARKER_CROSS, 26, 2)

    mode = "DRY RUN" if dry_run else "LIVE"
    lines = [
        f"{mode}  {fps:5.1f} fps  blobs={len(boxes)}",
        f"zone={zone or '-'}  confirmed={tracker.last_confirmed or '-'}",
        f"votes={[v or '.' for v in tracker.votes]}",
    ]
    if tracker.vetoed:
        lines.append(f"VETOED {tracker.vetoed} (not reachable)")

    for i, line in enumerate(lines):
        pos = (14, 28 + i * 24)
        cv2.putText(small, line, pos, cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 3)
        cv2.putText(small, line, pos, cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                    (80, 255, 80) if dry_run else (80, 80, 255), 1)

    cv2.imshow("greenbot", small)


# --------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--live", action="store_true",
                    help="actually click (default is dry run)")
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--weights", default=str(HERE / "best.pt"))
    ap.add_argument("--adjacency", default=str(HERE / "adjacency.json"))
    ap.add_argument("--no-overlay", action="store_true")
    ap.add_argument("--monitor", type=int, default=None)
    ap.add_argument("--seconds", type=float, default=0,
                    help="stop automatically after this many seconds (0 = run until F10)")
    args = ap.parse_args()

    cfg_path = Path(args.config)
    if not cfg_path.exists():
        sys.exit(f"missing config: {cfg_path}")
    cfg = load_config(cfg_path)
    if args.monitor is not None:
        cfg["monitor"] = args.monitor
    if args.no_overlay:
        cfg["overlay_enabled"] = False

    weights = Path(args.weights)
    if not weights.exists():
        sys.exit(f"missing weights: {weights}\nTrain first: python ml/train.py")

    adjacency = {}
    adj_path = Path(args.adjacency)
    if cfg["adjacency_enabled"]:
        if not adj_path.exists():
            sys.exit(f"adjacency_enabled is true but {adj_path} is missing")
        adjacency = json.loads(adj_path.read_text(encoding="utf-8"))
        adjacency.pop("_comment", None)

    try:
        import bettercam
        import keyboard
        from ultralytics import YOLO
    except ImportError as err:
        sys.exit(f"missing dependency: {err}\nRun setup.ps1, then activate .venv")

    dry_run = not args.live

    print(f"loading {weights} ...")
    model = YOLO(str(weights))
    names = model.names
    unknown = set(cfg["zones"]) - set(names.values())
    if unknown:
        print(f"warning: config zones not in the model: {', '.join(sorted(unknown))}")

    detector = GreenDetector(cfg)
    tracker = ZoneTracker(cfg, adjacency)
    clicker = Clicker(cfg, dry_run)
    triage = Triage(cfg, HERE.parent / "ml" / "dataset" / "raw" / "triage")

    camera = bettercam.create(output_idx=cfg["monitor"], output_color="BGR")
    if camera is None:
        sys.exit(f"could not open monitor {cfg['monitor']}")
    camera.start(target_fps=cfg["target_fps"], video_mode=True)

    screen_w = ctypes.windll.user32.GetSystemMetrics(0)
    screen_h = ctypes.windll.user32.GetSystemMetrics(1)

    print(f"mode: {'DRY RUN (no clicks)' if dry_run else 'LIVE - it will click'}")
    print(f"classes: {len(names)}   F10 = quit\n")

    if not dry_run:
        # Last chance to bail before something starts moving the mouse.
        for n in (3, 2, 1):
            print(f"  live in {n} ... (Ctrl+C to abort)")
            time.sleep(1)

    frame_i = 0
    zone = None
    fps = 0.0
    last_tick = time.perf_counter()
    started = time.perf_counter()
    last_status = 0.0
    checked_geometry = False

    try:
        while True:
            try:
                if keyboard.is_pressed("f10"):
                    print("\nF10 - stopping")
                    break
            except Exception:
                pass    # hook can be unavailable without admin; overlay key still works

            elapsed = time.perf_counter() - started
            if args.seconds and elapsed >= args.seconds:
                print(f"\nreached --seconds {args.seconds:g}")
                break

            frame = camera.get_latest_frame()
            if frame is None:
                continue
            frame_i += 1

            if not checked_geometry:
                checked_geometry = True
                h, w = frame.shape[:2]
                if (w, h) != (screen_w, screen_h):
                    print(f"warning: capture {w}x{h} != desktop {screen_w}x{screen_h}. "
                          f"Click coordinates assume they match - check Windows display scaling.")

            boxes = detector.detect(frame)

            if frame_i % cfg["classify_every_n"] == 0:
                clf_frame = frame
                max_w = cfg["classify_max_width"]
                if max_w and frame.shape[1] > max_w:
                    # Match the collector's downscale so training and runtime
                    # feed the network the same resampling.
                    scale = max_w / frame.shape[1]
                    clf_frame = cv2.resize(frame, None, fx=scale, fy=scale,
                                           interpolation=cv2.INTER_AREA)
                probs = model(clf_frame, imgsz=cfg["classify_imgsz"], verbose=False)[0].probs
                label = names[int(probs.top1)]
                conf = float(probs.top1conf)
                tracker.observe(label, conf)
                zone = tracker.resolve()
                triage.maybe_dump(clf_frame, conf, label)

            rule = cfg["zones"].get(zone) if zone and zone != "transit" else None
            target = pick_target(boxes, rule, frame.shape) if rule else None

            expected = (rule or {}).get("expected_blobs")
            if target and expected is not None and len(boxes) != expected:
                target = None   # scene does not match the zone's fingerprint

            aim = None
            now = time.time()
            if target and clicker.ready(now):
                aim = clicker.click(target)
                print(f"click #{clicker.count} zone={zone} at {aim}"
                      f"{' (dry run)' if dry_run else ''}")

            now_tick = time.perf_counter()
            dt = now_tick - last_tick
            last_tick = now_tick
            if dt > 0:
                fps = 0.9 * fps + 0.1 * (1 / dt) if fps else 1 / dt

            if cfg["overlay_enabled"]:
                draw_overlay(frame, boxes, target, aim, zone, tracker, fps,
                             dry_run, cfg["overlay_scale"])
                if cv2.waitKey(1) & 0xFF in (27, ord("q")):
                    print("\nquit")
                    break
            elif elapsed - last_status >= 2.0:
                # No overlay window, so say something to the terminal instead.
                last_status = elapsed
                print(f"  {elapsed:6.1f}s  {fps:5.1f} fps  blobs={len(boxes)}  "
                      f"zone={zone or '-'}  clicks={clicker.count}")
    except KeyboardInterrupt:
        print("\ninterrupted")
    except Exception as err:
        if type(err).__name__ == "FailSafeException":
            print("\nfailsafe triggered - stopping")
        else:
            raise
    finally:
        camera.stop()
        cv2.destroyAllWindows()
        print(f"\nclicks: {clicker.count}   triaged frames: {triage.total}")
        if triage.total:
            print(f"low-confidence frames in {triage.dir}\n"
                  f"Sort them into a new session folder, then re-run prepare_dataset.py.")


if __name__ == "__main__":
    main()
