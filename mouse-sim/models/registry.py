"""Model names used by the harness CLI and the export:

    line | minjerk | bezier      the Phase 4 baselines
    mm                          motion matching (Phase 5)
    gen[:<checkpoint dir>]      generative model (Phase 6), default models/generative/runs/latest
    hybrid[:<checkpoint dir>]   motion matching where it has qualifying candidates, generative elsewhere
    strokes                     new movements from the owner's strokes and texture (models/strokes)
"""
from __future__ import annotations

from .base import Model


def build(spec: str) -> Model:
    name, _, arg = spec.partition(":")
    name = name.removeprefix("baseline_")
    if name in ("line", "minjerk", "bezier"):
        from .baselines import Baseline
        return Baseline(name)
    if name in ("mm", "motion_matching"):
        from .motion_matching.matcher import MotionMatching
        return MotionMatching()
    if name in ("gen", "generative"):
        from .generative.sample import GenerativeModel
        return GenerativeModel(arg or None)
    if name == "hybrid":
        from .hybrid import Hybrid
        return Hybrid(arg or None)
    if name == "strokes":
        from .strokes.model import StrokeModel
        return StrokeModel()
    raise ValueError(f"unknown model {spec!r}")
