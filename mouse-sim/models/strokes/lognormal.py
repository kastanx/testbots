"""Sigma-lognormal strokes (the kinematic theory of rapid human movements, Plamondon).

A quick aimed movement is a sum of strokes. A stroke is a push whose speed over time has a lognormal
shape - it rises fast, peaks early and tails off - and whose direction turns evenly as it covers its
distance, so its path is a circular arc:

    p = (D, t0, mu, sigma, theta_s, theta_e)
    speed(t)     = D / (sigma sqrt(2 pi) (t - t0)) exp(-(ln(t - t0) - mu)^2 / (2 sigma^2)),  t > t0
    direction(t) = theta_s + (theta_e - theta_s) * (distance covered so far) / D

D in px, t0 in ms, mu in log ms, angles in rad. fit() decomposes a recorded velocity into strokes:
greedily at the biggest speed peak left, every stroke refitted together (least squares with the exact
Jacobian), until the fit is good enough or another stroke doesn't help.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.optimize import least_squares
from scipy.signal import butter, sosfiltfilt
from scipy.special import erf

SQ2 = math.sqrt(2.0)
SQ2PI = math.sqrt(2.0 * math.pi)
NAMES = ("D", "t0", "mu", "sigma", "theta_s", "theta_e")
# Bounds keep the strokes physical: none starts more than 300 ms before the recorded window (the
# onset - 40 ms), and none is narrower than sigma 0.1 - a near-zero sigma makes a short symmetric
# bump that two huge opposing strokes can be made to cancel into any speed profile.
LO = np.array([0.05, -300.0, math.log(3.0), 0.10, -6 * math.pi, -6 * math.pi])
HI = np.array([1e5, 1e5, math.log(20000.0), 1.0, 6 * math.pi, 6 * math.pi])
REST_MS = 150   # the hand is at rest after the last stop: fitted as this much zero speed
# The strokes' sizes may add up to at most this much more than the distance the hand travelled; past
# it, a penalty (in px, times SIZE_WEIGHT) joins the fit. Without it, pairs of strokes pulling in
# opposite directions explain fine detail - and come apart when one of them is varied.
SIZE_SLACK = 1.15
SIZE_WEIGHT = 0.05


def _parts(t, p):
    D, t0, mu, sg, ths, the = p
    dt = t - t0
    m = dt > 1e-6
    dtm = np.where(m, dt, 1.0)
    z = (np.log(dtm) - mu) / sg
    g = np.exp(-0.5 * z * z)
    lam = np.where(m, g / (sg * SQ2PI * dtm), 0.0)
    frac = np.where(m, 0.5 * (1.0 + erf(z / SQ2)), 0.0)
    phi = ths + (the - ths) * frac
    return m, dtm, z, g, lam, frac, phi


def stroke_vel(t, p) -> np.ndarray:
    """(len(t), 2) velocity of one stroke, px/ms."""
    _, _, _, _, lam, _, phi = _parts(np.asarray(t, float), p)
    s = p[0] * lam
    return np.column_stack([s * np.cos(phi), s * np.sin(phi)])


def velocity(t, P) -> np.ndarray:
    v = np.zeros((len(t), 2))
    for p in np.asarray(P, float).reshape(-1, 6):
        v += stroke_vel(t, p)
    return v


def stroke_pos(t, p) -> np.ndarray:
    """(len(t), 2) displacement one stroke has covered by time t - exactly, along its arc."""
    D, _, _, _, ths, the = p
    _, _, _, _, _, frac, _ = _parts(np.asarray(t, float), p)
    d = D * frac
    k = (the - ths) / D if D > 0 else 0.0
    if abs(k) < 1e-9:
        return np.column_stack([d * math.cos(ths), d * math.sin(ths)])
    phi = ths + k * d
    return np.column_stack([(np.sin(phi) - math.sin(ths)) / k, (math.cos(ths) - np.cos(phi)) / k])


def position(t, P) -> np.ndarray:
    out = np.zeros((len(t), 2))
    for p in np.asarray(P, float).reshape(-1, 6):
        out += stroke_pos(t, p)
    return out


def chord(p) -> np.ndarray:
    """A stroke's whole displacement, start to end of its arc."""
    D, _, _, _, ths, the = p
    k = (the - ths) / D if D > 0 else 0.0
    if abs(k) < 1e-9:
        return np.array([D * math.cos(ths), D * math.sin(ths)])
    phi = ths + k * D
    return np.array([(math.sin(phi) - math.sin(ths)) / k, (math.cos(ths) - math.cos(phi)) / k])


def mode_time(p) -> float:
    """When a stroke is fastest."""
    return float(p[1] + math.exp(p[2] - p[3] ** 2))


def jacobian(t, P) -> np.ndarray:
    """d(velocity, flattened x0, y0, x1, y1, ...) / dP."""
    P = np.asarray(P, float).reshape(-1, 6)
    J = np.zeros((2 * len(t), P.size))
    for i, p in enumerate(P):
        D, t0, mu, sg, ths, the = p
        m, dtm, z, g, lam, frac, phi = _parts(t, p)
        s = D * lam
        c, sn = np.cos(phi), np.sin(phi)
        pdf = np.where(m, g / SQ2PI, 0.0)
        dz = {"t0": -1.0 / (sg * dtm), "mu": -1.0 / sg, "sigma": -z / sg}
        ds = {"D": lam, "t0": s * (1.0 + z / sg) / dtm, "mu": s * z / sg, "sigma": s * (z * z - 1.0) / sg}
        dphi = {"t0": (the - ths) * pdf * dz["t0"], "mu": (the - ths) * pdf * dz["mu"],
                "sigma": (the - ths) * pdf * dz["sigma"], "theta_s": 1.0 - frac, "theta_e": frac}
        for j, name in enumerate(NAMES):
            a = ds.get(name, 0.0)
            b = dphi.get(name, 0.0)
            J[0::2, 6 * i + j] = np.where(m, a * c - s * sn * b, 0.0)
            J[1::2, 6 * i + j] = np.where(m, a * sn + s * c * b, 0.0)
    return J


def snr_db(v, vh) -> float:
    return 10 * math.log10(max(float(np.sum(v ** 2)), 1e-12) / max(float(np.sum((v - vh) ** 2)), 1e-12))


def _guess(t, resid, k) -> np.ndarray:
    sp = np.hypot(resid[:, 0], resid[:, 1])
    pk = sp[k]
    a = k
    while a > 0 and sp[a - 1] > 0.15 * pk and sp[a - 1] <= sp[a] * 1.05:
        a -= 1
    b = k
    while b < len(sp) - 1 and sp[b + 1] > 0.15 * pk and sp[b + 1] <= sp[b] * 1.05:
        b += 1
    D = float(np.sum(sp[a:b + 1]) * (t[1] - t[0])) / 0.85
    sg = 0.3
    rise = max(t[k] - t[a], 3.0)
    t0 = t[a] - rise * 0.6
    mu = math.log(max(t[k] - t0, 3.0)) + sg * sg
    ang = math.atan2(resid[k, 1], resid[k, 0])
    return np.clip(np.array([max(D, 0.1), t0, mu, sg, ang, ang]), LO + 1e-9, HI - 1e-9)


def fit(t, v, max_strokes=6, target_snr=20.0, min_gain_db=0.5, min_peak=0.02, size_cap=None):
    """Strokes for a velocity (n, 2) sampled at times t. Returns (P (k, 6), snr dB). With size_cap
    (px), the strokes' sizes adding up to more than it is penalised (see SIZE_SLACK)."""
    P = np.zeros(0)
    resid = v.copy()
    best_P, best_s = P, -np.inf
    flat = v.ravel()

    def residuals(q):
        r = velocity(t, q).ravel() - flat
        if size_cap is None:
            return r
        over = max(0.0, float(np.sum(q[0::6])) - size_cap)
        return np.append(r, SIZE_WEIGHT * over)

    def jac(q):
        J = jacobian(t, q)
        if size_cap is None:
            return J
        row = np.zeros((1, q.size))
        if float(np.sum(q[0::6])) > size_cap:
            row[0, 0::6] = SIZE_WEIGHT
        return np.vstack([J, row])

    for _ in range(max_strokes):
        sp = np.hypot(resid[:, 0], resid[:, 1])
        k = int(np.argmax(sp))
        if sp[k] < min_peak:
            break
        g = _guess(t, resid, k)
        r1 = least_squares(lambda q: (stroke_vel(t, q) - resid).ravel(), g, jac=lambda q: jacobian(t, q),
                           bounds=(LO, HI), method="trf", max_nfev=60)
        P = np.concatenate([P, r1.x])
        n = len(P) // 6
        r = least_squares(residuals, P, jac=jac, bounds=(np.tile(LO, n), np.tile(HI, n)), method="trf", max_nfev=100)
        P = r.x
        vh = velocity(t, P)
        resid = v - vh
        s = snr_db(v, vh)
        gain = s - best_s
        if s > best_s:
            best_P, best_s = P.copy(), s
        if s >= target_snr or gain < min_gain_db:
            break
    return best_P.reshape(-1, 6), best_s


def lowpass(x: np.ndarray, fc: float) -> np.ndarray:
    if fc <= 0 or len(x) < 30:
        return np.asarray(x, float)
    return sosfiltfilt(butter(2, fc, fs=1000.0, output="sos"), np.asarray(x, float), axis=0,
                       padlen=min(len(x) - 1, 300))


def highpass(x: np.ndarray, fc: float) -> np.ndarray:
    if fc <= 0 or len(x) < 30:
        return np.asarray(x, float)
    return sosfiltfilt(butter(2, fc, btype="highpass", fs=1000.0, output="sos"), np.asarray(x, float), axis=0,
                       padlen=min(len(x) - 1, 300))


def fit_movement(q: np.ndarray, plan_hz: float = 10.0, step: int = 2):
    """Strokes for a recorded movement: q (n, 2) positions on the 1 ms grid, ending at rest. The
    strokes are fitted to its slow part (low-passed at plan_hz, sampled every `step` ms) followed by
    REST_MS of standing still, so none of them is still creeping on after the movement ended; the
    rest is hand texture."""
    lp = lowpass(q, plan_hz)
    v = np.gradient(lp, axis=0)
    idx = np.arange(0, len(q), step)
    tail = np.arange(len(q) - 1 + step, len(q) + REST_MS, step)
    t = np.concatenate([idx, tail]).astype(float)
    vv = np.vstack([v[idx], np.zeros((len(tail), 2))])
    travelled = float(np.sum(np.hypot(v[:, 0], v[:, 1])))       # px, 1 ms steps
    return fit(t, vv, size_cap=SIZE_SLACK * travelled + 2.0)


def contribution(p, T: float) -> np.ndarray:
    """How far one stroke has moved by time T."""
    return stroke_pos(np.array([float(T)]), p)[0]
