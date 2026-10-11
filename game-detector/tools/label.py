"""Labeler: draw boxes around the objects in recorded frames (Phase 3).

    python -m tools.label --session s01
    python -m tools.label --session s01 --weights runs/detect/first/weights/best.pt   # model pre-draws boxes

Labels go to data/labels/<session>/<frame>.txt (YOLO format), next to a
data.yaml with the class names from configs/dataset.yaml. A frame counts as
labeled once it has a label file, including an empty one: press Enter on a
frame that has no objects.

Mouse:  drag              draw a box of the current type
        click             select a box
        right-click       delete the box under the cursor
        wheel             zoom at the cursor; middle-drag pans
Keys:   1 / 2             type (also changes the selected box)
        Enter / Space     save, next frame
        D or right arrow  next frame;  A or left arrow  previous
        N                 next frame to do (unlabeled, or auto-labeled and not checked yet)
        X or Delete       delete the selected box
        Z                 undo
        F                 fit to window;  H  hide boxes
        Q or Esc          save, quit
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, replace
from pathlib import Path

import cv2
import numpy as np

from detector.capture import IMAGE_EXTS
from detector.common import ROOT, load_yaml, make_dpi_aware, resolve, save_yaml
from detector.filters import DetectionFilters
from tools.view import Viewport, wheel_up, work_area

WINDOW = "labeler"
CLASS_COLORS = [(255, 220, 0), (0, 150, 255), (80, 230, 80), (230, 90, 230)]  # BGR per class
STATUS_H = 46
KEY_LEFT, KEY_RIGHT, KEY_DELETE = 0x250000, 0x270000, 0x2E0000


@dataclass
class Box:
    cls: int
    x1: float
    y1: float
    x2: float
    y2: float

    def contains(self, x: float, y: float) -> bool:
        return self.x1 <= x <= self.x2 and self.y1 <= y <= self.y2

    @property
    def area(self) -> float:
        return (self.x2 - self.x1) * (self.y2 - self.y1)


def read_labels(path: Path, w: int, h: int) -> list[Box] | None:
    """Boxes from a YOLO label file; None when the frame has no label file yet."""
    if not path.exists():
        return None
    boxes = []
    for line in path.read_text().splitlines():
        p = line.split()
        if len(p) == 5:
            c, cx, cy, bw, bh = int(float(p[0])), *(float(v) for v in p[1:])
            boxes.append(Box(c, (cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h))
    return boxes


def write_labels(path: Path, boxes: list[Box], w: int, h: int) -> None:
    lines = []
    for b in boxes:
        x1, x2 = max(0.0, min(b.x1, b.x2)), min(float(w), max(b.x1, b.x2))
        y1, y2 = max(0.0, min(b.y1, b.y2)), min(float(h), max(b.y1, b.y2))
        if x2 - x1 >= 1 and y2 - y1 >= 1:
            lines.append(f"{b.cls} {(x1 + x2) / 2 / w:.6f} {(y1 + y2) / 2 / h:.6f} {(x2 - x1) / w:.6f} {(y2 - y1) / h:.6f}")
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + ("\n" if lines else ""))
    tmp.replace(path)


class Labeler:
    def __init__(self, frames: list[Path], out: Path, names: list[str], detector=None):
        self.frames, self.out, self.names, self.detector = frames, out, names, detector
        self.labeled = {p.stem for p in out.glob("*.txt")}
        # Frames labeled by tools.autolabel and not checked yet; Enter marks one as checked.
        self.auto_path = out / "auto.json"
        self.auto_meta = json.loads(self.auto_path.read_text()) if self.auto_path.exists() else {"frames": []}
        self.auto = set(self.auto_meta["frames"]) & self.labeled
        sw, sh = work_area()
        # Leave room for the window frame, the title bar and the status bar.
        self.max_w, self.max_h = sw - 24, sh - 40 - STATUS_H
        self.cls = 0
        self.hide = False
        self.mouse = (0, 0)
        self.drag = None   # (x, y) where a left-drag started, in view pixels
        self.pan = None    # last position of a middle-drag
        self.vp = None
        self.redraw = True
        self.i = next((k for k, f in enumerate(frames) if self.needs_work(f.stem)), 0)
        self.load(self.i)

    def needs_work(self, stem: str) -> bool:
        return stem not in self.labeled or stem in self.auto

    # ----------------------------------------------------------- frames
    def label_path(self, i: int) -> Path:
        return self.out / f"{self.frames[i].stem}.txt"

    def load(self, i: int) -> None:
        self.i = i
        self.img = cv2.imread(str(self.frames[i]))
        h, w = self.img.shape[:2]
        if self.vp is None or (self.vp.W, self.vp.H) != (w, h):  # keep zoom/pan between same-size frames
            self.vp = Viewport(w, h, self.max_w, self.max_h)
        boxes = read_labels(self.label_path(i), w, h)
        self.suggested = 0
        if boxes is None and self.detector is not None:
            dets = DetectionFilters.load().apply(self.img, self.detector.detect(self.img)[0])
            boxes = [Box(self.names.index(d.type), *d.box) for d in dets if d.type in self.names]
            self.suggested = len(boxes)
        self.boxes = boxes or []
        self.history: list[list[Box]] = []
        self.sel = None
        self.dirty = False
        self.base = None
        self.redraw = True

    def save(self) -> None:
        h, w = self.img.shape[:2]
        stem = self.frames[self.i].stem
        write_labels(self.label_path(self.i), self.boxes, w, h)
        self.labeled.add(stem)
        self.dirty = False
        self.suggested = 0
        if stem in self.auto:  # a person has checked it now
            self.auto.discard(stem)
            self.auto_meta["frames"] = sorted(self.auto)
            self.auto_path.write_text(json.dumps(self.auto_meta, indent=1))

    def go(self, i: int) -> None:
        if self.dirty:
            self.save()
        self.load(max(0, min(len(self.frames) - 1, i)))

    def next_unlabeled(self) -> None:
        n = len(self.frames)
        for k in range(1, n + 1):
            j = (self.i + k) % n
            if self.needs_work(self.frames[j].stem):
                self.go(j)
                return

    # ----------------------------------------------------------- edits
    def change(self) -> None:
        self.history.append([replace(b) for b in self.boxes])
        self.dirty = True

    def box_at(self, fx: float, fy: float) -> int | None:
        hits = [k for k, b in enumerate(self.boxes) if b.contains(fx, fy)]
        return min(hits, key=lambda k: self.boxes[k].area) if hits else None

    def set_class(self, c: int) -> None:
        if c >= len(self.names):
            return
        self.cls = c
        if self.sel is not None and self.boxes[self.sel].cls != c:
            self.change()
            self.boxes[self.sel].cls = c

    def delete(self, k: int | None) -> None:
        if k is not None:
            self.change()
            del self.boxes[k]
            self.sel = None

    def undo(self) -> None:
        if self.history:
            self.boxes = self.history.pop()
            self.sel = None
            self.dirty = True

    # ----------------------------------------------------------- input
    def on_mouse(self, event, x, y, flags, _=None) -> None:
        y = min(y, self.vp.vh - 1)
        self.mouse = (x, y)
        self.redraw = True
        if event == cv2.EVENT_LBUTTONDOWN:
            self.drag = (x, y)
        elif event == cv2.EVENT_LBUTTONUP and self.drag is not None:
            (x0, y0), self.drag = self.drag, None
            fx0, fy0 = self.vp.to_full(x0, y0)
            fx1, fy1 = self.vp.to_full(x, y)
            if abs(x - x0) >= 4 and abs(y - y0) >= 4:
                self.change()
                self.boxes.append(Box(self.cls, min(fx0, fx1), min(fy0, fy1), max(fx0, fx1), max(fy0, fy1)))
                self.sel = len(self.boxes) - 1
            else:
                self.sel = self.box_at(fx1, fy1)
                if self.sel is not None:
                    self.cls = self.boxes[self.sel].cls
        elif event == cv2.EVENT_RBUTTONDOWN:
            self.delete(self.box_at(*self.vp.to_full(x, y)))
        elif event == cv2.EVENT_MBUTTONDOWN:
            self.pan = (x, y)
        elif event == cv2.EVENT_MBUTTONUP:
            self.pan = None
        elif event == cv2.EVENT_MOUSEMOVE and self.pan is not None and flags & cv2.EVENT_FLAG_MBUTTON:
            self.vp.pan(x - self.pan[0], y - self.pan[1])
            self.pan = (x, y)
            self.base = None
        elif event == cv2.EVENT_MOUSEWHEEL:
            self.vp.wheel(x, y, wheel_up(flags))
            self.base = None

    def on_key(self, key: int) -> bool:
        """Handle one key; False means quit."""
        self.redraw = True
        ch = chr(key).lower() if 0 <= key < 256 else ""
        if ch in ("q", "\x1b"):
            if self.dirty:
                self.save()
            return False
        if ch in ("\r", "\n", " "):
            self.save()
            if self.i + 1 < len(self.frames):
                self.go(self.i + 1)
        elif ch == "d" or key == KEY_RIGHT:
            self.go(self.i + 1)
        elif ch == "a" or key == KEY_LEFT:
            self.go(self.i - 1)
        elif ch == "n":
            self.next_unlabeled()
        elif ch.isdigit() and ch != "0":
            self.set_class(int(ch) - 1)
        elif ch in ("x", "\x08") or key == KEY_DELETE:
            self.delete(self.sel)
        elif ch in ("z", "\x1a"):
            self.undo()
        elif ch == "f":
            self.vp.reset()
            self.base = None
        elif ch == "h":
            self.hide = not self.hide
        return True

    # ----------------------------------------------------------- drawing
    def render(self) -> np.ndarray:
        vp = self.vp
        if self.base is None:
            self.base = vp.render(self.img)
        canvas = np.zeros((vp.vh + STATUS_H, vp.vw, 3), np.uint8)
        canvas[:vp.vh] = self.base
        view = canvas[:vp.vh]
        if not self.hide:
            for k, b in enumerate(self.boxes):
                (x1, y1), (x2, y2) = vp.to_view(b.x1, b.y1), vp.to_view(b.x2, b.y2)
                col = CLASS_COLORS[b.cls % len(CLASS_COLORS)]
                p1, p2 = (int(round(x1)), int(round(y1))), (int(round(x2)), int(round(y2)))
                if k == self.sel:
                    cv2.rectangle(view, (p1[0] - 2, p1[1] - 2), (p2[0] + 2, p2[1] + 2), (255, 255, 255), 1)
                cv2.rectangle(view, p1, p2, col, 2)
                cv2.putText(view, self.names[b.cls] if b.cls < len(self.names) else str(b.cls), (p1[0], p1[1] - 4),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1, cv2.LINE_AA)
        mx, my = self.mouse
        if self.drag is not None:
            cv2.rectangle(view, self.drag, (mx, my), CLASS_COLORS[self.cls % len(CLASS_COLORS)], 1)
        cv2.line(view, (mx, 0), (mx, vp.vh - 1), (210, 210, 210), 1)
        cv2.line(view, (0, my), (vp.vw - 1, my), (210, 210, 210), 1)

        bar = canvas[vp.vh:]
        name = self.frames[self.i].name
        stem = self.frames[self.i].stem
        if stem in self.auto:
            state = "auto-labeled, not checked: fix if needed, Enter = OK"
        else:
            state = "labeled" if stem in self.labeled else "not labeled"
        if self.dirty:
            state += ", unsaved"
        if self.suggested:
            state += f", {self.suggested} boxes suggested by the model (Enter keeps them)"
        checking = f" ({len(self.auto)} auto to check)" if self.auto else ""
        line1 = (f"frame {self.i + 1}/{len(self.frames)}  {name}  [{state}]   labeled {len(self.labeled)}/"
                 f"{len(self.frames)}{checking}   type: [{self.cls + 1}] {self.names[self.cls]}   "
                 f"boxes {len(self.boxes)}   zoom {vp.zoom / vp.fit:.1f}x")
        types = "  ".join(f"{k + 1} {n}" for k, n in enumerate(self.names))
        line2 = (f"drag draw | click select | right-click delete | {types} | Enter/Space save+next | A/D prev/next | "
                 f"N next to do | X delete | Z undo | wheel zoom, middle-drag pan, F fit | H hide | Q quit")
        cv2.putText(bar, line1, (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(bar, line2, (8, 38), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (170, 170, 170), 1, cv2.LINE_AA)
        cv2.rectangle(bar, (vp.vw - 26, 6), (vp.vw - 8, 24), CLASS_COLORS[self.cls % len(CLASS_COLORS)], -1)
        return canvas

    def run(self) -> None:
        cv2.namedWindow(WINDOW, cv2.WINDOW_AUTOSIZE)
        cv2.moveWindow(WINDOW, 0, 0)
        cv2.setMouseCallback(WINDOW, self.on_mouse)
        while True:
            if self.redraw:
                cv2.imshow(WINDOW, self.render())
                self.redraw = False
            key = cv2.waitKeyEx(15)
            if key != -1 and not self.on_key(key):
                break
            if cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:  # closed with the mouse
                if self.dirty:
                    self.save()
                break
        cv2.destroyAllWindows()


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--session", help="label data/raw/<session>/")
    g.add_argument("--frames", help="label the images in this folder (needs --out)")
    p.add_argument("--out", help="label folder (default: data/labels/<session>)")
    p.add_argument("--weights", help="a trained model pre-draws boxes on frames that have no labels yet")
    p.add_argument("--conf", type=float, default=0.4, help="model boxes at or above this are suggested")
    a = p.parse_args(argv)
    make_dpi_aware()

    names = list(load_yaml("configs/dataset.yaml").get("names") or [])
    if not names:
        raise SystemExit("set the class names (`names:`) in configs/dataset.yaml first")
    src = ROOT / "data" / "raw" / a.session if a.session else resolve(a.frames)
    frames = sorted(f for f in src.glob("*") if f.suffix.lower() in IMAGE_EXTS)
    if not frames:
        raise SystemExit(f"no frames in {src}")
    if a.out:
        out = resolve(a.out)
    elif a.session:
        out = ROOT / "data" / "labels" / a.session
    else:
        raise SystemExit("--frames needs --out")
    out.mkdir(parents=True, exist_ok=True)
    meta = {"names": {i: n for i, n in enumerate(names)}}
    if load_yaml(out / "data.yaml") != meta:
        save_yaml(out / "data.yaml", meta, header="# Class names for the labels in this folder (tools.label)\n")

    detector = None
    if a.weights:
        from detector.infer import YoloDetector

        detector = YoloDetector(a.weights, conf=a.conf)
    lab = Labeler(frames, out, names, detector)
    print(f"{len(frames)} frames in {src}, {len(lab.labeled)} already labeled -> {out}")
    lab.run()
    print(f"labeled {len(lab.labeled)}/{len(frames)} frames -> {out}")


if __name__ == "__main__":
    sys.exit(main())
