#!/usr/bin/env python3
"""Mouse clicks and movements over HTTP, delivered as a USB HID mouse.

GET|POST /click  -> press, hold, release -> 204 No Content
POST /moveclick  -> play a movement with its clicks -> 200 + JSON stats
                    (body: the output of mouse-sim's POST /api/generate,
                    "pos" or "changes" plus "clicks"; ?noclick=1 plays the
                    movement only)
POST /steer      -> while a /moveclick plays: {"press": [x, y]} bends the rest
                    of it so the next press lands on (x, y) (screen pixels,
                    "ms" optional); {"cancel": true} drops the presses still
                    to come -> 200 + JSON, or 409 when there's nothing to steer
GET /steer       -> where the movement playing is: 200 + JSON
bad /moveclick or /steer body -> 400 Bad Request
HID unavailable -> 503 Service Unavailable
anything else   -> 404 Not Found

/moveclick starts at t = 0 when the request arrives, sends one relative report
per millisecond in which the position or the button changes, presses at each
click's "down" and releases at its "up", and answers after the last release.
The mouse only moves relatively: the cursor has to be at the document's start
position already, and Windows' "Enhance pointer precision" must be off for
the pixel deltas to land 1:1.

The hold is drawn fresh for every click from a log-normal distribution, which
is roughly the shape human click durations take: a floor, a peak a little below
100 ms, and a long tail. A uniform draw would be flat across the range, which
no hand produces.

Report width follows whatever the gadget declares in configfs, so the two
cannot drift apart and start rejecting writes.

With CLICK_HID_SOCKET set (the Rival 600 look-alike, rival600.py), reports go
to that gadget's socket instead of a /dev/hidg device; CLICK_REPORT_ID and
CLICK_REPORT_LENGTH then give the report's ID byte and full length.
"""

import os
import sys
import json
import math
import time
import random
import socket
import struct
import threading
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import hidplay

HID_DEVICE = os.environ.get("CLICK_HID_DEVICE", "/dev/hidg0")
HID_SOCKET = os.environ.get("CLICK_HID_SOCKET", "")
REPORT_ID = os.environ.get("CLICK_REPORT_ID", "")
PORT = int(os.environ.get("CLICK_PORT", "8080"))
# The Rival 600 copy plays movements itself, through this socket next to the
# click socket.
PLAY_SOCKET = os.environ.get(
    "CLICK_PLAY_SOCKET",
    os.path.join(os.path.dirname(HID_SOCKET), "play.sock") if HID_SOCKET else "",
)
MAX_BODY = 16 * 1024 * 1024

REPORT_LENGTH_PATH = (
    "/sys/kernel/config/usb_gadget/autoclicker/functions/hid.usb0/report_length"
)

HOLD_MIN_MS = float(os.environ.get("CLICK_HOLD_MIN_MS", "40"))
HOLD_MAX_MS = float(os.environ.get("CLICK_HOLD_MAX_MS", "200"))
HOLD_MEDIAN_MS = float(os.environ.get("CLICK_HOLD_MEDIAN_MS", "85"))
HOLD_SIGMA = float(os.environ.get("CLICK_HOLD_SIGMA", "0.28"))


def report_length():
    """Bytes per HID report: env override, else whatever the gadget declares."""
    env = os.environ.get("CLICK_REPORT_LENGTH")
    if env:
        return int(env)
    try:
        with open(REPORT_LENGTH_PATH) as fh:
            return int(fh.read().strip())
    except (OSError, ValueError):
        return 4


REPORT_LENGTH = report_length()

# After the report ID, if any, the first byte is the button bitmap; the rest
# (X, Y, wheel...) stay zero.
_PREFIX = bytes([int(REPORT_ID, 0)]) if REPORT_ID else b""
BUTTON_DOWN = _PREFIX + bytes([0x01]) + bytes(REPORT_LENGTH - len(_PREFIX) - 1)
BUTTON_UP = _PREFIX + bytes([0x00]) + bytes(REPORT_LENGTH - len(_PREFIX) - 1)

# Reports must not interleave, so every click holds this for its full duration.
_click_lock = threading.Lock()

# The movement playing now, for /steer: {"start": [x, y], "playback":
# hidplay.Playback (Logitech; the Rival copy keeps its own)}, or None.
_playing = None


def draw_hold_ms():
    """A hold duration in ms, log-normal within [HOLD_MIN_MS, HOLD_MAX_MS]."""
    if HOLD_MIN_MS >= HOLD_MAX_MS:
        return HOLD_MIN_MS

    mu = math.log(HOLD_MEDIAN_MS)
    value = HOLD_MEDIAN_MS
    # Resample rather than clamp, so the bounds do not pile up probability mass
    # at the edges and give the distribution two visible spikes.
    for _ in range(16):
        value = random.lognormvariate(mu, HOLD_SIGMA)
        if HOLD_MIN_MS <= value <= HOLD_MAX_MS:
            return value
    return min(max(value, HOLD_MIN_MS), HOLD_MAX_MS)


def _send_socket(report):
    """One report through the gadget's socket. Returns its answer:
    b"ok" taken by the host, b"busy" still waiting (it will be sent),
    b"down" host not reading. Raises OSError if the gadget isn't there."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
        sock.bind("")               # autobind, so the gadget can answer
        sock.settimeout(1.0)
        sock.sendto(report, HID_SOCKET)
        return sock.recv(16)


def click():
    """Send one left click. Returns the hold used, in ms.

    Raises OSError if the HID device is unusable.
    """
    hold_ms = draw_hold_ms()
    if HID_SOCKET:
        with _click_lock:
            answer = _send_socket(BUTTON_DOWN)
            if answer != b"ok":
                # A "busy" down is still queued: replace it with the up, so the
                # button can never be left pressed.
                _send_socket(BUTTON_UP)
                raise OSError("mouse not taking reports (%s)" % answer.decode(errors="replace"))
            time.sleep(hold_ms / 1000.0)
            _send_socket(BUTTON_UP)  # "busy" is still delivered
        return hold_ms

    with _click_lock:
        # Non-blocking: if the host is not polling us, fail fast with EAGAIN
        # rather than blocking this thread forever holding the lock.
        fd = os.open(HID_DEVICE, os.O_WRONLY | os.O_NONBLOCK)
        try:
            os.write(fd, BUTTON_DOWN)
            time.sleep(hold_ms / 1000.0)
            os.write(fd, BUTTON_UP)
        finally:
            os.close(fd)
    return hold_ms


def _ask_rival(payload, timeout):
    """One request on the Rival 600 copy's play socket; its one-line JSON answer."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(PLAY_SOCKET)
        sock.sendall(payload)
        answer = b""
        while not answer.endswith(b"\n"):
            chunk = sock.recv(4096)
            if not chunk:
                break
            answer += chunk
    return json.loads(answer or b"{}")


def _play_rival(events, end_ms):
    """Hand the events to the Rival 600 copy, which plays them; its stats."""
    payload = b"PLY2" + struct.pack("<II", len(events), end_ms) + b"".join(
        struct.pack("<IBhh", t, b, max(-32768, min(32767, dx)), max(-32768, min(32767, dy)))
        for t, b, dx, dy in events)
    result = _ask_rival(payload, end_ms / 1000.0 + 10)
    if not result.get("ok"):
        raise OSError(result.get("error", "no answer from the mouse"))
    result.pop("ok")
    return result


def steer(req):
    """Steer the movement playing now (hidplay.Playback.handle), with "press"
    in screen pixels. Returns {"ok": ..., ...}."""
    playing = _playing
    if playing is None:
        return {"ok": False, "error": "nothing is playing"}
    if isinstance(req.get("press"), list) and len(req["press"]) == 2:
        x, y = req["press"]
        try:
            req = {**req, "press": [float(x) - playing["start"][0], float(y) - playing["start"][1]]}
        except (TypeError, ValueError):
            return {"ok": False, "error": "press must be [x, y]", "bad": True}
    if HID_SOCKET:
        body = json.dumps(req).encode()
        return _ask_rival(b"STER" + struct.pack("<I", len(body)) + body, 2.0)
    return playing["playback"].handle(req)


def _play_device(pb):
    """Play the Playback on the /dev/hidg gadget (Logitech: buttons, X, Y,
    wheel as signed bytes); its stats."""
    fd = os.open(HID_DEVICE, os.O_WRONLY | os.O_NONBLOCK)

    def write(report):
        # One report waiting per endpoint: retry while the host hasn't read
        # the last one, but give up if it stops reading altogether.
        deadline = time.monotonic() + 0.1
        while True:
            try:
                os.write(fd, report)
                return
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise OSError("host isn't reading the mouse")
                time.sleep(0.0002)

    def send(b, dx, dy):
        while True:             # deltas beyond a signed byte go in several reports
            sx, sy = max(-127, min(127, dx)), max(-127, min(127, dy))
            write(_PREFIX + bytes([b, sx & 0xff, sy & 0xff]) + bytes(REPORT_LENGTH - len(_PREFIX) - 3))
            dx, dy = dx - sx, dy - sy
            if not dx and not dy:
                return

    try:
        return pb.play(send)
    except OSError:
        try:
            send(0, 0, 0)       # never leave the button pressed
        except OSError:
            pass
        raise
    finally:
        os.close(fd)


def move_click(events, info):
    """Play a movement with its clicks (info: build_events'); returns playback
    stats. /steer can bend it while it plays.

    Raises OSError if the HID device is unusable.
    """
    global _playing
    with _click_lock:
        pb = None if HID_SOCKET else hidplay.Playback(events, info["end_ms"])
        _playing = {"start": info["start"], "playback": pb}
        try:
            if HID_SOCKET:
                return _play_rival(events, info["end_ms"])
            return _play_device(pb)
        finally:
            _playing = None


class Handler(BaseHTTPRequestHandler):
    server_version = "autoclicker/1.4"

    def _path(self):
        path, _, query = self.path.partition("?")
        return path, parse_qs(query)

    def do_GET(self):
        path, _ = self._path()
        if path == "/click":
            return self._click()
        if path == "/moveclick":
            return self.send_error(405, "POST the movement as JSON")
        if path == "/steer":
            return self._steer({"peek": True})
        self.send_error(404, "Not Found")

    def do_POST(self):
        path, query = self._path()
        if path == "/click":
            return self._click()
        if path == "/moveclick":
            return self._moveclick(query)
        if path == "/steer":
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 < length <= 4096:
                return self._json(400, {"error": "send the steer as a JSON body (Content-Length 1-4096)"})
            try:
                req = json.loads(self.rfile.read(length))
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
            if not isinstance(req, dict):
                return self._json(400, {"error": "expected a JSON object"})
            return self._steer(req)
        self.send_error(404, "Not Found")

    def _steer(self, req):
        try:
            answer = steer(req)
        except (OSError, ValueError) as exc:
            self.log_message("steer failed: %s", exc)
            return self._json(503, {"error": str(exc)})
        if req.get("peek"):
            ok = answer.pop("ok", False)
            return self._json(200, answer if ok else {"playing": False})
        if answer.pop("ok", False):
            return self._json(200, answer)
        return self._json(400 if answer.pop("bad", False) else 409, answer)

    def _click(self):
        try:
            hold_ms = click()
        except OSError as exc:
            self.log_message("click failed: %s", exc)
            self.send_error(503, "Service Unavailable")
            return

        self.log_message("click held %.1f ms", hold_ms)
        self.send_response(204)
        self.end_headers()

    def _moveclick(self, query):
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY:
            return self._json(400, {"error": "send the movement as a JSON body (Content-Length 1-%d)" % MAX_BODY})
        body = self.rfile.read(length)
        noclick = query.get("noclick", ["0"])[0] not in ("0", "", "false")
        try:
            events, info = hidplay.build_events(json.loads(body), with_clicks=not noclick)
        except ValueError as exc:       # bad JSON or hidplay.BadMove
            return self._json(400, {"error": str(exc)})

        try:
            stats = move_click(events, info)
        except OSError as exc:
            self.log_message("moveclick failed: %s", exc)
            return self._json(503, {"error": str(exc)})

        result = {**info, **stats}
        steers = stats.get("steers", 0)
        self.log_message("moveclick %d ms, %d click(s), moved %s, %d reports, max %.2f ms late%s",
                         info["end_ms"], stats.get("presses", info["clicks"]),
                         stats.get("end", info["distance"]), stats["reports"], stats["max_late_ms"],
                         ", steered %d times" % steers if steers else "")
        self._json(200, result)

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stdout.write("%s %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()


def main():
    if HOLD_MIN_MS < 0 or HOLD_MAX_MS < HOLD_MIN_MS:
        sys.exit(
            "CLICK_HOLD_MIN_MS/CLICK_HOLD_MAX_MS invalid: %s..%s"
            % (HOLD_MIN_MS, HOLD_MAX_MS)
        )
    if not HOLD_MIN_MS <= HOLD_MEDIAN_MS <= HOLD_MAX_MS:
        sys.exit(
            "CLICK_HOLD_MEDIAN_MS %s is outside %s..%s"
            % (HOLD_MEDIAN_MS, HOLD_MIN_MS, HOLD_MAX_MS)
        )

    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(
        "listening on 0.0.0.0:%d, HID %s, %d-byte reports%s, "
        "hold median %.0f ms sigma %.2f within %.0f-%.0f ms"
        % (PORT, HID_SOCKET or HID_DEVICE, REPORT_LENGTH,
           " (report ID %s)" % REPORT_ID if REPORT_ID else "",
           HOLD_MEDIAN_MS, HOLD_SIGMA, HOLD_MIN_MS, HOLD_MAX_MS),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
