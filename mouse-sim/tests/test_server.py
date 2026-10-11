import json

import pytest
from fastapi.testclient import TestClient

from server.app import create_app

SETUP = {
    "setup_version": 3, "confirmed": True,
    "mouse": {"model": "test mouse", "dpi": 800, "polling_hz": 1000},
    "windows": {}, "display": {},
}


@pytest.fixture
def root(tmp_path):
    return tmp_path / "data"


def client(root, setup=SETUP):
    root.mkdir(parents=True, exist_ok=True)
    if setup is not None:
        (root / "setup.json").write_text(json.dumps(setup))
    return TestClient(create_app(root, check_windows=False))


def test_real_session_needs_confirmed_setup(root):
    c = client(root, setup={**SETUP, "confirmed": False})
    r = c.post("/api/sessions", json={"meta": {"role": "train"}})
    assert r.status_code == 409
    r = c.post("/api/sessions", json={"meta": {"role": "train"}, "dryrun": True})
    assert r.status_code == 200
    assert (root / "dryrun" / r.json()["session_id"] / "meta.json").exists()


def test_chunks_are_ordered_idempotent_and_frozen_after_finish(root):
    c = client(root)
    sid = c.post("/api/sessions", json={"meta": {"role": "train"}}).json()["session_id"]
    ev = [{"t": 1.0, "k": "move", "x": 1, "y": 2, "b": 0}]
    assert c.post(f"/api/sessions/{sid}/chunks", json={"seq": 1, "events": ev}).status_code == 409
    assert c.post(f"/api/sessions/{sid}/chunks", json={"seq": 0, "events": ev}).json()["status"] == "ok"
    assert c.post(f"/api/sessions/{sid}/chunks", json={"seq": 0, "events": ev}).json()["status"] == "duplicate"
    trial = {"trial": 0, "cell": [1, 2, 3], "t_hit": 5.0, "warmup": False, "invalid": False}
    c.post(f"/api/sessions/{sid}/chunks", json={"seq": 1, "events": ev, "trials": [trial]})
    assert c.post(f"/api/sessions/{sid}/finish", json={"meta": {"session_id": "x"}, "seq_total": 3}).status_code == 409
    r = c.post(f"/api/sessions/{sid}/finish", json={"meta": {"notes": "hi", "session_id": "evil"}, "seq_total": 2})
    assert r.status_code == 200
    d = root / "raw" / sid
    meta = json.loads((d / "meta.json").read_text())
    assert meta["complete"] and meta["notes"] == "hi" and meta["session_id"] == sid
    assert meta["setup_version"] == 3 and meta["n_events"] == 2
    assert len((d / "events.jsonl").read_text().splitlines()) == 2
    assert c.post(f"/api/sessions/{sid}/chunks", json={"seq": 2, "events": ev}).status_code == 409


def test_coverage_counts_valid_training_hits_only(root):
    c = client(root)
    trials = [
        {"trial": 0, "cell": [1, 2, 3], "t_hit": 5.0, "warmup": False, "invalid": False},
        {"trial": 1, "cell": [1, 2, 3], "t_hit": 5.0, "warmup": True, "invalid": False},
        {"trial": 2, "cell": [1, 2, 3], "t_hit": None, "warmup": False, "invalid": True},
        {"trial": 3, "cell": [0, 0, 0], "t_hit": 9.0, "warmup": False, "invalid": False},
    ]
    for role in ("train", "test"):
        sid = c.post("/api/sessions", json={"meta": {"role": role}}).json()["session_id"]
        c.post(f"/api/sessions/{sid}/chunks", json={"seq": 0, "trials": trials})
    cov = c.get("/api/coverage").json()
    assert cov["n_sessions"] == 1 and cov["n_movements"] == 2
    assert cov["counts"][1][2][3] == 1 and cov["counts"][0][0][0] == 1
