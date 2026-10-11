import json
import os

import numpy as np
import pytest
from fastapi.testclient import TestClient

from pipeline import geometry
from pipeline.process import process
from server.app import create_app
from server.generate import on_ms_grid
from tools import synth

BUTTON = {"start": {"x": 1200, "y": 640}, "target": {"shape": "rect", "cx": 1786, "cy": 412, "w": 96, "h": 32}}


@pytest.fixture(scope="module")
def root(tmp_path_factory):
    root = tmp_path_factory.mktemp("gen_synth")
    synth.generate(root, ["train", "train"], n_trials=120, seed=21)
    process(root, log=lambda *_: None)
    return root


def client(root, runs_dir):
    return TestClient(create_app(root, check_windows=False, runs_dir=runs_dir))


@pytest.fixture
def c(root, tmp_path):
    return client(root, tmp_path / "runs")


def check_trial(j, start=(1200, 640)):
    assert set(j) == {"pos", "clicks"}
    pos, clicks = j["pos"], j["clicks"]
    assert pos[0] == list(start)
    for i, k in enumerate(clicks):
        assert set(k) == {"down", "up"} and isinstance(k["down"], int) and isinstance(k["up"], int)
        assert 0 <= k["down"] < k["up"] and (i == 0 or clicks[i - 1]["up"] < k["down"])
    assert clicks[-1]["up"] == len(pos) - 1


def test_output_is_the_path_and_the_clicks(c):
    for model in ("mm", "minjerk"):
        r = c.post("/api/generate", json={**BUTTON, "model": model, "seed": 1})
        assert r.status_code == 200, r.text
        j = r.json()
        check_trial(j)
        x, y = j["pos"][j["clicks"][-1]["down"]]
        assert geometry.inside("rect", 1786, 412, 96, 32, 6, x, y)  # the last press lands on the target


def test_changes_format_and_bounding_box_give_the_same_trial(c):
    dense = c.post("/api/generate", json={**BUTTON, "seed": 3}).json()
    box = {"left": 1738, "top": 396, "w": 96, "h": 32}
    ch = c.post("/api/generate", json={**BUTTON, "target": box, "seed": 3, "format": "changes"}).json()
    assert set(ch) == {"changes", "clicks"} and ch["changes"][0] == [0, 1200, 640]
    end = ch["clicks"][-1]["up"] + 1
    pos = []
    for (t, x, y), nxt in zip(ch["changes"], ch["changes"][1:] + [[end, 0, 0]]):
        assert nxt[0] > t
        pos += [[x, y]] * (nxt[0] - t)
    assert pos == dense["pos"] and ch["clicks"] == dense["clicks"]


def test_a_seeded_request_does_not_depend_on_earlier_requests(c):
    a = c.post("/api/generate", json={**BUTTON, "seed": 11}).json()
    for _ in range(3):
        c.post("/api/generate", json=BUTTON)
    b = c.post("/api/generate", json={**BUTTON, "seed": 11}).json()
    assert a == b


def test_bad_requests_are_rejected(c):
    bad = [
        {**BUTTON, "start": {"x": 5000, "y": 10}},
        {**BUTTON, "target": {"cx": 10, "cy": 10, "left": 5, "top": 5, "w": 10, "h": 10}},
        {**BUTTON, "target": {"cx": 10, "cy": 10, "w": 10}},
        {**BUTTON, "target": {"shape": "circle", "cx": 10, "cy": 10, "w": 10, "h": 20}},
        {**BUTTON, "target": {"cx": 4000, "cy": 10, "w": 10, "h": 10}},
        {**BUTTON, "model": "nope"},
        {**BUTTON, "skip_reactions": True},
        {"target": BUTTON["target"]},
    ]
    for body in bad:
        assert c.post("/api/generate", json=body).status_code == 422, body


def test_skip_reaction_only_takes_time_out(c):
    full = c.post("/api/generate", json={**BUTTON, "seed": 5}).json()
    skip = c.post("/api/generate", json={**BUTTON, "seed": 5, "skip_reaction": True}).json()
    check_trial(skip)
    assert skip["pos"][1] != skip["pos"][0]  # moving at t = 1 ms

    def path(pos):  # the positions visited, without timing
        return [p for i, p in enumerate(pos) if i == 0 or p != pos[i - 1]]

    assert path(skip["pos"]) == path(full["pos"])
    cut = len(full["pos"]) - len(skip["pos"])
    assert cut > 100  # the reaction time is gone
    assert skip["clicks"] == [{"down": k["down"] - cut, "up": k["up"] - cut} for k in full["clicks"]]


def test_no_misses_gives_one_click_on_the_target(c, root):
    tiny = {"shape": "circle", "cx": 2100, "cy": 300, "w": 8}
    for seed in range(25):
        j = c.post("/api/generate", json={"start": {"x": 600, "y": 1100}, "target": tiny, "seed": seed,
                                          "no_misses": True, "skip_reaction": True}).json()
        check_trial(j, start=(600, 1100))
        assert len(j["clicks"]) == 1
        x, y = j["pos"][j["clicks"][0]["down"]]
        assert geometry.inside("circle", 2100, 300, 8, 8, 0, x, y)
    from server.generate import _miss_keys
    assert _miss_keys(c.app.state.generator.models["mm"])  # the library does have trials with misses


def test_the_last_press_is_bent_onto_the_target():
    from pipeline.timeline import Target
    from server.generate import land_last_press
    pos = np.array([[100, 100]] * 50 + [[100 + k, 100] for k in range(1, 201)] + [[300, 100]] * 80)
    tgt = Target("circle", 310.0, 100.0, 8.0, 8.0, 0.0)  # the press at (300, 100) misses it by 6 px
    p, clicks = land_last_press(pos, [{"down": 290, "up": 329}], tgt, (3440, 1440))
    assert clicks == [{"down": 290, "up": 329}] and p[0].tolist() == [100, 100]
    assert tgt.contains(*p[290]) and np.abs(np.diff(p, axis=0)).max() <= 2
    assert (p[250:291] == p[290]).all()  # the pause before the press stays still


def test_bending_the_last_press_leaves_an_earlier_miss_alone():
    from pipeline.timeline import Target
    from server.generate import land_last_press
    # a miss at (200, 100) held from 100 to 139, then on to (300, 100), 6 px off the target too
    pos = np.array([[100 + k, 100] for k in range(100)] + [[200, 100]] * 60
                   + [[200 + k, 100] for k in range(1, 101)] + [[300, 100]] * 80)
    tgt = Target("circle", 310.0, 100.0, 8.0, 8.0, 0.0)
    clicks = [{"down": 100, "up": 139}, {"down": 290, "up": 329}]
    p, out = land_last_press(pos, clicks, tgt, (3440, 1440))
    assert out == clicks and tgt.contains(*p[290]) and not tgt.contains(*p[100])
    assert (p[:140] == pos[:140]).all()  # the miss and its hold are untouched
    assert np.abs(np.diff(p, axis=0)).max() <= 2


def test_the_last_press_lands_on_a_narrow_target(c):
    narrow = {"shape": "rect", "cx": 2100, "cy": 300, "w": 16, "h": 60, "r": 0}
    for seed in range(25):
        j = c.post("/api/generate", json={"start": {"x": 600, "y": 1100}, "target": narrow, "seed": seed}).json()
        check_trial(j, start=(600, 1100))
        x, y = j["pos"][j["clicks"][-1]["down"]]
        assert geometry.inside("rect", 2100, 300, 16, 60, 0, x, y)


def test_a_trial_ends_at_the_first_press_on_the_target():
    from pipeline.timeline import Target
    from server.generate import end_at_first_hit
    pos = np.array([[0, 0]] * 10 + [[50, 50]] * 30 + [[52, 50]] * 30)
    tgt = Target("rect", 50.0, 50.0, 40.0, 20.0, 6.0)  # both presses below land on it
    p, clicks = end_at_first_hit(pos, [{"down": 15, "up": 25}, {"down": 45, "up": 69}], tgt)
    assert clicks == [{"down": 15, "up": 25}] and len(p) == 26
    p, clicks = end_at_first_hit(pos, [{"down": 5, "up": 8}, {"down": 45, "up": 69}], tgt)  # a real miss first
    assert len(clicks) == 2 and len(p) == 70


def test_click_times_land_on_whole_milliseconds():
    pos = np.array([[0, 0]] * 10 + [[5, 5]] * 3)
    p, clicks = on_ms_grid(pos, np.array([[3.2, 6.0], [6.5, 11.4]]))
    assert clicks == [{"down": 4, "up": 6}, {"down": 7, "up": 12}] and len(p) == 13
    p, clicks = on_ms_grid(pos, np.array([[2.0, 4.0]]))  # a trial that runs on after its last release
    assert clicks == [{"down": 2, "up": 4}] and len(p) == 5


def test_generative_models_need_a_run_trained_on_this_data(root, tmp_path):
    runs = tmp_path / "runs"
    c = client(root, runs)
    st = c.get("/api/models").json()
    assert st["auto"] == "mm" and st["models"]["mm"]["available"]
    assert not st["models"]["hybrid"]["available"] and "no trained" in st["models"]["hybrid"]["reason"]
    assert c.post("/api/generate", json={**BUTTON, "model": "gen"}).status_code == 503

    run = runs / "r1"
    run.mkdir(parents=True)
    (run / "ckpt.pt").write_bytes(b"")
    (run / "config.json").write_text(json.dumps({"data_root": str(tmp_path / "other")}))
    (runs / "latest.txt").write_text("r1")
    st = c.get("/api/models").json()
    assert st["auto"] == "mm" and "trained on" in st["models"]["hybrid"]["reason"]
    assert c.post("/api/generate", json=BUTTON).status_code == 200


def test_no_processed_data(tmp_path):
    c = client(tmp_path / "empty", tmp_path / "runs")
    r = c.post("/api/generate", json=BUTTON)
    assert r.status_code == 503 and "pipeline all" in r.json()["detail"]
    assert not c.get("/api/models").json()["models"]["mm"]["available"]


def test_models_are_refitted_when_the_processed_data_changes(root, tmp_path):
    app = create_app(root, check_windows=False, runs_dir=tmp_path / "runs")
    c = TestClient(app)
    c.post("/api/generate", json=BUTTON)
    first = app.state.generator.models["mm"]
    c.post("/api/generate", json=BUTTON)
    assert app.state.generator.models["mm"] is first
    f = root / "processed" / "fitts.json"
    st = f.stat()
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 2_000_000_000))
    c.post("/api/generate", json=BUTTON)
    assert app.state.generator.models["mm"] is not first
