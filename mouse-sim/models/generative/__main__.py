"""python -m models.generative train [--data DIR] [--steps N] [--batch N] [--session-embedding 8]
python -m models.generative tune [--run DIR] [--write]   post-processing, on validation sessions
python -m models.generative export [--run DIR]      ONNX + sampler settings for the simulator
"""
import argparse
import sys


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    ap = argparse.ArgumentParser(prog="python -m models.generative", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["train", "tune", "export"])
    ap.add_argument("--write", action="store_true", help="tune: store the best setting in config/generative.json")
    ap.add_argument("--data", help="data root (default: mouse-sim/data or $MOUSESIM_DATA)")
    ap.add_argument("--steps", type=int, default=30000)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--base", type=int, default=32, help="U-Net base width")
    ap.add_argument("--out-dir", help="run directory (default: models/generative/runs/<timestamp>)")
    ap.add_argument("--session-embedding", type=int, default=0, help="per-session embedding size (0 = off)")
    ap.add_argument("--run", help="run directory (default: the latest)")
    ap.add_argument("--out", help="export directory (default: models/export/gen)")
    args = ap.parse_args(argv)
    if args.command == "train":
        from .train import train
        from pathlib import Path
        train(args.data, steps=args.steps, batch=args.batch, lr=args.lr, base=args.base,
              session_embedding=args.session_embedding, out_dir=Path(args.out_dir) if args.out_dir else None)
    elif args.command == "tune":
        from .tune import tune
        tune(args.data, args.run, write=args.write)
    else:
        from .export_onnx import export
        export(args.run, args.out, args.data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
