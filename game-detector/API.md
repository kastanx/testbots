# Detector API

`GET http://127.0.0.1:8790/`

**200**

```json
{"W": [[x1, y1, x2, y2], ...], "C": [[x1, y1, x2, y2]]}
```

- `W` wisps, `C` crater
- `[left, top, right, bottom]`, screen pixels

**503** no current detection

```json
{"W": [], "C": []}
```

Start: `run.bat detector.main --track`
Port: `--http PORT` · LAN: `--http-host 0.0.0.0`
