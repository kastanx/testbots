# pixelwatch

Watches one pixel on this PC. When the pixel stops matching its calibrated
colour, it fires a click at the Raspberry Pi, which clicks as a USB mouse.

```
screen pixel ──colorAt()──> watch.js ──POST /click──> Pi ──USB HID──> this PC
```

## Use

Pick the pixel (opens a browser, click the spot you want):

```
npm run calibrate
```

Then run the watcher:

```
npm run watch
```

## calibrate.js

Counts down 5 seconds so you can bring the right window to the front, takes a
screenshot, and serves it at `http://127.0.0.1:7333/`.

- **Click** anywhere on the screenshot to pick a pixel.
- **Arrow keys** nudge one pixel at a time — the magnifier in the corner shows
  exactly which pixel you are on. Worth using: anti-aliased edges look solid at
  a glance but read a blended colour.
- **Enter** or the Save button writes `config.json` and exits.

Re-running it replaces only the pixel and colour; `tolerance`, the interval
range, `verifyDelayMs` and `clickUrl` are preserved.

| Flag | Meaning |
|---|---|
| `--delay N` | Seconds before the screenshot (default 5, `0` for immediate) |

## watch.js

| Flag | Meaning |
|---|---|
| `--once` | One check, print whether it would click, exit |
| `--dry-run` | Run normally but never actually send a click |
| `--verbose` | Log every check, not just changes |

Without `--verbose` it logs only state changes and clicks, so it stays quiet
while the pixel is where it should be.

Failed clicks (Pi off, USB unplugged, wrong URL) are logged and the loop keeps
going. Ctrl+C prints a summary.

## config.json

Written by `calibrate.js`; edit by hand to tune.

```json
{
  "x": 247,
  "y": 481,
  "color": { "r": 200, "g": 10, "b": 50 },
  "tolerance": 12,
  "intervalMinMs": 1000,
  "intervalMaxMs": 5000,
  "verifyDelayMs": 5000,
  "clickUrl": "http://clicker.local:8080/click"
}
```

| Key | Meaning |
|---|---|
| `x`, `y` | Pixel to watch, in **logical** screen coordinates |
| `color` | Calibrated colour |
| `tolerance` | Max per-channel difference still counted as a match (0–255) |
| `intervalMinMs` | Shortest delay before the next check |
| `intervalMaxMs` | Longest delay before the next check |
| `verifyDelayMs` | How long the pixel has to come back after a click |
| `clickUrl` | The Pi's click endpoint |

Each check waits a **fresh random delay** between `intervalMinMs` and
`intervalMaxMs`, redrawn every tick — so the polling is not a metronome. Set
both to the same number for a fixed rate. `--verbose` prints each delay.

Raise `tolerance` if the pixel flickers between present and missing; lower it if
a genuinely different colour is being counted as a match.

## Aborting

After every click the watcher waits for the pixel to come back, re-checking a
few times a second for up to `verifyDelayMs`:

- **Pixel comes back** — normal polling resumes straight away. It does not sit
  out the full delay.
- **Pixel still missing when the delay runs out** — the click is not doing what
  it should, so the watcher logs `ABORT` and **exits with code 2** rather than
  clicking into the void.

A click that fails to send (Pi off, wrong URL) does not count: nothing reached
the Pi, so there is nothing to verify. Those are logged and retried.

`--dry-run` never exits; it logs `would ABORT` and carries on, so you can watch
the logic without the script stopping.

Exit codes: `0` normal stop (Ctrl+C, `--once`), `1` config or startup error,
`2` aborted because a click did not restore the pixel.

## DPI scaling

This is the one thing to be careful about.

`screen.colorAt()` takes **logical** coordinates, but screenshots come out at the
**physical** resolution. This display runs at 300% scale: logical 1280×720,
physical 3840×2160. The picker divides click coordinates by that factor before
saving, so `config.json` always holds logical coordinates.

The factor is computed at calibration time, not hardcoded — if you change your
display scaling or resolution, **re-run `npm run calibrate`**. Old coordinates
will point at the wrong place.

## Notes

- Only the primary display is captured.
- Pixel reads and screenshots both come from `@nut-tree-fork/nut-js`, already
  used by `get-color.js`. No new dependencies.
- The picker reads pixels in the browser via canvas, so nothing but the two
  numbers and a colour ever leaves the page.
---

# pixelwatch3 - three-spot variant

A separate pair of scripts in the same folder. The single-pixel `calibrate.js`
and `watch.js` above are untouched and keep their own `config.json`; this
variant has its own `config3.json` and shares no state with them.

Three pixels, each with a different job. One cycle evaluates them in order and
at most one rule fires:

| # | Spot | Rule |
|---|---|---|
| 1 | Guard | missing -> **abort**, exit 2 |
| 2 | Trigger | found -> **send a click** |
| 3 | Fallback | trigger missing **and** this missing -> **abort**, exit 3 |

Trigger missing but fallback present is the quiet case: no click, no abort.

The fallback is only read when the trigger is missing, since that is the only
time its state changes the outcome. Once the guard is gone the cycle stops
there - the trigger is not acted on.

## Use

```
node pixelwatch/calibrate3.js
```

```
node pixelwatch/watch3.js
```

Calibration keeps the single-pixel flow - countdown, magnifier, arrow-key
nudge - and walks through the three picks in order. Enter confirms each and
moves on; the last one saves.

**Each spot can have its own screenshot.** The three spots are usually not all
visible in the same screen state - the trigger in particular tends to appear
only once the guard's state has moved on - so the picker has a **Recapture**
button. Press it on any spot, switch to the window you want, and it takes a
fresh screenshot after the countdown; pick on that one instead.

A spot's colour is read from whichever screenshot was loaded when you picked
it, and stays with it. Recapturing for a later spot never rewrites an earlier
one's colour. Each chip shows which shot it came from (`shot #2`), and so does
the saved summary.

The countdown is timed on the server, not in the page: the tab will not be in
front while you set the screen up, and a backgrounded tab throttles its own
timers.

| Flag | Meaning |
|---|---|
| `--once` | Read all three, print which rule would fire, exit |
| `--dry-run` | Never click, never abort; logs what would have happened |
| `--verbose` | Log every cycle, not just changes |
| `--delay N` | (calibrate3) seconds before each capture, default 5 |

## config3.json

```json
{
  "spots": [
    { "x": 100, "y": 100, "color": { "r": 0, "g": 255, "b": 0 } },
    { "x": 200, "y": 150, "color": { "r": 255, "g": 0, "b": 0 } },
    { "x": 300, "y": 200, "color": { "r": 0, "g": 0, "b": 255 } }
  ],
  "tolerance": 12,
  "intervalMinMs": 1000,
  "intervalMaxMs": 5000,
  "clickUrl": "http://192.168.0.131:8080/click"
}
```

`spots` is ordered: guard, trigger, fallback. Interval and tolerance behave
exactly as in the single-pixel version - a fresh random delay every cycle.

Re-running `calibrate3.js` replaces only the three pixels; tolerance, interval
range and `clickUrl` are preserved.

Exit codes: `0` normal stop (Ctrl+C, `--once`), `1` config or startup error,
`2` guard missing, `3` trigger and fallback both missing.

There is deliberately **no post-click verification** here - the single-pixel
version re-checks its pixel after clicking and aborts if it does not come back,
but this variant's stopping conditions are rules 1 and 3 instead.
---

# smithing (was alarm.js) - watchdog variant

A third pair of scripts in the same folder, again with its own config
(`config-smithing.json`) and sharing no state with the other two.

One pixel, no clicking at all, and it never stops on its own. The alarm
**latches**, so a pixel that stays missing does not keep pushing:

| State | Pixel | Result |
|---|---|---|
| armed | missing | push once, then **disarm** |
| fired | missing | silent, however long it lasts |
| fired | back | **re-arm**, ready to push again |
| armed | present | nothing |

It starts armed, so a pixel that is already gone at startup pushes once.

One notification per missing episode. If the pixel flickers away and back ten
times you get ten pushes - one per episode - not one per check.

| Event | Result |
|---|---|
| Pixel disappears | push to ntfy, keep running |
| Pixel stays gone | silence |
| Pixel returns | re-armed, logged locally, no push |
| Ctrl+C | exit 0 with a summary |
| Unexpected crash | push `Alarm crashed: ...`, exit 1 |

It never contacts the Pi and has no `clickUrl`. A missing pixel never exits -
only Ctrl+C, a config error or a crash ends it.

Recovery is logged but deliberately not pushed, to keep the alerting quiet.

## Use

```
node pixelwatch/calibrate-smithing.js
```

```
node pixelwatch/smithing.js
```

Calibration is the original single-pixel flow, and it reuses `picker.html`
read-only - the same page the original `calibrate.js` serves.

| Flag | Meaning |
|---|---|
| `--once` | One check, print what would happen, exit |
| `--dry-run` | Never actually notify; still tracks armed/fired |
| `--verbose` | Log every check, with `[armed]` / `[fired]` |
| `--test-notify` | Send one push and exit; works before calibration |
| `--delay N` | (calibrate-smithing) seconds before the screenshot, default 5 |

## config-smithing.json

```json
{
  "x": 100,
  "y": 100,
  "color": { "r": 0, "g": 255, "b": 0 },
  "tolerance": 12,
  "intervalMinMs": 1000,
  "intervalMaxMs": 5000,
  "notify": {
    "url": "https://ntfy.sh/rs3gem123",
    "title": "smithing",
    "priority": "high"
  }
}
```

The title differs from the three-spot watcher's on purpose: if both are running
they push to the same topic, and the phone alert needs to say which one fired.

It fires on the **first** miss of an episode. If a flickering pixel gives false
alarms, raise `tolerance` first.
---

# pixelwatch3 v2 - watch3 plus a servo

`watch3.js` with two additions. Everything else - the three pixels, the rules,
the clicking through the Pi, the intervals, the calibration - is the same.
Its own config (`config3v2.json`); `watch3.js` is untouched.

Same rules as `watch3.js`, one cycle, in order:

| # | Condition | watch3.js | watch3v2.js |
|---|---|---|---|
| 1 | Guard missing | stop | **pause** |
| 2 | Trigger found | click | click |
| 3 | Trigger and fallback missing | stop | **pause** |

**Addition 1 - the servo.** The servo on the Arduino (`arduino/servo_control`,
through `servo.js`) goes to `activeAngle` (5) as soon as pixel 1 (guard) and
pixel 3 (fallback) are both present, and to `homeAngle` (90) as soon as either
is missing. It looks at those two pixels only - not pixel 2, not the rules,
not whether clicking is paused.

**Addition 2 - pause instead of stop, for the clicking.** Where `watch3.js`
exits, this pauses the clicking: one push, no clicks. Clicking resumes once it
has seen, in order:

1. the trigger (pixel 2)
2. then the guard (pixel 1)
3. then the fallback (pixel 3), with the guard still there

The servo keeps following pixels 1 and 3 throughout a pause. It never exits on
pixel state; only Ctrl+C stops it.

A re-arm step counts its pixel when a check finds it present - it need not
have been absent first. Several steps can complete on one check, and the rules
run on the check that completes the sequence. The sequence is only checked from
the check after a pause began.

All three pixels are read every cycle (watch3.js skips the fallback while the
trigger is present), because the servo needs the fallback either way.

## The servo

- Only one program can hold the Arduino's COM port. Close `servo-cli.js` or
  the servo web page (press Disconnect) first.
- The script tracks where the servo should be and re-sends it whenever that
  isn't confirmed, so an Arduino restart, a dropped command or a reconnect all
  heal by themselves.
- USB unplugged: one push; clicking carries on; it retries every 5 s and
  re-sends the position when the Arduino is back.
- `PIXELWATCH_CONFIG3V2=<path>` runs against another config file - that's how
  tests run without touching the real `config3v2.json`.
- **Ctrl+C sends the servo home before exiting.** A crash tries to as well.
- Angles outside the firmware's `LIMITS` are clamped; the script warns.

## Use

```
node pixelwatch/watch3v2.js
```

`config3v2.json` starts with the same three pixels as `config3.json`. To pick
different ones for v2 only:

```
node pixelwatch/calibrate3v2.js
```

| Flag | Meaning |
|---|---|
| `--once` | Read all three, print the rule and servo position, exit. Port not opened. |
| `--dry-run` | Never clicks, never opens the servo port, never pushes; logs what it would do |
| `--verbose` | Log every cycle, the state and which re-arm step it's on |
| `--test-notify` | Send one push and exit |

## config3v2.json

`config3.json`'s fields plus `servo`:

```json
"servo": { "activeAngle": 5, "homeAngle": 90, "port": "" }
```

`servo.port` empty means `$SERVO_PORT`, else auto-detect (the Uno is COM4 here).

Exit codes: `0` normal stop (Ctrl+C, `--once`), `1` config or startup error,
including the servo port being busy or missing at startup.
---

# mining_old (was watch3v3.js) - servo 2 presses instead of the Pi

`watch3v2.js` with one change: where v2 POSTs a click to the Pi's HTTP mouse,
v3 presses with **servo 2** (pin D10) - to `pressAngle` (0), hold
`pressHoldMs`, then back to the middle of its range. Servo 2 rests at that
middle between presses. `watch3v2.js` is untouched.

Everything else is v2:

| # | Condition | v2 | v3 |
|---|---|---|---|
| 1 | Guard missing | pause | pause |
| 2 | Trigger found | click via the Pi | **press with servo 2** |
| 3 | Trigger and fallback missing | pause | pause |

- **Servo 1** (pin D9) is **pressed** (`servo.activeAngle`, 5) while pixels 1
  and 3 are both present, and **released** to the middle of its range as soon
  as either or both are missing. It looks at pixels 1 and 3 only - not pixel 2,
  not the rules, not a pause.
- **Servo 2** (pin D10) taps on pixel 2 (the trigger), as the table above says.
- **Pause:** one push, no presses; re-arms on trigger, then guard, then fallback.
- Never exits on pixel state. Ctrl+C releases servo 1 and centers servo 2.

## Pixels are shared with v2

v3 has no calibration of its own. It reads the three pixels - and tolerance,
interval, servo 1's pressed angle, COM port and push topic - from **`config3v2.json`**,
the file `calibrate3v2.js` writes. It never writes that file. Recalibrating
with `calibrate3v2.js` updates v2 and v3 together.

`config-mining_old.json` only holds what v3 adds:

```json
{
  "servo2": { "pressAngle": 0, "pressHoldMs": 250 },
  "notify": { "title": "mining_old" }
}
```

`pressHoldMs` has to cover the travel as well as the dwell: at full speed the
firmware reports the move done at once while the servo is still swinging,
roughly 150 ms for 90 degrees on an SG90. Lengthen it if the press doesn't
land.

## Use

```
node pixelwatch/mining_old.js
```

Only one program can hold COM4: close `watch3v2.js`, `servo-cli.js`, and the
servo web page (press Disconnect) first.

| Flag | Meaning |
|---|---|
| `--once` | Read all three, print the rule and servo 1 position, exit. Port not opened. |
| `--dry-run` | Never opens the port, never pushes; logs every move and push it would make |
| `--verbose` | Log every cycle, the state and which re-arm step it's on |
| `--test-notify` | Send one push and exit |

**Power:** both servos run off the Uno's USB 5 V. A press on servo 2 while
servo 1 is moving can pull enough to restart the Arduino; the script re-sends
both positions when that happens, but a separate 5 V supply avoids it.

Exit codes: `0` normal stop (Ctrl+C, `--once`), `1` config or startup error,
including the port being busy or the board reporting fewer than two servos.
---

# pixelwatch taps - a sequence of three pixels

A separate script with its own calibration (`config-taps.json`). No other
script or config is read or written.

A fixed sequence, one step at a time:

| Step | Waits for | Then | Next |
|---|---|---|---|
| 1 | pixel 1 | servo 1 taps | step 2 |
| 2 | pixel 2 | servo 2 taps | step 3 |
| 3 | pixel 3 | wait 500-1000 ms, then servo 2 taps twice | back to step 1 |

The step 3 wait is a fresh random value each time (`step3Delay` in the config).
Ctrl+C during that wait cancels the double tap. Steps 1 and 2 tap straight away.

- Each check looks **only at the current step's pixel**. A pixel showing out
  of turn does nothing - pixel 3 on screen during step 1 is ignored until the
  sequence reaches step 3.
- A step advances only once all its taps went through. A failed tap (e.g. the
  Arduino not answering) is retried on the next check rather than skipped.
- A **tap** sends the servo to its tap angle (servo 1: 5, servo 2: 0), holds
  `tap.holdMs`, brings it back to the middle of its range and waits
  `tap.gapMs`. Both servos rest at the middle and never move at the same time.
- Nothing pauses and nothing exits on pixel state; only Ctrl+C stops it, after
  centering both servos. The summary says which step it stopped at.

**Timing.** Checks start 100-150 ms apart, a fresh random value each time.
When a step's taps take longer than that, the next check starts as soon as
they end. Two things make the range hold:

- Pixels are read with a 1x1 screen grab - the same value as nut.js
  `colorAt()`, but about 7 ms instead of about 55 ms.
- Windows timers fire up to ~16 ms late, so the wait sleeps to just short of
  the target and finishes on the event loop. Measured: 39/39 gaps within
  100-150 ms, at about 8% of one CPU core.

## Use

```
node pixelwatch/calibrate-taps.js
```

```
node pixelwatch/watch-taps.js
```

Calibration is the three-spot flow - screenshot, magnifier, arrow-key nudge,
and a **Recapture** button per spot, since the three pixels are usually on
screen at different times. It serves `picker3.html` read-only.

Pick pixels with a distinctive colour. A near-black or grey pixel can still
match the dark background left behind when the thing you're watching goes
away, and then it never reads as missing.

| Flag | Meaning |
|---|---|
| `--once` | Read all three, say what step 1 would do, exit. Port not opened. |
| `--dry-run` | Never opens the port; logs every tap and step change it would make |
| `--verbose` | Log every check's read, with millisecond timestamps |
| `--delay N` | (calibrate-taps) seconds before each capture, default 5 |

Only one program can hold COM4: close `watch3v2.js`, `mining_old.js`,
`servo-cli.js` and the servo web page (press Disconnect) first.

## config-taps.json

```json
{
  "spots": [ ... pixel 1, pixel 2, pixel 3 ... ],
  "tolerance": 12,
  "intervalMinMs": 100,
  "intervalMaxMs": 150,
  "servo1": { "tapAngle": 5 },
  "servo2": { "tapAngle": 0 },
  "tap": { "holdMs": 250, "gapMs": 200 },
  "step3Delay": { "minMs": 500, "maxMs": 1000 },
  "port": ""
}
```

`holdMs` covers the travel to the tap angle as well as the time there - about
150 ms for an SG90 swinging 90 degrees at full speed. `gapMs` covers the
travel back; without it the two taps of a double tap wouldn't separate.
Re-running the calibrator replaces only the pixels.

Exit codes: `0` normal stop (Ctrl+C, `--once`), `1` config or startup error.
---

# archeology (was watch-hold.js) - A/B hold, C/D tap, E tap

A separate script with its own calibration (`config-archeology.json`). No other
script or config is read or written.

Control pixels: **A** is a group of 28 blocks of 10x10 pixels, **B** and **C**
are one or more variations each, **D** and **E** are one pixel each. Servo 1
presses two buttons - button 1 at 5, button 2 at 126 - and rests at the middle
of its range. Servo 2 taps at 0.

**B and C variations.** B and C can each have any number of variations - each
its own pixel and colour, e.g. how it looks in different states. The group
counts as **present when any one of its variations is present**, and as
missing only when all of them are - for every check of it: for B starting a
hold, just before pressing, and while holding; for C the button 1 tap (which
needs C missing, i.e. none of its variations there). `add-b-archeology.js` and
`add-c-archeology.js` add variations (see Use).

**A blocks.** Each A control is the 10x10 square around the point you click,
from 5 pixels left/up of it to 4 right/down. It counts as present only when
**every one** of its 100 pixels still matches the calibration (each within the
tolerance); anything that changes even one pixel inside the block makes it
missing. `blockMatchPercent` lowers that (e.g. 95: up to 5 pixels may differ).

Three sections, each on its own check interval:

| # | Checks every | Condition | Action |
|---|---|---|---|
| 1 | 500-1000 ms | **at least 27 of the 28 A** missing (at most one left) **and** B present (any variation) | servo 1 **holds button 2** until B goes missing (all variations), at most 5 s |
| 2 | 100-150 ms | C missing (all variations) **and** D present | servo 1 **taps button 1**, then no checks for 3000-5000 ms |
| 3 | 3000-5000 ms | E present | servo 2 **taps** |

**The hold.** While servo 1 holds button 2, only B is checked - every
100-150 ms, so the release follows B quickly - and nothing else looks at the
screen: sections 2 and 3 stand still. The hold ends when B goes missing or at
the 5 s limit, and checking resumes one interval (500-1000 ms) later. If the
condition still holds then, a new hold starts.

**The cooldown.** After a button 1 tap, section 2 doesn't look at C and D again
for 3000-5000 ms, counted from the end of the tap.

**E goes first.** When section 1 is about to hold, or section 2 is about to
tap, E is checked right then: if it's present, servo 2 taps first and
finishes, and only then does the hold or the tap go ahead. After that tap the
hold checks A and B again before pressing, and section 2 checks C and D again
before tapping (no hold/tap if they no longer say so). When neither section is
about to act, nothing extra checks E. Section 3's own E check every 3-5 s runs
as well, unchanged - so if E is still there right after one of its taps, an
E-first check can tap it again.

**One move at a time.** Taps and holds never overlap: a tap finishes before the
next tap or a hold starts, and the two servos never move at the same time (both
at once can pull more than USB gives and restart the Arduino). A hold cancels
every section 2 and 3 tap whose pixels were read before it was decided, and A
and B are checked again right before pressing.

**Timing.** Checks start their interval apart, measured start to start; an
action that runs longer delays the next check until it ends. Waits are precise
to ~1 ms (Windows timers alone can be ~16 ms late); with a 100-150 ms section
running this costs a small share of one CPU core.

**Reading 28 blocks fast.** The A group is read from one grab of the area
around it - about 7 ms for an inventory-sized area - instead of 28 separate
reads. The values are the same as single-pixel reads (checked 30/30 on static
pixels).

## Use

```
node pixelwatch/calibrate-archeology.js
```

```
node pixelwatch/archeology.js
```

Calibration uses `picker-groups.html`: groups in order A, B, C, D, E. In group
A each click adds a block (28 in all), drawn as a box around the click;
Backspace removes the last, the arrow keys nudge it, and Enter moves to the
next group once it's full. Clicking a group's chip goes back to it.
**Recapture** takes a fresh screenshot whenever a group needs a different
screen state; every pick keeps the colours from the screenshot it was picked
on.

To redo just some groups and keep the rest exactly as they are, name them:

```
node pixelwatch/calibrate-archeology.js --only A
```

The page then shows only those groups and says which ones it keeps; saving
replaces only them - the other groups and all the settings stay untouched.
(`--only B` / `--only C` replaces all of that group's variations with the ones
picked.)

To **add** variations of B or C, keeping the saved ones and everything else:

```
node pixelwatch/add-b-archeology.js
```

```
node pixelwatch/add-c-archeology.js
```

The page shows the group's saved variations as dashed markers (B1, B2, ...) and
numbers the new ones after them; click one or more (Recapture in between if it
looks different in another screen state), then Save. Each run only appends -
nothing already saved is changed. `add-b-archeology.js` / `add-c-archeology.js` are
`calibrate-archeology.js --add B` / `--add C`.

| Flag | Meaning |
|---|---|
| `--once` | Read every pixel, print what each section would do, exit. Port not opened. Lists which A blocks and which B and C variations are present. |
| `--dry-run` | Never opens the port; runs the sections and logs what they'd do |
| `--verbose` | Log every check, with millisecond timestamps |
| `--only A` | (calibrate-archeology) pick only these groups, comma-separated (`A,B`); keep the rest |
| `--add B` | (calibrate-archeology) add variations to B (or `--add C`), keeping everything saved; same as `add-b-archeology.js` / `add-c-archeology.js` |
| `--delay N` | (calibrate-archeology) seconds before each capture, default 5 |
| `--no-open` | (calibrate-archeology) don't open a browser tab, just print the address |

Only one program can hold COM4: close the other watchers, `servo-cli.js` and the
servo web page (press Disconnect) first. Ctrl+C centers both servos, releasing a
hold, before exiting.

## config-archeology.json

```json
{
  "pixels": { "A": [ ... 28 ... ], "B": [ ... ], "C": [ ... ], "D": [ ... ], "E": [ ... ] },
  "tolerance": 12,
  "blockMatchPercent": 100,
  "servo1": { "button1Angle": 5, "button2Angle": 126 },
  "servo2": { "tapAngle": 0 },
  "tap": { "holdMs": 250, "gapMs": 200 },
  "hold": {
    "intervalMinMs": 500, "intervalMaxMs": 1000,
    "minAMissing": 27,
    "releaseCheckMinMs": 100, "releaseCheckMaxMs": 150,
    "maxHoldMs": 5000
  },
  "button1Tap": {
    "intervalMinMs": 100, "intervalMaxMs": 150,
    "cooldownMinMs": 3000, "cooldownMaxMs": 5000
  },
  "servo2Tap": { "intervalMinMs": 3000, "intervalMaxMs": 5000 },
  "port": ""
}
```

Each A entry is `{ x, y, color, block }`: the clicked point, its colour, and
the block's 100 colours as 10 strings (one per row, top to bottom) of 10 hex
`RRGGBB` values. B-E are `{ x, y, color }`; B's and C's lists hold one entry
per variation (at least one), D and E exactly one. A calibration from before the
blocks has no `block` for A; archeology says so and asks for
`--only A`.

`hold.minAMissing` is how many of the 28 A blocks must be missing (28: all of
them). `hold.releaseCheck*` is how often B is checked during a hold.

Re-running the calibrator replaces only the pixels it picked. `PIXELWATCH_CONFIG_ARCHEOLOGY`
points both scripts at another file - that's how the tests run without
touching the real one.

Exit codes: `0` normal stop (Ctrl+C, `--once`), `1` config or startup error.

---

# mining - pixel A taps; a full inventory taps, then pauses

`node pixelwatch/mining.js` - its own pixel A (`config-mining.json`, picked
with `calibrate-mining.js`), plus archeology's 28 inventory spaces, read from
`config-archeology.json` and never written.

Two checks, each every 3-5 s:

| Check | Condition | Action |
|---|---|---|
| pixel A | A present | servo 2 **taps** (0 and back to the middle) |
| inventory | 24 or more of the 28 spaces occupied | servo 1 **taps** (5 and back); 1 s later the spaces are counted again: still 24 or more -> one push, and **pause**. Fewer than 24 occupied -> nothing. |

**Occupied.** Archeology's 28 blocks were calibrated on empty slots, so a space
counts as occupied when its 10x10 block no longer matches - the same test
archeology uses, with archeology's tolerance and blockMatchPercent.
Recalibrating archeology's inventory (`calibrate-archeology.js --only A`)
changes it for mining too.

**The tap cycle.** Check -> servo 1 taps -> 1 s (from when servo 1 is sent
back) -> count again -> pause if still 24+ -> next check 3-5 s after that
second count. Servo 2 doesn't tap in between.

**Paused.** Nothing is tapped and pixel A isn't checked. The inventory is
still counted every 3-5 s, and once fewer than 24 spaces are occupied mining
resumes by itself. One push per pause (title "mining").

## Use

```
node pixelwatch/calibrate-mining.js
```

```
node pixelwatch/mining.js
```

| Flag | Meaning |
|---|---|
| `--once` | Read pixel A and the inventory, print what would happen, exit. Port not opened. Lists the empty spaces. |
| `--dry-run` | Never opens the port, never pushes; logs what it would do |
| `--verbose` | Log every check, with millisecond timestamps |
| `--test-notify` | Send one push and exit |
| `--delay N` | (calibrate-mining) seconds before each capture, default 5 |
| `--no-open` | (calibrate-mining) don't open a browser tab, just print the address |

Only one program can hold COM4: close the other servo watchers, `servo-cli.js`
and the servo web page first. Ctrl+C centers both servos before exiting.

## config-mining.json

```json
{
  "pixels": { "A": [ { "x": 0, "y": 0, "color": { "r": 0, "g": 0, "b": 0 } } ] },
  "tolerance": 12,
  "servo2": { "tapAngle": 0 },
  "servo1": { "tapAngle": 5 },
  "tap": { "holdMs": 250, "gapMs": 200 },
  "pixelA": { "intervalMinMs": 3000, "intervalMaxMs": 5000 },
  "inventory": {
    "intervalMinMs": 3000, "intervalMaxMs": 5000,
    "minOccupied": 24,
    "recheckMs": 1000
  },
  "notify": { "url": "https://ntfy.sh/rs3gem123", "title": "mining", "priority": "high" },
  "port": ""
}
```

`tolerance` is for pixel A only. `PIXELWATCH_CONFIG_MINING` points mining at
another file (and `PIXELWATCH_CONFIG_ARCHEOLOGY` the inventory) - that's how
the tests run without touching the real ones.

Exit codes: `0` normal stop (Ctrl+C, `--once`), `1` config or startup error.

---

# mouseover - pixel A missing clicks a wisp, or the crater

`node pixelwatch/mouseover.js` - its own pixel A (`config-mouseover.json`,
picked with `calibrate-mouseover.js`), archeology's 28 inventory spaces (read
from `config-archeology.json`, never written), game-detector's wisps and
crater, mouse-sim's paths and the Pi as the mouse.

Every 3-5 s, while RuneScape is the active window:

| Pixel A | Inventory | Clicked |
|---|---|---|
| present | anything | nothing |
| missing | not full | the nearest **wisp** (`W`) |
| missing | full - 27 or more of 28 occupied | the **crater** (`C`) |

A click:

1. game-detector (`GET http://127.0.0.1:8790/`) lists the wisps and the crater
   it sees;
2. the one of that kind nearest the pointer is the target;
3. mouse-sim makes a path from the pointer onto it with one click on it
   (`skip_reaction`, `no_misses`) - also when the pointer is on it already,
   which makes a short path and a click where it is;
4. the Pi plays the path and the click as the mouse (`/moveclick`).

**Only into the game.** Nothing is moved or clicked unless the window titled
exactly "RuneScape" is the active one and the press lands inside it - checked
before each check and again right before the Pi plays the path. Switching to
another app pauses mouseover ("isn't the active window - waiting"), and it
carries on when the game is back in front.

**Hover only.** With `"click": false` the Pi plays only the movement
(`/moveclick?noclick=1`), and a check does nothing while the pointer is on the
target already.

**Full.** Archeology's 28 blocks were calibrated on empty slots, so a space
counts as occupied when its 10x10 block no longer matches - the same test
archeology and mining use. Full is 27 or more occupied, as in mining
(`fullAt`).

**On the target.** A detector box also holds background around the wisp or
crater, so the path aims at the middle half of the box (`inset` 0.25 trims a
quarter of the width and of the height off each side), and "already on it"
means inside that middle half.

**Starting the rest.** game-detector and mouse-sim are started if they don't
answer, each in its own minimized window (in the taskbar, so they never cover
the game), and mouseover waits until they answer (measured: the detector 3.6 s,
mouse-sim 2.1 s). The detector runs without its preview: that window is always
on top, half the screen wide, and opens wherever Windows puts it - often over
the game, where the pointer would then hover on the preview instead. If one of
them stops, its window stays open on "Press any key" so its last lines can be
read. When mouseover stops - Ctrl+C, Ctrl+Break or closing its window - it
first lets a click the Pi is playing finish, so the button is never left down,
then closes the windows it opened, which frees the GPU from the detector. Ones
that were already running are left alone. The Pi is never started: its
services run by themselves.

It reads the pointer position but never moves it itself - only the Pi does. If
the pointer moved while the path was being made, that check is skipped: the Pi
moves relative to where the pointer is. No servos, so it can run next to the
servo scripts.

The Pi's moves only land on the planned pixels with Windows "Enhance pointer
precision" off (see autoclicker's README) and display scaling at 100 %.

## Use

```
node pixelwatch/calibrate-mouseover.js
```

```
node pixelwatch/mouseover.js
```

| Flag | Meaning |
|---|---|
| `--once` | Read pixel A and the inventory, list the wisps and the crater, make the path and click it would play, exit. Moves, clicks and starts nothing. |
| `--dry-run` | Everything but the click: the paths are made, never sent to the Pi |
| `--verbose` | Log every check, not just clicks |
| `--delay N` | (calibrate-mouseover) seconds before each capture, default 5 |
| `--no-open` | (calibrate-mouseover) don't open a browser tab, just print the address |

## config-mouseover.json

`calibrate-mouseover.js` writes pixel A into it. Everything else is optional:
without it the defaults below apply, so give only what you change.

```json
{
  "pixels": { "A": [ { "x": 0, "y": 0, "color": { "r": 0, "g": 0, "b": 0 } } ] },
  "tolerance": 12,
  "inventory": { "intervalMinMs": 3000, "intervalMaxMs": 5000, "fullAt": 27 },
  "click": true,
  "window": "RuneScape",
  "autostart": true,
  "detector": {
    "url": "http://127.0.0.1:8790/", "timeoutMs": 2000,
    "start": { "dir": "game-detector", "command": "call .\\run.bat detector.main --track --no-preview --http {port}",
               "title": "game-detector", "readyMs": 120000 }
  },
  "mouseSim": {
    "url": "http://127.0.0.1:8765/api/generate", "timeoutMs": 5000,
    "start": { "dir": "mouse-sim", "command": ".venv\\Scripts\\python.exe serve.py --port {port} --preload",
               "title": "mouse-sim server", "readyMs": 60000 }
  },
  "pi": { "url": "http://192.168.0.131:8080/moveclick", "timeoutMs": 20000 },
  "inset": 0.25
}
```

`tolerance` is for pixel A only. `fullAt` 27 means 27 or more occupied is
full. `click` false only moves the pointer. `window` is the exact title of the
window that has to be in front; `""` turns that check off. `start.dir` is
relative to the testbots folder, `{port}` is the url's
port, and `readyMs` is how long it waits for the server to answer. To get the
detector's preview back, drop `--no-preview` from its command - then drag the
preview off the game. Only servers on this PC (127.0.0.1, localhost) are
started. `PIXELWATCH_CONFIG_MOUSEOVER` points mouseover at another file (and
`PIXELWATCH_CONFIG_ARCHEOLOGY` the inventory) - that's how the tests run without
touching the real ones.

Exit codes: `0` normal stop (Ctrl+C, `--once`), `1` config or startup error.

---

# mouseover2 - fill at the wisps, dump at the crater

`node pixelwatch/mouseover2.js` - a second version of mouseover, with its own
pixels A, B and C (`config-mouseover2.json`, picked with
`calibrate-mouseover2.js`). mouseover and its config are left as they are. The
same parts do the clicks: archeology's 28 inventory spaces (read only),
game-detector's wisps and crater, mouse-sim's paths and the Pi as the mouse.

The inventory and pixels A, B and C are read every 1-1.5 s, and two phases
decide the clicks:

| Phase | What it sees | Clicked |
|---|---|---|
| filling | full (28 of 28), or pixel A appears | the **crater** - and it's dumping |
| filling | items still coming in | nothing |
| filling | nothing added for 6-10 s, 24 or more occupied | the **crater** - dumping now rather than filling up with another wisp |
| filling | nothing added for 6-10 s, fewer than 24 | a **wisp** |
| dumping | pixels B and C both missing | a **wisp** - nothing left to dump - and it's filling |
| dumping | items still going out | nothing |
| dumping | nothing removed for 2-4 s, fewer than 4 left | a **wisp** - and it's filling |
| dumping | nothing removed for 2-4 s, 4 or more left | the **crater** again |

**Nothing to dump.** Pixels B and C both missing means there's nothing left to
dump, however many spaces are occupied: dumping ends there and then, without
waiting for a quiet spell. While either is there, there is something to dump.
With nothing to dump the crater is never clicked - a full inventory then just
waits, and says so once.

**24 or more.** That's checked only when a filling has *ended* (nothing added
for 6-10 s) without the inventory being full: instead of starting another wisp
to fill up the last few spaces, it dumps now. While items are still coming in,
24 changes nothing.

**No double clicks on the way.** After a click nothing more is clicked until
the inventory moves the right way - items coming in after a wisp click (the
start of filling), going out after a crater click (the start of dumping),
which is the proof the character got there. If that doesn't happen within
5-10 s, the click counts as failed and is made again.

**Ranges.** Every range is drawn anew each time: the quiet spells after every
item that comes in or goes out, the waits at every click.

**Misreads.** Full, emptied and B-and-C-gone have to show on two readings in a
row, so one bad reading can't start or end a trip to the crater. Pixel A counts when it
*appears*: present on two readings in a row after being missing. Present from
the start, or still present after dumping, it doesn't count - so it can't send
it back to the crater over and over.

**Starting.** It watches first: the first click comes only after a quiet spell,
so starting it in the middle of harvesting or dumping doesn't interrupt
anything. It starts in the dumping phase when the inventory is full or pixel A
is present - and there is something to dump - otherwise filling.

**Moving wisps.** Before a wisp click the detector is looked at 4 times, 120 ms
apart, and each wisp is followed across the looks:

- **Standing still is preferred.** Moving or still is measured against the
  crater when it's in view: the crater doesn't move, so when the camera turns or
  the character walks everything shifts together and nothing counts as moving.
  The nearest wisp slower than 40 px/s is clicked, even when a moving one is
  nearer. Wisps are matched from look to look against the crater too, so a
  fast slide of the view doesn't swap two of them.
- **A moving wisp is met where it's going.** If every wisp moves, the nearest
  one is clicked: the path aims a little further along its way, and is held
  back (up to 0.8 s) so the press lands just as the wisp gets there - worked
  out from that path's own press time, so mouse-sim's varied paths don't throw
  it off. Measured on a wisp moving 150 px/s, 10 runs each: aimed this way
  10/10 presses landed on its centre line (3-5 px off it sideways); not aimed
  ahead, 0/10 - about 100 px behind, the misses you saw. "Where it's going" is
  on screen: a wisp standing still against the crater while the view slides
  (the character walking) is aimed ahead by the slide.
- **Followed all the way there.** The path goes to the Pi in one piece, and
  from that moment until 60 ms before the press every new detector frame (about
  30 a second) is used. The wisp is looked for where it should be - the crater
  as seen in that frame plus the wisp's own place against it - and its own
  movement and the crater's (the view) are each fitted over the last 200 ms.
  Whenever the press would land more than 6 px off where the wisp will be at
  the press, the rest of the path is bent there: the Pi's `/steer`
  (autoclicker), which blends the correction into the movement still to come
  like a hand correcting itself, and holds the press back if the bend needs
  longer than is left. That happens as often as needed - each new frame can
  bend it again. The spot on the wisp the path pressed (mouse-sim's choice) is
  kept. Lost for 150 ms: the nearest wisp is followed instead. No wisp in view
  at all for 150 ms: the click is called off and the path plays out without
  it. The log line says what happened: `followed it 600 ms (18 frames), it
  moved 83 px against the crater; steered 4x, the press 96 px over`, or `the
  view slid 54 px` when it was the view.

  Tested with fakes that behave like game-detector (a frame every 33 ms,
  20 ms late) and the Pi: a still wisp that sets off at 150 px/s as the
  pointer leaves was pressed 3-9 px from its centre (161 px behind it without
  following); at 300 px/s, 1-9 px; one that turns 90 degrees on the way, 7 px;
  the view sliding 100 px/s, 4-9 px. A Pi without `/steer` (an older
  autoclicker) is said once, and the clicks go on as before.

A click itself: the target of that kind nearest the pointer (for wisps as
above), a mouse-sim path with one click aimed at the middle half of the box,
played by the Pi - only while "RuneScape" is the active window and the press
lands inside it (otherwise nothing is even read). game-detector and mouse-sim
are started minimized if they don't answer and closed again when it stops.
`mouseover2-phases.js` holds the phase logic and `mouseover2-aim.js` the wisp
tracking, each on its own without the screen or the network.

## Use

```
node pixelwatch/calibrate-mouseover2.js
```

It picks the pixels that aren't calibrated yet - with A already there, just B
and C - and keeps the rest; once all three are there it picks all three again.
`--only B,C` picks exactly those.

```
node pixelwatch/mouseover2.js
node pixelwatch/mouseover2.js --model replay
```

Before the first click it has mouse-sim load the chosen model (`mouse-sim: strokes model ready`). A
mouse-sim still running from before the stroke model existed doesn't know it: mouseover2 then stops
and says to close that window - started again, it starts the new one. Both models give one position per
millisecond in whole pixels, played by the Pi at up to 1000 reports a second, as recorded with the
Rival at 800 DPI.

| Flag | Meaning |
|---|---|
| `--once` | Read pixels A, B, C and the inventory, say whether there's something to dump and which phase it would start in, list the wisps with their speeds and the crater, exit. Moves, clicks and starts nothing. |
| `--dry-run` | Everything but the click: the phases run and the paths are made, never sent to the Pi (each "click" then waits out its wait) |
| `--verbose` | Log every reading, not just phase changes and clicks |
| `--model strokes` | (default) mouse-sim's stroke model makes the paths: new movements built from your recorded strokes, never the same twice |
| `--model replay` | mouse-sim's motion matching makes the paths: your recorded movements played back, fitted to the click (what was used before 2026-10-11) |
| `--only A,B,C` | (calibrate-mouseover2) pick just these pixels; the others stay as they are |
| `--delay N` | (calibrate-mouseover2) seconds before each capture, default 5 |
| `--no-open` | (calibrate-mouseover2) don't open a browser tab, just print the address |

## config-mouseover2.json

`calibrate-mouseover2.js` writes pixels A, B and C into it. Everything else is
optional: give only what you change. Besides these it takes the same `click`,
`window`, `autostart`, `detector`, `mouseSim`, `pi` and `inset` as mouseover.

```json
{
  "pixels": {
    "A": [ { "x": 0, "y": 0, "color": { "r": 0, "g": 0, "b": 0 } } ],
    "B": [ { "x": 0, "y": 0, "color": { "r": 0, "g": 0, "b": 0 } } ],
    "C": [ { "x": 0, "y": 0, "color": { "r": 0, "g": 0, "b": 0 } } ]
  },
  "tolerance": 12,
  "inventory": {
    "intervalMinMs": 1000, "intervalMaxMs": 1500,
    "fullAt": 28,
    "dumpEarlyAt": 24,
    "emptyBelow": 4,
    "fillingQuietMinMs": 6000, "fillingQuietMaxMs": 10000,
    "emptyingQuietMinMs": 2000, "emptyingQuietMaxMs": 4000
  },
  "afterClick": { "wispMinMs": 5000, "wispMaxMs": 10000, "craterMinMs": 5000, "craterMaxMs": 10000 },
  "wisps": {
    "looks": 4, "lookGapMs": 120, "matchPx": 60, "stillPxPerSec": 40,
    "lead": true, "maxLeadPx": 300, "leadMarginMs": 150, "maxWaitMs": 800,
    "track": true, "pollMs": 8, "followPx": 45, "followWindowMs": 200, "detectorLagMs": 25,
    "steerPx": 6, "steerPxPerMs": 0.6, "steerMinMs": 60, "lostMs": 150, "retrackPx": 150, "piStartMs": 45
  }
}
```

- `tolerance` is for pixels A, B and C.
- `dumpEarlyAt`: a filling that ends with at least this many occupied (but not
  full) dumps instead of starting another wisp.
- `fillingQuiet*` has to be longer than the gap between two items while
  harvesting, `emptyingQuiet*` longer than the gap while dumping - or a quiet
  moment in the middle reads as "stopped".
- `afterClick.wisp*` / `crater*` have to cover the walk there plus the first
  item; give the crater more if it's further away.
- `wisps.matchPx` is how far a wisp may move between two looks and still be
  the same one; `lead: false` turns the aiming ahead off. `detectorLagMs` is
  how old a detector frame is when its answer comes (game-detector measured
  18 ms from grab to result, 30 at worst), `piStartMs` how long the Pi takes
  from a request to the first move (31-55 ms measured over WiFi).
- Following on the way: `track: false` turns it off (the path just plays).
  `steerPx` is how far off the press may be before the path is bent,
  `steerPxPerMs` the average speed of a bend (0.6 = 60 px in 100 ms, never
  under 40 ms), `steerMinMs` how long before the press the last bend may
  start. `followPx` is how far from where it should be a wisp may turn up in
  the next frame, `followWindowMs` how much of its recent movement counts,
  `lostMs` / `retrackPx` when and how far to look for another one, `pollMs`
  how often the detector is asked.

`PIXELWATCH_CONFIG_MOUSEOVER2` points mouseover2 at another file (and
`PIXELWATCH_CONFIG_ARCHEOLOGY` the inventory) - that's how the tests run without
touching the real ones.

Exit codes: `0` normal stop (Ctrl+C, `--once`), `1` config or startup error.
