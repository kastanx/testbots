# Output of `POST /api/generate`

The response is one movement to the target and the click on it, from the moment the target appears
until the mouse button is released.

```json
{
  "pos": [[1200, 640], [1200, 640], "…", [1784, 412]],
  "clicks": [{"down": 908, "up": 1017}]
}
```

This example moves from (1200, 640) to a 96 × 32 button centred at (1786, 412). `pos` has 1018 entries.

## `pos`

- The cursor position for every millisecond: `pos[t]` is `[x, y]` at `t` ms.
- `t = 0` is the moment the target appears. `pos[0]` is the start position from the request.
- With `"skip_reaction": true`, `t = 0` is the moment the cursor starts moving, and `pos[1]` is
  already its first step.
- Coordinates are whole screen pixels in the same space as the request: the origin is the top-left
  corner, x goes right, y goes down.
- The same position repeated means the cursor isn't moving during those milliseconds: before it starts,
  when it pauses, or while the button is held.
- `pos` ends at the last release: its length is `clicks[-1].up + 1`.

## `clicks`

- One entry per click, in time order.
- `down` is the press and `up` the release, in ms since `t = 0`. They index `pos` directly.
- The press happens at `pos[down]`, and the button stays down until `up`. Any cursor movement while it
  is held is in `pos` between those two indexes.
- The hold length is `up − down` ms.
- Usually there is one click. When there are more, the earlier ones missed the target, as you sometimes
  do, and the cursor moves on to click again. The last click always lands on the target. With
  `"no_misses": true` there is always exactly one click, on the target.
- Clicks never overlap: each `up` comes before the next `down`.

## The example, step by step

| t (ms) | `pos[t]` | What happens |
|---|---|---|
| 0–265 | (1200, 640) | the cursor stays still |
| 266 | (1201, 640) | it starts moving |
| 267–892 | … | it moves to the button |
| 893 | (1784, 412) | the last movement |
| 908 | (1784, 412) | button down |
| 1017 | (1784, 412) | button up, last entry of `pos` |

## `"format": "changes"`

When the request has `"format": "changes"`, `pos` is replaced by `changes`, which lists only the moments
the position changes:

```json
{
  "changes": [[0, 1200, 640], [266, 1201, 640], [270, 1202, 640], "…", [893, 1784, 412]],
  "clicks": [{"down": 908, "up": 1017}]
}
```

- Each entry is `[t, x, y]`: from millisecond `t` the cursor is at (x, y), until the next entry.
- The first entry is `[0, start x, start y]`.
- The movement ends at the last click's `up`, the same as with `pos`.
