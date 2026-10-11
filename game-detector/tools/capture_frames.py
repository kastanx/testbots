"""Phase 2: record training frames exactly the way the live app captures them.

    python -m tools.capture_frames --session s01 --notes "forest map, crowded"

Hotkeys only act while the game window has focus, so typing them elsewhere does
nothing. The game still receives them too; change them in configs/capture.yaml
(record.hotkeys) if they clash with a game keybind. While another window is in
front of the game nothing is saved, because the screen capture would show that
window instead of the game.
    L    start / stop recording: one PNG every record.interval_ms (default 1000)
    K    burst: 5 frames 200 ms apart, for rare moments (never skipped as duplicates)
    J    end the session (Ctrl+C in this window works too)

Frames go to data/raw/<session>/<session>_<n>.png with meta.json beside them,
which also records configs/game.yaml. A frame that is a near-duplicate of the
last saved one is skipped: same perceptual hash and no region of the picture
changed, so frames where only a small object moved are kept. Saved frames are
never edited.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import queue
import threading
import time
import winsound
from datetime import datetime
from pathlib import Path

import cv2
import imagehash
from PIL import Image

from detector.capture import foreground_window, open_capture
from detector.common import ROOT, load_yaml, make_dpi_aware

DEFAULT_HOTKEYS = {"toggle": "L", "burst": "K", "quit": "J"}
VK = {f"F{i}": 0x6F + i for i in range(1, 25)}
VK.update({"PAUSE": 0x13, "SCROLLLOCK": 0x91, "INSERT": 0x2D, "HOME": 0x24, "END": 0x23,
           "PAGEUP": 0x21, "PAGEDOWN": 0x22})
VK.update({chr(c): c for c in range(0x30, 0x3A)})
VK.update({chr(c): c for c in range(0x41, 0x5B)})


class Hotkeys:
    """Global key presses via GetAsyncKeyState polling; reports each press once."""

    def __init__(self, names: dict[str, str]):
        self.codes = {action: VK[str(key).upper()] for action, key in names.items()}
        self.down = {action: False for action in self.codes}
        self._get = ctypes.windll.user32.GetAsyncKeyState

    def poll(self) -> set[str]:
        pressed = set()
        for action, code in self.codes.items():
            is_down = bool(self._get(code) & 0x8000)
            if is_down and not self.down[action]:
                pressed.add(action)
            self.down[action] = is_down
        return pressed


class Recorder:
    """Skips near-duplicates and writes PNGs on a background thread.

    A frame is a duplicate of the last saved one when their perceptual hashes
    are within `dedup_max` bits AND no part of the picture changed noticeably.
    The second test matters with a still camera: a small object moving barely
    changes a whole-frame hash, but that frame is exactly what training needs.
    """

    BLOCK = 16           # thumbnail pixels per block side (~100 px at 3440 wide)
    BLOCK_CHANGE = 8.0   # mean grey-level change that counts as "this block changed"

    def __init__(self, out: Path, session: str, dedup_max: int):
        self.out, self.session, self.dedup_max = out, session, dedup_max
        self.saved = self.duplicates = self.bursts = 0
        self.seq = max((int(p.stem.rsplit("_", 1)[-1]) for p in out.glob(f"{session}_*.png")),
                       default=0)
        self.last = None  # (hash, grey thumbnail) of the last saved frame
        self.q: queue.Queue = queue.Queue(maxsize=64)
        self.writer = threading.Thread(target=self._write, daemon=True)
        self.writer.start()

    def is_duplicate(self, ph, thumb) -> bool:
        if self.last is None or ph - self.last[0] > self.dedup_max:
            return False
        diff = cv2.absdiff(thumb, self.last[1])
        h, w = diff.shape
        blocks = cv2.resize(diff, (max(1, w // self.BLOCK), max(1, h // self.BLOCK)), interpolation=cv2.INTER_AREA)
        return float(blocks.max()) < self.BLOCK_CHANGE

    def offer(self, frame, burst: bool = False) -> bool:
        img = frame.image
        h, w = img.shape[:2]
        thumb = cv2.cvtColor(cv2.resize(img, (512, max(1, round(512 * h / w))), interpolation=cv2.INTER_AREA),
                             cv2.COLOR_BGR2GRAY)
        ph = imagehash.phash(Image.fromarray(thumb))
        if not burst and self.is_duplicate(ph, thumb):
            self.duplicates += 1
            return False
        self.last = (ph, thumb)
        self.seq += 1
        name = f"{self.session}_{self.seq:05d}.png"
        self.q.put((self.out / name, img))
        self.saved += 1
        return True

    def _write(self) -> None:
        while True:
            path, img = self.q.get()
            if path is None:
                return
            cv2.imwrite(str(path), img, [cv2.IMWRITE_PNG_COMPRESSION, 3])

    def close(self) -> None:
        self.q.put((None, None))
        self.writer.join(timeout=30)


def beep(freq: int, ms: int = 70) -> None:
    try:
        winsound.Beep(freq, ms)
    except RuntimeError:
        pass


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--session", default=None, help="session id (default: date_time)")
    p.add_argument("--notes", default="", help="what this session covers: map, situation, ...")
    p.add_argument("--interval", type=int, default=None, help="ms between frames (default from capture.yaml)")
    p.add_argument("--capture-config", default="configs/capture.yaml")
    p.add_argument("--append", action="store_true", help="add to an existing session folder")
    a = p.parse_args(argv)
    make_dpi_aware()

    cfg = load_yaml(a.capture_config)
    rec_cfg = cfg.get("record") or {}
    interval = (a.interval or rec_cfg.get("interval_ms", 1000)) / 1000
    burst_n, burst_gap = int(rec_cfg.get("burst_count", 5)), rec_cfg.get("burst_gap_ms", 200) / 1000
    hk = {**DEFAULT_HOTKEYS, **(rec_cfg.get("hotkeys") or {})}
    keys = Hotkeys(hk)

    session = a.session or datetime.now().strftime("%Y%m%d_%H%M%S")
    out = ROOT / "data" / "raw" / session
    if out.exists() and any(out.glob("*.png")) and not a.append:
        raise SystemExit(f"{out} already has frames; pick another --session or pass --append")
    out.mkdir(parents=True, exist_ok=True)

    grabber = open_capture("screen", a.capture_config)
    grabber.start()
    first = grabber.latest(timeout=5)
    if first is None:
        grabber.stop()
        raise SystemExit("no frame from the capture")
    rec = Recorder(out, session, int(rec_cfg.get("dedup_max_distance", 4)))
    meta = {
        "session": session,
        "notes": a.notes,
        "started": datetime.now().isoformat(timespec="seconds"),
        "capture": {"backend": type(grabber.source).__name__, "window": cfg.get("window"),
                    "region": list(grabber.region), "frame_size": [first.image.shape[1], first.image.shape[0]]},
        "interval_ms": round(interval * 1000),
        "dedup_max_distance": rec.dedup_max,
        "game": load_yaml("configs/game.yaml"),
    }

    def write_meta(**extra):
        meta.update(extra, saved=rec.saved, duplicates_skipped=rec.duplicates, bursts=rec.bursts)
        tmp = out / "meta.json.tmp"
        tmp.write_text(json.dumps(meta, indent=1))
        tmp.replace(out / "meta.json")

    write_meta()
    print(f"session {session} -> {out}\n{meta['capture']}\n"
          f"in the game: {hk['toggle']} start/stop, {hk['burst']} burst, {hk['quit']} end", flush=True)

    recording = False
    next_shot = 0.0
    burst_times: list[float] = []
    last_status = 0.0
    hidden_noted = False
    try:
        while True:
            now = time.perf_counter()
            pressed = keys.poll()
            if grabber.hwnd is not None and foreground_window() != grabber.hwnd:
                pressed = set()  # keys typed into other windows aren't meant for us
            if "quit" in pressed:
                break
            if "toggle" in pressed:
                recording = not recording
                next_shot = now
                beep(1200 if recording else 600)
                print("recording" if recording else "paused", flush=True)
                write_meta()
            if "burst" in pressed:
                burst_times = [now + i * burst_gap for i in range(burst_n)]
                rec.bursts += 1
                beep(1500, 40)
            if grabber.window_lost:
                time.sleep(0.05)
                continue
            due_burst = bool(burst_times) and now >= burst_times[0]
            due_shot = recording and now >= next_shot
            if due_burst or due_shot:
                f = grabber.latest(timeout=0.5)
                if f is not None and not f.in_front:
                    # Another window covers the game, so this frame isn't the game: skip it.
                    if not hidden_noted:
                        print("  game not in front: not saving until it is", flush=True)
                        hidden_noted = True
                    f = None
                elif f is not None and hidden_noted:
                    print("  game in front again", flush=True)
                    hidden_noted = False
                if due_burst:
                    burst_times.pop(0)
                    if f is not None:
                        rec.offer(f, burst=True)
                else:
                    next_shot += interval
                    if next_shot < now:  # fell behind (e.g. window was minimized): don't catch up
                        next_shot = now + interval
                    if f is not None:
                        rec.offer(f)
            if now - last_status > 5 and (recording or burst_times):
                print(f"  saved {rec.saved}, duplicates skipped {rec.duplicates}", flush=True)
                last_status = now
            time.sleep(0.01)
    except KeyboardInterrupt:
        pass
    finally:
        grabber.stop()
        rec.close()
        write_meta(ended=datetime.now().isoformat(timespec="seconds"))
    print(f"done: {rec.saved} frames saved, {rec.duplicates} duplicates skipped -> {out}")


if __name__ == "__main__":
    main()
