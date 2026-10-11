"""Local server: serves the web pages, stores recorder sessions under data/raw/<session_id>/ and
generates trials over HTTP (POST /api/generate, see server/generate.py and docs/http-api.md).

Raw data is never edited. A session directory is created once, appended to while the session is
running (one chunk at a time, in order, idempotently), and frozen when the recorder calls /finish.
Dry-run sessions go to data/dryrun/ and never count towards coverage or the dataset.
"""
from __future__ import annotations

import json
import mimetypes
import os
import secrets
import threading
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from pipeline import geometry, paths, winsettings

from .generate import EXAMPLES, GenerateRequest, GenerateResponse, Generator

REQUIRED_SETUP = [("mouse", "model"), ("mouse", "dpi"), ("mouse", "polling_hz")]

# Windows' registry doesn't always know these; WebAssembly streaming compile needs the right type.
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _write_json_atomic(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _read_json(path: Path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def setup_status(root: Path, check_windows: bool = True) -> dict:
    setup = _read_json(paths.setup_file(root))
    if setup is None:
        return {"exists": False, "confirmed": False, "setup": None,
                "problems": ["data/setup.json does not exist"], "windows": {}}
    problems = []
    for section, key in REQUIRED_SETUP:
        if setup.get(section, {}).get(key) in (None, ""):
            problems.append(f"{section}.{key} is empty in setup.json")
    if not setup.get("confirmed"):
        problems.append("setup.json is not confirmed yet (set \"confirmed\": true once it is filled in)")
    current = winsettings.read() if check_windows else {}
    problems += winsettings.drift(setup, current)
    return {"exists": True, "confirmed": bool(setup.get("confirmed")), "setup": setup,
            "problems": problems, "windows": current}


class SessionStore:
    """All writes to session directories go through here, under one lock."""

    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.Lock()

    def _dir(self, session_id: str) -> Path:
        for base in (paths.raw_dir(self.root), paths.dryrun_dir(self.root)):
            d = base / session_id
            if d.is_dir():
                return d
        raise HTTPException(404, f"unknown session {session_id}")

    def create(self, meta: dict, dryrun: bool, setup: dict | None) -> dict:
        with self.lock:
            session_id = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
            base = paths.dryrun_dir(self.root) if dryrun else paths.raw_dir(self.root)
            d = base / session_id
            d.mkdir(parents=True, exist_ok=False)
            meta = dict(meta)
            meta.update({
                "session_id": session_id,
                "dryrun": dryrun,
                "complete": False,
                "created_at": _now_iso(),
                "setup_version": (setup or {}).get("setup_version"),
                "setup": setup,
            })
            _write_json_atomic(d / "meta.json", meta)
            (d / "events.jsonl").touch()
            (d / "trials.jsonl").touch()
            _write_json_atomic(d / ".upload.json", {"next_seq": 0, "n_events": 0, "n_trials": 0})
            return {"session_id": session_id, "dryrun": dryrun}

    def append_chunk(self, session_id: str, seq: int, events: list, trials: list) -> dict:
        with self.lock:
            d = self._dir(session_id)
            state = _read_json(d / ".upload.json")
            meta = _read_json(d / "meta.json")
            if meta.get("complete"):
                raise HTTPException(409, "session is finished; raw data is never edited")
            if seq < state["next_seq"]:
                return {"status": "duplicate", "next_seq": state["next_seq"]}
            if seq > state["next_seq"]:
                raise HTTPException(409, {"error": "out of order", "expected": state["next_seq"]})
            for name, items in (("events.jsonl", events), ("trials.jsonl", trials)):
                if not items:
                    continue
                with open(d / name, "a", encoding="utf-8", newline="\n") as f:
                    f.write("".join(json.dumps(it, separators=(",", ":")) + "\n" for it in items))
                    f.flush()
                    os.fsync(f.fileno())
            state["next_seq"] = seq + 1
            state["n_events"] += len(events)
            state["n_trials"] += len(trials)
            _write_json_atomic(d / ".upload.json", state)
            return {"status": "ok", **state}

    def finish(self, session_id: str, client_meta: dict, seq_total: int) -> dict:
        with self.lock:
            d = self._dir(session_id)
            state = _read_json(d / ".upload.json")
            meta = _read_json(d / "meta.json")
            if meta.get("complete"):
                return {"status": "already finished", **state}
            if state["next_seq"] != seq_total:
                raise HTTPException(409, {"error": "missing chunks", "have": state["next_seq"],
                                          "expected": seq_total})
            protected = {"session_id", "dryrun", "created_at", "setup_version", "setup"}
            meta.update({k: v for k, v in client_meta.items() if k not in protected})
            meta.update({"complete": True, "finished_at": _now_iso(),
                         "n_events": state["n_events"], "n_trials": state["n_trials"]})
            _write_json_atomic(d / "meta.json", meta)
            return {"status": "ok", **state}

    def list_sessions(self, include_dryrun: bool = False) -> list[dict]:
        out = []
        bases = [paths.raw_dir(self.root)] + ([paths.dryrun_dir(self.root)] if include_dryrun else [])
        for base in bases:
            if not base.is_dir():
                continue
            for d in sorted(base.iterdir()):
                meta = _read_json(d / "meta.json")
                if not meta:
                    continue
                out.append({k: meta.get(k) for k in (
                    "session_id", "role", "dryrun", "complete", "created_at", "finished_at",
                    "setup_version", "n_trials", "n_events", "feeling", "quality")})
        return out

    def coverage(self, setup_version) -> dict:
        """Valid, non-warm-up hits per recorder cell, over training sessions of this setup."""
        counts = [[[0] * geometry.N_SIZE for _ in range(geometry.N_DIR)] for _ in range(geometry.N_DIST)]
        n_sessions = n_moves = 0
        base = paths.raw_dir(self.root)
        if base.is_dir():
            for d in sorted(base.iterdir()):
                meta = _read_json(d / "meta.json")
                if not meta or meta.get("role") != "train" or meta.get("setup_version") != setup_version:
                    continue
                n_sessions += 1
                with open(d / "trials.jsonl", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        t = json.loads(line)
                        cell = t.get("cell")
                        if (t.get("warmup") or t.get("invalid") or t.get("t_hit") is None
                                or not cell or min(cell) < 0):
                            continue
                        di, ai, si = cell
                        counts[di][ai][si] += 1
                        n_moves += 1
        return {"setup_version": setup_version, "counts": counts, "n_sessions": n_sessions,
                "n_movements": n_moves, "goal_per_cell": geometry.GOAL_PER_CELL}


def create_app(data_root: Path | None = None, check_windows: bool = True, bundle_dir: Path | None = None,
               reports_dir: Path | None = None, runs_dir: Path | None = None) -> FastAPI:
    root = paths.data_root(data_root)
    store = SessionStore(root)
    generator = Generator(root, runs_dir)
    app = FastAPI(title="mouse-sim", description="POST /api/generate returns one trial from your mouse model. "
                                                 "Reference: docs/http-api.md in the project.")
    app.state.root = root
    app.state.generator = generator

    @app.middleware("http")
    async def isolation_headers(request: Request, call_next):
        # Cross-origin isolation gives 5 us timer resolution (100 us without) and lets
        # onnxruntime-web use threads.
        resp = await call_next(request)
        resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        resp.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        resp.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        if request.url.path.startswith("/api/") or request.url.path.endswith((".html", "/")):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.get("/api/health")
    def health():
        return {"ok": True, "data_root": str(root)}

    @app.get("/api/setup")
    def get_setup():
        return setup_status(root, check_windows)

    @app.get("/api/config")
    def get_config():
        from pipeline import config
        return {name: config.load(name) for name in ("cells", "recorder", "pipeline")}

    @app.post("/api/sessions")
    async def create_session(request: Request):
        body = await request.json()
        dryrun = bool(body.get("dryrun"))
        status = setup_status(root, check_windows)
        if not dryrun and status["problems"]:
            raise HTTPException(409, {"error": "settings lock not satisfied", "problems": status["problems"]})
        meta = body.get("meta") or {}
        if meta.get("role") not in ("train", "val", "test"):
            raise HTTPException(400, "meta.role must be train, val or test")
        return store.create(meta, dryrun, status["setup"])

    @app.post("/api/sessions/{session_id}/chunks")
    async def post_chunk(session_id: str, request: Request):
        body = await request.json()
        return store.append_chunk(session_id, int(body["seq"]), body.get("events") or [], body.get("trials") or [])

    @app.post("/api/sessions/{session_id}/finish")
    async def finish_session(session_id: str, request: Request):
        body = await request.json()
        return store.finish(session_id, body.get("meta") or {}, int(body["seq_total"]))

    @app.get("/api/sessions")
    def list_sessions(dryrun: bool = False):
        return store.list_sessions(include_dryrun=dryrun)

    @app.get("/api/coverage")
    def coverage():
        setup = _read_json(paths.setup_file(root)) or {}
        return store.coverage(setup.get("setup_version"))

    @app.post("/api/blindtests")
    async def save_blindtest(request: Request):
        body = await request.json()
        d = paths.blindtest_dir(root)
        d.mkdir(parents=True, exist_ok=True)
        name = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2) + ".json"
        body["saved_at"] = _now_iso()
        _write_json_atomic(d / name, body)
        return {"saved": name}

    @app.post("/api/generate", response_model=GenerateResponse)
    def generate_trial(req: Annotated[GenerateRequest, Body(openapi_examples=EXAMPLES)]):
        return JSONResponse(generator.generate(req))

    @app.get("/api/models")
    def models_status():
        return generator.status()

    bundle = Path(bundle_dir) if bundle_dir else paths.EXPORT
    reports = Path(reports_dir) if reports_dir else paths.REPORTS
    bundle.mkdir(parents=True, exist_ok=True)
    reports.mkdir(parents=True, exist_ok=True)

    @app.get("/reports/", response_class=HTMLResponse)
    def reports_index():
        import html as _html
        items = sorted(p.relative_to(reports).as_posix() for p in reports.rglob("*.html"))
        board = reports / "leaderboard.md"
        rows = "".join(f'<li><a href="/reports/{_html.escape(i)}">{_html.escape(i)}</a></li>' for i in items)
        md = _html.escape(board.read_text(encoding="utf-8")) if board.exists() else "No harness runs yet."
        return (f"<!doctype html><meta charset=utf-8><title>Reports</title><style>body{{font:14px system-ui;"
                f"margin:32px;max-width:1100px}}pre{{white-space:pre-wrap;background:#f4f4f4;padding:12px}}</style>"
                f"<h1>Reports</h1><ul>{rows or '<li>No reports yet: run <code>python -m pipeline all</code>.</li>'}</ul>"
                f"<h2>Leaderboard</h2><pre>{md}</pre>")
    app.mount("/bundle", StaticFiles(directory=bundle), name="bundle")
    app.mount("/reports", StaticFiles(directory=reports, html=True), name="reports")
    if paths.WEB_DIST.is_dir():
        app.mount("/", StaticFiles(directory=paths.WEB_DIST, html=True), name="web")
    else:
        @app.get("/")
        def no_build():
            return JSONResponse({"error": "web/dist is missing: run `npm run build` in web/ "
                                          "(or use `npm run dev` there for development)"}, 404)

    return app
