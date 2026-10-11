"""Loads the JSON files in config/. The web pages import the same files, so both sides agree."""
from __future__ import annotations

import json
from functools import lru_cache

from . import paths


@lru_cache(maxsize=None)
def load(name: str) -> dict:
    with open(paths.CONFIG / f"{name}.json", encoding="utf-8") as f:
        return json.load(f)


def pipeline() -> dict:
    return load("pipeline")


def harness() -> dict:
    return load("harness")


def recorder() -> dict:
    return load("recorder")


def motion_matching() -> dict:
    return load("motion_matching")


def generative() -> dict:
    return load("generative")
