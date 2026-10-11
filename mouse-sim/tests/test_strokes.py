import math

import numpy as np
import pytest

from models.base import TrialConditions
from models.strokes import lognormal
from models.strokes.model import StrokeModel, reaim, similarity
from pipeline.dataset import Dataset
from pipeline.process import process
from pipeline.timeline import Target
from tools import synth

P2 = np.array([[300.0, -20.0, math.log(180.0), 0.30, 0.10, -0.15],
               [25.0, 260.0, math.log(90.0), 0.25, -0.40, -0.30]])


def test_velocity_integrates_to_position():
    t = np.arange(0, 1500, dtype=float)
    v = lognormal.velocity(t, P2)
    p = lognormal.position(t, P2)
    trapezoid = np.cumsum((v[1:] + v[:-1]) / 2, axis=0)
    assert np.allclose(trapezoid, p[1:] - p[0], atol=0.05)
    assert np.allclose(p[-1], sum(lognormal.chord(q) for q in P2), atol=0.05)


def test_jacobian_matches_finite_differences():
    t = np.arange(0, 600, 2, dtype=float)
    J = lognormal.jacobian(t, P2)
    eps = 1e-6
    for k in range(P2.size):
        d = np.zeros(P2.size)
        d[k] = eps
        num = (lognormal.velocity(t, (P2.ravel() + d)).ravel() - lognormal.velocity(t, (P2.ravel() - d)).ravel()) / (2 * eps)
        assert np.allclose(J[:, k], num, rtol=1e-4, atol=1e-7), k


def test_fit_recovers_strokes():
    t = np.arange(0, 900, 2, dtype=float)
    P, snr = lognormal.fit(t, lognormal.velocity(t, P2), target_snr=35.0)
    assert snr > 30
    main = P[np.argmax(P[:, 0])]
    assert abs(main[0] - 300) < 15 and abs(math.exp(main[2]) - 180) < 20


@pytest.mark.parametrize("how", ["corrections", "similarity", "mixed"])
def test_reaim_lands_on_the_goal(how):
    goal = np.array([320.0, -14.0])
    T = 600.0
    Q = reaim(P2, goal, 2.5, T, how)
    got = sum(lognormal.contribution(q, T) for q in Q)
    assert np.allclose(got, goal, atol=1e-6)


def test_similarity_keeps_the_shape():
    Q = similarity(P2, np.array([150.0, 150.0]), 2000.0)
    assert np.allclose(Q[:, 2:4], P2[:, 2:4])              # timing untouched
    assert np.allclose(Q[:, 0] / P2[:, 0], Q[0, 0] / P2[0, 0])   # all scaled alike


@pytest.fixture(scope="module")
def synth_root(tmp_path_factory):
    root = tmp_path_factory.mktemp("strokes_synth")
    synth.generate(root, ["train", "train"], n_trials=120, seed=5)
    process(root, log=lambda *_: None)
    return root


@pytest.fixture(scope="module")
def model(synth_root):
    return StrokeModel(cache=False, workers=1).fit(Dataset(synth_root))


def test_the_server_answers_with_strokes(synth_root, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from models.strokes import library
    from server.app import create_app
    monkeypatch.setattr(library, "CACHE_DIR", tmp_path / "cache")      # nothing written into the package
    c = TestClient(create_app(synth_root, check_windows=False, runs_dir=tmp_path / "runs"))
    st = c.get("/api/models").json()
    assert st["auto"] == "mm" and st["models"]["strokes"]["available"]
    req = {"start": {"x": 1200, "y": 640}, "target": {"shape": "rect", "cx": 1786, "cy": 412, "w": 96, "h": 32},
           "model": "strokes", "skip_reaction": True, "no_misses": True}
    answers = []
    for _ in range(5):
        r = c.post("/api/generate", json=req)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["pos"][0] == [1200, 640] and len(j["clicks"]) == 1
        x, y = j["pos"][j["clicks"][0]["down"]]
        assert 1738 <= x <= 1834 and 396 <= y <= 428             # the press is on the target
        answers.append(j["pos"])
    assert len({str(a) for a in answers}) == 5                    # never the same twice
    seeded = [c.post("/api/generate", json={**req, "seed": 7}).json() for _ in range(2)]
    assert seeded[0] == seeded[1]                                  # a seed gives the same trial
    assert c.post("/api/generate", json={**req, "model": "auto"}).status_code == 200   # still motion matching


def test_generates_new_trials_that_land(model):
    tgt = Target("rect", 1700.0, 600.0, 80.0, 40.0, 6.0)
    cond = TrialConditions(start=(900.0, 800.0), target=tgt, screen=(2560, 1440))
    rng = np.random.default_rng(3)
    tls = [model.generate(cond, rng) for _ in range(20)]
    for tl in tls:
        assert tuple(tl.pos[0]) == (900, 800)
        assert len(tl.clicks) >= 1 and np.all(np.diff(tl.clicks, axis=1) > 0)
        assert float(np.max(np.hypot(*np.diff(tl.pos, axis=0).T))) < 60       # no jumps
    assert np.mean([tl.click_hit[-1] for tl in tls]) >= 0.8
    paths = {tuple(map(tuple, tl.pos[::25])) for tl in tls}
    assert len(paths) == len(tls)                                            # no two the same
