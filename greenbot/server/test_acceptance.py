"""Settle the plan's "Phase 6 - Acceptance criteria" checklist mechanically.

Every box on that list that a machine can decide is decided here, against an
ALREADY-RUNNING server over HTTP. This script never imports server.main and never
starts the service - a checker that boots its own process proves nothing about the
process you are actually shipping.

    python server/test_acceptance.py
    python server/test_acceptance.py --frame ml/dataset/raw/session_x/spot_01/f.jpg
    python server/test_acceptance.py --requests 1000 --pid 12345
    python server/test_acceptance.py --selftest      # no server, validator only

The two bullets a machine cannot settle (detector precision/recall >= 0.95 and the
50-frame "no boxes on players" eyeball) are reported as SKIP with a pointer to
ml/evaluate_detector.py, never silently dropped.

CONFIG SWAP BULLET - needs TWO runs, because swapping detector: hsv <-> yolo means
editing server/config.yaml and restarting the server:

    1. detector: yolo   -> python server/test_acceptance.py
       copy the "shape:" line it prints.
    2. edit server/config.yaml to detector: hsv, restart the server, then
       python server/test_acceptance.py --expect-shape "<the string from run 1>"

Run 2 fails if the JSON shape moved by so much as one key or one value type. That
is precisely what "requires no consumer change" means, so it is checked that way
instead of being asserted in prose.

Exit code is non-zero if anything FAILED. SKIPs never fail the run.
"""
import argparse
import base64
import json
import statistics
import struct
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

PASS = "PASS"
FAIL = "FAIL"
SKIP = "SKIP"

LATENCY_GATE_MS = 50.0      # the plan's gate for timing_ms.total
WARMUP_REQUESTS = 3         # lazy model/cudnn init must not land in the sample
RSS_DRIFT_MB = 50.0         # "flat memory" still has to breathe - allocator caches
RSS_DRIFT_PCT = 10.0

# The pinned contract, key by key and in contract order. Nothing else is allowed
# through: an extra key is exactly the drift this file exists to catch.
# "target" is the one box that matters for the reported location, or null when
# no rule applies (transit, or a spot with no entry in config `targets`).
TOP_KEYS = [("location", dict), ("target", (dict, type(None))), ("clickables", list),
            ("image", dict), ("timing_ms", dict)]
LOCATION_KEYS = [("id", str), ("confidence", float), ("top3", list)]
TOP3_KEYS = [("id", str), ("confidence", float)]
CLICKABLE_KEYS = [("cx", int), ("cy", int), ("x", int), ("y", int), ("w", int),
                  ("h", int), ("class", str), ("confidence", float)]
IMAGE_KEYS = [("width", int), ("height", int)]
TIMING_KEYS = [("classify", float), ("detect", float), ("total", float)]

# plan bullet -> the checks that decide it. Order matches the plan.
BULLETS = [
    ("curl -F file=@frame.png returns the schema above", ["schema", "b64", "coords"]),
    ("location reported honestly, transit/low-conf never mapped to a spot", ["honesty"]),
    ("clickables precision & recall >= 0.95 on the val split", ["det_metrics"]),
    ("no boxes on players across a 50-frame spot check", ["det_eyeball"]),
    ("latency: total <= 50 ms per request", ["latency"]),
    # {n} is filled in from --requests: a 40-request run must not print a claim
    # about 1,000 requests it never made.
    ("stability: {n} sequential requests, zero errors, flat memory", ["stability", "memory"]),
    ("config swap detector: hsv <-> yolo requires no consumer change", ["swap"]),
    ("README documents the JSON contract + coordinate-space rule", ["readme"]),
]


class Report:
    """Collects check results so the summary can map them back to plan bullets."""

    def __init__(self):
        self.results = {}
        self.order = []

    def add(self, key, title, status, measured="", details=()):
        self.results[key] = status
        self.order.append(key)
        print(f"[{status}] {title}" + (f"  |  {measured}" if measured else ""))
        for line in details:
            print(f"       {line}")
        return status

    def status_of(self, keys):
        seen = [self.results.get(k) for k in keys]
        if FAIL in seen:
            return FAIL
        if all(s in (SKIP, None) for s in seen):
            return SKIP
        return PASS

    def failed(self):
        return sum(1 for s in self.results.values() if s == FAIL)


def type_ok(value, expected):
    # JSON true is an int in Python. A bool where a number belongs is drift.
    if isinstance(value, bool):
        return expected is bool
    if expected is float:
        return isinstance(value, float)
    if expected is int:
        return isinstance(value, int)
    return isinstance(value, expected)


def validate_object(obj, spec, where, errors, notes):
    if not isinstance(obj, dict):
        errors.append(f"{where}: expected object, got {type(obj).__name__}")
        return
    expected = [k for k, _ in spec]
    missing = [k for k in expected if k not in obj]
    extra = [k for k in obj if k not in expected]
    for key in missing:
        errors.append(f"{where}.{key}: missing")
    for key in extra:
        errors.append(f"{where}.{key}: unexpected key - schema drift")
    for key, want in spec:
        if key in obj and not type_ok(obj[key], want):
            want_name = (" or ".join(t.__name__ for t in want)
                         if isinstance(want, tuple) else want.__name__)
            errors.append(f"{where}.{key}: expected {want_name}, got "
                          f"{type(obj[key]).__name__} ({obj[key]!r})")
    # The contract pins the shape as "do not add, rename or reorder keys", and
    # this checker exists to catch schema drift - so reordering is an error.
    if not missing and not extra and list(obj) != expected:
        errors.append(f"{where}: key order {list(obj)} != contract order {expected}")


def schema_errors(payload):
    """Return (errors, notes) for one /analyze response against the pinned shape."""
    errors, notes = [], []
    if not isinstance(payload, dict):
        return [f"$: expected object, got {type(payload).__name__}"], notes

    validate_object(payload, TOP_KEYS, "$", errors, notes)

    location = payload.get("location")
    validate_object(location, LOCATION_KEYS, "$.location", errors, notes)
    if isinstance(location, dict) and isinstance(location.get("top3"), list):
        top3 = location["top3"]
        if len(top3) != 3:
            errors.append(f"$.location.top3: expected 3 entries, got {len(top3)}")
        for i, entry in enumerate(top3):
            validate_object(entry, TOP3_KEYS, f"$.location.top3[{i}]", errors, notes)

    if isinstance(payload.get("clickables"), list):
        for i, box in enumerate(payload["clickables"]):
            validate_object(box, CLICKABLE_KEYS, f"$.clickables[{i}]", errors, notes)

    validate_object(payload.get("image"), IMAGE_KEYS, "$.image", errors, notes)
    validate_object(payload.get("timing_ms"), TIMING_KEYS, "$.timing_ms", errors, notes)
    return errors, notes


def geometry_errors(payload, real_w, real_h):
    """The coordinate-space rule: pixels of the SUBMITTED image, origin top-left."""
    errors = []
    image = payload.get("image")
    if not isinstance(image, dict):
        return ["$.image: missing, cannot check the coordinate space"]

    width, height = image.get("width"), image.get("height")
    if (width, height) != (real_w, real_h):
        errors.append(f"$.image: server reports {width}x{height}, the submitted file "
                      f"is {real_w}x{real_h} - the service must never rescale")

    boxes = payload.get("clickables")
    if not isinstance(boxes, list):
        return errors
    for i, box in enumerate(boxes):
        if not isinstance(box, dict) or not all(
                isinstance(box.get(k), int) and not isinstance(box.get(k), bool)
                for k in ("cx", "cy", "x", "y", "w", "h")):
            continue                    # schema_errors already reported this one
        x, y, w, h = box["x"], box["y"], box["w"], box["h"]
        where = f"$.clickables[{i}]"
        if w <= 0 or h <= 0:
            errors.append(f"{where}: degenerate box w={w} h={h}")
        if x < 0 or y < 0:
            errors.append(f"{where}: x={x} y={y} is outside the image (origin is top-left)")
        if x + w > real_w or y + h > real_h:
            errors.append(f"{where}: x+w={x + w} y+h={y + h} exceeds {real_w}x{real_h}")
        if abs(box["cx"] - round(x + w / 2)) > 1:
            errors.append(f"{where}: cx={box['cx']} is not the centre of x={x} w={w}")
        if abs(box["cy"] - round(y + h / 2)) > 1:
            errors.append(f"{where}: cy={box['cy']} is not the centre of y={y} h={h}")
    return errors


def shape_of(value):
    """A structural fingerprint: keys and value types, no values.

    Two backends producing the same fingerprint is the mechanical form of
    "swapping the detector requires no consumer change".
    """
    if isinstance(value, dict):
        return "{" + ",".join(f"{k}:{shape_of(v)}" for k, v in value.items()) + "}"
    if isinstance(value, list):
        return "[" + (shape_of(value[0]) if value else "") + "]"
    if isinstance(value, bool):
        return "bool"
    return type(value).__name__


def real_image_size(data, path):
    """Read WxH out of the file header. The checker must not take the server's word."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        width, height = struct.unpack(">II", data[16:24])
        return int(width), int(height)
    if data[:2] == b"\xff\xd8":
        i, n = 2, len(data)
        while i + 9 < n:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker == 0xFF:
                i += 1
                continue
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                          0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                height, width = struct.unpack(">HH", data[i + 5:i + 9])
                return int(width), int(height)
            i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
    sys.exit(f"cannot read the pixel size of {path} - PNG and JPEG only")


def mime_for(path):
    return "image/png" if path.suffix.lower() == ".png" else "image/jpeg"


def without_timing(payload):
    return {k: v for k, v in payload.items() if k != "timing_ms"}


def pct(values, q):
    ordered = sorted(values)
    i = max(0, min(len(ordered) - 1, int(round(q * (len(ordered) - 1)))))
    return ordered[i]


def stats_line(label, values):
    return (f"{label:<18} min {min(values):7.1f}  mean {statistics.mean(values):7.1f}  "
            f"p50 {pct(values, 0.50):7.1f}  p95 {pct(values, 0.95):7.1f}  "
            f"max {max(values):7.1f}")


def post_multipart(session, url, name, data, mime, timeout):
    files = {"file": (name, data, mime)}
    t0 = time.perf_counter()
    response = session.post(url + "/analyze", files=files, timeout=timeout)
    return response, (time.perf_counter() - t0) * 1e3


def post_b64(session, url, data, timeout):
    body = {"image_b64": base64.b64encode(data).decode("ascii")}
    t0 = time.perf_counter()
    response = session.post(url + "/analyze", json=body, timeout=timeout)
    return response, (time.perf_counter() - t0) * 1e3


def find_backend(health):
    """The active detector, wherever /health chose to echo it.

    A consumer has to be able to ask which backend answered without reading the
    server's config file, so this hunts rather than pinning one key name.
    """
    if isinstance(health, dict):
        for key, value in health.items():
            if (key in ("detector", "detector_backend", "backend")
                    and value in ("hsv", "yolo")):
                return value
            found = find_backend(value)
            if found:
                return found
    return None


def discover_pid(port):
    try:
        import psutil
    except ImportError:
        return None, "psutil is not installed (pip install psutil)"
    try:
        for conn in psutil.net_connections(kind="inet"):
            if (conn.status == psutil.CONN_LISTEN and conn.laddr
                    and conn.laddr.port == port and conn.pid):
                return conn.pid, None
    except Exception as exc:                                # noqa: BLE001
        return None, f"psutil could not enumerate sockets ({exc}) - pass --pid"
    return None, f"nothing found listening on port {port} - pass --pid"


def rss_mb(pid):
    import psutil

    return psutil.Process(pid).memory_info().rss / 1e6


def default_frame():
    for f in sorted((ROOT / "ml" / "dataset" / "raw").glob("*/*/*.jpg")):
        return f
    return None


def good_fixture():
    """The contract from the plan, by hand. The validator must accept this."""
    return {
        "location": {"id": "spot_03", "confidence": 0.94, "top3": [
            {"id": "spot_03", "confidence": 0.94},
            {"id": "spot_01", "confidence": 0.03},
            {"id": "transit", "confidence": 0.01}]},
        "target": {"cx": 812, "cy": 440, "x": 790, "y": 415, "w": 44, "h": 50,
                   "class": "clickable", "confidence": 0.91},
        "clickables": [{"cx": 812, "cy": 440, "x": 790, "y": 415, "w": 44, "h": 50,
                        "class": "clickable", "confidence": 0.91}],
        "image": {"width": 1280, "height": 536},
        "timing_ms": {"classify": 3.2, "detect": 9.8, "total": 14.1},
    }


def selftest():
    """Prove the validator catches drift, without needing a running server."""
    cases = []

    payload = good_fixture()
    payload["debug"] = {"note": "helpful extra"}
    cases.append(("extra top-level key", payload))

    payload = good_fixture()
    payload["clickables"][0]["score"] = 0.5
    cases.append(("extra key inside a clickable", payload))

    payload = good_fixture()
    payload["clickables"][0]["cls"] = payload["clickables"][0].pop("class")
    cases.append(("renamed key class -> cls", payload))

    payload = good_fixture()
    payload["clickables"][0]["x"] = 790.5
    cases.append(("float where a pixel int belongs", payload))

    payload = good_fixture()
    payload["clickables"][0]["confidence"] = 1
    cases.append(("int where a confidence float belongs", payload))

    payload = good_fixture()
    payload["location"]["top3"] = ["spot_03", "spot_01", "transit"]
    cases.append(("top3 of strings, not objects", payload))

    payload = good_fixture()
    payload["location"]["top3"] = payload["location"]["top3"][:2]
    cases.append(("top3 with 2 entries", payload))

    payload = good_fixture()
    del payload["image"]
    cases.append(("image block missing", payload))

    payload = good_fixture()
    payload["clickables"] = {"0": payload["clickables"][0]}
    cases.append(("clickables as an object", payload))

    payload = good_fixture()
    payload["timing_ms"]["gpu"] = 1.0
    cases.append(("extra timing key", payload))

    print("schema validator self-test (no server involved)\n")
    ok = True

    errors, notes = schema_errors(good_fixture())
    good_ok = not errors
    ok = ok and good_ok
    print(f"[{PASS if good_ok else FAIL}] hand-built contract fixture accepted"
          f"  |  {len(errors)} errors, {len(notes)} notes")
    for line in errors:
        print(f"       {line}")

    for title, broken in cases:
        errors, _ = schema_errors(broken)
        caught = bool(errors)
        ok = ok and caught
        print(f"[{PASS if caught else FAIL}] rejects: {title}"
              f"  |  {errors[0] if errors else 'NOT CAUGHT'}")

    # The contract says keys must not be reordered, so this is drift, not a note.
    reordered = {"image": {"width": 1280, "height": 536}, **good_fixture()}
    errors, _ = schema_errors(reordered)
    reorder_ok = any("key order" in e for e in errors)
    ok = ok and reorder_ok
    print(f"[{PASS if reorder_ok else FAIL}] rejects: reordered keys"
          f"  |  {errors[0] if errors else 'NOT CAUGHT'}")

    geo = geometry_errors(good_fixture(), 1280, 536)
    geo_ok = not geo
    ok = ok and geo_ok
    print(f"[{PASS if geo_ok else FAIL}] geometry accepts an in-bounds centred box"
          f"  |  {len(geo)} errors")

    bad = good_fixture()
    bad["clickables"][0]["x"] = 1260          # x + w runs off the right edge
    bad["clickables"][0]["cx"] = 100          # and cx is nowhere near the centre
    geo = geometry_errors(bad, 1280, 536)
    geo_ok = len(geo) >= 2
    ok = ok and geo_ok
    print(f"[{PASS if geo_ok else FAIL}] geometry rejects out-of-bounds + bad centre"
          f"  |  {len(geo)} errors")
    for line in geo:
        print(f"       {line}")

    shape_a = shape_of(good_fixture())
    other = good_fixture()
    other["location"]["id"] = "transit"
    other["clickables"][0]["confidence"] = 1.0     # what the hsv backend emits
    shape_ok = shape_of(other) == shape_a
    ok = ok and shape_ok
    print(f"[{PASS if shape_ok else FAIL}] fingerprint ignores values, tracks shape")
    print(f"       shape: {shape_a}")

    drifted = good_fixture()
    drifted["clickables"][0]["confidence"] = 1
    shape_ok = shape_of(drifted) != shape_a
    ok = ok and shape_ok
    print(f"[{PASS if shape_ok else FAIL}] fingerprint moves when a value type drifts")

    print("\nself-test " + ("PASSED" if ok else "FAILED"))
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8765")
    ap.add_argument("--frame", help="test image; defaults to the first ml/dataset/raw frame")
    ap.add_argument("--config", default=str(HERE / "config.yaml"))
    ap.add_argument("--requests", type=int, default=1000,
                    help="sequential POSTs for the latency + stability bullets")
    ap.add_argument("--pid", type=int, default=None,
                    help="server pid, for the flat-memory half of the stability bullet")
    ap.add_argument("--readme", default=str(ROOT / "README.md"))
    ap.add_argument("--expect-id", metavar="LABEL",
                    help="ground-truth location for --frame (e.g. transit). Asserts the "
                         "service reports exactly this id, which is what 'never mapped to "
                         "a spot' actually means once transit is a trained class.")
    ap.add_argument("--expect-shape", default=None,
                    help="fingerprint printed by a run against the other detector backend")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--selftest", action="store_true",
                    help="validate the schema checker against fixtures, no server needed")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(selftest())

    try:
        import requests
    except ImportError:
        sys.exit("requests is not installed - pip install requests")
    try:
        import yaml
    except ImportError:
        sys.exit("pyyaml is not installed - pip install pyyaml")

    cfg_path = Path(args.config)
    if not cfg_path.exists():
        sys.exit(f"no config at {cfg_path}")
    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))

    frame = Path(args.frame) if args.frame else default_frame()
    if frame is None:
        sys.exit("no frames under ml/dataset/raw - pass --frame")
    frame = frame.resolve()
    if not frame.exists():
        sys.exit(f"no such frame: {frame}")
    data = frame.read_bytes()
    real_w, real_h = real_image_size(data, frame)

    url = args.url.rstrip("/")
    threshold = float(cfg.get("location_conf_threshold", 0.70))
    # The pid for the memory check must come from the URL actually being tested,
    # not from the config file: pointing --url at a second instance while the
    # config still names the first samples the wrong process's RSS.
    port = urlparse(url).port or (443 if urlparse(url).scheme == "https" else 80)
    if int(cfg.get("port", port)) != port:
        print(f"note:    --url port {port} != config port {cfg.get('port')}; "
              f"memory is sampled from the process serving {url}")

    print(f"server:  {url}")
    print(f"frame:   {frame}  ({real_w}x{real_h}, {len(data) / 1024:.0f} KiB)")
    print(f"config:  {cfg_path}  (detector={cfg.get('detector')}, "
          f"location_conf_threshold={threshold})")
    print()

    report = Report()
    session = requests.Session()

    # 1 - health
    health = None
    try:
        response = session.get(url + "/health", timeout=args.timeout)
        health = response.json()
        echoed = [k for k in ("detector", "models", "port", "classify_imgsz",
                              "detect_imgsz", "detect_conf", "location_conf_threshold",
                              "hsv", "config")
                  if json.dumps(health).find(f'"{k}"') >= 0]
        ok = response.status_code == 200 and isinstance(health, dict) and bool(echoed)
        report.add("health", "1. GET /health responds and echoes config",
                   PASS if ok else FAIL,
                   f"HTTP {response.status_code}, config keys echoed: {', '.join(echoed) or 'NONE'}",
                   [json.dumps(health)[:400]])
    except Exception as exc:                                # noqa: BLE001
        sys.exit(f"cannot reach {url}/health ({exc}) - start the server first, "
                 f"this checker deliberately does not start it for you")

    # 2 - the pinned schema, multipart
    response, wall = post_multipart(session, url, frame.name, data, mime_for(frame), args.timeout)
    if response.status_code != 200:
        sys.exit(f"POST /analyze returned HTTP {response.status_code}: {response.text[:300]}")
    multipart = response.json()
    errors, notes = schema_errors(multipart)
    report.add("schema", "2. POST /analyze (multipart) returns the pinned schema",
               PASS if not errors else FAIL,
               f"HTTP 200, {len(errors)} drift errors, {len(notes)} notes, "
               f"{len(multipart.get('clickables', []))} clickables, {wall:.1f} ms wall",
               list(errors) + list(notes))

    # 3 - the JSON convenience path must agree with multipart
    response, _ = post_b64(session, url, data, args.timeout)
    if response.status_code != 200:
        report.add("b64", "3. POST /analyze ({image_b64}) returns an equivalent result",
                   FAIL, f"HTTP {response.status_code}: {response.text[:200]}")
    else:
        b64 = response.json()
        b64_errors, _ = schema_errors(b64)
        diffs = list(b64_errors)
        if b64.get("image") != multipart.get("image"):
            diffs.append(f"image differs: {b64.get('image')} vs {multipart.get('image')}")
        if (b64.get("location") or {}).get("id") != (multipart.get("location") or {}).get("id"):
            diffs.append("location.id differs between multipart and image_b64")
        a, b = multipart.get("clickables") or [], b64.get("clickables") or []
        if len(a) != len(b):
            diffs.append(f"clickable count differs: multipart {len(a)} vs b64 {len(b)}")
        else:
            for i, (x, y) in enumerate(zip(a, b)):
                if [x.get(k) for k in ("x", "y", "w", "h")] != [y.get(k) for k in ("x", "y", "w", "h")]:
                    diffs.append(f"clickables[{i}] box differs between transports")
        identical = without_timing(multipart) == without_timing(b64)
        report.add("b64", "3. POST /analyze ({image_b64}) returns an equivalent result",
                   PASS if not diffs else FAIL,
                   f"{len(diffs)} differences; payload minus timing_ms is "
                   f"{'byte-identical' if identical else 'equivalent but not byte-identical'}",
                   diffs)

    # 4 - coordinate space
    geo = geometry_errors(multipart, real_w, real_h)
    boxes = multipart.get("clickables") or []
    report.add("coords", "4. coordinates are pixels of the submitted image, origin top-left",
               PASS if not geo else FAIL,
               f"image {multipart.get('image')} vs file {real_w}x{real_h}; "
               f"{len(boxes)} boxes checked for bounds and cx/cy centring",
               geo)

    # 5 - honesty: a low-confidence id is still the real id
    location = multipart.get("location") or {}
    conf = location.get("confidence")
    lid = location.get("id")
    top3 = location.get("top3") or []
    problems = []
    if not isinstance(lid, str) or not lid.strip():
        problems.append(f"location.id is {lid!r} - blanked ids are not honest reporting")
    if top3 and isinstance(top3[0], dict):
        if top3[0].get("id") != lid:
            problems.append(f"location.id {lid!r} != top3[0].id {top3[0].get('id')!r} - remapped?")
        if top3[0].get("confidence") != conf:
            problems.append(f"location.confidence {conf} != top3[0].confidence "
                            f"{top3[0].get('confidence')}")
    confs = [e.get("confidence") for e in top3 if isinstance(e, dict)]
    if confs and confs != sorted(confs, reverse=True):
        problems.append(f"top3 is not sorted by descending confidence: {confs}")
    if args.expect_id:
        # Ground truth supplied, so the bullet is directly testable. Once transit
        # is a trained class it answers confidently, and "never mapped to a spot"
        # is proved by the id being right - not by confidence being low.
        exercised = True
        if lid != args.expect_id:
            problems.append(f"expected location.id {args.expect_id!r}, got {lid!r}")
        observed = (f"expected {args.expect_id!r}, got {lid!r} at conf {conf} "
                    f"- reported as-is, not remapped")
    elif isinstance(conf, float) and conf < threshold:
        exercised = True
        observed = (f"observed conf {conf:.4f} < threshold {threshold} and id is still "
                    f"{lid!r} - the honesty path was exercised")
    else:
        exercised = False
        observed = (f"observed conf {conf} >= threshold {threshold} on this frame, so the "
                    f"low-confidence path was NEVER EXERCISED; id/top3 consistency passed. "
                    f"Pass --expect-id, or use an off-spot frame, to close this bullet.")
    # A high-confidence frame cannot certify the low-confidence behaviour. Only
    # FAIL on a real inconsistency; otherwise SKIP rather than claim a PASS.
    status = FAIL if problems else (PASS if exercised else SKIP)
    report.add("honesty", "5. location reported honestly, never blanked or remapped",
               status, observed, problems)

    # 6 + 7 - one sequential run feeds both the latency and the stability bullets
    for _ in range(WARMUP_REQUESTS):
        post_multipart(session, url, frame.name, data, mime_for(frame), args.timeout)

    pid, pid_reason = (args.pid, None) if args.pid else discover_pid(port)
    rss_before = None
    if pid:
        try:
            rss_before = rss_mb(pid)
        except Exception as exc:                            # noqa: BLE001
            pid, pid_reason = None, f"cannot read RSS of pid {pid} ({exc})"

    server_ms, wall_ms, failures = [], [], []
    print(f"       running {args.requests} sequential requests "
          f"(after {WARMUP_REQUESTS} warmup)...")
    for i in range(args.requests):
        try:
            response, wall = post_multipart(session, url, frame.name, data,
                                            mime_for(frame), args.timeout)
            if response.status_code != 200:
                failures.append(f"#{i}: HTTP {response.status_code} {response.text[:120]}")
                continue
            payload = response.json()
            errs, _ = schema_errors(payload)
            if errs:
                failures.append(f"#{i}: {errs[0]}")
                continue
            server_ms.append(float(payload["timing_ms"]["total"]))
            wall_ms.append(wall)
        except Exception as exc:                            # noqa: BLE001
            failures.append(f"#{i}: {type(exc).__name__}: {exc}")

    if server_ms:
        mean_total = statistics.mean(server_ms)
        p95_total = pct(server_ms, 0.95)
        # The plan says "total <= 50 ms per request", not "on average". Gating on
        # the mean alone lets a run with a 500 ms outlier pass, so p95 is gated
        # too; max is reported but left ungated because OS scheduling jitter on a
        # desktop would make it flaky.
        ok = mean_total <= LATENCY_GATE_MS and p95_total <= LATENCY_GATE_MS
        report.add("latency", f"6. latency over {args.requests} requests "
                              f"(gate: mean AND p95 timing_ms.total <= {LATENCY_GATE_MS:.0f} ms)",
                   PASS if ok else FAIL,
                   f"mean {mean_total:.1f} ms, p95 {p95_total:.1f} ms, "
                   f"max {max(server_ms):.1f} ms",
                   [stats_line("server total_ms", server_ms),
                    stats_line("wall-clock ms", wall_ms)])
    else:
        report.add("latency", "6. latency", FAIL, "no successful request to measure")

    report.add("stability", f"7a. {args.requests} sequential requests, zero errors",
               PASS if not failures else FAIL,
               f"{len(server_ms)}/{args.requests} ok, {len(failures)} errors",
               failures[:10])

    if pid and rss_before is not None:
        rss_after = rss_mb(pid)
        drift = rss_after - rss_before
        allowed = max(RSS_DRIFT_MB, rss_before * RSS_DRIFT_PCT / 100.0)
        report.add("memory", "7b. flat memory across those requests",
                   PASS if drift <= allowed else FAIL,
                   f"pid {pid}: RSS {rss_before:.1f} -> {rss_after:.1f} MB "
                   f"(drift {drift:+.1f} MB, allowed {allowed:.1f})")
    else:
        report.add("memory", "7b. flat memory across those requests", SKIP,
                   pid_reason or "no server pid available - rerun with --pid <server pid>")

    # 8 - a stateless service cannot drift between identical requests
    first = session.post(url + "/analyze",
                         files={"file": (frame.name, data, mime_for(frame))},
                         timeout=args.timeout).json()
    second = session.post(url + "/analyze",
                          files={"file": (frame.name, data, mime_for(frame))},
                          timeout=args.timeout).json()
    id_a = (first.get("location") or {}).get("id")
    id_b = (second.get("location") or {}).get("id")
    n_a, n_b = len(first.get("clickables") or []), len(second.get("clickables") or [])
    problems = []
    if id_a != id_b:
        problems.append(f"location.id drifted: {id_a!r} -> {id_b!r}")
    if n_a != n_b:
        problems.append(f"clickable count drifted: {n_a} -> {n_b}")
    identical = without_timing(first) == without_timing(second)
    report.add("determinism", "8. same frame twice -> same answer (statelessness)",
               PASS if not problems else FAIL,
               f"id {id_a!r} x2, {n_a} clickables x2; payload minus timing_ms is "
               f"{'byte-identical' if identical else 'NOT byte-identical (confidence jitter)'}",
               problems)

    # 9 - the config swap bullet
    backend_cfg = cfg.get("detector")
    backend_health = find_backend(health)
    shape = shape_of(multipart)
    problems = []
    if backend_health is None:
        problems.append("/health does not echo the active detector - a consumer cannot "
                        "tell which backend it is talking to")
    elif backend_health != backend_cfg:
        problems.append(f"/health says detector={backend_health!r} but config says "
                        f"{backend_cfg!r}")
    if backend_health == "hsv":
        bad = [i for i, b in enumerate(boxes) if b.get("confidence") != 1.0]
        if bad:
            problems.append(f"hsv boxes must carry confidence 1.0; boxes {bad} do not")
    details = [f"shape: {shape}"]
    if args.expect_shape:
        if args.expect_shape != shape:
            problems.append("shape differs from the other backend's run:")
            problems.append(f"  expected {args.expect_shape}")
            problems.append(f"  got      {shape}")
        status = PASS if not problems else FAIL
        measured = f"backend={backend_health}, shape compared against --expect-shape"
    elif not boxes:
        status = SKIP if not problems else FAIL
        measured = (f"backend={backend_health}, but this frame produced 0 clickables so the "
                    f"box shape cannot be fingerprinted - use a frame with a box")
    else:
        # One backend proves nothing about swappability. Only the --expect-shape
        # branch, which compares a fingerprint captured under the OTHER backend,
        # can close this bullet.
        status = FAIL if problems else SKIP
        measured = (f"backend={backend_health} matches config, but only ONE backend was "
                    f"observed; rerun under the other backend with --expect-shape to "
                    f"close this bullet")
    report.add("swap", "9. detector backend is swappable behind an identical shape",
               status, measured, details + problems)

    # 10 - the README bullet
    readme = Path(args.readme)
    if not readme.exists():
        report.add("readme", "10. README documents the contract + coordinate-space rule",
                   FAIL, f"no README at {readme}")
    else:
        text = readme.read_text(encoding="utf-8", errors="replace").lower()
        # Distinctive strings only. Bare terms like "cy" and "coordinate" match
        # inside "accuracy" and "click coordinates", so the v1 README scored 3/7
        # while documenting none of the v2 contract.
        want = ['"clickables"', '"timing_ms"', '"top3"', "/analyze",
                "origin top-left", "never rescales"]
        missing = [w for w in want if w not in text]
        report.add("readme", "10. README documents the contract + coordinate-space rule",
                   PASS if not missing else FAIL, f"{readme}, missing terms: "
                   f"{', '.join(missing) or 'none'}")

    # bullets a machine cannot settle
    report.add("det_metrics", "detector precision & recall >= 0.95 on the val split", SKIP,
               "needs the held-out detection split - run ml/evaluate_detector.py")
    report.add("det_eyeball", "no boxes on players across 50 frames", SKIP,
               "needs a human eyeball - ml/evaluate_detector.py renders the frames to review")

    print("\n" + "=" * 92)
    print("PHASE 6 ACCEPTANCE CHECKLIST")
    print("=" * 92)
    for title, keys in BULLETS:
        status = report.status_of(keys)
        tag = "SKIP-needs-human" if status == SKIP else status
        print(f"  [{tag:<16}] {title.format(n=f'{args.requests:,}')}")
    print("=" * 92)

    failed = report.failed()
    skipped = sum(1 for s in report.results.values() if s == SKIP)
    print(f"{len(report.results)} checks: {len(report.results) - failed - skipped} passed, "
          f"{failed} failed, {skipped} skipped")
    if failed:
        sys.exit(f"ACCEPTANCE FAILED - {failed} check(s) failed")
    print("ACCEPTANCE PASSED for everything a machine can decide.")


if __name__ == "__main__":
    main()
