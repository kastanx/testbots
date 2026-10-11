"""Synthetic owner: writes fake recorder sessions in the exact raw format, for testing the pipeline,
the harness and the models before (and independently of) the owner's real recordings.

This is a test fixture, not a model of anyone. It has a stable "personal signature" (reaction time,
Fitts parameters, direction-dependent curvature, undershoot and corrective submovements, dwell,
click hold, slip, tremor) plus day-to-day drift between sessions, and it imitates the input chain:
1000 Hz polling on a drifting clock, whole-pixel cursor positions, delivery jitter, the odd dropped
report, 5 us timestamps, and target markers on 144 Hz frames.

    python -m tools.synth --out data_synth --sessions train:8,val:1,test:2 --trials 250 --seed 1

Never point --out at the real data folder; the CLI refuses to.
"""
from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
from scipy.special import betainc

from pipeline import config, geometry, paths

RC = config.recorder()


@dataclass
class Owner:
    rt_ms: float = 285.0
    rt_sigma: float = 0.2
    fitts_a: float = 95.0
    fitts_b: float = 120.0
    undershoot: float = 0.045          # primary lands short by this fraction of D on average
    sd_along: tuple = (0.045, 1.2)     # endpoint SD = k * D + c (px)
    sd_across: tuple = (0.022, 0.9)
    curv_amp: float = 0.045            # lateral bulge as a fraction of D, varies with direction
    curv_phase_deg: float = 30.0
    curv_bias: float = 0.012
    beta_shape: tuple = (2.6, 3.5)     # speed profile peaks at (a-1)/(a+b-2) ~ 0.39 of the submovement
    dwell_ms: float = 70.0
    dwell_sigma: float = 0.35
    hold_ms: float = 92.0
    hold_sigma: float = 0.25
    slip_prob: float = 0.08
    tremor_px: float = 0.3
    tremor_hz: float = 9.5
    give_up: float = 0.07              # chance of clicking without a needed correction (-> some misses)


@dataclass
class SessionDrift:
    speed: float = 1.0
    rt: float = 1.0
    curv: float = 0.0
    dwell: float = 1.0

    @classmethod
    def draw(cls, rng):
        return cls(speed=rng.normal(1, 0.045), rt=rng.normal(1, 0.06), curv=rng.normal(0, 0.008),
                   dwell=rng.normal(1, 0.08))


@dataclass
class Segment:
    t0: float
    t1: float
    p0: np.ndarray
    p1: np.ndarray
    curv: float
    shape: tuple
    tremor: bool = True


@dataclass
class TrialPlan:
    segments: list = field(default_factory=list)
    clicks: list = field(default_factory=list)   # (t_down, t_up, slip_vec)
    leave_at: float | None = None


def _lognormal(rng, median, sigma):
    return float(median * math.exp(rng.normal(0, sigma)))


def sample_in_cell(cell, cursor, screen, rng):
    """Python port of sampleInCell() from web/src/shared/placement.ts."""
    di, ai, si = cell
    d_lo = geometry.DIST_EDGES[di]
    d_hi = min(geometry.DIST_EDGES[di + 1], math.hypot(*screen))
    if d_hi <= d_lo:
        return None
    D0 = math.exp(rng.uniform(math.log(d_lo), math.log(d_hi)))
    theta = math.radians(ai * geometry.DIR_WIDTH + rng.uniform(-geometry.DIR_WIDTH / 2, geometry.DIR_WIDTH / 2))
    along0 = math.exp(rng.uniform(math.log(geometry.SIZE_EDGES[si]), math.log(geometry.SIZE_EDGES[si + 1])))
    if rng.random() < RC["circle_probability"]:
        shape, w = "circle", max(2, round(along0))
        h = w
    else:
        shape = "rect"
        c, s = abs(math.cos(theta)), abs(math.sin(theta))
        aspect = math.exp(rng.uniform(*np.log(RC["rect_aspect_range"])))
        m = min(aspect / c if c > 1e-9 else math.inf, 1 / s if s > 1e-9 else math.inf)
        h = round(along0 / m)
        w = round(aspect * h)
        lo, hi = RC["rect_side_range_px"]
        if not (lo <= w <= hi and lo <= h <= hi):
            return None
    cx = round(cursor[0] + D0 * math.cos(theta))
    cy = round(cursor[1] + D0 * math.sin(theta))
    m = RC["edge_margin_px"]
    if cx - w / 2 < m or cx + w / 2 > screen[0] - m or cy - h / 2 < m or cy + h / 2 > screen[1] - m:
        return None
    r = float(geometry.corner_radius(w, h, RC["corner_radius_px"])) if shape == "rect" else 0.0
    dx, dy = cx - cursor[0], cy - cursor[1]
    D = math.hypot(dx, dy)
    th = float(geometry.direction_deg(dx, dy))
    along, across = (float(v) for v in geometry.sizes_along_across(shape, w, h, math.radians(th)))
    if D < along / 2 + RC["start_outside_margin_px"]:
        return None
    if geometry.cell_of(D, th, along) != tuple(cell):
        return None
    return {"shape": shape, "cx": cx, "cy": cy, "w": w, "h": h, "r": r, "cell": list(cell),
            "plan": {"D": D, "theta": th, "along": along, "across": across}}


def place(cursor, screen, rng):
    cells = [(d, a, s) for d in range(geometry.N_DIST) for a in range(geometry.N_DIR) for s in range(geometry.N_SIZE)]
    for _ in range(400):
        cell = cells[rng.integers(len(cells))]
        for _ in range(6):
            p = sample_in_cell(cell, cursor, screen, rng)
            if p:
                return p
    raise RuntimeError("could not place a target")


def plan_trial(owner: Owner, drift: SessionDrift, rng, start, tgt, inject_pause=False) -> TrialPlan:
    c = np.array([tgt["cx"], tgt["cy"]], float)
    start = np.asarray(start, float)
    plan = TrialPlan()

    def endpoint(dist, w_along, w_across, u, n, precise):
        k_al, c_al = owner.sd_along
        k_ac, c_ac = owner.sd_across
        if precise:  # corrective submovements are slower and more accurate
            sd_al = 0.12 * dist + 0.12 * w_along
            sd_ac = 0.10 * dist + 0.10 * w_across
            bias = -0.03 * dist
        else:
            sd_al, sd_ac = k_al * dist + c_al, k_ac * dist + c_ac
            bias = -owner.undershoot * dist
        return c + u * (bias + rng.normal(0, sd_al)) + n * rng.normal(0, sd_ac)

    t = _lognormal(rng, owner.rt_ms * drift.rt, owner.rt_sigma)
    cur = start.copy()
    if rng.random() < 0.25:  # small drift while reacting
        drift_to = cur + rng.normal(0, 1.5, 2)
        t0 = t * rng.uniform(0.2, 0.6)
        plan.segments.append(Segment(t0, t0 + rng.uniform(40, 120), cur.copy(), drift_to, 0.0, (2, 2), False))
        cur = drift_to

    def move(t, cur, aim, duration, curv, shape):
        plan.segments.append(Segment(t, t + duration, cur.copy(), aim.copy(), curv, shape))
        return t + duration, aim.copy()

    def corrections(t, cur, max_n=4):
        for i in range(max_n):
            v = c - cur
            dist = float(np.hypot(*v))
            u = v / dist if dist > 1e-9 else np.array([1.0, 0.0])
            n = np.array([-u[1], u[0]])
            th = math.atan2(v[1], v[0])
            w_al, w_ac = (float(x) for x in geometry.sizes_along_across(tgt["shape"], tgt["w"], tgt["h"], th))
            off = cur - c
            if abs(off @ u) <= 0.4 * w_al and abs(off @ n) <= 0.4 * w_ac:
                break
            if rng.random() < owner.give_up:
                break
            gap = rng.uniform(25, 110)
            dur = (55 + 75 * math.log2(dist / max(min(w_al, w_ac), 2) + 1)) * drift.speed * rng.normal(1, 0.1)
            t, cur = move(t + gap, cur, endpoint(dist, w_al, w_ac, u, n, True), max(dur, 40),
                          rng.normal(0, 0.03), (2.4, 2.9))
        return t, cur

    # Primary submovement
    v = c - cur
    D = float(np.hypot(*v))
    u = v / D
    n = np.array([-u[1], u[0]])
    theta = math.atan2(v[1], v[0])
    w_al, w_ac = (float(x) for x in geometry.sizes_along_across(tgt["shape"], tgt["w"], tgt["h"], theta))
    T1 = (owner.fitts_a + owner.fitts_b * math.log2(D / max(w_al, 2) + 1)) * 0.78 * drift.speed * rng.normal(1, 0.08)
    curv = owner.curv_amp * math.sin(theta - math.radians(owner.curv_phase_deg)) + owner.curv_bias + drift.curv
    a, b = owner.beta_shape
    t, cur = move(t, cur, endpoint(D, w_al, w_ac, u, n, False), max(T1, 70), curv + rng.normal(0, 0.012),
                  (a * rng.normal(1, 0.05), b * rng.normal(1, 0.05)))
    if inject_pause:
        # A >2 s stop mid-movement, then the hand moves on: the pipeline must reject this trial.
        t, cur = move(t + 2600, cur, cur + n * 8, 150, 0.0, (2.4, 2.9))
    t, cur = corrections(t, cur)

    for _attempt in range(4):
        th = math.atan2(*(c - cur)[::-1])
        w_al = float(geometry.chord(tgt["shape"], tgt["w"], tgt["h"], th))
        dwell = _lognormal(rng, (owner.dwell_ms + 16 * math.log2(64 / max(w_al, 4))) * drift.dwell, owner.dwell_sigma)
        t_down = t + max(dwell, 0.0)
        hold = _lognormal(rng, owner.hold_ms, owner.hold_sigma)
        slip = rng.choice([-1, 1], 2) * (rng.random(2) < 0.5) if rng.random() < owner.slip_prob else np.zeros(2)
        plan.clicks.append((t_down, t_down + hold, slip))
        hit = bool(geometry.inside(tgt["shape"], tgt["cx"], tgt["cy"], tgt["w"], tgt["h"], tgt["r"],
                                   np.round(cur[0]), np.round(cur[1])))
        cur = cur + slip
        t = t_down + hold
        if hit:
            break
        # Re-react after a miss, then a correction movement and another click.
        t += _lognormal(rng, 210, 0.3)
        t, cur = corrections(t, cur, max_n=3)
    return plan


def evaluate_path(plan: TrialPlan, start, times, owner: Owner, rng_phase):
    """Continuous (float) cursor position at the given trial-local times."""
    pos = np.tile(np.asarray(start, float), (len(times), 1))
    trem = np.zeros((len(times), 2))
    for seg in plan.segments:
        after = times >= seg.t1
        pos[after] = seg.p1
        active = (times >= seg.t0) & (times < seg.t1)
        if active.any():
            tau = (times[active] - seg.t0) / (seg.t1 - seg.t0)
            s = betainc(seg.shape[0], seg.shape[1], tau)
            d = seg.p1 - seg.p0
            L = float(np.hypot(*d))
            nrm = np.array([-d[1], d[0]]) / L if L > 1e-9 else np.zeros(2)
            pos[active] = seg.p0 + np.outer(s, d) + np.outer(seg.curv * L * np.sin(np.pi * s), nrm)
            if seg.tremor:
                env = np.sin(np.pi * tau)
                ph = rng_phase
                trem[active, 0] = owner.tremor_px * env * np.sin(2 * np.pi * owner.tremor_hz * times[active] / 1000 + ph)
                trem[active, 1] = owner.tremor_px * env * np.cos(2 * np.pi * owner.tremor_hz * 1.07 * times[active] / 1000 + ph)
    # Slips happen during the hold: shift positions from shortly after the down onward.
    for (t_down, _t_up, slip) in plan.clicks:
        if np.any(slip):
            pos[times >= t_down + 25] += slip
    return pos + trem


class Quantizer:
    """Whole-pixel cursor: the sensor and Windows carry sub-pixel remainders, so the cursor is the
    rounded accumulated position (no hysteresis)."""

    def __init__(self, p):
        self.cur = np.floor(np.asarray(p, float) + 0.5)

    def step(self, p):
        new = np.floor(p + 0.5)
        changed = bool(np.any(new != self.cur))
        self.cur = new
        return changed


def make_session(out_root: Path, role: str, n_trials: int, rng, owner: Owner, day: int,
                 inject: bool = False, dpr: float = 1.0, screen=(3440, 1440)) -> str:
    drift = SessionDrift.draw(rng)
    started = datetime(2026, 9, 1, 9, 0) + timedelta(days=day, hours=int(rng.integers(0, 10)))
    sid = started.strftime("%Y%m%d-%H%M%S") + f"-{rng.integers(0, 0xFFFF):04x}"
    d = out_root / "raw" / sid
    d.mkdir(parents=True)
    period = 1.0 * (1 + rng.normal(0, 50e-6))
    phase = rng.uniform(0, 1)
    frame = 1000.0 / 144.0
    frame_phase = rng.uniform(0, frame)
    t_clock = 2500.0 + rng.uniform(0, 500)
    cursor = np.array([screen[0] / 2, screen[1] / 2])
    quant = Quantizer(cursor)
    ev_lines, tr_lines = [], []
    last_arrival = -1.0

    def fmt(v):
        return repr(round(float(v), 4))

    def arrival(t_true):
        nonlocal last_arrival
        k = math.ceil((t_true - phase) / period - 1e-9)
        t_poll = phase + k * period
        delay = 0.12 + rng.exponential(0.18) + (rng.uniform(1, 3) if rng.random() < 0.004 else 0.0)
        a = max(t_poll + delay, last_arrival + 0.005)
        last_arrival = a
        return round(a / 0.005) * 0.005

    def next_frame(t):
        return frame_phase + math.ceil((t - frame_phase) / frame) * frame

    def css(v):
        return v / dpr

    t_prev_up = t_clock
    for trial in range(n_trials):
        t_on = next_frame(t_prev_up + rng.uniform(*RC["pause_ms"]))
        tgt = place(tuple(cursor), screen, rng)
        plan = plan_trial(owner, drift, rng, cursor, tgt, inject_pause=inject and trial == n_trials // 2 + 10)
        if inject and trial == n_trials // 2:
            plan.leave_at = plan.clicks[0][0] * 0.5
        t_end = plan.clicks[-1][1]
        # Polls inside the trial window, in session time.
        k0 = math.ceil((t_on - phase) / period)
        k1 = math.floor((t_on + t_end - phase) / period)
        polls = phase + np.arange(k0, k1 + 1) * period
        local = polls - t_on
        path = evaluate_path(plan, cursor, local, owner, rng.uniform(0, 2 * np.pi))
        path[:, 0] = np.clip(path[:, 0], 0, screen[0] - 1)
        path[:, 1] = np.clip(path[:, 1], 0, screen[1] - 1)
        drops = rng.random(len(polls)) < 0.0005

        events = [(t_on, f'{{"t":{fmt(t_on)},"k":"target_on","trial":{trial}}}')]
        click_idx = 0
        clicks = plan.clicks
        miss_t, t_hit, t_up_hit = [], None, None

        def emit_button(ci, edge):
            nonlocal t_hit, t_up_hit
            a = arrival(t_on + clicks[ci][edge])
            x, y = css(quant.cur[0]), css(quant.cur[1])
            if edge == 0:
                hit = bool(geometry.inside(tgt["shape"], tgt["cx"], tgt["cy"], tgt["w"], tgt["h"], tgt["r"],
                                           quant.cur[0], quant.cur[1]))
                events.append((a, f'{{"t":{fmt(a)},"k":"down","x":{fmt(x)},"y":{fmt(y)},"b":1,"btn":0}}'))
                kind = "hit" if hit and t_hit is None else "miss"
                events.append((a, f'{{"t":{fmt(a)},"k":"{kind}","trial":{trial},"x":{fmt(x)},"y":{fmt(y)}}}'))
                if kind == "hit":
                    t_hit = a
                else:
                    miss_t.append(round(a, 4))
            else:
                events.append((a, f'{{"t":{fmt(a)},"k":"up","x":{fmt(x)},"y":{fmt(y)},"b":0,"btn":0}}'))
                if t_hit is not None and t_up_hit is None:
                    t_up_hit = a

        for i, tp in enumerate(polls):
            # button events happen at poll times too
            while click_idx < 2 * len(clicks) and t_on + clicks[click_idx // 2][click_idx % 2] <= tp:
                emit_button(*divmod(click_idx, 2))
                click_idx += 1
            if t_up_hit is not None:
                break  # the target is gone once the hit click is released
            if quant.step(path[i]) and not drops[i]:
                a = arrival(tp)
                b = 1 if any(t_on + cd <= tp < t_on + cu for cd, cu, _ in clicks) else 0
                events.append((a, f'{{"t":{fmt(a)},"k":"move","x":{fmt(css(quant.cur[0]))},'
                                  f'"y":{fmt(css(quant.cur[1]))},"b":{b}}}'))
        while click_idx < 2 * len(clicks) and t_up_hit is None:  # button events after the last poll
            emit_button(*divmod(click_idx, 2))
            click_idx += 1
        if plan.leave_at is not None:
            tl = t_on + plan.leave_at
            events.append((tl, f'{{"t":{fmt(tl)},"k":"leave","x":0,"y":0}}'))
            events.append((tl + 400, f'{{"t":{fmt(tl + 400)},"k":"enter","x":0,"y":0}}'))
        t_up = t_up_hit if t_up_hit is not None else t_on + t_end
        t_off = next_frame(t_up)
        events.append((t_off, f'{{"t":{fmt(t_off)},"k":"target_off","trial":{trial}}}'))
        events.sort(key=lambda e: e[0])
        ev_lines += [e[1] for e in events]
        invalid_reasons = ["pointer_left"] if plan.leave_at is not None else []
        tr_lines.append(json.dumps({
            "trial": trial, "shape": tgt["shape"],
            "cx": css(tgt["cx"]), "cy": css(tgt["cy"]), "w": css(tgt["w"]), "h": css(tgt["h"]), "r": css(tgt["r"]),
            "cell": tgt["cell"], "t_on": round(t_on, 4), "t_off": round(t_off, 4),
            "t_hit": None if t_hit is None else round(t_hit, 4), "t_up": round(t_up, 4),
            "misses": len(miss_t), "miss_t": miss_t, "warmup": trial < RC["warmup_trials"],
            "invalid": bool(invalid_reasons), "invalid_reasons": invalid_reasons,
            "start_x": css(cursor[0]), "start_y": css(cursor[1]),
            "plan": {k: round(v, 4) for k, v in tgt["plan"].items()},
        }, separators=(",", ":")))
        cursor = quant.cur.copy()
        t_prev_up = t_up

    (d / "events.jsonl").write_text("\n".join(ev_lines) + "\n", encoding="utf-8")
    (d / "trials.jsonl").write_text("\n".join(tr_lines) + "\n", encoding="utf-8")
    meta = {
        "session_id": sid, "synthetic": True, "role": role, "dryrun": False, "complete": True,
        "created_at": started.isoformat(), "started_at": started.isoformat(),
        "setup_version": 1, "setup": {"setup_version": 1, "mouse": {"model": "synthetic", "dpi": 800, "polling_hz": 1000}},
        "devicePixelRatio": dpr, "canvas_phys": list(screen), "screen_phys": list(screen),
        "viewport_css": [screen[0] / dpr, screen[1] / dpr], "fullscreen": True, "crossOriginIsolated": True,
        "event_source": "pointermove-coalesced", "refresh_hz": 144.0, "units": "css_px",
        "n_trials": n_trials, "feeling": "normal", "notes": "synthetic owner",
        "drift": {"speed": drift.speed, "rt": drift.rt, "curv": drift.curv, "dwell": drift.dwell},
    }
    (d / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return sid


def generate(out_root: Path, roles: list[str], n_trials: int, seed: int, owner: Owner | None = None,
             inject: bool = True, dpr: float = 1.0, screen=(3440, 1440)) -> list[str]:
    out_root = Path(out_root)
    real = paths.PROJECT / "data"
    if out_root.resolve() == real.resolve():
        raise SystemExit("refusing to write synthetic sessions into the real data folder")
    rng = np.random.default_rng(seed)
    owner = owner or Owner()
    out_root.mkdir(parents=True, exist_ok=True)
    setup = out_root / "setup.json"
    if not setup.exists():
        setup.write_text(json.dumps({"setup_version": 1, "confirmed": True, "synthetic": True,
                                     "mouse": {"model": "synthetic", "dpi": 800, "polling_hz": 1000}}, indent=2))
    sids = []
    for i, role in enumerate(roles):
        sids.append(make_session(out_root, role, n_trials, rng, owner, day=i * 2,
                                 inject=inject and i == 0, dpr=dpr, screen=screen))
    return sids


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--sessions", default="train:8,val:1,test:2")
    ap.add_argument("--trials", type=int, default=250)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--dpr", type=float, default=1.0)
    args = ap.parse_args()
    roles = []
    for part in args.sessions.split(","):
        role, n = part.split(":")
        roles += [role] * int(n)
    sids = generate(Path(args.out), roles, args.trials, args.seed, dpr=args.dpr)
    print(f"wrote {len(sids)} synthetic sessions to {Path(args.out).resolve() / 'raw'}")


if __name__ == "__main__":
    main()
