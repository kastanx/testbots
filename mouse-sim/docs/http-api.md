# HTTP API

The local server answers `POST /api/generate` with one whole **trial** from your mouse model. You send
where the cursor is and where the target is. You get back the cursor position every millisecond from
the moment the target appears, and the press and release time of each click, as JSON.

This page covers running the server and what to send. [output-spec.md](output-spec.md) specifies the
response and how to read it.

---

## 1. Run the server

From `mouse-sim/`:

```bash
.venv/Scripts/python serve.py
```

It prints `mouse-sim: http://localhost:8765/ (data: …)` and keeps running until you close the window
(or press Ctrl+C). `start.bat` starts the same server and also opens the recorder and simulator pages in
your browser. It is one server for everything: the recorder, the simulator and this API.

| Option | Default | Meaning |
|---|---|---|
| `--port N` | `8765` | Port to listen on. |
| `--host ADDR` | `127.0.0.1` | `127.0.0.1`: only this PC can connect. `0.0.0.0`: other machines on your network can too, at `http://<this PC's IP>:8765`. There is no password, so anyone on the network can then use the whole server, including the recorder's upload endpoints. Windows Firewall asks the first time. |
| `--preload` | off | Load the model before serving, so the first request is as fast as the rest. |
| `--data DIR` | `mouse-sim/data` | Another data folder. |

**It needs processed recordings:** record sessions, then run `python -m pipeline all`. When you re-run
the pipeline, tune a model or train the generative model, the server notices on the next request and
reloads by itself. Changes to the code need a restart.

**Check that it works:**

- <http://localhost:8765/api/models> lists which models can answer, and why not if one can't.
- <http://localhost:8765/docs> is an interactive page with every endpoint. Open `POST /api/generate`,
  press "Try it out", pick an example and press "Execute".

## 2. Request

`POST /api/generate` with header `Content-Type: application/json` and a body like:

```json
{
  "start": {"x": 1200, "y": 640},
  "target": {"left": 1738, "top": 396, "w": 96, "h": 32}
}
```

| Field | Required | Meaning |
|---|---|---|
| `start.x`, `start.y` | yes | Where the cursor is when the target appears, in screen pixels with the origin at the top-left. Rounded to whole pixels. |
| `target.left`, `target.top` | these… | The top-left corner of the target's bounding box. |
| `target.cx`, `target.cy` | …or these | Its centre instead. A box `left, top, w, h` is the same target as centre `left + w/2, top + h/2`. |
| `target.w`, `target.h` | `w` always, `h` for a rect | Width and height in pixels. A circle has only `w`, its diameter. |
| `target.shape` | no (`"rect"`) | `"rect"`, a button with rounded corners, or `"circle"`. |
| `target.r` | no | Corner radius of a rect. Default `min(6, w/4, h/4)`, like the recorder's buttons. It only decides whether a press right in a corner counts as a hit. |
| `screen.w`, `screen.h` | no | Screen size, for stopping the cursor at the edges. Default: the screen of your recordings (3440 × 1440). |
| `model` | no (`"auto"`) | Which model answers (section 4). |
| `seed` | no | A non-negative integer: the same request with the same seed returns the same trial. |
| `format` | no (`"dense"`) | `"dense"` returns `pos`, one position per millisecond. `"changes"` returns `changes`, only the moments the position changes. Both carry the same information. |
| `skip_reaction` | no (`false`) | `true`: the cursor starts moving at once. The reaction time is left out: about 250 ms of standing still before you start to move, and any pause over 40 ms before the main movement. Only time is removed; the path is the same. For when you have already reacted, for example by tapping the target yourself. |
| `no_misses` | no (`false`) | `true`: exactly one click, and it lands on the target. Without it the model sometimes misses and clicks again, as you do (about 8% of trials, more on small targets). |

**The target is the clickable area.** Give its bounding box or its centre and size. Where the press lands
inside it is not an input: the model decides that, the way you click, near the middle with more scatter on
bigger targets. The whole box counts as clickable, so for an odd-shaped object, send a box
that lies inside it.

## 3. Response

The response holds only the cursor path and the clicks:

```json
{"pos": [[1200, 640], [1200, 640], "…", [1784, 412]], "clicks": [{"down": 908, "up": 1017}]}
```

`pos` has one position per millisecond, and `clicks` has the press and release times in ms.
[output-spec.md](output-spec.md) explains how to read them.

## 4. Models

| `model` | What it is | Available now |
|---|---|---|
| `auto` (default) | Motion matching, the model that scored best on your data. | yes |
| `mm` | Motion matching: one of your recorded movements, rotated, scaled and retimed to fit the request. | yes |
| `hybrid` | Motion matching where a close enough recording exists, the generative model elsewhere. | no |
| `gen` | The generative model alone. | no |
| `strokes` | New movements: your recorded movements taken apart into strokes, one varied part of the way toward another of yours, with your own hand texture. Never the same twice. | yes |
| `line`, `minjerk`, `bezier` | Baselines, for comparison only; they fail the harness clearly. | yes |

On a session held out from training, a classifier told the models' movements from yours with
AUC 0.725 for motion matching, 0.829 for the hybrid and 0.983 for the generative model. 0.5 means it
can't tell them apart; your own other sessions score 0.728. So no generative model is installed: with
about 1,200 movements it is far worse than motion matching. `hybrid` and `gen` return 503 until one is
trained with `python -m models.generative train`.

`strokes` (2026-10-11, the same held-out session, 5 runs) scored AUC 0.788 against motion matching's
0.710 (floor 0.744, so both pass), and better than motion matching on path shape (0.613 vs 0.644). Its
movements are never copies: asked the same thing 100 times it gave 100 different movements, where
motion matching gave 1-8. `auto` stays motion matching; ask for `strokes` by name.
[models/strokes/README.md](../models/strokes/README.md) has the details.

`GET /api/models` shows what is available, with the reason when a model isn't. A generative model
trained on a different data folder, such as the synthetic test data, is never used for this one.

## 5. Errors

A request that can't be answered gets one of these, with the body `{"detail": …}`:

| Status | When |
|---|---|
| 422 | Bad request: a missing or invalid field (FastAPI lists each one), or the start or the target centre is off the screen. |
| 503 | Can't answer yet: there are no processed recordings, or the requested model isn't available. `detail` says why. |
| 500 | Generation failed. `detail` has the message; the traceback is in the server's console. |

## 6. Speed

- **The first request** after starting, or after the data or config changed, loads the recordings and
  fits the model. That takes about 1 s for motion matching on your data. `hybrid` and `gen` also load
  PyTorch and the network: a few seconds. `--preload` does this before serving.
- **After that, motion matching** takes about 4 ms per request on the same PC, measured on your data.
- **`strokes`** fits strokes to every recording on first use: about 15 s on all cores, then cached in
  models/strokes/cache (about 1 s to load). After that about 2 ms per movement. `--preload` loads only
  the default model, so ask for one `strokes` movement first if the first real one has to be fast.
- **The generative model** runs 32 network steps per movement on the GPU. Its time per request hasn't been
  measured yet.
- The server handles one request at a time. Others wait their turn.

## 7. Calling it

Each example sends the request from section 2.

**Node 18+** (built-in `fetch`):

```js
const res = await fetch("http://localhost:8765/api/generate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ start: { x: 1200, y: 640 }, target: { left: 1738, top: 396, w: 96, h: 32 } }),
});
if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
const trial = await res.json();
console.log(trial.pos.length, trial.clicks);
```

**Python** (standard library only):

```python
import json
import urllib.request

body = {"start": {"x": 1200, "y": 640}, "target": {"left": 1738, "top": 396, "w": 96, "h": 32}}
req = urllib.request.Request("http://localhost:8765/api/generate", json.dumps(body).encode(),
                             {"Content-Type": "application/json"})
trial = json.load(urllib.request.urlopen(req))
print(len(trial["pos"]), trial["clicks"])
```

**PowerShell:**

```powershell
$body = @{ start = @{ x = 1200; y = 640 }; target = @{ left = 1738; top = 396; w = 96; h = 32 } } | ConvertTo-Json
$trial = Invoke-RestMethod -Method Post -Uri http://localhost:8765/api/generate -ContentType 'application/json' -Body $body
$trial.clicks
```

**curl** (Git Bash, Linux, macOS):

```bash
curl -s -X POST http://localhost:8765/api/generate -H "Content-Type: application/json" -d '{"start":{"x":1200,"y":640},"target":{"left":1738,"top":396,"w":96,"h":32}}'
```

A web page on another origin can't call the API: the server sends no CORS headers, so the browser
blocks the request. Scripts and programs are not affected.
