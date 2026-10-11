"""Screen capture.

A *source* produces frames. `Grabber` runs a source on its own thread and keeps
only the newest frame, so the consumer always gets the latest picture and never
works through a backlog.

Regions are [left, top, right, bottom] in screen pixels (virtual desktop,
physical pixels). Call `make_dpi_aware()` before using anything here.

Sources:
    dxcam   DXGI Desktop Duplication. The default, and what recorded frames use.
    mss     GDI BitBlt. A slower fallback in case DXGI misbehaves.
    folder  Replays saved frames, plus their YOLO labels if there are any.
    synth   The synthetic self-test scene from tools/synth.py.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from detector.common import Detection, load_yaml, resolve

# A private handle, so the argtypes set here don't leak into other libraries.
_user32 = ctypes.WinDLL("user32", use_last_error=True)
_user32.GetForegroundWindow.restype = wt.HWND
for _fn, _args in {
    "IsWindow": [wt.HWND],
    "IsIconic": [wt.HWND],
    "IsWindowVisible": [wt.HWND],
    "GetWindowTextLengthW": [wt.HWND],
    "GetWindowTextW": [wt.HWND, wt.LPWSTR, ctypes.c_int],
    "GetClientRect": [wt.HWND, ctypes.POINTER(wt.RECT)],
    "ClientToScreen": [wt.HWND, ctypes.POINTER(wt.POINT)],
}.items():
    getattr(_user32, _fn).argtypes = _args

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp"}


# --------------------------------------------------------------------- windows

def list_windows() -> list[tuple[int, str]]:
    """Visible top-level windows that have a title."""
    found: list[tuple[int, str]] = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def callback(hwnd, _):
        if _user32.IsWindowVisible(hwnd):
            n = _user32.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                _user32.GetWindowTextW(hwnd, buf, n + 1)
                found.append((hwnd, buf.value))
        return True

    _user32.EnumWindows(callback, 0)
    return found


def find_window(title: str) -> int | None:
    """The visible window titled `title`, ignoring case; failing that, the first
    whose title contains it. Exact matches win, so "RuneScape" doesn't pick a
    browser tab called "RuneScape Wiki"."""
    want = title.lower()
    windows = list_windows()
    for hwnd, name in windows:
        if name.lower() == want:
            return hwnd
    for hwnd, name in windows:
        if want in name.lower():
            return hwnd
    return None


def client_rect(hwnd) -> tuple[int, int, int, int] | None:
    """A window's client area in screen pixels; None if it is minimized or gone."""
    if not _user32.IsWindow(hwnd) or _user32.IsIconic(hwnd):
        return None
    r = wt.RECT()
    if not _user32.GetClientRect(hwnd, ctypes.byref(r)) or r.right <= 0 or r.bottom <= 0:
        return None
    pt = wt.POINT(0, 0)
    _user32.ClientToScreen(hwnd, ctypes.byref(pt))
    return (pt.x, pt.y, pt.x + r.right, pt.y + r.bottom)


def foreground_window() -> int | None:
    return _user32.GetForegroundWindow()


def primary_monitor() -> tuple[int, int, int, int]:
    return (0, 0, _user32.GetSystemMetrics(0), _user32.GetSystemMetrics(1))


def virtual_screen() -> tuple[int, int, int, int]:
    x, y = _user32.GetSystemMetrics(76), _user32.GetSystemMetrics(77)
    return (x, y, x + _user32.GetSystemMetrics(78), y + _user32.GetSystemMetrics(79))


# --------------------------------------------------------------------- sources

def _dxgi_outputs() -> list[tuple[int, int, tuple[int, int, int, int]]]:
    """(device index, output index, desktop rect) for every monitor dxcam can see."""
    import dxcam

    factory = getattr(dxcam, "__factory")  # dxcam keeps its output list here
    found = []
    for d_idx, outputs in enumerate(factory.outputs):
        for o_idx, out in enumerate(outputs):
            out.update_desc()
            r = out.desc.DesktopCoordinates
            found.append((d_idx, o_idx, (r.left, r.top, r.right, r.bottom)))
    return found


class DxcamSource:
    """DXGI Desktop Duplication. grab() returns None until the screen changes."""

    name = "dxcam"

    def __init__(self, region):
        import dxcam

        self._dxcam = dxcam
        self.camera = None
        self.output = None
        self.set_region(region)

    def set_region(self, region) -> None:
        l, t, r, b = (int(v) for v in region)
        cx, cy = (l + r) // 2, (t + b) // 2
        for d_idx, o_idx, (ol, ot, orr, ob) in _dxgi_outputs():
            if ol <= cx < orr and ot <= cy < ob:
                break
        else:
            raise RuntimeError(f"capture region {list(region)} is not on any monitor")
        if (d_idx, o_idx) != self.output:
            if self.camera is not None:
                self.camera.release()
            self.camera = self._dxcam.create(device_idx=d_idx, output_idx=o_idx, output_color="BGR")
            self.output = (d_idx, o_idx)
        l, t, r, b = max(l, ol), max(t, ot), min(r, orr), min(b, ob)
        self.rel = (l - ol, t - ot, r - ol, b - ot)
        self.region = (l, t, r, b)

    def grab(self) -> np.ndarray | None:
        return self.camera.grab(region=self.rel)

    def close(self) -> None:
        if self.camera is not None:
            self.camera.release()
            self.camera = None


class MssSource:
    """GDI capture through mss. Always returns a frame, changed or not."""

    name = "mss"

    def __init__(self, region):
        self.region = tuple(int(v) for v in region)
        self._sct = None

    def set_region(self, region) -> None:
        self.region = tuple(int(v) for v in region)

    def grab(self) -> np.ndarray:
        if self._sct is None:
            import mss

            self._sct = mss.mss()  # mss handles belong to the thread that made them
        l, t, r, b = self.region
        shot = self._sct.grab({"left": l, "top": t, "width": r - l, "height": b - t})
        return np.ascontiguousarray(np.asarray(shot)[:, :, :3])

    def close(self) -> None:
        if self._sct is not None:
            self._sct.close()
            self._sct = None


def read_yolo_labels(label_path: Path, width: int, height: int, names=None) -> list[Detection]:
    """YOLO txt label file -> Detection list in pixels."""
    dets = []
    if not label_path.exists():
        return dets
    for line in label_path.read_text().split("\n"):
        parts = line.split()
        if len(parts) < 5:
            continue
        cls = int(float(parts[0]))
        cx, cy, w, h = (float(v) for v in parts[1:5])
        box = ((cx - w / 2) * width, (cy - h / 2) * height, (cx + w / 2) * width, (cy + h / 2) * height)
        name = names[cls] if names and cls < len(names) else str(cls)
        dets.append(Detection(box=box, type=name, conf=1.0))
    return dets


def label_path_for(image_path: Path) -> Path:
    """Ultralytics layout: .../images/<split>/x.png -> .../labels/<split>/x.txt"""
    parts = list(image_path.parts)
    for i in range(len(parts) - 1, -1, -1):
        if parts[i] == "images":
            parts[i] = "labels"
            return Path(*parts).with_suffix(".txt")
    return image_path.with_suffix(".txt")


class FolderSource:
    """Replays saved frames at a fixed rate. Labels next to them become ground truth."""

    name = "folder"

    def __init__(self, path, fps: float = 30, loop: bool = True, names=None):
        p = resolve(path)
        if p.is_dir():
            self.files = sorted(f for f in p.rglob("*") if f.suffix.lower() in IMAGE_EXTS)
        else:
            self.files = [p]
        if not self.files:
            raise FileNotFoundError(f"no images in {p}")
        self.interval = 1 / fps
        self.loop = loop
        self.names = list(names) if names else None
        self.region = (0, 0, 0, 0)
        self.truth = None
        self.current = None
        self.done = False
        self._i = 0
        self._next = 0.0

    def set_region(self, region) -> None:
        pass

    def grab(self) -> np.ndarray | None:
        now = time.perf_counter()
        if now < self._next or self.done:
            return None
        if self._i >= len(self.files):
            if not self.loop:
                self.done = True
                return None
            self._i = 0
        f = self.files[self._i]
        self._i += 1
        self._next = now + self.interval
        img = cv2.imread(str(f), cv2.IMREAD_COLOR)
        lp = label_path_for(f)
        self.truth = read_yolo_labels(lp, img.shape[1], img.shape[0], self.names) if lp.exists() else None
        self.current = f
        self.region = (0, 0, img.shape[1], img.shape[0])
        return img

    def close(self) -> None:
        pass


class SynthSource:
    """The synthetic self-test scene, rendered live at a fixed rate."""

    name = "synth"

    def __init__(self, fps: float = 60, size=(1280, 720), seed: int = 0):
        from tools.synth import LiveScene

        self.scene = LiveScene(size=size, seed=seed)
        self.interval = 1 / fps
        self.region = (0, 0, size[0], size[1])
        self.truth = None
        self._next = 0.0

    def set_region(self, region) -> None:
        pass

    def grab(self) -> np.ndarray | None:
        now = time.perf_counter()
        if now < self._next:
            return None
        # Don't try to catch up after a stall; just keep the pace from here.
        self._next = self._next + self.interval if now - self._next < 0.1 else now + self.interval
        img, self.truth = self.scene.step(self.interval)
        return img

    def close(self) -> None:
        pass


# --------------------------------------------------------------------- grabber

@dataclass
class Frame:
    idx: int
    t: float                     # perf_counter() when the frame was grabbed
    wall: float                  # time.time() at the same moment
    image: np.ndarray            # BGR
    origin: tuple[int, int]      # screen position of the frame's top-left pixel
    truth: list[Detection] | None = None
    in_front: bool = True        # the followed window was the foreground window when grabbed


class Grabber(threading.Thread):
    """Runs a source on its own thread and keeps only the newest frame.

    With `hwnd` set, the capture region follows that window's client area,
    capture pauses while the window is minimized, and every frame records
    whether the window was in front. DXGI captures the screen, so a frame
    grabbed while another window covers the game shows that window instead.
    Windows in `also_front` (the preview) count as the game. With `lockstep`, no frame is
    dropped: the next one is grabbed only after the consumer took the last
    (for replaying a folder once, frame by frame).
    """

    def __init__(self, source, hwnd=None, max_fps: float = 0, lockstep: bool = False):
        super().__init__(daemon=True, name="capture")
        self.source = source
        self.hwnd = hwnd
        self.max_fps = max_fps
        self.lockstep = lockstep
        self.also_front: set[int] = set()
        self._taken = 0
        self.error: BaseException | None = None
        self.count = 0
        self.window_lost = False
        self.game_in_front = True
        self._frame: Frame | None = None
        self._cond = threading.Condition()
        self._stop_evt = threading.Event()

    @property
    def region(self):
        return self.source.region

    def run(self) -> None:
        min_dt = 1 / self.max_fps if self.max_fps else 0.0
        next_check = 0.0
        last = 0.0
        idx = 0
        try:
            while not self._stop_evt.is_set():
                now = time.perf_counter()
                if self.hwnd is not None and now >= next_check:
                    self._follow_window()
                    next_check = now + 1.0
                if self.window_lost:
                    time.sleep(0.05)
                    continue
                if min_dt and now - last < min_dt:
                    time.sleep(min(0.002, min_dt - (now - last)))
                    continue
                if self.lockstep:
                    with self._cond:
                        self._cond.wait_for(lambda: self._taken >= idx or self._stop_evt.is_set())
                img = self.source.grab()
                if img is None:
                    if getattr(self.source, "done", False):
                        break
                    time.sleep(0.0005)
                    continue
                t, wall = time.perf_counter(), time.time()
                last = t
                idx += 1
                if self.hwnd is not None:
                    fg = _user32.GetForegroundWindow()
                    self.game_in_front = fg == self.hwnd or fg in self.also_front
                l, top = self.source.region[:2]
                frame = Frame(idx, t, wall, img, (l, top), getattr(self.source, "truth", None), self.game_in_front)
                with self._cond:
                    self._frame = frame
                    self._cond.notify_all()
                self.count = idx
        except BaseException as e:  # surfaced to the consumer by latest()
            self.error = e
        finally:
            self._stop_evt.set()
            with self._cond:
                self._cond.notify_all()
            self.source.close()

    def _follow_window(self) -> None:
        rect = client_rect(self.hwnd)
        self.window_lost = rect is None
        if rect is not None and tuple(rect) != tuple(self.source.region):
            self.source.set_region(rect)

    def latest(self, after: int = 0, timeout: float = 1.0, take: bool = True) -> Frame | None:
        """The newest frame with idx > after; waits up to `timeout` for one.
        take=False only peeks: in lockstep mode the frame stays due for the consumer."""
        with self._cond:
            self._cond.wait_for(
                lambda: (self._frame is not None and self._frame.idx > after) or self._stop_evt.is_set(),
                timeout,
            )
            if self.error is not None:
                raise RuntimeError(f"capture failed: {self.error!r}") from self.error
            f = self._frame
            if f is not None and f.idx > after:
                if take:
                    self._taken = f.idx
                    self._cond.notify_all()
                return f
        return None

    @property
    def finished(self) -> bool:
        return self._stop_evt.is_set()

    def stop(self) -> None:
        self._stop_evt.set()
        with self._cond:
            self._cond.notify_all()
        if self.is_alive():
            self.join(timeout=2)


def open_capture(source: str = "screen", capture_cfg: str | Path = "configs/capture.yaml",
                 fps: float = 60, names=None, loop: bool = True) -> Grabber:
    """Build a Grabber for `source`.

    "screen" uses configs/capture.yaml, "window:<title>" follows a window,
    "synth" renders the self-test scene, anything else is a folder or image.
    """
    if source == "screen" or source.startswith("window:"):
        cfg = load_yaml(capture_cfg)
        if source.startswith("window:"):
            cfg["window"] = source.split(":", 1)[1]
        hwnd = None
        if cfg.get("window"):
            hwnd = find_window(cfg["window"])
            if hwnd is None:
                raise RuntimeError(f'no window with "{cfg["window"]}" in its title. Is it running?')
            region = client_rect(hwnd)
            if region is None:
                raise RuntimeError(f'window "{cfg["window"]}" is minimized')
        else:
            region = cfg.get("region") or primary_monitor()
        backend = cfg.get("backend", "dxcam")
        src = MssSource(region) if backend == "mss" else DxcamSource(region)
        return Grabber(src, hwnd=hwnd, max_fps=cfg.get("max_fps", 0) or 0)
    if source == "synth":
        return Grabber(SynthSource(fps=fps))
    # A single pass over a folder is an evaluation: process every frame.
    return Grabber(FolderSource(source, fps=fps, names=names, loop=loop), lockstep=not loop)
