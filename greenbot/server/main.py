"""Local HTTP inference service: post a frame, get location + clickable boxes.

This is the v2 deliverable. It reports FACTS ONLY - no clicking, no input
injection, no capture loop, no decision about which clickable is the right one.
It is stateless on purpose: the consumer owns the frame stream, so it also owns
any smoothing or majority voting over top3.

    python server/main.py
    python server/main.py --config server/config.test.yaml
    uvicorn main:app --host 127.0.0.1 --port 8765      # from inside server/

config.yaml is the single source of truth for host, port, thresholds, HSV
values and model paths. Model paths resolve against the CONFIG FILE'S OWN
directory, never the process CWD, because start_server.bat may be launched
from anywhere (Explorer double-click, a scheduler, another app).
"""
import argparse
import base64
import binascii
import json
import os
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / "config.yaml"

# The hsv backend must return exactly what tools/propose_boxes.py labelled, so
# it imports that implementation rather than keeping a second copy. Two copies
# drifted apart once already (rect vs ellipse kernel, missing CLOSE), which
# made `detector: hsv` silently disagree with the training labels.
sys.path.insert(0, str(HERE.parent / "tools"))
from propose_boxes import hsv_boxes   # noqa: E402

from picker import pick_target        # noqa: E402  (server/picker.py)

# The service is loopback-only, but a runaway capture loop or a wrong-endpoint
# upload should get a clean 413 instead of eating the box's memory.
MAX_UPLOAD_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 40_000_000

HSV_CLASS = "clickable"

REQUIRED_KEYS = ("host", "port", "detector", "models", "classify_imgsz",
                 "detect_imgsz", "detect_conf", "location_conf_threshold", "hsv")

# Filled once by the lifespan handler; every request only reads from it.
STATE = {}


def _fail(msg):
    # A startup problem has to be obvious in the console the .bat opened, not a
    # 500 on the first request - so print plainly before uvicorn logs the trace.
    print(f"\nSTARTUP FAILED: {msg}\n", file=sys.stderr, flush=True)
    sys.exit(1)


def config_path():
    """--config sets GREENBOT_CONFIG, so uvicorn's own CLI can pick it up too."""
    env = os.environ.get("GREENBOT_CONFIG")
    return Path(env).expanduser().resolve() if env else DEFAULT_CONFIG


def load_config(path):
    if not path.exists():
        _fail(f"no config at {path}\n  point GREENBOT_CONFIG at one, or pass --config")
    try:
        cfg = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        _fail(f"{path} is not valid YAML: {exc}")
    if not isinstance(cfg, dict):
        _fail(f"{path} must contain a YAML mapping")
    missing = [k for k in REQUIRED_KEYS if k not in cfg]
    if missing:
        _fail(f"{path} is missing required keys: {', '.join(missing)}")
    if cfg["detector"] not in ("yolo", "hsv"):
        _fail(f"detector in {path} must be 'yolo' or 'hsv', got {cfg['detector']!r}")
    for key in ("classifier", "detector"):
        if key not in cfg["models"]:
            _fail(f"{path} is missing models.{key}")
    for key in ("lo", "hi", "min_area", "morph_kernel"):
        if key not in cfg["hsv"]:
            _fail(f"{path} is missing hsv.{key}")
    return cfg


def resolve_model(cfg, path, which):
    raw = Path(str(cfg["models"][which]))
    return raw if raw.is_absolute() else (path.parent / raw).resolve()


def _load_models(cfg, cfg_path):
    from ultralytics import YOLO   # heavy import, keep it off module-import time

    clf_path = resolve_model(cfg, cfg_path, "classifier")
    if not clf_path.exists():
        _fail(f"classifier weights not found: {clf_path}\n"
              f"  config:  {cfg_path}\n"
              f"  entry:   models.classifier = {cfg['models']['classifier']}\n"
              "  train one with:  python ml/train.py\n"
              "  then copy runs/classify/<run>/weights/best.pt to that path")
    clf = YOLO(str(clf_path))
    if clf.task != "classify":
        _fail(f"{clf_path} is a '{clf.task}' model, not a classifier")

    det = None
    det_path = resolve_model(cfg, cfg_path, "detector")
    if cfg["detector"] == "yolo":
        if not det_path.exists():
            _fail(f"detector weights not found: {det_path}\n"
                  f"  config:  {cfg_path}\n"
                  f"  entry:   detector: yolo, models.detector = {cfg['models']['detector']}\n"
                  "  train it with:   python ml/train_detector.py\n"
                  "  or switch that config to:  detector: hsv")
        det = YOLO(str(det_path))
        if det.task != "detect":
            _fail(f"{det_path} is a '{det.task}' model, not a detector")

    # One throwaway inference so the first real request is not the one that pays
    # for lazy CUDA/cuDNN init.
    warm = np.zeros((64, 64, 3), np.uint8)
    clf.predict(warm, imgsz=int(cfg["classify_imgsz"]), verbose=False)
    if det is not None:
        det.predict(warm, imgsz=int(cfg["detect_imgsz"]), verbose=False)

    return clf, clf_path, det, det_path


@asynccontextmanager
async def lifespan(_app):
    path = config_path()
    cfg = load_config(path)
    clf, clf_path, det, det_path = _load_models(cfg, path)
    STATE.update(cfg=cfg, cfg_path=path, clf=clf, clf_path=clf_path,
                 det=det, det_path=det_path, backend=cfg["detector"],
                 started_at=time.time())
    print(f"config:     {path}")
    print(f"classifier: {clf_path}  ({len(clf.names)} classes)")
    print(f"detector:   {cfg['detector']}"
          + (f"  {det_path}" if det is not None else "  (threshold fallback)"))
    yield
    STATE.clear()


app = FastAPI(title="greenbot vision service", version="2.0", lifespan=lifespan)

# CORS matters if you ever call this from the Electron renderer via fetch();
# from Node's http/axios it is irrelevant. The server binds to 127.0.0.1 only,
# so "*" cannot be reached from off-box.
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])


def _box(x, y, w, h, cls, conf):
    """The one place box geometry is built, so both backends cannot drift."""
    return {"cx": int(round(x + w / 2)), "cy": int(round(y + h / 2)),
            "x": int(round(x)), "y": int(round(y)),
            "w": int(round(w)), "h": int(round(h)),
            "class": str(cls), "confidence": float(conf)}


def hsv_detect(img, cfg):
    """Phase-2 green-blob logic, via the same function tools/propose_boxes.py
    uses to write labels - so `detector: hsv` reproduces what was labelled."""
    hsv_cfg = cfg["hsv"]
    boxes = hsv_boxes(img,
                      np.array(hsv_cfg["lo"], np.uint8),
                      np.array(hsv_cfg["hi"], np.uint8),
                      float(hsv_cfg["min_area"]),
                      int(hsv_cfg["morph_kernel"]))
    # A threshold has no notion of confidence; say so rather than invent one.
    return [_box(x, y, w, h, HSV_CLASS, 1.0) for (x, y, w, h) in boxes]


def _rescale_box(box, factor):
    """Map a box from detection space back to screen space."""
    x, y = box["x"] * factor, box["y"] * factor
    w, h = box["w"] * factor, box["h"] * factor
    return _box(x, y, w, h, box["class"], box["confidence"])


def grab_screen(monitor):
    """One frame of the given monitor, BGR, at native resolution.

    The camera is created once and kept: bettercam's device duplication handle
    is expensive to build, and a per-request create/stop cycle leaks handles.
    """
    cam = STATE.get("camera")
    if cam is None:
        try:
            import bettercam
        except ImportError:
            raise HTTPException(500, "bettercam is not installed - /analyze/screen "
                                     "needs it; pip install bettercam")
        cam = bettercam.create(output_idx=monitor, output_color="BGR")
        if cam is None:
            raise HTTPException(500, f"could not open monitor {monitor}")
        STATE["camera"] = cam

    frame = cam.grab()
    if frame is None:
        # grab() returns None when nothing changed since the last call, which is
        # normal on a static screen - fall back to the previous frame.
        frame = STATE.get("last_frame")
    if frame is None:
        raise HTTPException(503, "screen capture returned no frame")
    STATE["last_frame"] = frame
    return frame


def select_target(clickables, location_id, shape, cfg):
    """The one box that matters here, or None if no rule applies.

    A location with no rule - transit especially - deliberately yields None
    rather than a guess. The full list stays in `clickables` either way.
    """
    rule = (cfg.get("targets") or {}).get(location_id)
    if not rule or not clickables:
        return None
    boxes = [(c["x"], c["y"], c["w"], c["h"]) for c in clickables]
    chosen = pick_target(boxes, rule, shape)
    if chosen is None:
        return None
    return next(c for c in clickables
                if (c["x"], c["y"], c["w"], c["h"]) == tuple(chosen))


def yolo_detect(img, cfg):
    r = STATE["det"].predict(img, imgsz=int(cfg["detect_imgsz"]),
                             conf=float(cfg["detect_conf"]), verbose=False)[0]
    boxes = []
    for b in r.boxes:
        x1, y1, x2, y2 = (float(v) for v in b.xyxy[0])
        boxes.append(_box(x1, y1, x2 - x1, y2 - y1,
                          r.names[int(b.cls[0])], round(float(b.conf[0]), 4)))
    return boxes


def classify(img, cfg):
    r = STATE["clf"].predict(img, imgsz=int(cfg["classify_imgsz"]), verbose=False)[0]
    probs = [float(p) for p in r.probs.data.tolist()]
    order = sorted(range(len(probs)), key=lambda i: probs[i], reverse=True)
    # A transit or low-confidence frame is returned exactly as the model saw it.
    return [{"id": str(r.names[i]), "confidence": round(probs[i], 4)}
            for i in order[:min(3, len(probs))]]


def _decode_b64(value):
    if not isinstance(value, str):
        raise HTTPException(400, "'image_b64' must be a string")
    text = value.strip()
    # The Electron renderer sends canvas.toDataURL(), which carries a prefix.
    if text.startswith("data:"):
        _, _, text = text.partition(",")
    text = "".join(text.split())
    if len(text) > MAX_UPLOAD_BYTES // 3 * 4 + 8:
        raise HTTPException(413, f"'image_b64' exceeds the {MAX_UPLOAD_BYTES} byte limit")
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "'image_b64' is not valid base64")


async def _read_image_bytes(request):
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"payload is {declared} bytes, "
                                 f"the limit is {MAX_UPLOAD_BYTES}")

    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype == "multipart/form-data":
        form = await request.form()
        upload = form.get("file")
        if upload is None or isinstance(upload, str):
            raise HTTPException(400, "multipart body needs a file part named 'file'")
        raw = await upload.read()
    elif ctype == "application/json":
        try:
            payload = json.loads(await request.body() or b"{}")
        except ValueError:
            raise HTTPException(400, "body is not valid JSON")
        if not isinstance(payload, dict) or "image_b64" not in payload:
            raise HTTPException(400, "JSON body needs an 'image_b64' string")
        raw = _decode_b64(payload["image_b64"])
    else:
        raise HTTPException(415, "post multipart/form-data with a 'file' part, "
                                 "or application/json with 'image_b64'")

    if not raw:
        raise HTTPException(400, "empty image payload")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"image is {len(raw)} bytes, "
                                 f"the limit is {MAX_UPLOAD_BYTES}")
    return raw


def _model_info(path, model):
    stat = path.stat()
    return {"path": str(path),
            "loaded": True,
            "task": model.task,
            "class_names": [str(n) for n in model.names.values()],
            "size_bytes": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")}


@app.get("/health")
def health():
    import torch
    from ultralytics import __version__ as ultralytics_version

    cfg = STATE["cfg"]
    detector = {"backend": STATE["backend"]}
    if STATE["det"] is not None:
        detector.update(_model_info(STATE["det_path"], STATE["det"]))
    else:
        detector.update({"path": str(STATE["det_path"]), "loaded": False,
                         "task": "detect", "class_names": [HSV_CLASS],
                         "hsv": cfg["hsv"]})

    return {"status": "ok",
            "config_path": str(STATE["cfg_path"]),
            "detector_backend": STATE["backend"],
            "uptime_s": round(time.time() - STATE["started_at"], 1),
            "models": {"classifier": _model_info(STATE["clf_path"], STATE["clf"]),
                       "detector": detector},
            "versions": {"python": sys.version.split()[0],
                         "ultralytics": ultralytics_version,
                         "torch": torch.__version__,
                         "opencv": cv2.__version__,
                         "cuda_available": torch.cuda.is_available()},
            "config": cfg}


@app.post("/analyze")
async def analyze(request: Request):
    t0 = time.perf_counter()
    raw = await _read_image_bytes(request)
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "not a decodable image")
    h, w = img.shape[:2]
    if w * h > MAX_PIXELS:
        raise HTTPException(413, f"image is {w}x{h}, the limit is {MAX_PIXELS} pixels")

    cfg = STATE["cfg"]
    t1 = time.perf_counter()
    top3 = classify(img, cfg)
    t2 = time.perf_counter()
    # Coordinates stay in the submitted image's pixel space - the service never
    # rescales; a consumer capturing and clicking at different resolutions owns
    # that mapping.
    clickables = yolo_detect(img, cfg) if STATE["det"] is not None else hsv_detect(img, cfg)
    t3 = time.perf_counter()

    return {"location": {"id": top3[0]["id"],
                         "confidence": top3[0]["confidence"],
                         "top3": top3},
            "target": select_target(clickables, top3[0]["id"], img.shape, cfg),
            "clickables": clickables,
            "image": {"width": int(w), "height": int(h)},
            "timing_ms": {"classify": round((t2 - t1) * 1e3, 1),
                          "detect": round((t3 - t2) * 1e3, 1),
                          "total": round((t3 - t0) * 1e3, 1)}}


@app.post("/analyze/screen")
@app.get("/analyze/screen")
async def analyze_screen(preview: int = 0):
    """Same answer as /analyze, but the service grabs the screen itself.

    ?preview=1 appends `preview_b64`, a JPEG of the exact downscaled frame the
    decision was made on. Opt-in and not part of the pinned /analyze contract -
    it exists so the monitor panel can show what the service actually saw
    rather than a second, slightly-different capture of its own.

    Coordinates come back in SCREEN pixels, not in the downscaled space the
    models run on, so a consumer can click them directly. Inference still runs
    at capture.detect_width because that is the scale the collector recorded at
    - at native resolution the green skill-level digits in the HUD clear
    hsv.min_area and show up as phantom targets.
    """
    cfg = STATE["cfg"]
    cap = cfg.get("capture", {})
    t0 = time.perf_counter()
    full = grab_screen(int(cap.get("monitor", 0)))
    screen_h, screen_w = full.shape[:2]

    detect_w = int(cap.get("detect_width", 1280))
    scale = min(1.0, detect_w / screen_w) if detect_w else 1.0
    small = full if scale == 1.0 else cv2.resize(full, None, fx=scale, fy=scale,
                                                 interpolation=cv2.INTER_AREA)
    t1 = time.perf_counter()
    top3 = classify(small, cfg)
    t2 = time.perf_counter()
    detected = yolo_detect(small, cfg) if STATE["det"] is not None else hsv_detect(small, cfg)
    t3 = time.perf_counter()

    clickables = [_rescale_box(b, 1 / scale) for b in detected] if scale != 1.0 else detected
    boxes = [(b["x"], b["y"], b["w"], b["h"]) for b in clickables]
    target = select_target(clickables, top3[0]["id"], (screen_h, screen_w), cfg) if boxes else None

    payload = {"location": {"id": top3[0]["id"],
                            "confidence": top3[0]["confidence"],
                            "top3": top3},
               "target": target,
               "clickables": clickables,
               "image": {"width": int(screen_w), "height": int(screen_h)},
               "capture": {"monitor": int(cap.get("monitor", 0)),
                           "detect_width": int(small.shape[1]),
                           "scale": round(scale, 6)},
               "timing_ms": {"capture": round((t1 - t0) * 1e3, 1),
                             "classify": round((t2 - t1) * 1e3, 1),
                             "detect": round((t3 - t2) * 1e3, 1),
                             "total": round((t3 - t0) * 1e3, 1)}}

    if preview:
        ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            payload["preview_b64"] = base64.b64encode(buf.tobytes()).decode("ascii")

    return payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.environ.get("GREENBOT_CONFIG"),
                    help="defaults to server/config.yaml or $GREENBOT_CONFIG")
    ap.add_argument("--host", default=None, help="override config host")
    ap.add_argument("--port", type=int, default=None, help="override config port")
    args = ap.parse_args()

    if args.config:
        os.environ["GREENBOT_CONFIG"] = str(Path(args.config).expanduser().resolve())

    path = config_path()
    cfg = load_config(path)   # fail before uvicorn binds anything
    host = args.host or cfg["host"]
    port = int(args.port or cfg["port"])

    import uvicorn

    print(f"http://{host}:{port}/health")
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
