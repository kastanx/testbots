"""Live outputs: the preview image and the per-frame JSON stream (Phase 7)."""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import socket
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np

from detector.color import hex_bgr
from detector.common import Detection, resolve

_user32 = ctypes.WinDLL("user32", use_last_error=True)
_user32.FindWindowW.restype = wt.HWND
_user32.FindWindowW.argtypes = [wt.LPCWSTR, wt.LPCWSTR]
_user32.SetWindowDisplayAffinity.argtypes = [wt.HWND, wt.DWORD]
WDA_EXCLUDEFROMCAPTURE = 0x11

# Box colors per object type, in order of first appearance (BGR).
_TYPE_COLORS = [(255, 191, 0), (203, 66, 255), (0, 200, 255), (80, 220, 80), (255, 255, 255)]
_type_index: dict[str, int] = {}


def type_color(name: str) -> tuple[int, int, int]:
    i = _type_index.setdefault(name, len(_type_index))
    return _TYPE_COLORS[i % len(_TYPE_COLORS)]


def _label(img, text, x, y, fg=(255, 255, 255), bg=(0, 0, 0), scale=0.45):
    (tw, th), base = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 1)
    y = max(th + 3, y)
    cv2.rectangle(img, (x, y - th - 3), (x + tw + 4, y + base - 1), bg, -1)
    cv2.putText(img, text, (x + 2, y - 2), cv2.FONT_HERSHEY_SIMPLEX, scale, fg, 1, cv2.LINE_AA)
    return tw + 4


def draw(frame: np.ndarray, dets: list[Detection], origin: tuple[int, int], scale: float,
         swatches: dict[str, tuple[int, int, int]], status: list[str], truth: list[Detection] | None = None,
         details: bool = False) -> np.ndarray:
    """Preview image plus a status bar.

    Compact (default): a box in the type's color, the confidence and a dot in the
    object's color, so small objects stay visible. details=True adds the track id,
    type name, color value and screen-pixel center as text.
    """
    if scale != 1:
        img = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    else:
        img = frame.copy()
    ox, oy = origin
    if truth:
        for t in truth:  # ground truth, thin grey, only for synth / labeled replays
            x1, y1, x2, y2 = (int(round(v * scale)) for v in t.box)
            cv2.rectangle(img, (x1, y1), (x2, y2), (160, 160, 160), 1)
    for d in dets:
        x1, y1, x2, y2 = (int(round(v * scale)) for v in d.box)
        col = type_color(d.type)
        sw = swatches.get(d.color) or hex_bgr(d.color) or (128, 128, 128)
        if not details:
            cv2.rectangle(img, (x1 - 1, y1 - 1), (x2 + 1, y2 + 1), col, 2)
            cv2.circle(img, (x2 + 6, y1 + 3), 4, sw, -1)
            cv2.circle(img, (x2 + 6, y1 + 3), 4, (0, 0, 0), 1)
            cv2.putText(img, f"{d.conf * 100:.0f}", (x1, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.38, col, 1, cv2.LINE_AA)
            continue
        cv2.rectangle(img, (x1, y1), (x2, y2), col, 2)
        cx, cy = d.center
        ident = f"#{d.id} " if d.id is not None else ""
        top = f"{ident}{d.type} {d.conf:.2f}"
        bottom = f"{d.color} ({cx + ox:.0f},{cy + oy:.0f})"
        _label(img, top, x1, y1 - 2, fg=(0, 0, 0), bg=col)
        yb = min(img.shape[0] - 2, y2 + 14)
        cv2.rectangle(img, (x1, yb - 11), (x1 + 10, yb - 1), sw, -1)
        cv2.rectangle(img, (x1, yb - 11), (x1 + 10, yb - 1), (0, 0, 0), 1)
        _label(img, bottom, x1 + 12, yb)
        cv2.drawMarker(img, (int(cx * scale), int(cy * scale)), col, cv2.MARKER_CROSS, 8, 1)
    if status:
        h = 18 * len(status) + 6
        bar = img[:h].copy()
        cv2.rectangle(bar, (0, 0), (img.shape[1], h), (0, 0, 0), -1)
        img[:h] = cv2.addWeighted(img[:h], 0.35, bar, 0.65, 0)
        for i, line in enumerate(status):
            cv2.putText(img, line, (6, 17 + 18 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return img


def message(frame, dets: list[Detection], latency_ms: float) -> dict:
    """One JSON message per frame, in screen pixels (handoff Phase 7 format)."""
    ox, oy = frame.origin
    objects = []
    for d in dets:
        x1, y1, x2, y2 = d.box
        cx, cy = d.center
        objects.append({
            "id": d.id,
            "type": d.type,
            "color": d.color,
            "conf": round(d.conf, 3),
            "box": [round(x1 + ox), round(y1 + oy), round(x2 + ox), round(y2 + oy)],
            "center": [round(cx + ox), round(cy + oy)],
        })
    return {"t": round(frame.wall, 4), "frame": frame.idx, "latency_ms": round(latency_ms, 2), "objects": objects}


class UdpSink:
    """Fire-and-forget JSON datagrams; nobody listening is fine."""

    def __init__(self, target: str):
        host, port = target.rsplit(":", 1)
        self.addr = (host or "127.0.0.1", int(port))
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send(self, msg: dict) -> None:
        try:
            self.sock.sendto(json.dumps(msg, separators=(",", ":")).encode(), self.addr)
        except OSError:
            pass

    def close(self) -> None:
        self.sock.close()


class JsonlSink:
    def __init__(self, path: str):
        p = resolve(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        self.f = open(p, "a", encoding="utf-8")

    def send(self, msg: dict) -> None:
        self.f.write(json.dumps(msg, separators=(",", ":")) + "\n")

    def close(self) -> None:
        self.f.close()


class _ExclusiveHTTPServer(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second server bind the same port and share the
    # requests; exclusive use makes a second detector fail at startup instead.
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self) -> None:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        socketserver.TCPServer.server_bind(self)  # skips HTTPServer's slow reverse DNS lookup
        self.server_name, self.server_port = self.server_address[:2]


class HttpSink:
    """GET / returns the newest frame's boxes in screen pixels, [x1, y1, x2, y2] each,
    under one key per type: {"W": [...wisps], "C": [...craters]} (see API.md).

    With no result in the last max_age seconds (game not in front, paused,
    starting up) the answer is 503 with empty lists, so old boxes are never served.
    """

    KEYS = {"wisp": "W", "crater": "C"}

    def __init__(self, port: int, host: str = "127.0.0.1", max_age: float = 1.0):
        self.max_age = max_age
        self._latest: tuple[float, bytes] | None = None
        sink = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path.split("?", 1)[0] != "/":
                    self._reply(404, b'{"W":[],"C":[]}')
                    return
                latest = sink._latest
                if latest is None or time.monotonic() - latest[0] > sink.max_age:
                    self._reply(503, b'{"W":[],"C":[]}')
                else:
                    self._reply(200, latest[1])

            def _reply(self, code: int, body: bytes) -> None:
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):  # keep the console for the detector's own status
                pass

        self.httpd = _ExclusiveHTTPServer((host, port), Handler)
        self.url = f"http://{host}:{self.httpd.server_address[1]}/"
        threading.Thread(target=self.httpd.serve_forever, daemon=True, name="http").start()

    def send(self, msg: dict) -> None:
        out = {k: [] for k in self.KEYS.values()}
        for o in msg["objects"]:
            key = self.KEYS.get(o["type"])
            if key:
                out[key].append(o["box"])
        self._latest = (time.monotonic(), json.dumps(out, separators=(",", ":")).encode())

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def setup_preview_window(title: str, topmost: bool = True) -> dict:
    """Keep the preview out of screen capture and on top of the game.

    Excluding it from capture means it can sit over the captured area without
    showing up in its own frames: the capture sees the game underneath.
    """
    hwnd = _user32.FindWindowW(None, title)
    excluded = bool(hwnd) and bool(_user32.SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE))
    if topmost:
        try:
            cv2.setWindowProperty(title, cv2.WND_PROP_TOPMOST, 1)
        except cv2.error:
            topmost = False
    return {"hwnd": hwnd, "excluded_from_capture": excluded, "topmost": topmost}
