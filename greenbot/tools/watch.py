"""Poll /analyze/screen while you play and print what the service sees.

Alt-tab into the game and watch this. One line per poll: where it thinks you
are, how many green boxes it found, and the screen coordinate it would hand a
consumer to click. Nothing is clicked.

    python tools/watch.py
    python tools/watch.py --hz 5 --url http://127.0.0.1:8765

Ctrl+C to stop. A summary of how often each location came up is printed at the end.
"""
import argparse
import sys
import time
from collections import Counter

import requests


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8765")
    ap.add_argument("--hz", type=float, default=3.0, help="polls per second")
    ap.add_argument("--timeout", type=float, default=10.0)
    args = ap.parse_args()

    url = args.url.rstrip("/") + "/analyze/screen"
    session = requests.Session()
    period = 1.0 / max(0.1, args.hz)

    try:
        session.get(args.url.rstrip("/") + "/health", timeout=args.timeout)
    except requests.RequestException as err:
        sys.exit(f"no server at {args.url} ({err}).\n"
                 f"Start it with:  run.bat server\\main.py")

    print(f"polling {url} at {args.hz:g} Hz - Ctrl+C to stop\n")
    print(f"{'location':<10} {'conf':>6} {'boxes':>6}  {'target (screen px)':<22} {'ms':>6}")
    print("-" * 60)

    seen = Counter()
    no_target = 0
    polls = 0
    try:
        while True:
            t0 = time.perf_counter()
            try:
                r = session.get(url, timeout=args.timeout)
                r.raise_for_status()
                p = r.json()
            except requests.RequestException as err:
                print(f"  request failed: {err}")
                time.sleep(period)
                continue

            polls += 1
            loc = p["location"]
            seen[loc["id"]] += 1
            target = p.get("target")
            if target:
                where = f"({target['cx']}, {target['cy']})  {target['w']}x{target['h']}"
            else:
                where = "-"
                no_target += 1

            print(f"{loc['id']:<10} {loc['confidence']:>6.3f} "
                  f"{len(p['clickables']):>6}  {where:<22} {p['timing_ms']['total']:>6.1f}")

            slept = period - (time.perf_counter() - t0)
            if slept > 0:
                time.sleep(slept)
    except KeyboardInterrupt:
        pass

    print("\n" + "-" * 60)
    if not polls:
        return
    print(f"{polls} polls")
    for name, n in seen.most_common():
        print(f"  {name:<10} {n:>5}  ({100 * n / polls:.0f}%)")
    print(f"  no target  {no_target:>5}  ({100 * no_target / polls:.0f}%)")


if __name__ == "__main__":
    main()
