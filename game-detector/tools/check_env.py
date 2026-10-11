"""Phase 0: is this machine ready? GPU, PyTorch, Ultralytics, capture, DPI.

    python -m tools.check_env
"""

from __future__ import annotations

import ctypes
import platform
import sys

from detector.common import make_dpi_aware


def main() -> int:
    make_dpi_aware()
    ok = True
    print(f"python       {sys.version.split()[0]}  ({platform.platform()})")

    import torch

    cuda = torch.cuda.is_available()
    gpu = ""
    if cuda:
        props = torch.cuda.get_device_properties(0)
        gpu = f"  {props.name}, {props.total_memory / 2**30:.1f} GB"
    print(f"torch        {torch.__version__}  cuda={cuda}{gpu}")
    ok &= cuda

    import cv2
    import numpy
    import ultralytics

    print(f"ultralytics  {ultralytics.__version__}   opencv {cv2.__version__}   numpy {numpy.__version__}")
    try:
        import tensorrt

        print(f"tensorrt     {tensorrt.__version__}")
    except ImportError:
        print("tensorrt     not installed (the first `format=engine` export installs it)")

    import dxcam

    from detector.capture import primary_monitor, virtual_screen

    user32 = ctypes.windll.user32
    scaling = round(user32.GetDpiForSystem() * 100 / 96)
    awareness = user32.GetAwarenessFromDpiAwarenessContext(user32.GetThreadDpiAwarenessContext())
    aware = {0: "unaware", 1: "system", 2: "per-monitor"}.get(awareness, str(awareness))
    print(f"screen       primary {primary_monitor()}  virtual {virtual_screen()}  scaling {scaling}%  "
          f"dpi-awareness={aware}")
    ok &= awareness == 2
    print("dxcam        " + dxcam.output_info().strip().replace("\n", "\n             "))

    print()
    ultralytics.checks()
    print("\nREADY" if ok else "\nNOT READY: see above")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
