"""Compare page: your own movement against motion matching and the stroke model, for a start and a
target you pick (tools/compare.html).

    python mouse-sim/compare.py [--port 8771] [--open]

A small server of its own, separate from the main one: it loads the recordings and both models itself,
so it runs next to a mouse-sim server without touching it. The page records your attempt the way the
recorder does (pointermove + getCoalescedEvents, CSS pixels and browser timestamps); it is turned into
a 1 ms timeline here exactly as recordings are (pipeline.convert: physical pixels, timestamps snapped
to the 1000 Hz polling grid). Model trials are made exactly as POST /api/generate makes them. All three
are measured by the pipeline's own feature code (pipeline.features), so the numbers are the harness's.
"""
from __future__ import annotations

import argparse
import math
import threading
import webbrowser
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from models.base import TrialConditions
from pipeline import config, paths
from pipeline.convert import grid_times, to_physical
from pipeline.features import analyse_timeline
from pipeline.segment import kinematics
from pipeline.timeline import Target, Timeline
from server.generate import Generator, _run, end_at_first_hit, land_last_press, on_ms_grid, skip_reaction

PAGE = Path(__file__).resolve().parent / "compare.html"
MODELS = {"replay": "mm", "strokes": "strokes"}
FEATURES = ["rt", "mt", "dwell", "hold", "peak_speed", "t_peak_frac", "path_len", "path_eff", "curv_px",
            "curv_norm", "overshoot_px", "overshoot_norm", "n_sub", "ldlj", "jit_rms", "end_along",
            "end_across", "slip"]


class Point(BaseModel):
    x: float
    y: float


class Box(BaseModel):
    cx: float
    cy: float
    w: float = Field(gt=0)
    h: float = Field(gt=0)


class ModelsRequest(BaseModel):
    start: Point                     # physical px
    target: Box                      # physical px
    n: int = Field(3, ge=1, le=12)   # trials per model
    skip_reaction: bool = True
    no_misses: bool = True
    models: list[str] = ["replay", "strokes"]


class AttemptRequest(BaseModel):
    """What the page recorded, as the browser gave it: CSS pixels, page timestamps (ms)."""
    dpr: float = Field(gt=0)
    t_on: float                      # when the target appeared
    start: Point                     # the pointer then (CSS px)
    target: Box                      # CSS px
    moves: list[list[float]]         # [t, x, y]
    downs: list[list[float]]         # [t, x, y], left button
    ups: list[list[float]]           # [t, x, y]


def target_of(b: Box, scale: float = 1.0) -> Target:
    w, h = b.w * scale, b.h * scale
    return Target("rect", b.cx * scale, b.cy * scale, w, h, min(6.0 * scale, w / 4, h / 4))


def _num(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return round(v, 4) if math.isfinite(v) else None


def analysis(tl: Timeline) -> dict:
    """The pipeline's view of a trial: its phases, features and speed (px/ms) for every ms."""
    _, rows, _, _ = analyse_timeline(tl)
    speed = kinematics(tl).speed
    out = {"pos": tl.pos.astype(int).tolist(), "clicks": [[float(a), float(b)] for a, b in tl.clicks],
           "hits": [bool(h) for h in tl.click_hit], "speed": np.round(speed, 4).tolist()}
    if rows:
        m = rows[0]
        out.update({"onset": _num(m["t_onset"]), "last_stop": _num(m["t_last_stop"]), "down": _num(m["t_down"]),
                    "up": _num(m["t_up"]), "features": {k: _num(m.get(k)) for k in FEATURES}})
    return out


def make_app(root=None) -> FastAPI:
    gen = Generator(paths.data_root(root))
    app = FastAPI(title="mouse-sim compare")
    pcfg = config.pipeline()

    @app.get("/")
    def page():
        return FileResponse(PAGE, media_type="text/html")

    @app.get("/api/info")
    def info():
        st = gen.status()
        sc = st["screen"]
        return {"screen": [sc["w"], sc["h"]] if sc else None, "training_trials": st["training_trials"],
                "models": {k: st["models"].get(v, {}) for k, v in MODELS.items()}}

    @app.post("/api/models")
    def models(req: ModelsRequest):
        tgt = target_of(req.target)
        start = (float(np.rint(req.start.x)), float(np.rint(req.start.y)))
        out = {}
        for name in req.models:
            if name not in MODELS:
                raise HTTPException(422, f"unknown model {name!r}: {', '.join(MODELS)}")
            trials = []
            for _ in range(req.n):
                with gen.lock:             # what POST /api/generate does, keeping where it came from
                    gen._refresh()
                    model = gen._model(MODELS[name])
                    screen = gen.screen
                    tl = _run(model, TrialConditions(start=start, target=tgt, screen=screen),
                              np.random.default_rng(), seeded=False, no_misses=req.no_misses)
                pos, clicks = on_ms_grid(tl.pos, tl.clicks)
                pos, clicks = end_at_first_hit(pos, clicks, tgt)
                if req.no_misses:
                    clicks = clicks[-1:]
                pos, clicks = land_last_press(pos, clicks, tgt, screen)
                if req.skip_reaction:
                    pos, clicks = skip_reaction(tl, pos, clicks)
                meta = getattr(tl, "meta", {}) or {}
                source = meta.get("source") or ((meta.get("movements") or [{}])[0].get("template"))
                t2 = Timeline(pos=np.asarray(pos), clicks=np.array([[c["down"], c["up"]] for c in clicks], float),
                              target=tgt, screen=screen)
                trials.append({**analysis(t2), "source": source})
            out[name] = trials
        return out

    @app.post("/api/attempt")
    def attempt(req: AttemptRequest):
        if len(req.moves) < 2:
            raise HTTPException(422, "no movement recorded")
        dpr = req.dpr
        mv = np.array(req.moves, float)
        t = mv[:, 0]
        xp, yp = to_physical(mv[:, 1], dpr), to_physical(mv[:, 2], dpr)
        tg, _ = grid_times(t, 1000.0 / pcfg["polling_hz_default"], pcfg["burst_gap_ms"])
        order = np.argsort(tg, kind="stable")
        tg, xs, ys = tg[order], xp[order], yp[order]
        downs = sorted(req.downs, key=lambda d: d[0])
        ups = sorted(req.ups, key=lambda u: u[0])
        if not downs:
            raise HTTPException(422, "no click recorded")
        t_end = max(u[0] for u in ups) if ups else downs[-1][0] + 1
        K = int(math.ceil(t_end - req.t_on)) + 1
        grid = req.t_on + np.arange(K)
        idx = np.searchsorted(tg, grid, side="right") - 1
        start = (int(to_physical(req.start.x, dpr)), int(to_physical(req.start.y, dpr)))
        pos = np.empty((K, 2), np.int32)
        have = idx >= 0
        pos[have, 0] = xs[idx[have]]
        pos[have, 1] = ys[idx[have]]
        pos[~have] = start
        clicks, cxy = [], []
        for d in downs:
            u = next((u[0] for u in ups if u[0] >= d[0]), t_end)
            clicks.append((d[0] - req.t_on, min(u, t_end) - req.t_on))
            cxy.append((d[1] * dpr, d[2] * dpr))
        tgt = target_of(req.target, dpr)
        hits = np.array([tgt.contains(x, y) for x, y in cxy], bool)
        with gen.lock:
            gen._refresh()
            gen._dataset()
            screen = gen.screen
        tl = Timeline(pos=pos, clicks=np.array(clicks, float), target=tgt, screen=screen,
                      click_xy=np.array(cxy, float), click_hit=hits)
        return analysis(tl)

    # load the recordings and both models now, so the first comparison is quick
    def warm():
        with gen.lock:
            gen._refresh()
            for name in MODELS.values():
                try:
                    gen._model(name)
                except HTTPException as e:
                    print(f"compare: model {name} not available: {e.detail}", flush=True)
        print("compare: models loaded", flush=True)
    threading.Thread(target=warm, daemon=True).start()
    return app


def main(argv=None):
    ap = argparse.ArgumentParser(description="compare your movement with mouse-sim's models")
    ap.add_argument("--port", type=int, default=8771)
    ap.add_argument("--data", help="data root (default: mouse-sim/data or $MOUSESIM_DATA)")
    ap.add_argument("--open", action="store_true", help="open the page in the browser")
    args = ap.parse_args(argv)
    app = make_app(args.data)
    url = f"http://localhost:{args.port}/"
    print(f"compare: {url}", flush=True)
    if args.open:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
