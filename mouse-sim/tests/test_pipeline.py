import json
import math

import numpy as np
import pytest

from pipeline import rawio
from pipeline.convert import _assign_slots, grid_times, to_physical
from pipeline.dataset import Dataset
from pipeline.features import analyse_timeline, count_submovements
from pipeline.process import process
from pipeline.timeline import Target, Timeline, TimelineStore
from pipeline.validate import validate
from pipeline import config
from tools import synth


def test_assign_slots_resolves_collisions():
    assert list(_assign_slots(np.array([0.0, 1.7, 2.1]))) == [0, 1, 2]
    assert list(_assign_slots(np.array([0.1, 1.45, 2.05, 3.0]))) == [0, 1, 2, 3]
    out = _assign_slots(np.array([5.2, 5.6, 7.0, 9.45, 10.1]))
    assert np.all(np.diff(out) > 0)


def test_grid_times_snaps_to_polling_grid():
    rng = np.random.default_rng(1)
    polls = 1000.37 + np.cumsum(rng.choice([1, 1, 1, 2], 500))
    t = polls + 0.12 + rng.exponential(0.08, len(polls))
    tg, stats = grid_times(t, 1.0, 20.0)
    frac = (tg - tg[0]) % 1.0
    assert np.all((frac < 1e-6) | (frac > 1 - 1e-6))   # integral spacing
    assert np.all(np.diff(tg) >= 1.0 - 1e-9)
    assert np.mean(np.abs(np.diff(tg) - np.diff(polls)) < 1e-6) > 0.97
    assert stats["bursts"] == 1


def test_to_physical_rounds_after_scaling():
    assert list(to_physical([1376.8, 1376.0], 1.25)) == [1721, 1720]


def _analytic_timeline(rt=250, mt=400, dwell=100, hold=90, D=300.0, size=40.0):
    """Stationary, a minimum-jerk move to the right, stationary, click."""
    K = rt + mt + dwell + hold
    t = np.arange(K, dtype=float)
    s = np.clip((t - rt) / mt, 0, 1)
    x = 1000 + D * (10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5)
    pos = np.stack([np.rint(x), np.full(K, 500.0)], 1).astype(int)
    tgt = Target("circle", 1000 + D, 500.0, size, size)
    return Timeline(pos=pos, clicks=np.array([[rt + mt + dwell, K - 0.5]]), target=tgt, screen=(3440, 1440))


def test_segmentation_and_features_on_a_known_movement():
    tl = _analytic_timeline()
    trial, rows, prof, spec = analyse_timeline(tl)
    assert not trial["rejected"], trial["reasons"]
    (m,) = rows
    assert abs(m["rt"] - 250) <= 20
    assert abs(m["rt"] + m["mt"] - 750) < 1e-6
    assert abs(m["dwell"] - 100) <= 25
    assert abs(m["hold"] - 89.5) < 1e-6
    assert m["n_sub"] == 1
    assert m["path_eff"] > 0.99 and abs(m["curv_norm"]) < 0.01
    assert abs(m["end_along"]) < 1 and abs(m["end_across"]) < 1 and m["miss"] == 0
    assert abs(m["D"] - 300) <= 1 and m["cell_d"] == 3 and m["cell_a"] == 0
    assert abs(m["t_peak_frac"] * m["mt"] - 200) < 40  # min-jerk peaks half-way through the move
    assert prof.shape == (1, config.pipeline()["speed_profile_points"])


def test_a_long_stop_mid_movement_is_rejected():
    tl = _analytic_timeline()
    pos = tl.pos.copy()
    # freeze the cursor for 2.5 s in the middle of the move
    mid = 450
    frozen = np.concatenate([pos[:mid], np.repeat(pos[mid:mid + 1], 2500, 0), pos[mid:]])
    tl2 = Timeline(pos=frozen, clicks=tl.clicks + 2500, target=tl.target, screen=tl.screen)
    trial, _, _, _ = analyse_timeline(tl2)
    assert "pause_mid_movement" in trial["reasons"]


def test_submovement_count_ignores_pixel_blips():
    cfg = config.pipeline()
    t = np.arange(600.0)
    main = 2.0 * np.exp(-0.5 * ((t - 150) / 40) ** 2)
    corr = 0.4 * np.exp(-0.5 * ((t - 380) / 25) ** 2)
    blips = 0.08 * ((t.astype(int) % 23) == 0)
    assert count_submovements(main + corr + blips, cfg) == 2


def test_timeline_store_roundtrip(tmp_path):
    tls = [_analytic_timeline(), _analytic_timeline(rt=300, D=120)]
    TimelineStore.pack(tls).save(tmp_path / "t.npz")
    back = TimelineStore.load(tmp_path / "t.npz")
    assert len(back) == 2
    b = back.get(1)
    assert np.array_equal(b.pos, tls[1].pos) and b.target == tls[1].target
    assert b.click_hit.tolist() == tls[1].click_hit.tolist()


@pytest.fixture(scope="module")
def synth_root(tmp_path_factory):
    root = tmp_path_factory.mktemp("synth")
    synth.generate(root, ["train", "train", "test"], n_trials=170, seed=11)
    return root


def test_synthetic_sessions_validate(synth_root):
    for d in rawio.session_dirs(synth_root):
        rep = validate(rawio.load_session(d))
        assert rep["ok"], rep["errors"]
        assert 950 < rep["stats"]["event_rate_hz"] < 1050


def test_process_end_to_end(synth_root):
    summary = process(synth_root, log=lambda *_: None)
    assert not summary["failed"] and summary["trials"] == 510
    ds = Dataset(synth_root)
    first = ds.trials[ds.trials["session_id"] == ds.trials["session_id"].min()]
    reasons = dict(zip(first["trial"], first["reasons"]))
    assert "pointer_left" in reasons[85]
    assert "pause_mid_movement" in reasons[95]
    assert ds.trials["rejected"].sum() <= 4
    prim = ds.usable_movements(primary_only=True)
    assert 220 < prim["rt"].median() < 350
    assert prim["n_sub"].median() <= 2
    assert ds.fitts["r2"] > 0.4 and ds.fitts["b"] > 0  # few movements per group in this small set
    assert set(ds.trials["role"]) == {"train", "test"}
    # every movement row points at a stored timeline whose clicks match it
    row = prim.iloc[0]
    tl = ds.timeline(row["tl_index"])
    assert math.isclose(tl.clicks[0][0], row["t_down"])


def test_fractional_device_pixel_ratio(tmp_path):
    root = tmp_path / "dpr"
    synth.generate(root, ["train"], n_trials=40, seed=5, dpr=1.25)
    raw = rawio.load_session(rawio.session_dirs(root)[0])
    assert raw.moves["x"].dtype == float and np.any(raw.moves["x"] % 1 != 0)
    rep = validate(raw)
    assert rep["stats"]["whole_pixel_share"] > 0.999, rep
    meta = json.loads((rawio.session_dirs(root)[0] / "meta.json").read_text())
    assert meta["devicePixelRatio"] == 1.25
