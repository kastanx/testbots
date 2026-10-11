"""Metric 3: the owner's blind test (run in the simulator, saved to data/blindtests/).

Each trial plays one real test movement and one generated movement for the same start and target,
in random order; the owner picks the real one. With 100 trials, 59 or more correct is better than
chance at p < 0.05, so the model passes with 58 or fewer.
"""
from __future__ import annotations

import json
from pathlib import Path

from scipy.stats import binomtest

from pipeline import config, paths


def score(result: dict) -> dict:
    trials = [t for t in result.get("trials", []) if t.get("answer") in ("A", "B")]
    n = len(trials)
    correct = sum(1 for t in trials if t["answer"] == t["real"])
    cfg = config.harness()["blind"]
    p = binomtest(correct, n, 0.5, alternative="greater").pvalue if n else float("nan")
    return {"n": n, "correct": correct, "p_value": float(p), "model": result.get("model"),
            "complete": n >= cfg["trials"],
            "pass": n >= cfg["trials"] and correct <= cfg["pass_max_correct"] * n / cfg["trials"]}


def latest(root: Path, model_name: str) -> dict | None:
    d = paths.blindtest_dir(Path(root))
    if not d.is_dir():
        return None
    best = None
    for f in sorted(d.glob("*.json")):
        res = json.loads(f.read_text())
        if res.get("model") != model_name:
            continue
        s = score(res)
        s["file"] = f.name
        if s["complete"]:
            best = s
    return best
