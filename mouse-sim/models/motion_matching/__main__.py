"""python -m models.motion_matching tune [--data DIR] [--write]"""
import argparse
import sys


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    ap = argparse.ArgumentParser(prog="python -m models.motion_matching")
    ap.add_argument("command", choices=["tune"])
    ap.add_argument("--data", help="data root (default: mouse-sim/data or $MOUSESIM_DATA)")
    ap.add_argument("--write", action="store_true", help="store the best setting in config/motion_matching.json")
    ap.add_argument("--reports", help="where the tuning report goes (default: mouse-sim/reports)")
    args = ap.parse_args(argv)
    from .tune import tune
    tune(args.data, write=args.write, reports_dir=args.reports)
    return 0


if __name__ == "__main__":
    sys.exit(main())
