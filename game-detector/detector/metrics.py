"""Matching detections to ground truth, for live checks and error reviews."""

from __future__ import annotations

from collections import Counter

import numpy as np

from detector.common import Detection


def iou_matrix(a: list[Detection], b: list[Detection]) -> np.ndarray:
    if not a or not b:
        return np.zeros((len(a), len(b)))
    A = np.array([d.box for d in a], dtype=np.float64)
    B = np.array([d.box for d in b], dtype=np.float64)
    x1 = np.maximum(A[:, None, 0], B[None, :, 0])
    y1 = np.maximum(A[:, None, 1], B[None, :, 1])
    x2 = np.minimum(A[:, None, 2], B[None, :, 2])
    y2 = np.minimum(A[:, None, 3], B[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    area_a = (A[:, 2] - A[:, 0]) * (A[:, 3] - A[:, 1])
    area_b = (B[:, 2] - B[:, 0]) * (B[:, 3] - B[:, 1])
    return inter / np.maximum(area_a[:, None] + area_b[None, :] - inter, 1e-9)


def match(dets: list[Detection], truths: list[Detection], iou_thr: float = 0.5,
          same_type: bool = False) -> list[tuple[int, int]]:
    """Greedy one-to-one matching, highest confidence first. Returns (det, truth) index pairs."""
    ious = iou_matrix(dets, truths)
    pairs, used = [], set()
    for di in sorted(range(len(dets)), key=lambda i: -dets[i].conf):
        best, best_iou = None, iou_thr
        for ti in range(len(truths)):
            if ti in used or ious[di, ti] < best_iou:
                continue
            if same_type and dets[di].type != truths[ti].type:
                continue
            best, best_iou = ti, ious[di, ti]
        if best is not None:
            used.add(best)
            pairs.append((di, best))
    return pairs


class Tally:
    """Running detection, type and color accuracy against ground truth.

    Boxes are matched regardless of type (IoU >= 0.5), so a box that is found
    but given the wrong type counts as found + a type error, which keeps
    "can it see the object" apart from "does it know which one it is".
    """

    def __init__(self, iou_thr: float = 0.5):
        self.iou_thr = iou_thr
        self.frames = 0
        self.tp = self.fp = self.fn = 0
        self.type_ok = 0
        self.color_ok = self.color_total = 0
        self.type_confusion: Counter = Counter()
        self.color_confusion: Counter = Counter()
        self.per_type: Counter = Counter()  # (type, "tp"/"fp"/"fn")

    def update(self, dets: list[Detection], truths: list[Detection]) -> None:
        self.frames += 1
        pairs = match(dets, truths, self.iou_thr)
        matched_d = {d for d, _ in pairs}
        matched_t = {t for _, t in pairs}
        self.tp += len(pairs)
        self.fp += len(dets) - len(pairs)
        self.fn += len(truths) - len(pairs)
        for di, ti in pairs:
            d, t = dets[di], truths[ti]
            self.type_confusion[(t.type, d.type)] += 1
            if d.type == t.type:
                self.type_ok += 1
                self.per_type[(t.type, "tp")] += 1
            else:
                self.per_type[(t.type, "fn")] += 1
                self.per_type[(d.type, "fp")] += 1
            if t.color != "unknown":
                read = "unknown" if d.color.startswith("#") else d.color
                self.color_total += 1
                self.color_ok += read == t.color
                self.color_confusion[(t.color, read)] += 1
        for i, d in enumerate(dets):
            if i not in matched_d:
                self.per_type[(d.type, "fp")] += 1
        for i, t in enumerate(truths):
            if i not in matched_t:
                self.per_type[(t.type, "fn")] += 1

    def summary(self) -> dict:
        def ratio(a, b):
            return round(a / b, 4) if b else None

        types = sorted({k[0] for k in self.per_type})
        per_type = {}
        for t in types:
            tp, fp, fn = (self.per_type[(t, k)] for k in ("tp", "fp", "fn"))
            per_type[t] = {"precision": ratio(tp, tp + fp), "recall": ratio(tp, tp + fn), "tp": tp, "fp": fp, "fn": fn}
        color_errors = {f"{t}->{d}": n for (t, d), n in self.color_confusion.most_common() if t != d}
        type_errors = {f"{t}->{d}": n for (t, d), n in self.type_confusion.most_common() if t != d}
        return {
            "frames": self.frames,
            "boxes": {"precision": ratio(self.tp, self.tp + self.fp), "recall": ratio(self.tp, self.tp + self.fn),
                      "tp": self.tp, "fp": self.fp, "fn": self.fn},
            "type_accuracy": ratio(self.type_ok, self.tp),
            "color_accuracy": ratio(self.color_ok, self.color_total),
            "per_type": per_type,
            "type_errors": type_errors,
            "color_errors": dict(list(color_errors.items())[:10]),
        }
