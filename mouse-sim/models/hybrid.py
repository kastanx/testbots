"""Hybrid (the simulator's default): motion matching wherever it has qualifying candidates, the
generative model everywhere else. Whether this or a per-region choice wins is the leaderboard's call."""
from __future__ import annotations

from .base import Model, TrialConditions
from .generative.sample import GenerativeModel
from .motion_matching.matcher import MotionMatching


class Hybrid(Model):
    name = "hybrid"
    version = "1"

    def __init__(self, run_dir: str | None = None):
        self.gen = GenerativeModel(run_dir)
        self.mm = MotionMatching(fallback=self.gen)

    def fit(self, ds) -> "Hybrid":
        self.mm.fit(ds)
        return self

    def describe(self) -> dict:
        return {"name": self.name, "version": self.version, "motion_matching": self.mm.describe(),
                "generative": self.gen.describe()}

    def generate(self, cond: TrialConditions, rng):
        return self.mm.generate(cond, rng)

    def generate_batch(self, conds: list, rng) -> list:
        covered = [bool(self.mm.distances(self.mm.conditions(c))[1].any()) for c in conds]
        out = [None] * len(conds)
        rest = [i for i, ok in enumerate(covered) if not ok]
        for i, ok in enumerate(covered):
            if ok:
                out[i] = self.mm.generate(conds[i], rng)
        if rest:
            for i, tl in zip(rest, self.gen.generate_batch([conds[i] for i in rest], rng)):
                tl.meta = {**getattr(tl, "meta", {}), "fallback": True}
                out[i] = tl
            self.mm.stats["fallback"] += len(rest)
        return out
