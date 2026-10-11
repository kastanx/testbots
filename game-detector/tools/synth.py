"""Synthetic self-test scene: two object types in seven colors on a game-like background.

This is not game data. It exists to prove the whole pipeline on this machine
before any real frames are labeled: training, TensorRT export, the live app,
the color reader and the accuracy numbers, all against exact ground truth.

    python -m tools.synth dataset      # datasets/synth: YOLO dataset, data.yaml, colors.yaml
    python -m tools.synth show         # the animated scene in a window (for a screen-capture test)

The live app can also render it directly: `python -m detector.main --source synth ...`.

Objects: "gem" (faceted diamond) and "slime" (dome with eyes). Look-alikes
that must not be detected: coins and crystal shards in the same colors,
colored flowers, a pond, HUD icons. Partial occlusion by trees, pillars and
explosions; objects cut off at the frame edge; lighting changes.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import dataclass, replace
from pathlib import Path

import cv2
import numpy as np

from detector.color import ColorTable, box_pixels_hsv, calibrate
from detector.common import Detection, resolve, save_yaml

TYPES = ("gem", "slime")
PALETTE = {  # BGR
    "red": (45, 45, 215),
    "orange": (35, 140, 240),
    "yellow": (45, 215, 230),
    "green": (70, 190, 60),
    "blue": (215, 115, 45),
    "purple": (190, 70, 150),
    "white": (232, 232, 232),
}
COLORS = tuple(PALETTE)
THEMES = {  # three BGR anchors along the terrain ramp
    "grass": [(40, 70, 95), (50, 120, 70), (40, 85, 45)],
    "sand": [(110, 170, 205), (90, 150, 180), (120, 130, 140)],
    "cave": [(45, 45, 52), (62, 72, 88), (82, 82, 76)],
    "snow": [(228, 218, 212), (200, 196, 190), (160, 150, 142)],
}
WINDOW_TITLE = "synthetic game"


@dataclass
class Obj:
    kind: str           # gem / slime, or a look-alike: coin / shard
    color: str
    bgr: tuple
    x: float            # center
    y: float
    s: float            # height in px
    vx: float = 0.0
    vy: float = 0.0
    angle: float = 0.0


# ------------------------------------------------------------------ drawing

def shade(col, k: float) -> tuple[int, int, int]:
    """k < 1 darkens, k > 1 mixes toward white."""
    c = np.asarray(col, np.float64)
    c = c * k if k <= 1 else c + (255 - c) * (k - 1)
    return tuple(int(np.clip(v, 0, 255)) for v in c)


def vary_color(col, rng) -> tuple[int, int, int]:
    """Small per-object hue, saturation and brightness jitter."""
    hsv = cv2.cvtColor(np.uint8([[col]]), cv2.COLOR_BGR2HSV)[0, 0].astype(np.int64)
    if hsv[1] > 40:
        hsv[0] = (hsv[0] + rng.integers(-3, 4)) % 180
    hsv[1] = np.clip(hsv[1] * rng.uniform(0.85, 1.08), 0, 255)
    hsv[2] = np.clip(hsv[2] * rng.uniform(0.8, 1.06), 0, 255)
    return tuple(int(v) for v in cv2.cvtColor(np.uint8([[hsv]]), cv2.COLOR_HSV2BGR)[0, 0])


def _p(a: np.ndarray) -> list[np.ndarray]:
    return [np.round(np.asarray(a) * 16).astype(np.int32)]  # 4 fractional bits (shift=4)


def _ellipse(cx, cy, ax, ay, a0, a1, n=28) -> np.ndarray:
    t = np.radians(np.linspace(a0, a1, n))
    return np.stack([cx + ax * np.cos(t), cy + ay * np.sin(t)], 1)


def draw_gem(img, idm, oid, o: Obj) -> np.ndarray:
    cx, cy, s, col = o.x, o.y, o.s, o.bgr
    w = 0.8 * s
    crown = np.array([[cx - .3 * w, cy - .45 * s], [cx + .3 * w, cy - .45 * s],
                      [cx + .5 * w, cy - .15 * s], [cx - .5 * w, cy - .15 * s]])
    left = np.array([[cx - .5 * w, cy - .15 * s], [cx, cy - .15 * s], [cx, cy + .5 * s]])
    right = np.array([[cx, cy - .15 * s], [cx + .5 * w, cy - .15 * s], [cx, cy + .5 * s]])
    outline = np.array([[cx - .3 * w, cy - .45 * s], [cx + .3 * w, cy - .45 * s], [cx + .5 * w, cy - .15 * s],
                        [cx, cy + .5 * s], [cx - .5 * w, cy - .15 * s]])
    cv2.fillPoly(img, _p(crown), shade(col, 1.35), cv2.LINE_AA, 4)
    cv2.fillPoly(img, _p(left), col, cv2.LINE_AA, 4)
    cv2.fillPoly(img, _p(right), shade(col, 0.72), cv2.LINE_AA, 4)
    th = max(1, round(s / 30))
    dark = shade(col, 0.4)
    for a, b in (((cx - .3 * w, cy - .45 * s), (cx - .12 * w, cy - .15 * s)),
                 ((cx + .3 * w, cy - .45 * s), (cx + .12 * w, cy - .15 * s)),
                 ((cx - .12 * w, cy - .15 * s), (cx, cy + .5 * s)),
                 ((cx + .12 * w, cy - .15 * s), (cx, cy + .5 * s))):
        cv2.line(img, _p(a)[0], _p(b)[0], shade(col, 0.6), 1, cv2.LINE_AA, 4)
    cv2.polylines(img, _p(outline), True, dark, th, cv2.LINE_AA, 4)
    hl = _ellipse(cx - .17 * w, cy - .34 * s, .09 * w, .035 * s, 0, 360, 12)
    cv2.fillPoly(img, _p(hl), (255, 255, 255), cv2.LINE_AA, 4)
    if idm is not None:
        cv2.fillPoly(idm, _p(outline), oid, cv2.LINE_8, 4)
    return outline


def draw_slime(img, idm, oid, o: Obj) -> np.ndarray:
    cx, cy, s, col = o.x, o.y, o.s, o.bgr
    w = 1.15 * s
    base = cy + .25 * s
    dome = _ellipse(cx, base, w / 2, .75 * s, 180, 360)
    skirt = _ellipse(cx, base, w / 2, .25 * s, 0, 180)
    body = np.vstack([dome, skirt])
    cv2.fillPoly(img, _p(body), col, cv2.LINE_AA, 4)
    cv2.fillPoly(img, _p(skirt), shade(col, 0.72), cv2.LINE_AA, 4)
    hl = _ellipse(cx - .22 * w, cy - .2 * s, .1 * w, .07 * s, 0, 360, 14)
    cv2.fillPoly(img, _p(hl), shade(col, 1.5), cv2.LINE_AA, 4)
    for side in (-1, 1):
        ex, ey = cx + side * .17 * w, cy - .02 * s
        cv2.fillPoly(img, _p(_ellipse(ex, ey, .09 * s, .11 * s, 0, 360, 14)), (250, 250, 250), cv2.LINE_AA, 4)
        cv2.fillPoly(img, _p(_ellipse(ex + side * .02 * s, ey + .02 * s, .045 * s, .06 * s, 0, 360, 12)),
                     (20, 20, 20), cv2.LINE_AA, 4)
    cv2.polylines(img, _p(body), True, shade(col, 0.4), max(1, round(s / 30)), cv2.LINE_AA, 4)
    if idm is not None:
        cv2.fillPoly(idm, _p(body), oid, cv2.LINE_8, 4)
    return body


def draw_coin(img, o: Obj) -> None:
    """Look-alike: a round coin in an object color, no eyes, no facets."""
    r = o.s / 2
    cv2.fillPoly(img, _p(_ellipse(o.x, o.y, r, r, 0, 360, 32)), shade(o.bgr, 0.8), cv2.LINE_AA, 4)
    cv2.fillPoly(img, _p(_ellipse(o.x, o.y, .72 * r, .72 * r, 0, 360, 28)), o.bgr, cv2.LINE_AA, 4)
    cv2.polylines(img, _p(_ellipse(o.x, o.y, r, r, 0, 360, 32)), True, shade(o.bgr, 0.45), 1, cv2.LINE_AA, 4)


def draw_shard(img, o: Obj) -> None:
    """Look-alike: a thin crystal shard in an object color."""
    c, sn = math.cos(o.angle), math.sin(o.angle)
    pts = np.array([[0, -o.s / 2], [o.s * .13, o.s * .3], [0, o.s / 2], [-o.s * .13, o.s * .3]])
    pts = pts @ np.array([[c, sn], [-sn, c]]) + [o.x, o.y]
    cv2.fillPoly(img, _p(pts), o.bgr, cv2.LINE_AA, 4)
    cv2.polylines(img, _p(pts), True, shade(o.bgr, 0.5), 1, cv2.LINE_AA, 4)


SHAPES = {"gem": draw_gem, "slime": draw_slime}


def draw_occluder(img, idm, kind: str, x: float, y: float, size: float, seed: int) -> None:
    r = np.random.default_rng(seed)
    if kind == "tree":
        for _ in range(4):
            cx, cy = x + r.uniform(-.5, .5) * size, y + r.uniform(-.4, .4) * size
            rad = size * r.uniform(.45, .7)
            pts = _ellipse(cx, cy, rad, rad, 0, 360, 36)
            cv2.fillPoly(img, _p(pts), (int(r.integers(25, 45)), int(r.integers(70, 105)), int(r.integers(30, 50))),
                         cv2.LINE_AA, 4)
            cv2.fillPoly(idm, _p(pts), -1, cv2.LINE_8, 4)
            hl = _ellipse(cx - rad * .3, cy - rad * .3, rad * .35, rad * .3, 0, 360, 20)
            cv2.fillPoly(img, _p(hl), (50, 130, 70), cv2.LINE_AA, 4)
    else:  # pillar
        w, h = size * .35, size * 2.2
        x1, y1, x2, y2 = x - w / 2, y - h / 2, x + w / 2, y + h / 2
        pts = np.array([[x1, y1], [x2, y1], [x2, y2], [x1, y2]])
        cv2.fillPoly(img, _p(pts), (118, 122, 126), cv2.LINE_AA, 4)
        cv2.fillPoly(img, _p(np.array([[x2 - w * .25, y1], [x2, y1], [x2, y2], [x2 - w * .25, y2]])), (82, 85, 88),
                     cv2.LINE_AA, 4)
        cv2.fillPoly(idm, _p(pts), -1, cv2.LINE_8, 4)


def draw_explosion(img, idm, x: float, y: float, r: float) -> None:
    for k, col in ((1.0, (20, 90, 230)), (.75, (40, 170, 250)), (.45, (170, 240, 255))):
        cv2.fillPoly(img, _p(_ellipse(x, y, r * k, r * k, 0, 360, 40)), col, cv2.LINE_AA, 4)
    cv2.fillPoly(idm, _p(_ellipse(x, y, r * .8, r * .8, 0, 360, 40)), -1, cv2.LINE_8, 4)


def draw_sparkle(img, x: float, y: float, r: float) -> None:
    col = (200, 255, 255)
    cv2.line(img, (int(x - r), int(y)), (int(x + r), int(y)), col, 1, cv2.LINE_AA)
    cv2.line(img, (int(x), int(y - r)), (int(x), int(y + r)), col, 1, cv2.LINE_AA)


def draw_hud(img, idm, rng_seed: int) -> None:
    """A game-style HUD: a bottom bar with colored icons (look-alikes) and some text."""
    H, W = img.shape[:2]
    r = np.random.default_rng(rng_seed)
    bar_h = 52
    y0 = H - bar_h
    img[y0:] = (img[y0:].astype(np.uint16) * 3 // 10 + 20).astype(np.uint8)
    idm[y0:] = -1
    for i in range(10):
        x = 16 + i * 46
        cv2.rectangle(img, (x, y0 + 8), (x + 36, y0 + 44), (90, 90, 90), 2)
        if r.random() < 0.7:
            col = PALETTE[COLORS[int(r.integers(len(COLORS)))]]
            if r.random() < 0.5:
                cv2.rectangle(img, (x + 8, y0 + 16), (x + 28, y0 + 36), col, -1)
            else:
                cv2.circle(img, (x + 18, y0 + 26), 10, col, -1, cv2.LINE_AA)
    cv2.putText(img, f"HP {int(r.integers(20, 99))}/99   MP {int(r.integers(5, 60))}/60", (W - 330, y0 + 33),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (90, 220, 90), 2, cv2.LINE_AA)
    cv2.putText(img, f"Score {int(r.integers(0, 99999)):05d}", (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                (0, 0, 0), 4, cv2.LINE_AA)
    cv2.putText(img, f"Score {int(r.integers(0, 99999)):05d}", (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                (240, 240, 240), 2, cv2.LINE_AA)
    cv2.rectangle(idm, (0, 0), (190, 40), -1, -1)


def make_world(rng, w: int, h: int, theme: str) -> np.ndarray:
    """A large terrain image to crop frames from."""
    a0, a1, a2 = (np.array(c, np.float32) for c in THEMES[theme])

    def noise(cell):
        g = rng.random((h // cell + 2, w // cell + 2)).astype(np.float32)
        return cv2.resize(g, (w, h), interpolation=cv2.INTER_CUBIC)

    t = 0.65 * noise(220) + 0.35 * noise(60)
    t = (t - t.min()) / (t.max() - t.min() + 1e-6)
    lo = (t < 0.5)[..., None]
    k = np.where(lo, t[..., None] * 2, (t[..., None] - 0.5) * 2)
    img = np.where(lo, a0 + (a1 - a0) * k, a1 + (a2 - a1) * k)
    img += rng.normal(0, 1.5, img.shape).astype(np.float32)
    img = np.clip(img, 0, 255).astype(np.uint8)

    for _ in range(int(rng.integers(1, 3))):  # paths
        pts = np.cumsum(rng.normal(0, 120, (8, 2)), 0) + [rng.uniform(0, w), rng.uniform(0, h)]
        cv2.polylines(img, [pts.astype(np.int32)], False, shade(a0, 0.8), int(rng.integers(18, 40)), cv2.LINE_AA)
    if rng.random() < 0.4:  # pond: a blue look-alike
        cx, cy = rng.uniform(0, w), rng.uniform(0, h)
        cv2.ellipse(img, (int(cx), int(cy)), (int(rng.uniform(80, 220)), int(rng.uniform(50, 140))), 0, 0, 360,
                    (150, 95, 40), -1, cv2.LINE_AA)
    for _ in range(w * h // 30000):  # rocks
        cx, cy = int(rng.uniform(0, w)), int(rng.uniform(0, h))
        ax, ay = int(rng.uniform(6, 34)), int(rng.uniform(5, 24))
        g = int(rng.integers(90, 150))
        ang = float(rng.uniform(0, 180))
        cv2.ellipse(img, (cx, cy), (ax, ay), ang, 0, 360, (g, g, g + 4), -1, cv2.LINE_AA)
        cv2.ellipse(img, (cx, cy), (ax, ay), ang, 0, 360, (g // 2, g // 2, g // 2), 1, cv2.LINE_AA)
    for _ in range(w * h // 9000):  # flowers: tiny colored dots
        col = PALETTE[COLORS[int(rng.integers(len(COLORS)))]]
        cv2.circle(img, (int(rng.uniform(0, w)), int(rng.uniform(0, h))), int(rng.integers(1, 4)), col, -1, cv2.LINE_AA)
    return img


def random_object(rng, kind: str, x: float, y: float, s_min=20.0, s_max=105.0) -> Obj:
    color = COLORS[int(rng.integers(len(COLORS)))]
    s = float(np.exp(rng.uniform(np.log(s_min), np.log(s_max))))
    return Obj(kind, color, vary_color(PALETTE[color], rng), x, y, s, angle=float(rng.uniform(0, math.pi)))


def render(bg: np.ndarray, objs: list[Obj], lookalikes: list[Obj], occluders: list[tuple],
           explosions: list[tuple], sparkles: list[tuple], hud_seed: int | None,
           gains=(1.0, 1.0, 1.0)) -> tuple[np.ndarray, list[Detection]]:
    """Draw one frame and work out the ground truth from what is actually visible."""
    img = bg.copy()
    idm = np.zeros(img.shape[:2], np.int16)
    for o in lookalikes:
        (draw_coin if o.kind == "coin" else draw_shard)(img, o)
    outlines = [SHAPES[o.kind](img, idm, i, o) for i, o in enumerate(objs, 1)]
    for kind, x, y, size, seed in occluders:
        draw_occluder(img, idm, kind, x, y, size, seed)
    for x, y, r in explosions:
        draw_explosion(img, idm, x, y, r)
    for x, y, r in sparkles:
        draw_sparkle(img, x, y, r)
    if hud_seed is not None:
        draw_hud(img, idm, hud_seed)
    if gains != (1.0, 1.0, 1.0):  # scene lighting, one lookup table per channel
        lut = np.clip(np.arange(256, dtype=np.float32)[:, None] * np.asarray(gains, np.float32), 0, 255)
        img = cv2.LUT(img, lut.astype(np.uint8).reshape(256, 1, 3))

    H, W = idm.shape
    truths = []
    for i, (o, poly) in enumerate(zip(objs, outlines), 1):
        x0, y0 = max(0, int(poly[:, 0].min()) - 2), max(0, int(poly[:, 1].min()) - 2)
        x1, y1 = min(W, int(poly[:, 0].max()) + 3), min(H, int(poly[:, 1].max()) + 3)
        if x0 >= x1 or y0 >= y1:
            continue
        m = idm[y0:y1, x0:x1] == i
        visible = int(m.sum())
        full = cv2.contourArea(poly.astype(np.float32))
        if visible < 20 or visible < 0.3 * full:  # labeling rule: >= 30% visible
            continue
        ys, xs = np.nonzero(m)
        box = (float(x0 + xs.min()), float(y0 + ys.min()), float(x0 + xs.max() + 1), float(y0 + ys.max() + 1))
        if box[2] - box[0] < 4 or box[3] - box[1] < 4:
            continue
        truths.append(Detection(box=box, type=o.kind, conf=1.0, color=o.color))
    return img, truths


# ------------------------------------------------------------------ live scene

class LiveScene:
    """An animated scene: objects drift around a world twice the frame size while the camera pans."""

    def __init__(self, size=(1280, 720), seed: int = 0, n_objects: int = 40):
        self.rng = np.random.default_rng(seed)
        self.W, self.H = size
        self.ww, self.wh = 2 * self.W, 2 * self.H
        self.world = make_world(self.rng, self.ww, self.wh, "grass")
        self.objs = [self._spawn() for _ in range(n_objects)]
        r = self.rng
        self.lookalikes = [random_object(r, str(r.choice(["coin", "shard"])), r.uniform(0, self.ww),
                                         r.uniform(0, self.wh), 14, 50) for _ in range(40)]
        self.occluders = [(str(r.choice(["tree", "tree", "pillar"])), float(r.uniform(0, self.ww)),
                           float(r.uniform(0, self.wh)), float(r.uniform(40, 110)), int(r.integers(1 << 30)))
                          for _ in range(16)]
        self.hud_seed = int(r.integers(1 << 30))
        self.t = 0.0
        self.boom = None

    def _spawn(self) -> Obj:
        r = self.rng
        o = random_object(r, str(r.choice(TYPES)), r.uniform(0, self.ww), r.uniform(0, self.wh))
        speed, ang = r.uniform(15, 110), r.uniform(0, 2 * math.pi)
        o.vx, o.vy = speed * math.cos(ang), speed * math.sin(ang)
        return o

    def step(self, dt: float) -> tuple[np.ndarray, list[Detection]]:
        r = self.rng
        self.t += dt
        for o in self.objs:
            o.x += o.vx * dt
            o.y += o.vy * dt
            if not 0 <= o.x <= self.ww:
                o.vx = -o.vx
            if not 0 <= o.y <= self.wh:
                o.vy = -o.vy
        if r.random() < dt * 1.5:  # keep the mix of types and colors changing
            self.objs[int(r.integers(len(self.objs)))] = self._spawn()
        cx = int(self.W / 2 * (1 + math.sin(0.11 * self.t)))
        cy = int(self.H / 2 * (1 + math.sin(0.07 * self.t + 1)))
        bg = self.world[cy:cy + self.H, cx:cx + self.W]

        def near(x, y, m):
            return -m < x - cx < self.W + m and -m < y - cy < self.H + m

        objs = [replace(o, x=o.x - cx, y=o.y - cy) for o in self.objs if near(o.x, o.y, o.s)]
        looks = [replace(o, x=o.x - cx, y=o.y - cy) for o in self.lookalikes if near(o.x, o.y, o.s)]
        occl = [(k, x - cx, y - cy, s, sd) for k, x, y, s, sd in self.occluders if near(x, y, 2.5 * s)]
        if self.boom is None and r.random() < dt * 0.3:
            self.boom = (r.uniform(0, self.W), r.uniform(0, self.H), r.uniform(25, 70), self.t)
        booms = []
        if self.boom is not None:
            x, y, rad, t0 = self.boom
            k = (self.t - t0) / 0.6
            if k > 1:
                self.boom = None
            else:
                booms.append((x, y, rad * (0.4 + 0.6 * k)))
        sparkles = [(o.x + r.uniform(-o.s, o.s), o.y + r.uniform(-o.s, o.s), r.uniform(2, 5))
                    for o in objs[:6] if r.random() < 0.5]
        light = 1 + 0.08 * math.sin(0.3 * self.t)
        gains = (light * (1 + 0.04 * math.sin(0.2 * self.t)), light, light * (1 - 0.04 * math.sin(0.2 * self.t)))
        return render(bg, objs, looks, occl, booms, sparkles, self.hud_seed, gains)


# ------------------------------------------------------------------ dataset

def random_frame(rng, world: np.ndarray, size) -> tuple[np.ndarray, list[Detection]]:
    W, H = size
    x0 = int(rng.integers(0, world.shape[1] - W))
    y0 = int(rng.integers(0, world.shape[0] - H))
    bg = world[y0:y0 + H, x0:x0 + W]
    if rng.random() < 0.5:
        bg = bg[:, ::-1]
    bg = np.ascontiguousarray(bg)
    n = 0 if rng.random() < 0.1 else int(rng.integers(1, 22))  # ~10% frames with no objects
    objs = [random_object(rng, str(rng.choice(TYPES)), rng.uniform(-.04, 1.04) * W, rng.uniform(-.04, 1.04) * H)
            for _ in range(n)]
    looks = [random_object(rng, str(rng.choice(["coin", "shard"])), rng.uniform(0, W), rng.uniform(0, H), 14, 50)
             for _ in range(int(rng.integers(0, 12)))]
    occl = [(str(rng.choice(["tree", "tree", "pillar"])), float(rng.uniform(0, W)), float(rng.uniform(0, H)),
             float(rng.uniform(40, 110)), int(rng.integers(1 << 30))) for _ in range(int(rng.integers(0, 4)))]
    booms = [(rng.uniform(0, W), rng.uniform(0, H), rng.uniform(25, 70))] if rng.random() < 0.15 else []
    sparkles = [(o.x + rng.uniform(-o.s, o.s), o.y + rng.uniform(-o.s, o.s), rng.uniform(2, 5))
                for o in objs if rng.random() < 0.3]
    hud = int(rng.integers(1 << 30)) if rng.random() < 0.7 else None
    light = rng.uniform(0.8, 1.12)
    gains = tuple(float(light * (1 + rng.uniform(-0.06, 0.06))) for _ in range(3))
    return render(bg, objs, looks, occl, booms, sparkles, hud, gains)


def write_yolo(path: Path, truths: list[Detection], W: int, H: int) -> None:
    lines = []
    for t in truths:
        x1, y1, x2, y2 = t.box
        lines.append(f"{TYPES.index(t.type)} {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} "
                     f"{(x2 - x1) / W:.6f} {(y2 - y1) / H:.6f}")
    path.write_text("\n".join(lines) + ("\n" if lines else ""))


def make_dataset(out: Path, counts: dict[str, int], size, seed: int) -> None:
    W, H = size
    rng = np.random.default_rng(seed)
    # Different worlds per split, like recording sessions: nothing leaks from train into val/test.
    worlds_per_theme = {"train": 3, "val": 1, "test": 1}
    table = ColorTable()
    color_crops: dict[str, list[np.ndarray]] = {c: [] for c in COLORS}
    t0 = time.time()
    total = 0
    for split, n in counts.items():
        worlds = [make_world(rng, 2 * W, 2 * H, th) for th in THEMES for _ in range(worlds_per_theme[split])]
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)
        for i in range(n):
            img, truths = random_frame(rng, worlds[int(rng.integers(len(worlds)))], size)
            stem = f"{split}_{i:05d}"
            cv2.imwrite(str(out / "images" / split / f"{stem}.png"), img, [cv2.IMWRITE_PNG_COMPRESSION, 1])
            write_yolo(out / "labels" / split / f"{stem}.txt", truths, W, H)
            if split == "train" and i < 400:  # color calibration samples, like labeled boxes with a color attribute
                for t in truths:
                    color_crops[t.color].append(box_pixels_hsv(img, t.box, table.reader["center_frac"]))
            total += 1
            if total % 200 == 0:
                print(f"  {total} frames, {time.time() - t0:.0f} s", flush=True)

    data = {"path": str(out.resolve()), "train": "images/train", "val": "images/val", "test": "images/test",
            "names": {i: n for i, n in enumerate(TYPES)}}
    save_yaml(out / "data.yaml", data, header="# Synthetic self-test dataset, written by tools/synth.py\n")
    table.colors = calibrate(color_crops, table.reader)
    table.save(out / "colors.yaml")
    meta = {"size": [W, H], "counts": counts, "seed": seed, "types": TYPES, "colors": COLORS,
            "seconds": round(time.time() - t0, 1)}
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    print(f"wrote {total} frames to {out} in {time.time() - t0:.0f} s; colors calibrated from labeled boxes:")
    for name, spec in table.colors.items():
        print(f"  {name:7s} {spec.to_dict()}")


def show(size, fps: float, seed: int) -> None:
    """Animated scene in a window, for testing real screen capture against it."""
    scene = LiveScene(size=size, seed=seed)
    cv2.namedWindow(WINDOW_TITLE, cv2.WINDOW_AUTOSIZE)
    dt = 1 / fps
    nxt = time.perf_counter()
    print(f'"{WINDOW_TITLE}" running; q or Esc to quit. '
          f'Capture it with: python -m detector.main --source "window:{WINDOW_TITLE}" ...')
    while True:
        img, _ = scene.step(dt)
        cv2.imshow(WINDOW_TITLE, img)
        nxt += dt
        wait = max(1, int((nxt - time.perf_counter()) * 1000))
        if cv2.waitKey(wait) & 0xFF in (ord("q"), 27):
            break
        if cv2.getWindowProperty(WINDOW_TITLE, cv2.WND_PROP_VISIBLE) < 1:
            break
    cv2.destroyAllWindows()


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("dataset", help="render a labeled YOLO dataset")
    d.add_argument("--out", default="datasets/synth")
    d.add_argument("--train", type=int, default=1200)
    d.add_argument("--val", type=int, default=200)
    d.add_argument("--test", type=int, default=200)
    d.add_argument("--size", default="1280x720")
    d.add_argument("--seed", type=int, default=7)
    s = sub.add_parser("show", help="show the animated scene in a window")
    s.add_argument("--size", default="1280x720")
    s.add_argument("--fps", type=float, default=60)
    s.add_argument("--seed", type=int, default=0)
    a = p.parse_args(argv)
    size = tuple(int(v) for v in a.size.lower().split("x"))
    if a.cmd == "dataset":
        make_dataset(resolve(a.out), {"train": a.train, "val": a.val, "test": a.test}, size, a.seed)
    else:
        show(size, a.fps, a.seed)


if __name__ == "__main__":
    main()
