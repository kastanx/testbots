"""Turn the green blobs found in a frame into the one box to click.

Boxes are OpenCV bounding rects: (x, y, w, h) in frame coordinates.
Which box wins is decided per zone by bot/config.json.
"""


def _area(b):
    return b[2] * b[3]


def _cx(b):
    return b[0] + b[2] / 2


def _cy(b):
    return b[1] + b[3] / 2


SORT_KEYS = {
    "x": _cx,
    "y": _cy,
    "area": _area,
}

STRATEGIES = {
    "leftmost": lambda boxes, rule, shape: min(boxes, key=_cx),
    "rightmost": lambda boxes, rule, shape: max(boxes, key=_cx),
    "topmost": lambda boxes, rule, shape: min(boxes, key=_cy),
    "bottommost": lambda boxes, rule, shape: max(boxes, key=_cy),
    "largest": lambda boxes, rule, shape: max(boxes, key=_area),
    "smallest": lambda boxes, rule, shape: min(boxes, key=_area),
}


def _nearest_center(boxes, rule, shape):
    if not shape:
        return max(boxes, key=_area)
    h, w = shape[0], shape[1]
    return min(boxes, key=lambda b: (_cx(b) - w / 2) ** 2 + (_cy(b) - h / 2) ** 2)


def _by_index(boxes, rule, shape):
    key = SORT_KEYS.get(rule.get("sort", "x"), _cx)
    ordered = sorted(boxes, key=key)
    i = int(rule.get("index", 0))
    # Out of range means the scene is not what the rule assumed - clicking the
    # nearest box anyway is how a bot ends up clicking the wrong thing.
    if i < -len(ordered) or i >= len(ordered):
        return None
    return ordered[i]


STRATEGIES["nearest_center"] = _nearest_center
STRATEGIES["index"] = _by_index


def in_roi(box, roi):
    """True when the box centre falls inside roi = [x, y, w, h]."""
    rx, ry, rw, rh = roi
    return rx <= _cx(box) <= rx + rw and ry <= _cy(box) <= ry + rh


def filter_boxes(boxes, rule):
    """Apply the zone's optional roi / area window before any strategy runs."""
    if not rule:
        return list(boxes)
    out = list(boxes)
    roi = rule.get("roi")
    if roi:
        out = [b for b in out if in_roi(b, roi)]
    lo = rule.get("min_area")
    hi = rule.get("max_area")
    if lo is not None:
        out = [b for b in out if _area(b) >= lo]
    if hi is not None:
        out = [b for b in out if _area(b) <= hi]
    return out


def pick_target(boxes, rule, frame_shape=None):
    """Return the chosen (x, y, w, h), or None when the rule cannot be satisfied."""
    if not boxes or not rule:
        return None
    candidates = filter_boxes(boxes, rule)
    if not candidates:
        return None
    strategy = STRATEGIES.get(rule.get("pick", "largest"))
    if strategy is None:
        raise ValueError(f"unknown pick strategy: {rule.get('pick')!r} "
                         f"(known: {', '.join(sorted(STRATEGIES))})")
    return strategy(candidates, rule, frame_shape)
