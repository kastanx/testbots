import math

import numpy as np

from eval.blind import score
from eval.ratio import feature_ratios, weighted_median
from pipeline import geometry, winsettings


def test_settings_drift_is_reported():
    setup = {"windows": {"pointer_speed": 10, "enhance_pointer_precision": True, "cursor_size": 32},
             "display": {"resolution": [3440, 1440], "refresh_hz": 144, "scaling_percent": 100}}
    same = {"pointer_speed": 10, "enhance_pointer_precision": True, "cursor_size": 32,
            "resolution": [3440, 1440], "refresh_hz": 144, "scaling_percent": 100}
    assert winsettings.drift(setup, same) == []
    changed = dict(same, pointer_speed=12, scaling_percent=125)
    problems = winsettings.drift(setup, changed)
    assert len(problems) == 2 and any("pointer_speed" in p for p in problems)


def test_blind_scoring():
    def result(n_correct, n=100):
        return {"model": "hybrid", "trials": [{"real": "A", "answer": "A" if i < n_correct else "B"} for i in range(n)]}
    assert score(result(58))["pass"]
    assert not score(result(59))["pass"]
    assert not score(result(40, n=60))["pass"]  # incomplete
    assert score(result(70))["p_value"] < 0.001


def test_geometry_bins_and_chords():
    assert geometry.dist_bin(19.9) == -1 and geometry.dist_bin(20) == 0 and geometry.dist_bin(2000) == 6
    assert geometry.dir_bin(345) == 0 and geometry.dir_bin(90) == 3
    assert geometry.size_bin(8) == 0 and geometry.size_bin(128) == 4
    assert math.isclose(float(geometry.chord("rect", 100, 20, 0.0)), 100)
    assert math.isclose(float(geometry.chord("rect", 100, 20, math.pi / 2)), 20, rel_tol=1e-9)
    assert bool(geometry.inside("rect", 0, 0, 40, 20, 5, 19, 0))
    assert not bool(geometry.inside("rect", 0, 0, 40, 20, 5, 19.9, 9.9))  # rounded corner


def test_ratio_is_one_when_model_equals_reference():
    rng = np.random.default_rng(0)
    import pandas as pd
    real = pd.DataFrame({"group": ["g"] * 200, "f": rng.normal(0, 1, 200)})
    ref = pd.DataFrame({"group": ["g"] * 200, "f": rng.normal(0.2, 1, 200)})
    gen_same = ref.copy()
    gen_bad = pd.DataFrame({"group": ["g"] * 200, "f": rng.normal(2, 1, 200)})
    assert math.isclose(feature_ratios(real, [gen_same], [ref], ["f"], 10)["f"]["median"], 1.0)
    assert feature_ratios(real, [gen_bad], [ref], ["f"], 10)["f"]["median"] > 3
    assert weighted_median([1, 2, 10], [1, 1, 5]) == 10
