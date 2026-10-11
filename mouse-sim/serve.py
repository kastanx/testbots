"""Start the local server from any working directory: python mouse-sim/serve.py [--port N] [--data DIR]"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from server.__main__ import main  # noqa: E402

if __name__ == "__main__":
    main()
