"""Fingerprint report (an HTML page with Plotly charts). The same builder draws the owner alone or
the owner next to one or more models, so later phases can show them side by side."""
from __future__ import annotations

import html
import json
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from . import config, geometry, paths
from .dataset import Dataset
from .features import fitts_fit

PALETTE = ["#2f6db3", "#d1603d", "#3a9a5b", "#8a5bc2", "#c28f1f", "#5a5a5a"]


@dataclass
class FingerprintData:
    name: str
    movs: pd.DataFrame          # usable movements (primary and after-miss) with features
    profiles: np.ndarray        # speed profiles, rows aligned with movs
    spectra: np.ndarray         # jitter spectra, rows aligned with movs
    freqs: np.ndarray

    @property
    def primary(self) -> pd.DataFrame:
        return self.movs[self.movs["mov"] == 0]

    @classmethod
    def from_dataset(cls, ds: Dataset, name: str, role: str | None = None, include_warmup: bool = False):
        m = ds.usable_movements(role=role, include_warmup=include_warmup)
        p = ds.profiles
        idx = m.index.to_numpy()
        return cls(name, m.reset_index(drop=True), p["profiles"][idx], p["spectra"][idx], p["freqs"])


def _layout(fig, title, height=420):
    fig.update_layout(title=dict(text=title, x=0, font=dict(size=16)), height=height, template="plotly_white",
                      margin=dict(l=60, r=20, t=60, b=50), legend=dict(orientation="h", y=-0.15))
    return fig


def fig_fitts(datasets):
    fig = go.Figure()
    for i, d in enumerate(datasets):
        f = fitts_fit(d.movs)
        g = pd.DataFrame(f["groups"])
        if g.empty:
            continue
        c = PALETTE[i % len(PALETTE)]
        fig.add_trace(go.Scatter(x=g["IDe"], y=g["MT"], mode="markers", name=d.name, marker=dict(color=c, size=8),
                                 error_y=dict(type="data", array=g["MT_sd"] / np.sqrt(g["n"]), color=c, thickness=1),
                                 text=[f"D bin {a}, size bin {b}, n={n}" for a, b, n in zip(g.cell_d, g.cell_s, g.n)]))
        if "a" in f:
            x = np.linspace(0, g["IDe"].max() * 1.05, 20)
            fig.add_trace(go.Scatter(x=x, y=f["a"] + f["b"] * x, mode="lines", line=dict(color=c, dash="dot"),
                                     name=f"{d.name}: MT = {f['a']:.0f} + {f['b']:.0f}·IDe (R² {f['r2']:.2f})"))
    fig.update_xaxes(title="effective index of difficulty IDe = log2(De/We + 1) (bits)")
    fig.update_yaxes(title="movement time (ms)")
    return _layout(fig, "Fitts's law (groups of distance × size, ISO 9241-411 effective width)")


def fig_speed_profiles(datasets):
    nd = geometry.N_DIST
    edges = geometry.DIST_EDGES
    titles = [f"{edges[i]:.0f}–{edges[i + 1]:.0f} px" if math.isfinite(edges[i + 1]) else f"{edges[i]:.0f}+ px"
              for i in range(nd)]
    fig = make_subplots(rows=1, cols=nd, subplot_titles=titles, shared_yaxes=False, horizontal_spacing=0.025)
    for i, d in enumerate(datasets):
        prim = d.primary
        c = PALETTE[i % len(PALETTE)]
        for b in range(nd):
            sel = (prim["cell_d"] == b).to_numpy()
            if sel.sum() < 3:
                continue
            P = d.profiles[d.movs["mov"].to_numpy() == 0][sel]
            mean = P.mean(axis=0)
            sd = P.std(axis=0)
            x = np.linspace(0, 1, P.shape[1])
            fig.add_trace(go.Scatter(x=np.concatenate([x, x[::-1]]), y=np.concatenate([mean + sd, (mean - sd)[::-1]]),
                                     fill="toself", fillcolor=c, opacity=0.12, line=dict(width=0), showlegend=False,
                                     hoverinfo="skip"), row=1, col=b + 1)
            fig.add_trace(go.Scatter(x=x, y=mean, line=dict(color=c, width=2), name=d.name, showlegend=b == 0,
                                     hovertemplate=f"{d.name}<br>n={int(sel.sum())}<extra></extra>"), row=1, col=b + 1)
    fig.update_xaxes(title_text="")
    fig.update_xaxes(title_text="time / MT", row=1, col=nd // 2 + 1)
    fig.update_yaxes(title_text="speed (px/ms)", row=1, col=1)
    return _layout(fig, "Average speed profile per distance bin (mean ± SD, time normalised to the movement time)", 360)


def fig_curvature(datasets):
    fig = go.Figure()
    centers = np.arange(geometry.N_DIR) * geometry.DIR_WIDTH
    offset = 10.0
    for i, d in enumerate(datasets):
        prim = d.primary
        r = []
        for a in range(geometry.N_DIR):
            v = prim.loc[prim["cell_a"] == a, "curv_norm"]
            r.append(100 * v.mean() if len(v) else np.nan)
        r = np.array(r)
        fig.add_trace(go.Scatterpolar(r=np.append(r, r[0]) + offset, theta=np.append(centers, centers[0]),
                                      mode="lines+markers", name=d.name, line=dict(color=PALETTE[i % len(PALETTE)]),
                                      customdata=np.append(r, r[0]),
                                      hovertemplate="%{theta}°: %{customdata:.2f}% of D<extra>" + d.name + "</extra>"))
    th = np.linspace(0, 360, 73)
    fig.add_trace(go.Scatterpolar(r=np.full_like(th, offset), theta=th, mode="lines", name="straight",
                                  line=dict(color="#999", dash="dot", width=1), hoverinfo="skip"))
    ticks = np.arange(0, 2 * offset + 1, 5)
    fig.update_layout(polar=dict(angularaxis=dict(direction="clockwise", rotation=0,
                                                  tickvals=list(centers), ticktext=[f"{c:.0f}°" for c in centers]),
                                 radialaxis=dict(range=[0, 2 * offset], tickvals=list(ticks),
                                                 ticktext=[f"{t - offset:+.0f}%" for t in ticks])))
    return _layout(fig, "Path curvature by movement direction (mean signed max deviation, % of distance; "
                        "+ = bulges to the right of travel; 0° = right, 90° = down)", 480)


def _ellipse(x, y, k=2.4477):
    cov = np.cov(x, y)
    vals, vecs = np.linalg.eigh(cov)
    t = np.linspace(0, 2 * np.pi, 60)
    pts = (vecs @ np.diag(np.sqrt(np.maximum(vals, 0)) * k) @ np.vstack([np.cos(t), np.sin(t)]))
    return pts[0] + np.mean(x), pts[1] + np.mean(y)


def fig_endpoints(datasets):
    ns = geometry.N_SIZE
    fig = make_subplots(rows=1, cols=ns, subplot_titles=[f"size {s:.0f} px" for s in geometry.SIZE_CENTERS],
                        horizontal_spacing=0.04)
    for i, d in enumerate(datasets):
        prim = d.primary
        c = PALETTE[i % len(PALETTE)]
        for s in range(ns):
            g = prim[prim["cell_s"] == s]
            if len(g) < 3:
                continue
            fig.add_trace(go.Scatter(x=g["end_along"], y=g["end_across"], mode="markers", name=d.name,
                                     marker=dict(color=c, size=4, opacity=0.35), showlegend=s == 0,
                                     hovertemplate="along %{x:.1f}, across %{y:.1f}<extra></extra>"), row=1, col=s + 1)
            ex, ey = _ellipse(g["end_along"].to_numpy(), g["end_across"].to_numpy())
            fig.add_trace(go.Scatter(x=ex, y=ey, mode="lines", line=dict(color=c, width=2), showlegend=False,
                                     hoverinfo="skip"), row=1, col=s + 1)
    for s in range(ns):
        half = geometry.SIZE_CENTERS[s] / 2
        lim = max(half * 3, 12)
        fig.add_shape(type="rect", x0=-half, x1=half, y0=-half, y1=half, line=dict(color="#aaa", dash="dot"),
                      row=1, col=s + 1)
        fig.update_xaxes(range=[-lim, lim], row=1, col=s + 1)
        fig.update_yaxes(range=[-lim, lim], row=1, col=s + 1, scaleanchor=f"x{s + 1 if s else ''}")
    fig.update_xaxes(title_text="along (px, + = past centre)", row=1, col=ns // 2 + 1)
    fig.update_yaxes(title_text="across (px, + = right)", row=1, col=1)
    return _layout(fig, "Click positions relative to the target centre, by target size (95% ellipses; dotted = nominal size)", 380)


def fig_histograms(datasets):
    cols = [("rt", "reaction time (ms)", (0, 900)), ("dwell", "pause before click (ms)", (0, 600)),
            ("hold", "click hold (ms)", (0, 300))]
    fig = make_subplots(rows=1, cols=3, subplot_titles=[c[1] for c in cols])
    for i, d in enumerate(datasets):
        prim = d.primary
        for j, (col, _, rng) in enumerate(cols):
            v = prim[col].dropna()
            fig.add_trace(go.Histogram(x=v, histnorm="probability density", name=d.name, opacity=0.55,
                                       marker_color=PALETTE[i % len(PALETTE)], showlegend=j == 0,
                                       xbins=dict(start=rng[0], end=rng[1], size=(rng[1] - rng[0]) / 45)),
                          row=1, col=j + 1)
    fig.update_layout(barmode="overlay")
    return _layout(fig, "Timing distributions (primary movements)", 340)


def fig_jitter(datasets):
    fig = go.Figure()
    for i, d in enumerate(datasets):
        S = d.spectra[d.movs["mov"].to_numpy() == 0]
        S = S[~np.isnan(S).any(axis=1)]
        if len(S) == 0:
            continue
        mean = np.exp(np.mean(np.log(S + 1e-12), axis=0))
        fig.add_trace(go.Scatter(x=d.freqs, y=mean, name=d.name, line=dict(color=PALETTE[i % len(PALETTE)])))
    fig.update_xaxes(title="frequency (Hz)")
    fig.update_yaxes(title="PSD (px²/Hz)", type="log")
    return _layout(fig, "Micro-jitter spectrum during movement (raw position minus a 5 Hz low-pass; geometric mean)", 360)


def fig_misses_and_mt(datasets):
    fig = make_subplots(rows=1, cols=2, subplot_titles=["miss rate by target size", "movement time by distance bin"])
    for i, d in enumerate(datasets):
        prim = d.primary
        c = PALETTE[i % len(PALETTE)]
        rates = prim.groupby("cell_s")["miss"].mean().reindex(range(geometry.N_SIZE))
        fig.add_trace(go.Bar(x=[f"{s:.0f}" for s in geometry.SIZE_CENTERS], y=100 * rates, name=d.name,
                             marker_color=c), row=1, col=1)
        fig.add_trace(go.Box(x=prim["cell_d"], y=prim["mt"], name=d.name, marker_color=c, showlegend=False,
                             boxpoints=False), row=1, col=2)
    fig.update_yaxes(title_text="% of first clicks that miss", row=1, col=1)
    fig.update_yaxes(title_text="MT (ms)", row=1, col=2)
    fig.update_xaxes(title_text="size (px)", row=1, col=1)
    fig.update_xaxes(title_text="distance bin (0 = 20–50 px … 6 = 1600+ px)", row=1, col=2)
    fig.update_layout(barmode="group", boxmode="group")
    return _layout(fig, "Misses and movement time", 360)


def fig_coverage(trials: pd.DataFrame):
    counts = np.zeros((geometry.N_SIZE, geometry.N_DIST, geometry.N_DIR))
    for c in trials["cell_planned"].dropna():
        cell = json.loads(c) if isinstance(c, str) else c
        if cell and min(cell) >= 0:
            counts[cell[2], cell[0], cell[1]] += 1
    goal = geometry.GOAL_PER_CELL
    fig = make_subplots(rows=1, cols=geometry.N_SIZE, subplot_titles=[f"size {s:.0f} px" for s in geometry.SIZE_CENTERS],
                        horizontal_spacing=0.02)
    for s in range(geometry.N_SIZE):
        fig.add_trace(go.Heatmap(z=counts[s], zmin=0, zmax=goal, colorscale="RdYlGn", showscale=s == geometry.N_SIZE - 1,
                                 x=[f"{a * 30}°" for a in range(geometry.N_DIR)],
                                 y=[f"{geometry.DIST_EDGES[d]:.0f}" for d in range(geometry.N_DIST)],
                                 hovertemplate="dir %{x}, dist ≥ %{y}: %{z}<extra></extra>"), row=1, col=s + 1)
        fig.update_yaxes(autorange="reversed", row=1, col=s + 1, showticklabels=s == 0)
        fig.update_xaxes(tickvals=["0°", "90°", "180°", "270°"], row=1, col=s + 1)
    return _layout(fig, f"Coverage: valid training movements per cell (goal {goal})", 330)


SUMMARY_COLS = ["rt", "mt", "peak_speed", "t_peak_frac", "path_eff", "curv_norm", "n_sub", "overshoot_norm",
                "end_along_norm", "end_across_norm", "dwell", "hold", "slip", "ldlj", "jit_rms", "miss"]


def summary_table(datasets) -> str:
    rows = []
    for col in SUMMARY_COLS:
        cells = []
        for d in datasets:
            v = d.primary[col].dropna()
            if not len(v):
                cells.append("–")
            elif col == "miss":
                cells.append(f"{100 * v.mean():.1f}% <span class=dim>of first clicks</span>")
            else:
                cells.append(f"{v.median():.3g} <span class=dim>[{v.quantile(.1):.3g}, {v.quantile(.9):.3g}]</span>")
        rows.append(f"<tr><td>{col}</td>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>")
    head = "".join(f"<th>{html.escape(d.name)}</th>" for d in datasets)
    return (f"<table class=summary><tr><th>feature (primary movements)</th>{head}</tr>{''.join(rows)}</table>"
            "<p class=dim>median [10th, 90th percentile]</p>")


def _plotly_script(out_dir: Path) -> str:
    """Reports under reports/ share one plotly.min.js; reports anywhere else embed it."""
    import os

    import plotly.offline

    reports = paths.REPORTS.resolve()
    out_dir = out_dir.resolve()
    if out_dir != reports and reports not in out_dir.parents:
        return f"<script>{plotly.offline.get_plotlyjs()}</script>"
    target = reports / "plotly.min.js"
    if not target.exists():
        target.write_text(plotly.offline.get_plotlyjs(), encoding="utf-8")
    return f'<script src="{os.path.relpath(target, out_dir).replace(os.sep, "/")}"></script>'


CSS = """
body{font:14px/1.5 system-ui,'Segoe UI',sans-serif;margin:0;background:#f6f6f4;color:#222}
main{max-width:1280px;margin:0 auto;padding:24px}
h1{font-size:24px;margin:0 0 4px}.dim{color:#777}
.card{background:#fff;border-radius:8px;padding:12px 16px;margin:16px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
table.summary{border-collapse:collapse;font-variant-numeric:tabular-nums}
table.summary td,table.summary th{padding:3px 12px;border-bottom:1px solid #eee;text-align:left}
.kv{display:flex;gap:28px;flex-wrap:wrap}.kv div b{display:block;font-size:20px}
"""


def render(datasets, out: Path, title: str, intro_html: str = "", trials: pd.DataFrame | None = None) -> Path:
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    figs = [fig_fitts(datasets), fig_speed_profiles(datasets), fig_curvature(datasets), fig_endpoints(datasets),
            fig_histograms(datasets), fig_jitter(datasets), fig_misses_and_mt(datasets)]
    if trials is not None and "cell_planned" in trials:
        figs.append(fig_coverage(trials))
    parts = [f.to_html(full_html=False, include_plotlyjs=False, config={"displaylogo": False}) for f in figs]
    script = _plotly_script(out.parent)
    page = f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1"><title>{html.escape(title)}</title>
<style>{CSS}</style>{script}</head><body><main>
<h1>{html.escape(title)}</h1><p class=dim>generated {datetime.now():%Y-%m-%d %H:%M}</p>
{intro_html}<div class=card>{summary_table(datasets)}</div>
{''.join(f'<div class=card>{p}</div>' for p in parts)}
</main></body></html>"""
    out.write_text(page, encoding="utf-8")
    return out


def fingerprint_report(root, out=None) -> Path:
    ds = Dataset(root)
    data = [FingerprintData.from_dataset(ds, "owner (all usable sessions)")]
    f = ds.fitts
    n_sess = sum(1 for s in ds.sessions if s.get("used"))
    by_role = ds.trials.groupby("role")["session_id"].nunique().to_dict()
    usable = ds.usable_trials()
    intro = f"""<div class="card kv">
<div><b>{n_sess}</b>sessions ({', '.join(f'{v} {k}' for k, v in sorted(by_role.items()))})</div>
<div><b>{len(usable):,}</b>usable trials (of {len(ds.trials):,}; warm-up and rejected left out)</div>
<div><b>{len(data[0].movs):,}</b>movements ({int((data[0].movs['mov'] > 0).sum())} after a miss)</div>
<div><b>{f.get('a', float('nan')):.0f} + {f.get('b', float('nan')):.0f}·IDe</b>Fitts fit on training data (R² {f.get('r2', float('nan')):.2f})</div>
<div><b>{f.get('throughput_bits_per_s', float('nan')):.1f} bit/s</b>throughput</div></div>"""
    train_trials = ds.trials[(ds.trials["role"] == "train") & ~ds.trials["rejected"] & ~ds.trials["warmup"]]
    out = Path(out) if out else paths.REPORTS / "fingerprint.html"
    return render(data, out, "Mouse movement fingerprint", intro, train_trials)
