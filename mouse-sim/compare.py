"""Start the compare page from any working directory: python mouse-sim/compare.py [--port 8771] [--open]
(tools/compare.py has the details)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tools.compare import main  # noqa: E402

if __name__ == "__main__":
    main()
