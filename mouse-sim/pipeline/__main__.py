"""python -m pipeline {validate,process,report,all} [--data DIR]"""
from __future__ import annotations

import argparse
import sys

from . import paths, rawio
from .validate import validate


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    ap = argparse.ArgumentParser(prog="python -m pipeline")
    ap.add_argument("command", choices=["validate", "process", "report", "all"])
    ap.add_argument("--data", help="data root (default: mouse-sim/data or $MOUSESIM_DATA)")
    ap.add_argument("--allow-failures", action="store_true",
                    help="process sessions that fail validation anyway (exploration only)")
    ap.add_argument("--out", help="report output file (default: reports/fingerprint.html)")
    args = ap.parse_args(argv)
    root = paths.data_root(args.data)

    if args.command == "validate":
        bad = 0
        for d in rawio.session_dirs(root):
            rep = validate(rawio.load_session(d))
            s = rep["stats"]
            print(f"{'ok  ' if rep['ok'] else 'FAIL'}  {rep['session_id']}  {s['trials']:4d} trials  "
                  f"{s['event_rate_hz']:6.0f} Hz  gaps {s['gap_share']:.2%}  whole px {s['whole_pixel_share']:.1%}")
            for e in rep["errors"]:
                print(f"        error: {e}")
            for w in rep["warnings"]:
                print(f"        warning: {w}")
            bad += not rep["ok"]
        return 1 if bad else 0

    if args.command in ("process", "all"):
        from .process import process
        summary = process(root, allow_failures=args.allow_failures)
        if summary["failed"] and not args.allow_failures:
            print("Some sessions failed validation (see above). Fix the cause or re-run with --allow-failures.")
            if args.command == "process":
                return 1

    if args.command in ("report", "all"):
        from .report import fingerprint_report
        out = fingerprint_report(root, args.out)
        print(f"report: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
