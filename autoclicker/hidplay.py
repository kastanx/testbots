"""Real-time playback of a mouse movement with clicks, as relative HID reports.

Shared by autoclicker.py (Logitech gadget, /dev/hidg0) and rival600.py (the
Rival 600 copy), which each supply their own send(buttons, dx, dy).

build_events() turns the /moveclick document - the output of mouse-sim's
POST /api/generate, with "pos" or "changes" - into events (t_ms, buttons, dx,
dy): at t ms after the start, the buttons are in that state and the cursor
moves by (dx, dy). Only moments where something changes become events, the way
a real mouse only reports when something changes.

Playback plays them on time. A report goes out when its millisecond comes (the
host reads it at its next poll, within 1 ms). If playback falls behind, the
motion already due is merged into one report - never across a button change -
so the end position and the clicks are always exact.

While it plays, Playback.steer() can bend the rest of the movement so the next
press lands somewhere else (a target that moved), and Playback.cancel() can
drop the presses still to come (a target that's gone).
"""

import threading
import time

MAX_DURATION_MS = 60000
# A steer bends the movement over at least this long - a shorter bend would
# be a jump - and the press waits for it if need be.
MIN_BEND_MS = 40


class BadMove(ValueError):
    """The /moveclick document doesn't describe a valid movement."""


def _int(value, what):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value):
        raise BadMove(f"{what} must be a whole number (got {value!r})")
    return int(value)


def _point(value, what):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise BadMove(f"{what} must be [x, y] (got {value!r})")
    return _int(value[0], what + " x"), _int(value[1], what + " y")


def build_events(doc, with_clicks=True):
    """The document's movement and clicks as [(t_ms, buttons, dx, dy)].

    Returns (events, info) where info has the start position, the end time and
    the number of clicks. Raises BadMove if the document is invalid.
    """
    if not isinstance(doc, dict):
        raise BadMove("expected a JSON object with \"pos\" or \"changes\", and \"clicks\"")

    raw_clicks = doc.get("clicks")
    if not isinstance(raw_clicks, list) or not raw_clicks:
        raise BadMove("\"clicks\" must be a list with at least one {\"down\", \"up\"}")
    clicks = []
    for i, c in enumerate(raw_clicks):
        if not isinstance(c, dict):
            raise BadMove(f"clicks[{i}] must be {{\"down\": ms, \"up\": ms}}")
        down, up = _int(c.get("down"), f"clicks[{i}].down"), _int(c.get("up"), f"clicks[{i}].up")
        if not 0 <= down < up:
            raise BadMove(f"clicks[{i}]: need 0 <= down < up (got {down}, {up})")
        if clicks and down <= clicks[-1][1]:
            raise BadMove(f"clicks[{i}] starts before clicks[{i - 1}] ends")
        clicks.append((down, up))
    end = clicks[-1][1]
    if end > MAX_DURATION_MS:
        raise BadMove(f"movement is {end} ms long, the limit is {MAX_DURATION_MS} ms")

    # Change points [(t, x, y)]: from t on, the cursor is at (x, y).
    if "pos" in doc:
        pos = doc["pos"]
        if not isinstance(pos, list) or len(pos) < end + 1:
            raise BadMove(f"\"pos\" needs {end + 1} entries (one per ms up to the last up), "
                          f"got {len(pos) if isinstance(pos, list) else 'none'}")
        points = []
        last = None
        for t in range(end + 1):
            p = _point(pos[t], f"pos[{t}]")
            if p != last:
                points.append((t, p[0], p[1]))
                last = p
    elif "changes" in doc:
        raw = doc["changes"]
        if not isinstance(raw, list) or not raw:
            raise BadMove("\"changes\" must be a non-empty list of [t, x, y]")
        points = []
        for i, entry in enumerate(raw):
            if not isinstance(entry, (list, tuple)) or len(entry) != 3:
                raise BadMove(f"changes[{i}] must be [t, x, y] (got {entry!r})")
            t = _int(entry[0], f"changes[{i}] t")
            x, y = _int(entry[1], f"changes[{i}] x"), _int(entry[2], f"changes[{i}] y")
            if i == 0 and t != 0:
                raise BadMove("changes[0] must be at t = 0 (the start position)")
            if points and t <= points[-1][0]:
                raise BadMove(f"changes[{i}]: t must increase (got {t} after {points[-1][0]})")
            if t <= end:
                points.append((t, x, y))
    else:
        raise BadMove("expected \"pos\" or \"changes\"")

    start = points[0][1:]
    times = {t for t, _, _ in points[1:]}
    if with_clicks:
        times.update(t for c in clicks for t in c)

    events = []
    k = 0                       # points[k] is the position in force at time t
    prev = start
    buttons = 0
    ci = 0
    for t in sorted(times):
        while k + 1 < len(points) and points[k + 1][0] <= t:
            k += 1
        x, y = points[k][1], points[k][2]
        if with_clicks:
            while ci < len(clicks) and clicks[ci][1] <= t:
                ci += 1
            b = 1 if ci < len(clicks) and clicks[ci][0] <= t < clicks[ci][1] else 0
        else:
            b = 0
        dx, dy = x - prev[0], y - prev[1]
        if dx or dy or b != buttons:
            events.append((t, b, dx, dy))
        prev, buttons = (x, y), b

    info = {"start": list(start), "end_ms": end, "clicks": len(clicks) if with_clicks else 0,
            "distance": [prev[0] - start[0], prev[1] - start[1]]}
    return events, info


def wait_until(deadline, clock=time.monotonic, sleep=time.sleep):
    """Sleep most of the way, then spin the last fraction of a millisecond:
    sleeps alone can overshoot. The sleeps leave the CPU (and Python's lock)
    to other threads, so a steer is taken in at once."""
    left = deadline - clock()
    if left > 0.0004:
        sleep(left - 0.0003)
    while clock() < deadline:
        pass


class Refused(Exception):
    """A steer or cancel that can't be done now: nothing playing, the button
    already down, or the movement over."""


def min_jerk(u):
    """0 -> 1 with no speed or acceleration at either end: the shape of a
    quick, smooth correction by hand."""
    return u * u * u * (10 - 15 * u + 6 * u * u)


class Playback:
    """The events as a plan - for every millisecond, the position (relative to
    the start, in pixels) and the buttons - played one millisecond at a time:
    a report goes out in each millisecond whose rounded position or buttons
    differ from the last report's. steer() and cancel() change the part of the
    plan not played yet, from any thread.

    A steer is kept as a bend - (from, to, dx, dy): an offset that grows from
    nothing at `from` to (dx, dy) at `to` and stays after it - and the player
    adds the bends up for each millisecond it plays. So a steer takes
    microseconds, and never holds the player up."""

    def __init__(self, events, end_ms=None):
        end = max([t for t, _, _, _ in events] + [end_ms or 0])
        self.xs = [0] * (end + 1)
        self.ys = [0] * (end + 1)
        self.bs = [0] * (end + 1)
        x = y = b = 0
        k = 0
        for t in range(end + 1):
            while k < len(events) and events[k][0] == t:
                _, b, dx, dy = events[k]
                x += dx
                y += dy
                k += 1
            self.xs[t], self.ys[t], self.bs[t] = x, y, b
        self.bends = []         # (from, to, dx, dy)
        self.events = len(events)
        self.lock = threading.Lock()
        self.now = -1           # the last millisecond played; -1 before the start
        self.done = False

    def _at(self, t):
        """The planned position at ms t, bends included."""
        x, y = self.xs[t], self.ys[t]
        for a, e, dx, dy in self.bends:
            if t >= a:
                s = 1.0 if t > e else min_jerk((t - a + 1) / (e - a + 1))
                x += dx * s
                y += dy * s
        return x, y

    def _press_at(self, t0):
        """The next press at or after t0 (not one already down), or None."""
        bs = self.bs
        try:
            if t0 > 0 and bs[t0 - 1]:
                t0 = bs.index(0, t0)
            return bs.index(1, t0)
        except ValueError:
            return None

    def _check(self):
        if self.done:
            raise Refused("nothing is playing")
        t0 = self.now + 1
        if t0 > 0 and self.bs[t0 - 1]:
            raise Refused("the button is down")
        return t0

    def state(self):
        """Where playback is: {"playing", "at_ms", "press_ms" (None: no press
        left), "end_ms"}."""
        with self.lock:
            return {"playing": not self.done, "at_ms": self.now,
                    "press_ms": self._press_at(self.now + 1), "end_ms": len(self.bs) - 1}

    def handle(self, req):
        """A steer request: {"press": [dx, dy]} relative to the start, with
        "ms" optional (steer()), {"cancel": true} or {"peek": true}. Returns
        {"ok": True, ...the answer} or {"ok": False, "error": ...}."""
        try:
            if req.get("peek"):
                return {"ok": True, **self.state()}
            if req.get("cancel"):
                return {"ok": True, **self.cancel()}
            dx, dy = req["press"]
            return {"ok": True, **self.steer(float(dx), float(dy), req.get("ms", MIN_BEND_MS))}
        except Refused as exc:
            return {"ok": False, "error": str(exc)}
        except (AttributeError, KeyError, TypeError, ValueError) as exc:
            return {"ok": False, "error": "bad steer request: %r" % (exc,), "bad": True}

    def steer(self, x, y, ms=MIN_BEND_MS):
        """Bend the rest of the movement so the next press - or, with no press
        left, the end - lands on (x, y), relative to the start.

        The bend starts in the next millisecond and runs until the movement
        before the press ends, but at least `ms`; if that's past the press, the
        press (and all after it) waits until the bend is done. What comes after
        the bend - the pause, the press, the hold - moves along with it.
        Returns {"at_ms", "press_ms", "end_ms", "bend": [from, to], "moved"}.
        Raises Refused.
        """
        ms = max(MIN_BEND_MS, int(ms))
        with self.lock:
            t0 = self._check()
            n = len(self.bs)
            if t0 >= n:
                raise Refused("the movement is over")
            press = self._press_at(t0)
            target = press if press is not None else n - 1
            # the last millisecond before the press in which the plan moves -
            # the recorded movement, or an earlier bend still going on
            moving = t0 - 1
            for t in range(target - 1, max(t0, 1) - 1, -1):
                if self.xs[t] != self.xs[t - 1] or self.ys[t] != self.ys[t - 1]:
                    moving = t
                    break
            for _, e, _, _ in self.bends:
                if moving < e < target:
                    moving = e
            end = max(moving, t0 + ms - 1)
            # (every earlier bend ends before the press, so what's put in at
            # the press below is never inside one)
            if press is not None and end >= press:
                # the press waits: copies of the moment before it, without the button
                wait = end + 1 - press
                self.xs[press:press] = [self.xs[press]] * wait
                self.ys[press:press] = [self.ys[press]] * wait
                self.bs[press:press] = [0] * wait
                target = press = press + wait
            elif press is None and end > target:
                # no press: the movement ends when the bend does
                more = end - target
                self.xs.extend([self.xs[target]] * more)
                self.ys.extend([self.ys[target]] * more)
                self.bs.extend([self.bs[target]] * more)
                target = end
            px, py = self._at(target)
            dx, dy = x - px, y - py
            self.bends.append((t0, end, dx, dy))
            return {"at_ms": self.now, "press_ms": press, "end_ms": len(self.bs) - 1,
                    "bend": [t0, end], "moved": [round(dx), round(dy)]}

    def cancel(self):
        """Drop the presses still to come. A press already down is released as
        planned. Returns {"at_ms", "dropped"}. Raises Refused."""
        with self.lock:
            if self.done:
                raise Refused("nothing is playing")
            bs = self.bs
            n = len(bs)
            t = self.now + 1
            if 0 < t < n and bs[t - 1]:
                # the press that's down now goes on until its release
                t = bs.index(0, t) if 0 in bs[t:] else n
            dropped = sum(1 for i in range(t, n) if bs[i] and not (bs[i - 1] if i > t else 0))
            bs[t:] = [0] * (n - t)
            return {"at_ms": self.now, "dropped": dropped}

    def play(self, send, clock=time.monotonic, sleep=time.sleep):
        """Play the plan on time; send(buttons, dx, dy) returns once the host
        has the report. Returns playback stats, with "end": where the pointer
        ended up relative to the start, and "presses" sent."""
        start = clock()
        sx = sy = sb = 0        # what the reports so far add up to
        t = 0
        reports = presses = 0
        max_late = 0.0
        try:
            while True:
                due = start + t / 1000.0
                wait_until(due, clock, sleep)
                now = clock()
                with self.lock:
                    n = len(self.bs)
                    if t >= n:
                        break
                    # Behind schedule: on to the latest millisecond already due,
                    # as long as the buttons stay the same.
                    b = self.bs[t]
                    last = min(n - 1, int((now - start) * 1000))
                    while t < last and self.bs[t + 1] == b:
                        t += 1
                    self.now = t
                    x, y = self._at(t)
                    x, y = round(x), round(y)
                if (x, y, b) != (sx, sy, sb):
                    max_late = max(max_late, now - due)
                    send(b, x - sx, y - sy)
                    presses += b and not sb
                    sx, sy, sb = x, y, b
                    reports += 1
                t += 1
        finally:
            with self.lock:
                self.done = True
        return {"reports": reports, "events": self.events,
                "duration_ms": round((clock() - start) * 1000, 1),
                "max_late_ms": round(max_late * 1000, 2),
                "end": [sx, sy], "presses": presses, "steers": len(self.bends)}


def play(events, send, clock=time.monotonic):
    """Send the events on time; send(buttons, dx, dy) returns once the host
    has the report. Returns playback stats."""
    return Playback(events).play(send, clock)
