"""Real-time detector with a live preview (handoff Phase 7, proof-of-concept form).

    python -m detector.main --weights runs/detect/game/weights/best.pt
    python -m detector.main --filter                          # Phase 1 color filter, no model needed
    python -m detector.main --source synth --weights ...      # synthetic self-test scene
    python -m detector.main --source data/raw/s04 --weights ...   # replay recorded frames

Threads: capture (keeps only the newest frame) -> inference (detector, color
reader, JSON out) -> main thread (preview window).

Preview keys: q/Esc quit, space pause, s snapshot, +/- confidence threshold,
d toggles the detailed labels (id, type, color, screen position).

HTTP: GET http://127.0.0.1:8790/ returns the current boxes (API.md); --http 0 turns it off.
"""

from __future__ import annotations

import argparse
import errno
import json
import sys
import threading
import time
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime

import cv2
import numpy as np

from detector.capture import Frame, open_capture
from detector.color import ColorFilterDetector, ColorReader, ColorTable
from detector.common import RUNS, Detection, make_dpi_aware, resolve
from detector.filters import DetectionFilters
from detector.metrics import Tally
from detector.output import HttpSink, JsonlSink, UdpSink, draw, message, setup_preview_window, type_color
from tools.view import work_area

WINDOW = "game-detector preview"


@dataclass
class Result:
    frame: Frame
    dets: list[Detection]
    wait_ms: float      # frame age when inference started
    detect_ms: float
    color_ms: float
    latency_ms: float   # grab -> result ready
    speed: dict = field(default_factory=dict)


class Stats:
    def __init__(self, window_s: float = 2.0):
        self.window_s = window_s
        self.recent: deque = deque()
        self.latency, self.detect, self.color, self.wait = [], [], [], []
        self.t_first = None
        self.t_last = None

    def add(self, r: Result) -> None:
        now = time.perf_counter()
        self.t_first = self.t_first or now
        self.t_last = now
        self.recent.append((now, r.latency_ms, r.detect_ms, r.color_ms, len(r.dets)))
        while self.recent and now - self.recent[0][0] > self.window_s:
            self.recent.popleft()
        self.latency.append(r.latency_ms)
        self.detect.append(r.detect_ms)
        self.color.append(r.color_ms)
        self.wait.append(r.wait_ms)

    def line(self) -> str:
        if len(self.recent) < 2:
            return "waiting for frames..."
        span = self.recent[-1][0] - self.recent[0][0]
        rate = (len(self.recent) - 1) / span if span > 0 else 0.0
        lat = np.array([x[1] for x in self.recent])
        det = np.mean([x[2] for x in self.recent])
        col = np.mean([x[3] for x in self.recent])
        return (f"{rate:5.1f} det/s | grab->result {lat.mean():5.1f} ms (p95 {np.percentile(lat, 95):5.1f}) | "
                f"detect {det:4.1f} | color {col:4.2f} | objects {self.recent[-1][4]}")

    def summary(self) -> dict:
        n = len(self.latency)
        if n < 2:
            return {"results": n}
        dur = self.t_last - self.t_first
        lat = np.array(self.latency)
        return {
            "results": n,
            "seconds": round(dur, 2),
            "detections_per_s": round((n - 1) / dur, 2) if dur > 0 else None,
            "latency_ms": {k: round(float(v), 2) for k, v in
                           {"mean": lat.mean(), "p50": np.percentile(lat, 50), "p95": np.percentile(lat, 95),
                            "p99": np.percentile(lat, 99), "max": lat.max()}.items()},
            "share_within_20ms": round(float((lat <= 20).mean()), 4),
            "detect_ms_mean": round(float(np.mean(self.detect)), 2),
            "detect_ms_p95": round(float(np.percentile(self.detect, 95)), 2),
            "color_ms_mean": round(float(np.mean(self.color)), 3),
            "frame_age_at_start_ms_mean": round(float(np.mean(self.wait)), 2),
        }


class ColorVote:
    """With tracking on, show each track's most common recent color, so it doesn't flicker."""

    def __init__(self, length: int = 15):
        self.history: dict[int, deque] = defaultdict(lambda: deque(maxlen=length))

    def apply(self, dets: list[Detection]) -> None:
        for d in dets:
            if d.id is None or d.color.startswith("#"):  # raw colors aren't categories to vote on
                continue
            h = self.history[d.id]
            h.append(d.color)
            d.color = Counter(h).most_common(1)[0][0]


class Worker(threading.Thread):
    def __init__(self, grabber, detector, reader, sinks, tally, max_rate: float, vote: ColorVote | None,
                 filters: DetectionFilters | None = None):
        super().__init__(daemon=True, name="inference")
        self.filters = filters or DetectionFilters()
        self.grabber, self.detector, self.reader = grabber, detector, reader
        self.sinks, self.tally, self.vote = sinks, tally, vote
        self.min_dt = 1 / max_rate if max_rate else 0.0
        self.stats = Stats()
        self.latest: Result | None = None
        self.paused = False
        self.game_hidden = False
        self.error: BaseException | None = None
        self.done = threading.Event()
        self._stop_evt = threading.Event()
        self.read_colors = not isinstance(detector, ColorFilterDetector)

    def run(self) -> None:
        last_idx, last_done = 0, -1e9
        try:
            while not self._stop_evt.is_set():
                if self.paused:
                    time.sleep(0.02)
                    continue
                fr = self.grabber.latest(after=last_idx, timeout=0.25)
                if fr is None:
                    if self.grabber.finished:
                        break
                    continue
                last_idx = fr.idx
                # Rate cap: skip frames that come too soon after the last processed
                # one, so the frames that are processed are always fresh ones.
                if self.min_dt and fr.t - last_done < 0.85 * self.min_dt:
                    continue
                self.game_hidden = not fr.in_front
                if self.game_hidden:  # something covers the game: the frame isn't the game
                    continue
                last_done = fr.t
                self.latest = self.process(fr)
        except BaseException as e:
            self.error = e
        finally:
            self.done.set()

    def process(self, fr: Frame) -> Result:
        t0 = time.perf_counter()
        dets, speed = self.detector.detect(fr.image)
        dets = self.filters.apply(fr.image, dets)
        t1 = time.perf_counter()
        if self.read_colors:
            for d in dets:
                d.color, d.color_conf = self.reader.read(fr.image, d.box)
        if self.vote is not None:
            self.vote.apply(dets)
        t2 = time.perf_counter()
        r = Result(fr, dets, (t0 - fr.t) * 1e3, (t1 - t0) * 1e3, (t2 - t1) * 1e3, (t2 - fr.t) * 1e3, speed)
        self.stats.add(r)
        if self.sinks:
            msg = message(fr, dets, r.latency_ms)
            for s in self.sinks:
                s.send(msg)
        if self.tally is not None and fr.truth is not None:
            self.tally.update(dets, fr.truth)
        return r

    def stop(self) -> None:
        self._stop_evt.set()
        self.join(timeout=3)


def latest_weights() -> str | None:
    """The engine of the most recently trained run that has one, else the newest best.pt.

    tools.retrain exports the engine only when training is done, so a run that is
    still training (its best.pt is rewritten every epoch) is never picked up halfway,
    and neither are the bootstrap models used only for auto-labeling.
    """
    pts = list(RUNS.glob("detect/*/weights/best.pt"))
    done = [p for p in pts if p.with_suffix(".engine").exists()
            and p.with_suffix(".engine").stat().st_mtime >= p.stat().st_mtime]
    if done:
        return str(max(done, key=lambda p: p.stat().st_mtime).with_suffix(".engine"))
    return str(max(pts, key=lambda p: p.stat().st_mtime)) if pts else None


def save_snapshot(r: Result, annotated: np.ndarray | None) -> str:
    out = RUNS / "snapshots"
    out.mkdir(parents=True, exist_ok=True)
    stem = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    cv2.imwrite(str(out / f"{stem}.png"), r.frame.image)  # raw frame, usable for labeling
    if annotated is not None:
        cv2.imwrite(str(out / f"{stem}_preview.jpg"), annotated, [cv2.IMWRITE_JPEG_QUALITY, 92])
    (out / f"{stem}.json").write_text(json.dumps(message(r.frame, r.dets, r.latency_ms), indent=1))
    return str(out / stem)


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--weights", help="YOLO .pt or TensorRT .engine (default: newest runs/detect/*/weights/best.*)")
    p.add_argument("--filter", action="store_true", help="use the Phase 1 color filter instead of a model")
    p.add_argument("--source", default="screen", help='"screen" (see configs/capture.yaml), "synth", or a folder of frames')
    p.add_argument("--capture-config", default="configs/capture.yaml")
    p.add_argument("--colors", default="configs/colors.yaml")
    p.add_argument("--imgsz", default=None, help="inference size, 640 or H,W (default: the engine's export size "
                                                  "or the training size)")
    p.add_argument("--conf", type=float, default=0.4)
    p.add_argument("--iou", type=float, default=0.7)
    p.add_argument("--track", action="store_true", help="ByteTrack ids; also steadies colors")
    p.add_argument("--max-rate", type=float, default=30,
                   help="cap detections per second, leaving GPU time for the game (0 = every new frame)")
    p.add_argument("--fps", type=float, default=60, help="frame rate of the synth and folder sources")
    p.add_argument("--once", action="store_true", help="folder source: stop after the last frame")
    p.add_argument("--udp", metavar="HOST:PORT", help="send one JSON message per frame over UDP")
    p.add_argument("--jsonl", metavar="PATH", help="append one JSON line per frame to this file")
    p.add_argument("--http", type=int, default=8790, metavar="PORT",
                   help="serve the current boxes at GET http://<host>:PORT/ (API.md); 0 = off")
    p.add_argument("--http-host", default="127.0.0.1",
                   help="address the HTTP server listens on; 0.0.0.0 = reachable from other devices")
    p.add_argument("--no-preview", action="store_true")
    p.add_argument("--preview-width", type=int, default=0, help="preview width in px (default: half the screen)")
    p.add_argument("--details", action="store_true", help="label boxes with id, type, color and position")
    p.add_argument("--no-filters", action="store_true",
                   help="keep detections in the UI panels and on the progress bar (see configs/capture.yaml)")
    p.add_argument("--no-topmost", action="store_true", help="don't keep the preview above other windows")
    p.add_argument("--duration", type=float, default=0, help="stop after this many seconds")
    p.add_argument("--stats-json", help="write the final stats summary to this file")
    p.add_argument("--save-every", type=float, default=0, help="save a snapshot every N seconds (also headless)")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    make_dpi_aware()

    table = ColorTable.load(args.colors)
    reader = ColorReader(table)  # names from colors.yaml if calibrated, else "#rrggbb"
    swatches = {n: c.bgr() for n, c in table.colors.items()}
    if args.filter:
        try:
            detector = ColorFilterDetector(table)
        except ValueError as e:
            print(e, file=sys.stderr)
            return 2
        backend = "color filter"
    else:
        from detector.infer import YoloDetector

        weights = args.weights or latest_weights()
        if not weights:
            print("No --weights given and no trained model under runs/detect/. "
                  "Use --filter to run the color filter instead.", file=sys.stderr)
            return 2
        detector = YoloDetector(weights, imgsz=args.imgsz, conf=args.conf, iou=args.iou, track=args.track)
        backend = f"YOLO {resolve(weights).name}"

    try:
        grabber = open_capture(args.source, args.capture_config, fps=args.fps,
                               names=list(detector.names.values()), loop=not args.once)
    except (RuntimeError, FileNotFoundError) as e:
        print(f"capture: {e}", file=sys.stderr)
        return 2
    grabber.start()
    first = grabber.latest(timeout=5, take=False)  # warm-up only; the worker still gets it
    if first is None:
        grabber.stop()
        print("No frame from the capture within 5 s.", file=sys.stderr)
        return 1
    h, w = first.image.shape[:2]
    print(f"source: {args.source} ({type(grabber.source).__name__}) {w}x{h} at screen {grabber.region}")
    print(f"backend: {backend}" + (f", imgsz {detector.imgsz}, conf {args.conf}" if not args.filter else ""))
    for _ in range(3):  # warm-up: CUDA/TensorRT initialisation and memory allocation
        detector.detect(first.image)

    sinks = []
    if args.udp:
        sinks.append(UdpSink(args.udp))
    if args.jsonl:
        sinks.append(JsonlSink(args.jsonl))
    if args.http:
        try:
            http = HttpSink(args.http, args.http_host)
        except OSError as e:
            grabber.stop()
            for s in sinks:
                s.close()
            why = "is already in use" if e.errno == errno.EADDRINUSE else f"can't be opened (error {e.errno})"
            print(f"HTTP port {args.http} on {args.http_host} {why}. Is another detector running? "
                  f"Use --http <other port>, or --http 0 for no HTTP.", file=sys.stderr)
            return 2
        sinks.append(http)
        print(f"http: GET {http.url}")
    tally = Tally()
    vote = ColorVote() if args.track else None
    filters = DetectionFilters.load(args.capture_config, game_frames=args.source != "synth" and not args.no_filters)
    worker = Worker(grabber, detector, reader, sinks, tally, args.max_rate, vote, filters)
    worker.start()

    preview_w = args.preview_width or work_area()[0] // 2
    show_details = args.details
    for name in detector.names.values():  # fix the box colors in class order: first cyan, second magenta
        type_color(name)
    legend = "  ".join(f"{name}={c}" for name, c in zip(detector.names.values(), ("cyan", "magenta", "orange", "green")))

    def render(r: Result) -> np.ndarray:
        status = [worker.stats.line(),
                  f"{backend} | conf >= {detector.conf:.2f} | {legend} | q quit  space pause  s snapshot  "
                  f"+/- conf  d details"
                  + ("  [PAUSED]" if worker.paused else "")
                  + ("  [game not in front: paused]" if worker.game_hidden else "")]
        scale = min(1.0, preview_w / r.frame.image.shape[1])
        return draw(r.frame.image, r.dets, r.frame.origin, scale, swatches, status, r.frame.truth, show_details)

    t_start = time.perf_counter()
    next_print = t_start + 2
    next_save = t_start + args.save_every if args.save_every else None
    shown = None
    annotated = None
    win_info = None
    try:
        while True:
            now = time.perf_counter()
            r = worker.latest
            if args.duration and now - t_start >= args.duration:
                break
            if worker.done.is_set():
                break
            if now >= next_print:
                print(worker.stats.line(), flush=True)
                next_print = now + 2
            if next_save is not None and now >= next_save and r is not None:
                annotated = render(r)
                print("snapshot:", save_snapshot(r, annotated))
                next_save = now + args.save_every
            if args.no_preview:
                time.sleep(0.01)
                continue
            if r is not None and r is not shown:
                annotated = render(r)
                shown = r
                cv2.imshow(WINDOW, annotated)
                if win_info is None:
                    win_info = setup_preview_window(WINDOW, topmost=not args.no_topmost)
                    if win_info["hwnd"]:
                        grabber.also_front.add(win_info["hwnd"])  # clicking the preview doesn't pause
                    print(f"preview window: excluded from capture={win_info['excluded_from_capture']}, "
                          f"topmost={win_info['topmost']}")
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if key == ord(" "):
                worker.paused = not worker.paused
            elif key == ord("d"):
                show_details = not show_details
                shown = None  # redraw with the new style
            elif key == ord("s") and r is not None:
                print("snapshot:", save_snapshot(r, annotated))
            elif key in (ord("+"), ord("=")) and hasattr(detector, "conf"):
                detector.conf = min(0.95, round(detector.conf + 0.05, 2))
            elif key in (ord("-"), ord("_")) and hasattr(detector, "conf"):
                detector.conf = max(0.05, round(detector.conf - 0.05, 2))
            if win_info is not None and cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                break  # window closed with the mouse
    except KeyboardInterrupt:
        pass
    finally:
        worker.stop()
        grabber.stop()
        for s in sinks:
            s.close()
        if not args.no_preview:
            cv2.destroyAllWindows()

    if worker.error is not None:
        print(f"inference stopped with an error: {worker.error!r}", file=sys.stderr)
    summary = {"backend": backend, "source": args.source, "frames_captured": grabber.count,
               "live": worker.stats.summary()}
    if tally.frames:
        summary["accuracy"] = tally.summary()
    print(json.dumps(summary, indent=1))
    if args.stats_json:
        p = resolve(args.stats_json)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(summary, indent=1))
    return 1 if worker.error is not None else 0


if __name__ == "__main__":
    sys.exit(main())
