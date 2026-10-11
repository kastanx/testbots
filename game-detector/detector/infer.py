"""YOLO wrapper (Phase 4/7). Works with .pt weights and TensorRT .engine files."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from detector.common import Detection, load_yaml, resolve


def parse_imgsz(value) -> int | list[int]:
    """640, "640", "384,640" or [384, 640] (height, width)."""
    if isinstance(value, (list, tuple)):
        return [int(v) for v in value] if len(value) > 1 else int(value[0])
    s = str(value).replace("x", ",")
    parts = [int(p) for p in s.split(",") if p.strip()]
    return parts[0] if len(parts) == 1 else parts


def native_imgsz(weights: Path) -> int | list[int]:
    """The size a model expects: an engine's export size (it can't run at any
    other), the whole-frame size of a model trained on crops (infer.yaml in its
    run folder), or the training size of .pt weights."""
    if weights.suffix == ".engine":
        with open(weights, "rb") as f:  # Ultralytics prefixes engines with length + JSON metadata
            n = int.from_bytes(f.read(4), "little", signed=True)
            return parse_imgsz(json.loads(f.read(n).decode())["imgsz"])
    infer_cfg = load_yaml(weights.parent.parent / "infer.yaml")
    if infer_cfg.get("imgsz"):
        return parse_imgsz(infer_cfg["imgsz"])
    import torch

    ckpt = torch.load(weights, map_location="cpu", weights_only=False)
    return parse_imgsz((ckpt.get("train_args") or {}).get("imgsz", 640))


def keep_distinct(xyxy: np.ndarray, conf: np.ndarray, cls: np.ndarray, iou_thr: float = 0.45,
                  contain_thr: float = 0.6) -> np.ndarray:
    """Mask of boxes to keep: drop a box that overlaps a more confident box of the same
    class (IoU >= iou_thr) or lies mostly inside it (>= contain_thr of its own area).

    YOLO26 is NMS-free, and a model trained on a few duplicate labels learns to box
    one wisp twice (a box per orb plus one around both); this keeps one of them.
    """
    keep = np.zeros(len(conf), bool)
    area = (xyxy[:, 2] - xyxy[:, 0]) * (xyxy[:, 3] - xyxy[:, 1])
    for i in np.argsort(-conf):
        dup = False
        for j in np.flatnonzero(keep):
            if cls[j] != cls[i]:
                continue
            iw = min(xyxy[i, 2], xyxy[j, 2]) - max(xyxy[i, 0], xyxy[j, 0])
            ih = min(xyxy[i, 3], xyxy[j, 3]) - max(xyxy[i, 1], xyxy[j, 1])
            inter = max(0.0, iw) * max(0.0, ih)
            if inter / (area[i] + area[j] - inter) >= iou_thr or inter / min(area[i], area[j]) >= contain_thr:
                dup = True
                break
        keep[i] = not dup
    return keep


class YoloDetector:
    def __init__(self, weights: str | Path, imgsz=None, conf: float = 0.25, iou: float = 0.7,
                 device=0, track: bool = False, tracker: str = "bytetrack.yaml", dedupe: bool = True):
        from ultralytics import YOLO

        self.weights = resolve(weights)
        if not self.weights.exists():
            raise FileNotFoundError(f"weights not found: {self.weights}")
        self.model = YOLO(str(self.weights), task="detect")
        self.imgsz = parse_imgsz(imgsz) if imgsz else native_imgsz(self.weights)
        self.conf = conf
        self.iou = iou
        self.device = device
        self.engine = self.weights.suffix == ".engine"
        self.dedupe = dedupe
        self.tracker = self._new_tracker(tracker) if track else None

    @staticmethod
    def _new_tracker(name: str):
        # ByteTrack fed directly with CPU results. Ultralytics' own model.track()
        # adds a few ms of extra GPU syncs per frame.
        from ultralytics.trackers.byte_tracker import BYTETracker
        from ultralytics.utils import YAML, IterableSimpleNamespace
        from ultralytics.utils.checks import check_yaml

        return BYTETracker(args=IterableSimpleNamespace(**YAML.load(check_yaml(name))))

    @property
    def names(self) -> dict[int, str]:
        return self.model.names

    def detect(self, frame: np.ndarray) -> tuple[list[Detection], dict]:
        """Detections in frame pixels, plus Ultralytics' per-stage times in ms."""
        # The tracker also wants weak detections, to keep tracks through a bad frame.
        conf = min(self.conf, self.tracker.args.track_low_thresh) if self.tracker else self.conf
        kw = dict(imgsz=self.imgsz, conf=conf, iou=self.iou, device=self.device, verbose=False)
        if not self.engine:
            kw["quantize"] = 16  # FP16; an engine's precision is fixed at export time
        r = self.model.predict(frame, **kw)[0]
        boxes = r.boxes.cpu().numpy()  # the one GPU -> CPU copy
        if self.dedupe and len(boxes) > 1:
            boxes = boxes[keep_distinct(boxes.xyxy, boxes.conf, boxes.cls)]
        if self.tracker is not None:
            self.tracker.args.track_high_thresh = self.tracker.args.new_track_thresh = self.conf
            rows = np.asarray(self.tracker.update(boxes, frame)).reshape(-1, 8)
            picks = [(int(row[7]), int(row[4])) for row in rows]  # (detection index, track id)
        else:
            picks = [(i, None) for i in range(len(boxes))]
        xyxy, scores, cls = boxes.xyxy, boxes.conf, boxes.cls.astype(int)
        names = self.names
        dets = [Detection(box=tuple(float(v) for v in xyxy[i]), type=names[int(cls[i])], conf=float(scores[i]),
                          id=tid) for i, tid in picks]
        return dets, r.speed
