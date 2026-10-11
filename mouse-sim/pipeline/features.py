"""Movement features. One shared code path computes them for real and generated movements, so the
two are always measured the same way (handoff Phase 2 "Features")."""
from __future__ import annotations

import math

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal import butter, periodogram, savgol_filter, sosfiltfilt

from . import config, geometry
from .segment import Kinematics, Movement, kinematics, rejections, segment
from .timeline import Timeline

NFFT = 1024
FREQS = np.fft.rfftfreq(NFFT, d=1e-3)


def spectrum_freqs(cfg: dict | None = None) -> np.ndarray:
    cfg = cfg or config.pipeline()
    lo, hi = cfg["jitter"]["bands_hz"][0][0], cfg["jitter"]["spectrum_max_hz"]
    return FREQS[(FREQS >= lo) & (FREQS <= hi)]


def conditions(start, target, screen) -> dict:
    """Movement conditions from a start point to the target (the model inputs)."""
    dx, dy = target.cx - start[0], target.cy - start[1]
    D = float(math.hypot(dx, dy))
    theta = float(geometry.direction_deg(dx, dy))
    along, across = (float(v) for v in geometry.sizes_along_across(target.shape, target.w, target.h, math.radians(theta)))
    di, ai, si = geometry.cell_of(D, theta, along)
    return {
        "start_x": float(start[0]), "start_y": float(start[1]), "D": D, "theta": theta,
        "size_along": along, "size_across": across, "shape": target.shape,
        "start_rel_x": float(start[0]) / screen[0], "start_rel_y": float(start[1]) / screen[1],
        "cell_d": di, "cell_a": ai, "cell_s": si,
    }


def _residual(pos: np.ndarray, cfg: dict) -> np.ndarray:
    """raw - low-passed position: everything above the jitter low-pass cut-off."""
    if len(pos) < 30:
        return pos - pos.mean(axis=0)
    sos = butter(2, cfg["jitter"]["lowpass_hz"], fs=1000.0, output="sos")
    pad = min(len(pos) - 1, 300)
    return pos - sosfiltfilt(sos, pos, axis=0, padlen=pad)


def count_submovements(speed: np.ndarray, cfg: dict) -> int:
    """Speed dips below dip_frac of the preceding peak, followed by a new peak. Counted on a
    Gaussian-smoothed speed, and a new submovement must reach min_peak (absolute and relative to the
    movement's top speed) and cover min_px, so pixel-step blips and tremor ripples don't count."""
    sc = cfg["submovement"]
    if len(speed) < 3:
        return 0
    s = gaussian_filter1d(speed, sc["smooth_ms"], mode="nearest") if sc.get("smooth_ms") else speed
    top = float(s.max())
    if top < sc["min_peak"]:
        return 0
    floor = max(sc["min_peak"], sc.get("min_peak_rel", 0.0) * top)
    d = np.diff(s)
    peaks = np.flatnonzero((np.concatenate([[1], d]) > 0) & (np.concatenate([d, [-1]]) <= 0))
    peaks = [int(p) for p in peaks if s[p] >= floor]
    if not peaks:
        return 0
    count, ref = 1, peaks[0]
    for p in peaks[1:]:
        v = ref + int(np.argmin(s[ref:p + 1]))
        if s[v] < sc["dip_frac"] * s[ref]:
            below = np.flatnonzero(s[p:] < sc["dip_frac"] * s[p])
            e = p + int(below[0]) if len(below) else len(s)
            if float(np.sum(s[v:e])) >= sc.get("min_px", 0.0):
                count += 1
                ref = p
                continue
        if s[p] > s[ref]:
            ref = p
    return count


def _ldlj(pos: np.ndarray, k0: int, k1: int, amplitude: float, cfg: dict) -> float:
    jc = cfg["jerk_smooth"]
    n = k1 - k0 + 1
    if n < 8 or amplitude < 1:
        return float("nan")
    a = max(0, k0 - jc["window_ms"])
    b = min(len(pos), k1 + jc["window_ms"] + 1)
    w = min(jc["window_ms"], (b - a) if (b - a) % 2 else (b - a) - 1)
    if w <= jc["polyorder"]:
        return float("nan")
    jerk = savgol_filter(pos[a:b], w, jc["polyorder"], deriv=3, delta=1e-3, axis=0, mode="interp")[k0 - a:k1 - a + 1]
    T = n * 1e-3
    integral = float(np.sum(jerk[:, 0] ** 2 + jerk[:, 1] ** 2) * 1e-3)
    dj = T ** 5 / amplitude ** 2 * integral
    return -math.log(dj) if dj > 0 else float("nan")


def movement_features(tl: Timeline, kin: Kinematics, mv: Movement, residual: np.ndarray, cfg: dict):
    k0, k1 = mv.k_onset, mv.k_down
    start = kin.pos[k0]
    tg = tl.target
    cond = conditions(start, tg, tl.screen)
    D = max(cond["D"], 1e-6)
    th = math.radians(cond["theta"])
    u = np.array([math.cos(th), math.sin(th)])
    nrm = np.array([-u[1], u[0]])  # right-hand side of travel on screen
    along, across = cond["size_along"], cond["size_across"]
    seg = kin.sm[k0:k1 + 1]
    spd = kin.speed[k0:k1 + 1]
    mt = mv.t_down - k0
    f = {
        "rt": k0 - mv.t_ref,
        "mt": mt,
        "dwell": mv.t_down - mv.k_last_stop,
        "hold": mv.t_up - mv.t_down,
    }
    if len(seg) >= 2:
        kp = int(np.argmax(spd))
        f["peak_speed"] = float(spd[kp])
        f["t_peak_frac"] = kp / (len(seg) - 1)
        steps = np.hypot(*np.diff(seg, axis=0).T)
        path = float(steps.sum())
        chord_v = seg[-1] - seg[0]
        chord = float(np.hypot(*chord_v))
        f["path_len"] = path
        f["path_eff"] = chord / path if path > 0.5 else 1.0
        if chord > 0.5:
            ul = chord_v / chord
            dev = ul[0] * (seg[:, 1] - seg[0, 1]) - ul[1] * (seg[:, 0] - seg[0, 0])
            km = int(np.argmax(np.abs(dev)))
            f["curv_px"] = float(dev[km])
            f["curv_norm"] = float(dev[km]) / D
            f["curv_pos"] = float((seg[km] - seg[0]) @ ul) / chord
        else:
            f["curv_px"] = f["curv_norm"] = 0.0
            f["curv_pos"] = float("nan")
        proj = (seg - start) @ u
        f["overshoot_px"] = float(proj.max() - D)
        f["overshoot_norm"] = f["overshoot_px"] / along
        f["passed_far_edge"] = float(proj.max() > D + along / 2)
        f["n_sub"] = count_submovements(spd, cfg)
        f["ldlj"] = _ldlj(kin.pos, k0, k1, max(chord, 1.0), cfg)
    else:
        f.update({"peak_speed": 0.0, "t_peak_frac": float("nan"), "path_len": 0.0, "path_eff": 1.0,
                  "curv_px": 0.0, "curv_norm": 0.0, "curv_pos": float("nan"), "overshoot_px": -D,
                  "overshoot_norm": -D / along, "passed_far_edge": 0.0, "n_sub": 0, "ldlj": float("nan")})
    end = mv.down_xy - np.array([tg.cx, tg.cy])
    f["end_along"] = float(end @ u)
    f["end_across"] = float(end @ nrm)
    f["end_along_norm"] = f["end_along"] / along
    f["end_across_norm"] = f["end_across"] / across
    ku = min(int(np.floor(mv.t_up)), len(kin.pos) - 1)
    hold = kin.pos[k1:ku + 1]
    f["slip"] = float(np.hypot(*(kin.pos[ku] - mv.down_xy)))
    f["slip_max"] = float(np.max(np.hypot(*(hold - mv.down_xy).T))) if len(hold) else 0.0
    f["miss"] = float(not mv.hit)

    r = residual[k0:k1 + 1]
    f["jit_rms"] = float(np.sqrt(np.mean(np.sum(r ** 2, axis=1)))) if len(r) else float("nan")
    spec = np.full(len(spectrum_freqs(cfg)), np.nan)
    if len(r) >= 16:
        _, px = periodogram(r[:, 0], fs=1000.0, window="hann", nfft=max(NFFT, len(r)), detrend="constant")
        fr, py = periodogram(r[:, 1], fs=1000.0, window="hann", nfft=max(NFFT, len(r)), detrend="constant")
        psd = px + py
        for i, (lo, hi) in enumerate(cfg["jitter"]["bands_hz"], start=1):
            sel = (fr >= lo) & (fr < hi)
            f[f"jit_b{i}"] = float(np.log10(np.sum(psd[sel]) * (fr[1] - fr[0]) + 1e-12))
        sf = spectrum_freqs(cfg)
        spec = np.interp(sf, fr, psd)
    else:
        for i in range(1, len(cfg["jitter"]["bands_hz"]) + 1):
            f[f"jit_b{i}"] = float("nan")

    n_prof = cfg["speed_profile_points"]
    prof = np.interp(np.linspace(0, len(spd) - 1, n_prof), np.arange(len(spd)), spd) if len(spd) >= 2 else np.zeros(n_prof)
    return cond, f, prof, spec


def analyse_timeline(tl: Timeline, cfg: dict | None = None, record: dict | None = None,
                     markers: list | None = None):
    """Segment a trial and measure every movement in it.
    Returns (trial-level dict, list of movement dicts, speed profiles, jitter spectra)."""
    cfg = cfg or config.pipeline()
    kin = kinematics(tl, cfg)
    movements = segment(tl, kin, cfg)
    reasons = rejections(tl, kin, movements, cfg, record, markers)
    residual = _residual(kin.pos, cfg)
    rows, profs, specs = [], [], []
    for mv in movements:
        cond, f, prof, spec = movement_features(tl, kin, mv, residual, cfg)
        rows.append({"mov": mv.index, "after_miss": mv.after_miss, "moved": mv.moved,
                     "t_ref": mv.t_ref, "t_onset": float(mv.k_onset), "t_last_stop": float(mv.k_last_stop),
                     "t_down": mv.t_down, "t_up": mv.t_up, "hit": mv.hit, **cond, **f})
        profs.append(prof)
        specs.append(spec)
    trial = {
        "rejected": bool(reasons), "reasons": ",".join(reasons), "n_clicks": len(tl.clicks),
        "n_misses": int(sum(not m.hit for m in movements)), "duration_ms": len(tl.pos),
        **{f"trial_{k}": v for k, v in conditions(tl.pos[0], tl.target, tl.screen).items()},
        "shape": tl.target.shape, "cx": tl.target.cx, "cy": tl.target.cy, "w": tl.target.w, "h": tl.target.h,
        "r": tl.target.r, "screen_w": tl.screen[0], "screen_h": tl.screen[1],
    }
    n_spec = len(spectrum_freqs(cfg))
    return (trial, rows, np.array(profs).reshape(-1, cfg["speed_profile_points"]),
            np.array(specs).reshape(-1, n_spec))


def fitts_fit(movs, cfg: dict | None = None) -> dict:
    """Fitts's law on primary movements: MT = a + b*log2(De/We + 1) on (distance, size) groups,
    with We = 4.133 * SD of endpoints along the movement axis (ISO 9241-411), plus a per-movement
    fit on nominal width that the models use to scale time."""
    cfg = cfg or config.pipeline()
    p = movs[(movs["mov"] == 0) & (movs["mt"] > 0)]
    groups = []
    for (dbin, sbin), g in p.groupby(["cell_d", "cell_s"]):
        if len(g) < cfg["fitts_min_group_n"] or dbin < 0:
            continue
        we = 4.133 * float(np.std(g["end_along"], ddof=1))
        de = float(np.mean(g["D"] + g["end_along"]))
        if we <= 0 or de <= 0:
            continue
        groups.append({"cell_d": int(dbin), "cell_s": int(sbin), "n": int(len(g)), "De": de, "We": we,
                       "IDe": math.log2(de / we + 1), "MT": float(np.mean(g["mt"])),
                       "MT_sd": float(np.std(g["mt"], ddof=1))})
    out = {"groups": groups, "n_movements": int(len(p))}
    if len(groups) >= 3:
        x = np.array([g["IDe"] for g in groups])
        y = np.array([g["MT"] for g in groups])
        b, a = np.polyfit(x, y, 1)
        pred = a + b * x
        out.update({"a": float(a), "b": float(b),
                    "r2": float(1 - np.sum((y - pred) ** 2) / np.sum((y - y.mean()) ** 2)),
                    "throughput_bits_per_s": float(np.mean(x / (y / 1000)))})
    if len(p) >= 3:
        idn = np.log2(p["D"] / p["size_along"] + 1)
        bn, an = np.polyfit(idn, p["mt"], 1)
        out.update({"a_nominal": float(an), "b_nominal": float(bn)})
    return out


def predicted_mt(fitts: dict, D, size_along):
    return fitts["a_nominal"] + fitts["b_nominal"] * np.log2(np.asarray(D) / np.asarray(size_along) + 1)
