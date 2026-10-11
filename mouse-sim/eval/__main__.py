"""python -m eval run --model <name> [--data DIR] [--limit N] [--no-cnn] [--role test|val]
python -m eval quicklook [--model mm --model minjerk]   first look before there are test sessions
python -m eval blind [--data DIR]          score saved blind tests

Model names: line, minjerk, bezier, mm, gen[:checkpoint], hybrid[:checkpoint] (see models/registry.py).
"""
from __future__ import annotations

import argparse
import json
import sys

from pipeline import paths


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    ap = argparse.ArgumentParser(prog="python -m eval", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["run", "quicklook", "blind"])
    ap.add_argument("--model", action="append", help="model to score (repeatable)")
    ap.add_argument("--data", help="data root (default: mouse-sim/data or $MOUSESIM_DATA)")
    ap.add_argument("--role", default="test", help="score on test (default) or val sessions")
    ap.add_argument("--limit", type=int, help="score on a random subset of this many trials")
    ap.add_argument("--no-cnn", action="store_true", help="skip the CNN classifier (faster)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--reports", help="where reports and the leaderboard go (default: mouse-sim/reports)")
    args = ap.parse_args(argv)
    root = paths.data_root(args.data)

    if args.command == "blind":
        from .blind import score
        d = paths.blindtest_dir(root)
        for f in sorted(d.glob("*.json")) if d.is_dir() else []:
            s = score(json.loads(f.read_text()))
            print(f"{f.name}: {s['model']}: {s['correct']}/{s['n']} correct, p = {s['p_value']:.3f} -> "
                  f"{'PASS' if s['pass'] else ('incomplete' if not s['complete'] else 'FAIL')}")
        return 0

    if args.command == "quicklook":
        from .quicklook import quicklook
        quicklook(root, args.model or ["mm", "minjerk"], use_cnn=not args.no_cnn)
        return 0

    from .harness import run
    for spec in args.model or ["line", "minjerk", "bezier"]:
        print(f"== {spec}")
        run(spec, root, limit=args.limit, seed=args.seed, use_cnn=not args.no_cnn, role=args.role,
            reports_dir=args.reports)
    return 0


if __name__ == "__main__":
    sys.exit(main())
