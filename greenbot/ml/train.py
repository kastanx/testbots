"""Train the YOLO11n-cls localizer and deploy the winner to server/models/.

Lands at server/models/location_cls.pt, which is the path server/config.yaml
points at (relative to the config file, not to the CWD).

    python ml/train.py
    python ml/train.py --imgsz 320 --epochs 80        # if two spots stay confused
"""
import argparse
import shutil
import sys
from pathlib import Path

ML = Path(__file__).resolve().parent
ROOT = ML.parent
DATA = ML / "dataset"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="yolo11n-cls.pt")
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--imgsz", type=int, default=224)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--device", default="0")
    ap.add_argument("--name", default="greenbot")
    ap.add_argument("--no-deploy", action="store_true",
                    help="skip copying best.pt to server/models/location_cls.pt")
    args = ap.parse_args()

    for split in ("train", "val"):
        if not (DATA / split).exists():
            sys.exit(f"missing {DATA / split} - run ml/prepare_dataset.py first")

    import torch
    from ultralytics import YOLO

    if args.device != "cpu" and not torch.cuda.is_available():
        sys.exit("CUDA not available - install the cu124 torch build (see setup.ps1), "
                 "or pass --device cpu to train slowly on the CPU")
    if torch.cuda.is_available():
        print(f"device: {torch.cuda.get_device_name(0)}")

    # The base weights sit next to this project; without this, ultralytics
    # re-downloads them into whatever the current directory happens to be.
    base = args.model
    if not Path(base).exists() and (ROOT / base).exists():
        base = str(ROOT / base)

    model = YOLO(base)
    model.train(
        data=str(DATA),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        project=str(ROOT / "runs" / "classify"),
        name=args.name,
        exist_ok=False,
        # Mirroring would collapse left/right-symmetric spots into each other.
        fliplr=0.0,
        flipud=0.0,
        # Erasing stays on: it stands in for players occluding the scene.
        erasing=0.4,
        degrees=0.0,
        patience=15,
    )

    save_dir = Path(model.trainer.save_dir)
    best = save_dir / "weights" / "best.pt"
    print(f"\nrun:              {save_dir}")
    print(f"confusion matrix: {save_dir / 'confusion_matrix_normalized.png'}")

    if not args.no_deploy and best.exists():
        dst = ROOT / "server" / "models" / "location_cls.pt"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(best, dst)
        print(f"deployed:         {dst}")

    print("\nNext: python ml/evaluate.py")


if __name__ == "__main__":
    main()
