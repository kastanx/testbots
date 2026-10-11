"""Where things live on disk. Every CLI takes --data to point at another data root (tests and the
synthetic owner use their own roots so they can never touch the owner's real recordings)."""
from __future__ import annotations

import os
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
CONFIG = PROJECT / "config"
REPORTS = PROJECT / "reports"
EXPORT = PROJECT / "models" / "export"
GEN_RUNS = PROJECT / "models" / "generative" / "runs"
WEB_DIST = PROJECT / "web" / "dist"


def data_root(override: str | os.PathLike | None = None) -> Path:
    if override:
        return Path(override).resolve()
    env = os.environ.get("MOUSESIM_DATA")
    return Path(env).resolve() if env else PROJECT / "data"


def raw_dir(root: Path) -> Path:
    return root / "raw"


def dryrun_dir(root: Path) -> Path:
    return root / "dryrun"


def processed_dir(root: Path) -> Path:
    return root / "processed"


def blindtest_dir(root: Path) -> Path:
    return root / "blindtests"


def setup_file(root: Path) -> Path:
    return root / "setup.json"


def splits_file(root: Path) -> Path:
    return root / "splits.json"
