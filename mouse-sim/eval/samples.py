"""Sets of movements to compare: the real test set, model output, and matched real reference sets.
Every set is measured with pipeline.features.analyse_timeline, the same code the pipeline uses."""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from pipeline import config, geometry
from pipeline.dataset import Dataset
from pipeline.features import analyse_timeline
from pipeline.timeline import Timeline

N_PATH = config.harness()["c2st"]["cnn_points"]


@dataclass
class MovementSet:
    """Primary movements (one per trial) plus what the classifiers and report need."""
    name: str
    rows: pd.DataFrame          # features + conditions; pair_id links to a test trial
    paths: np.ndarray           # (n, 3, N_PATH): canonical x, y and speed
    profiles: np.ndarray        # (n, 101) speed profiles
    spectra: np.ndarray         # (n, F) jitter spectra
    after_miss: pd.DataFrame    # after-miss movements (reported, not scored)
    trials: pd.DataFrame        # trial-level rows (rejections, misses)

    def __len__(self):
        return len(self.rows)


def canonical_path(tl: Timeline, k0: int, k1: int, n: int = N_PATH) -> np.ndarray:
    """Onset->click in a frame where the start is the origin and the target centre is (1, 0)."""
    p = tl.pos[k0:k1 + 1].astype(float)
    if len(p) < 2:
        p = np.vstack([p, p])
    start = p[0]
    v = np.array([tl.target.cx, tl.target.cy]) - start
    D = max(float(np.hypot(*v)), 1e-6)
    c, s = v / D
    rot = np.array([[c, s], [-s, c]])
    q = (p - start) @ rot.T / D
    t = np.linspace(0, len(q) - 1, n)
    qx = np.interp(t, np.arange(len(q)), q[:, 0])
    qy = np.interp(t, np.arange(len(q)), q[:, 1])
    sp = np.hypot(np.gradient(qx), np.gradient(qy)) * (n - 1)
    return np.stack([qx, qy, sp])


def analyse_many(name: str, timelines: list[Timeline], pair_ids: list, extra: list[dict] | None = None) -> MovementSet:
    rows, after, trials, paths, profs, specs = [], [], [], [], [], []
    for i, tl in enumerate(timelines):
        trial, mrows, prof, spec = analyse_timeline(tl)
        base = {"pair_id": pair_ids[i], **(extra[i] if extra else {})}
        trials.append({**base, **trial})
        if not mrows:
            continue
        m0 = mrows[0]
        rows.append({**base, **m0, "rejected": trial["rejected"]})
        paths.append(canonical_path(tl, int(m0["t_onset"]), int(math.floor(m0["t_down"]))))
        profs.append(prof[0])
        specs.append(spec[0])
        after += [{**base, **m} for m in mrows[1:]]
    return MovementSet(name, pd.DataFrame(rows), np.array(paths).reshape(-1, 3, N_PATH),
                       np.array(profs), np.array(specs), pd.DataFrame(after), pd.DataFrame(trials))


def test_trials(ds: Dataset, role: str = "test", limit: int | None = None, seed: int = 0) -> pd.DataFrame:
    t = ds.usable_trials(role=role)
    if limit and len(t) > limit:
        t = t.sample(limit, random_state=seed)
    return t.sort_values(["session_id", "trial"])


def real_set(ds: Dataset, trials: pd.DataFrame, name: str) -> MovementSet:
    tls = [ds.timeline(i) for i in trials["tl_index"]]
    pair = [f"{s}:{t}" for s, t in zip(trials["session_id"], trials["trial"])]
    extra = [{"session_id": s} for s in trials["session_id"]]
    return analyse_many(name, tls, pair, extra)


def _cond_vec(df: pd.DataFrame) -> np.ndarray:
    th = np.radians(df["trial_theta"].to_numpy())
    return np.stack([np.log(df["trial_D"]), np.cos(th), np.sin(th), np.log(df["trial_size_along"])], 1)


def matched_reference(ds: Dataset, trials: pd.DataFrame, rng: np.random.Generator, name: str,
                      role: str = "train") -> MovementSet:
    """For each test trial, a real trial from other sessions with the same conditions (same fine
    cell, picked at random; nearest neighbour if the cell is empty). Comparing it with the test set
    measures how much the owner differs from themself across days: the denominator of the ratio."""
    pool = ds.usable_trials(role=role)
    keys = list(zip(pool["trial_cell_d"], pool["trial_cell_a"], pool["trial_cell_s"]))
    by_cell: dict = {}
    for i, k in enumerate(keys):
        by_cell.setdefault(k, []).append(i)
    pv = _cond_vec(pool)
    tv = _cond_vec(trials)
    chosen = []
    for j, (d, a, s) in enumerate(zip(trials["trial_cell_d"], trials["trial_cell_a"], trials["trial_cell_s"])):
        cand = by_cell.get((d, a, s))
        if cand:
            chosen.append(cand[rng.integers(len(cand))])
        else:
            dist = np.sum((pv - tv[j]) ** 2 * np.array([4.0, 1.0, 1.0, 1.0]), axis=1)
            chosen.append(int(np.argmin(dist)))
    picked = pool.iloc[chosen]
    tls = [ds.timeline(i) for i in picked["tl_index"]]
    pair = [f"{s}:{t}" for s, t in zip(trials["session_id"], trials["trial"])]
    extra = [{"session_id": s, "source": f"{ps}:{pt}"} for s, ps, pt in
             zip(trials["session_id"], picked["session_id"], picked["trial"])]
    return analyse_many(name, tls, pair, extra)


def coarse_group(D, theta, size_along) -> np.ndarray:
    g = config.harness()["groups"]
    edges = [math.inf if e is None else e for e in g["distance_edges"]]
    di = np.clip(np.searchsorted(edges, np.asarray(D, float), side="right") - 1, 0, len(edges) - 2)
    centers = np.array(g["direction_centers_deg"], float)
    diff = np.abs(geometry.angle_diff_deg(np.asarray(theta, float)[:, None], centers[None, :]))
    ai = np.argmin(diff, axis=1)
    si = (np.asarray(size_along, float) >= g["size_edge_px"]).astype(int)
    names = ["short", "mid", "long"]
    dirs = ["right", "down", "left", "up"]
    return np.array([f"{names[d] if d < 3 else d}-{dirs[a] if len(centers) == 4 else a}-{'big' if s else 'small'}"
                     for d, a, s in zip(di, ai, si)])


def attach_groups(test: pd.DataFrame, *sets: MovementSet) -> None:
    """Every set inherits the group of the test trial it is paired with."""
    groups = dict(zip([f"{s}:{t}" for s, t in zip(test["session_id"], test["trial"])],
                      coarse_group(test["trial_D"], test["trial_theta"], test["trial_size_along"])))
    for ms in sets:
        if len(ms.rows):
            ms.rows["group"] = ms.rows["pair_id"].map(groups)
