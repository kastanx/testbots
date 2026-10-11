"""reports/leaderboard.md (and .json): one row per harness run."""
from __future__ import annotations

import json
from pathlib import Path

from pipeline import paths


def _fmt(v, nd=2):
    try:
        return f"{float(v):.{nd}f}"
    except (TypeError, ValueError):
        return "–"


def update(entry: dict, reports: Path | None = None) -> Path:
    reports = Path(reports or paths.REPORTS)
    reports.mkdir(parents=True, exist_ok=True)
    jf = reports / "leaderboard.json"
    rows = json.loads(jf.read_text()) if jf.exists() else []
    rows.append(entry)
    jf.write_text(json.dumps(rows, indent=2, default=float))
    lines = [
        "# Leaderboard",
        "",
        "Every harness run on held-out test sessions (`python -m eval run --model ...`). "
        "Ratio = W1(model, test) / W1(owner's other sessions, test) per feature; the model passes when every key "
        "feature is at most 1.25, the classifier AUC is within 0.05 of the drift floor, and the blind test "
        "has 58 or fewer correct out of 100.",
        "",
        "| date | data | model | n test | worst key feature (ratio) | features ≤ 1.25 | C2ST AUC | drift floor | blind | pass |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in reversed(rows):
        lines.append(
            f"| {r['date']} | {r.get('data', '')} | {r['model']} | {r['n_test']} | "
            f"{r.get('worst_feature', '–')} ({_fmt(r.get('worst_ratio'))}) | {r.get('n_pass', '–')}/{r.get('n_features', '–')} | "
            f"{_fmt(r.get('auc'))} | {_fmt(r.get('auc_floor'))} | {r.get('blind', '–')} | {'yes' if r.get('pass') else 'no'} |")
    md = reports / "leaderboard.md"
    md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return md
