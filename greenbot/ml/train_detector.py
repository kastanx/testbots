"""Train the YOLO11n clickable detector and deploy it to server/models/.

Detection uses yolo11n.pt, NOT the -cls variant the location classifier uses,
and imgsz 640 - drop that to 480 only if request latency ever demands it.

Default augmentation is right for detection, with one exception: --fliplr
defaults to 0.0. The plan says a horizontal flip is acceptable for detection
(unlike the location classifier, where mirroring collapses left/right-symmetric
spots into each other) *unless* left/right context is part of what makes
something clickable - and to use fliplr=0 if in doubt. Nothing has proven that
context irrelevant here, so 0.0 is the default. Pass --fliplr 0.5 once you have
a validated baseline to compare against.

    python ml/train_detector.py
    python ml/train_detector.py --epochs 100 --fliplr 0.5
"""
import argparse
import shutil
import sys
from pathlib import Path

ML = Path(__file__).resolve().parent
ROOT = ML.parent
DATA = ML / "dataset-detect"
DEPLOY = ROOT / "server" / "models" / "clickable_det.pt"


def resolve_base(model):
    """Find the pretrained weights without letting ultralytics scatter them.

    Left alone, ultralytics downloads the base .pt into whatever the current
    directory happens to be, so you end up with copies wherever you launched
    from. The project keeps one copy next to the repo root.
    """
    base = Path(model)
    if base.exists():
        return str(base)
    beside = ROOT / base.name
    if beside.exists():
        return str(beside)
    if base.suffix == ".pt":
        from ultralytics.utils.downloads import attempt_download_asset

        print(f"base weights not on disk, fetching -> {beside}")
        attempt_download_asset(str(beside))
        return str(beside)
    return model      # a .yaml: ultralytics resolves it from its own cfg dir


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="yolo11n.pt",
                    help="detection base weights (NOT the -cls variant)")
    ap.add_argument("--data", default=str(DATA / "data.yaml"))
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--device", default="0")
    ap.add_argument("--name", default="greenbot-det")
    ap.add_argument("--fliplr", type=float, default=0.0,
                    help="horizontal flip probability - see the module docstring "
                         "for why this defaults to 0 and not to ultralytics' 0.5")
    ap.add_argument("--no-deploy", action="store_true",
                    help="skip copying best.pt to server/models/clickable_det.pt")
    args = ap.parse_args()

    data = Path(args.data).resolve()
    if not data.exists():
        sys.exit(f"missing {data} - run ml/prepare_detect_dataset.py first")
    for split in ("train", "val"):
        d = data.parent / "images" / split
        if not d.exists() or not any(d.glob("*.jpg")):
            sys.exit(f"no images in {d} - run ml/prepare_detect_dataset.py first")

    import torch
    from ultralytics import YOLO

    if args.device != "cpu" and not torch.cuda.is_available():
        sys.exit("CUDA not available - install the cu124 torch build (see setup.ps1), "
                 "or pass --device cpu to train slowly on the CPU")
    if torch.cuda.is_available():
        print(f"device: {torch.cuda.get_device_name(0)}")

    model = YOLO(resolve_base(args.model))
    model.train(
        data=str(data),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        project=str(ROOT / "runs" / "detect"),
        name=args.name,
        exist_ok=False,
        fliplr=args.fliplr,
        patience=15,
    )

    save_dir = Path(model.trainer.save_dir)
    best = save_dir / "weights" / "best.pt"
    print(f"\nrun:              {save_dir}")
    print(f"PR curve:         {save_dir / 'PR_curve.png'}")

    if not args.no_deploy and best.exists():
        DEPLOY.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(best, DEPLOY)
        print(f"deployed:         {DEPLOY}")

    print("\nNext: python ml/evaluate_detector.py")


if __name__ == "__main__":
    main()
