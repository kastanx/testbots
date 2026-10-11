"""python -m server [--port 8765] [--host 127.0.0.1] [--data DIR] [--preload]"""
import argparse

import uvicorn
from fastapi import HTTPException

from .app import create_app


def main():
    ap = argparse.ArgumentParser(description="mouse-sim local server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1",
                    help="address to listen on (default: this PC only; 0.0.0.0 = reachable from the network)")
    ap.add_argument("--data", help="data root (default: mouse-sim/data or $MOUSESIM_DATA)")
    ap.add_argument("--bundle", help="simulator bundle directory (default: models/export)")
    ap.add_argument("--reports", help="reports directory (default: reports)")
    ap.add_argument("--preload", action="store_true",
                    help="load the default model before serving, so the first /api/generate is fast")
    args = ap.parse_args()
    app = create_app(args.data, bundle_dir=args.bundle, reports_dir=args.reports)
    if args.preload:
        try:
            name = app.state.generator.preload()
            print(f"mouse-sim: model {name} loaded", flush=True)
        except HTTPException as e:
            print(f"mouse-sim: no model loaded: {e.detail}", flush=True)
    everywhere = args.host in ("0.0.0.0", "::")
    shown = "localhost" if everywhere or args.host == "127.0.0.1" else args.host
    print(f"mouse-sim: http://{shown}:{args.port}/   (data: {app.state.root})"
          + ("   also reachable from other machines" if everywhere else ""), flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
