"""Loads data/processed/ for the harness and the models."""
from __future__ import annotations

import json
from functools import cached_property
from pathlib import Path

import numpy as np
import pandas as pd

from . import paths
from .timeline import Timeline, TimelineStore


class Dataset:
    def __init__(self, root: Path | str | None = None):
        self.root = paths.data_root(root)
        self.dir = paths.processed_dir(self.root)
        if not (self.dir / "movements.parquet").exists():
            raise FileNotFoundError(f"{self.dir} has no processed data; run `python -m pipeline process` first")
        self.trials = pd.read_parquet(self.dir / "trials.parquet")
        self.movements = pd.read_parquet(self.dir / "movements.parquet")
        self.fitts = json.loads((self.dir / "fitts.json").read_text())
        self.sessions = json.loads((self.dir / "sessions.json").read_text())

    @cached_property
    def store(self) -> TimelineStore:
        return TimelineStore.load(self.dir / "timelines.npz")

    @cached_property
    def profiles(self) -> dict:
        z = np.load(self.dir / "profiles.npz")
        return {"profiles": z["profiles"], "spectra": z["spectra"], "freqs": z["freqs"]}

    def timeline(self, tl_index: int) -> Timeline:
        return self.store.get(int(tl_index))

    def usable_trials(self, role: str | None = None, include_warmup: bool = False) -> pd.DataFrame:
        t = self.trials[~self.trials["rejected"]]
        if not include_warmup:
            t = t[~t["warmup"]]
        if role is not None:
            t = t[t["role"] == role]
        return t

    def usable_movements(self, role: str | None = None, include_warmup: bool = False,
                         primary_only: bool = False) -> pd.DataFrame:
        m = self.movements[~self.movements["rejected"]]
        if not include_warmup:
            m = m[~m["warmup"]]
        if role is not None:
            m = m[m["role"] == role]
        if primary_only:
            m = m[m["mov"] == 0]
        return m

    def roles(self) -> dict:
        return {s["session_id"]: s.get("role") for s in self.sessions if s.get("used")}
