# click-recorder

Record and replay mouse clicks, with optional humanized timing.
Ships as a **desktop app** (Electron) and a **CLI**, both on **Windows** and **macOS**.

Both front-ends read and write the same `recordings.json`, in the same format —
you can record in the CLI and edit in the app, or the other way round.

## Install & run

```bash
npm install
npm start
```

`npm start` opens the app. `npm run cli` runs the original terminal version.

## The app

```
┌── Recordings ──┬───────── Click map ─────────┬──── Clicks ────┐
│ speed        7 │        ①                    │ #  X    Y  Delay│
│ ip7speed     7 │         \                   │ 1 957  341   397│
│ relleka      8 │      ⑤—④—③                  │ 2 650  507 16786│
│ ☑ releka2    8 │                             │ 3 715  593  7158│
└────────────────┴─────────────────────────────┴─────────────────┘
```

**Editing clicks**

| Action | How |
| ------ | --- |
| Add a click | Click empty space on the map, or **Add at cursor** / **Pick from screen** |
| Move a click | Drag its dot, or type exact X/Y in the table |
| Nudge precisely | Select it, then arrow keys (hold <kbd>Shift</kbd> for 10px) |
| Change timing | Edit the **Delay ms** column (time since the previous click) |
| Reorder | <kbd>Ctrl</kbd> + arrow keys — the delay travels with the click |
| Delete | <kbd>Delete</kbd>, or the × on the row |
| Zoom / pan | Scroll to zoom, <kbd>Shift</kbd>-drag or middle-drag to pan, **Fit** to reset |
| Undo / redo | <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> |
| Save | <kbd>Ctrl</kbd>+<kbd>S</kbd> |

Nothing touches `recordings.json` until you hit Save. Saves go through a temp
file and leave a `recordings.json.bak`.

**Playlists** — tick several recordings in the sidebar and playback picks one at
random each loop. With nothing ticked, it plays whatever is in the editor.

**Global hotkeys** work with the window unfocused:

| Key | Action |
| --- | ------ |
| <kbd>R</kbd> | start recording |
| <kbd>Space</kbd> | capture a click at the cursor |
| <kbd>S</kbd> | stop recording / stop playback |
| <kbd>P</kbd> | play, or pause/resume while playing |

They're suppressed while you're typing in a field, and while <kbd>Ctrl</kbd>,
<kbd>Alt</kbd> or <kbd>Win</kbd> is held — so <kbd>Ctrl</kbd>+<kbd>S</kbd> saves
rather than stopping a recording.

Because they're system-wide, they also fire when the app is in the background.
Click the **Hotkeys on** pill in the title bar to disarm them and drive the app
with the buttons instead.

## The CLI

```bash
npm run cli
```

Same hotkeys, plus <kbd>Q</kbd> to save and <kbd>L</kbd> to load a playlist.
<kbd>Ctrl</kbd>+<kbd>C</kbd> quits.

## How global hotkeys work

`input-monitor.js` spawns a small platform process that watches the keyboard
system-wide and writes one token per line to stdout (`READY`, `r`, `s`, `p`,
`space`, `q`, `l`). The two implementations are interchangeable:

- **Windows** — `recorder-win.ps1`, polling `GetAsyncKeyState` via PowerShell.
  No native module, no compilation, no admin rights. It's spawned with
  `-ExecutionPolicy Bypass`, so your machine's execution policy doesn't matter.
- **macOS** — `recorder`, compiled from `recorder.swift` using a `CGEventTap`.
  Rebuild with `swiftc recorder.swift -o recorder`. macOS also needs
  Accessibility permission (System Settings → Privacy & Security → Accessibility).

## Layout

| File | Role |
| ---- | ---- |
| `electron/main.js` | app main process: window, IPC, hotkeys, recording state |
| `electron/renderer/` | the UI (`index.html`, `styles.css`, `app.js`) |
| `recorder.js` | the CLI |
| `input-monitor.js` | shared global-hotkey monitor |
| `recordings-store.js` | shared `recordings.json` read/write |
| `replay-engine.js` | playback used by the app |
| `humanizer.js` | human-like timing, jitter and pauses |

## Data format

Unchanged from the original CLI:

```json
[{ "id": "…", "name": "…", "events": [{ "x": 957, "y": 341, "time": 397, "button": 0 }] }]
```

`time` is cumulative ms from the start of the recording. The editor shows
per-click delays instead and converts on load/save; the round-trip is exact and
preserves any extra per-event fields (such as the older `randomize` flag).

## Other scripts

```bash
npm run color        # colour under the cursor after 5s
npm run test-hook    # verify the global hotkey monitor
```

## Notes

Mouse control uses `@nut-tree-fork/nut-js`, whose native binary is N-API, so the
same build works in both Node and Electron with no rebuild step. `robotjs` and
`uiohook-napi` were dropped: neither has a prebuild for current Node on Windows.
