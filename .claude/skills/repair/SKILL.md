---
name: repair
description: Get the OSRS tablet back to a playable state and restart the greenbot clicker, then watch it long enough to confirm it is really working. Invoked manually as /repair and automatically by the supervisor whenever the clicker stops on its own. Drives the tablet directly over adb.
---

# Repair: get it playing again, restart the clicker, confirm it stuck

The greenbot harness clicks obstacles on the Rellekka Rooftop Agility Course in
Old School RuneScape, on an Android tablet driven over adb. When it stops on its
own, you fix the game, **restart the clicker, and verify it is actually
progressing** before you report success.

You run both manually (`/repair`) and autonomously. Either way the job is the
same and it ends with the clicker running and confirmed.

---

## Everything you need, up front

```bash
node greenbot/repair/snap.js <scratchpad>/tablet.png   # see the tablet
adb shell input tap X Y                                # tap (1:1 with the screenshot)
node greenbot/repair/camera.js                         # north + max pitch
node greenbot/harness/control.js status                # is the clicker running?
node greenbot/harness/control.js start                 # restart it
node greenbot/harness/control.js wait-healthy --timeout 180
```

### Coordinates are 1:1. Do not "calibrate".

A screenshot pixel **is** an `input tap` pixel. Verified: display 0 has
`logicalFrame Rect(0,0 - 2560,1600)`, rotation 1. Screencap is 2560x1600.

> **Trap:** `wm size` reports `1600x2560` (the panel's portrait native
> orientation) and `dumpsys window displays` may report `cur=1920x1200` — that
> second one is a **stale scrcpy virtual display**, not the real screen. Neither
> contradicts the 1:1 mapping. `dumpsys display` is the authority. A previous run
> lost significant time chasing a transposition that does not exist.

### Chain wake + unlock + action into one invocation

```bash
adb shell "input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; input tap 1280 800"
```

The lock is insecure (`deviceLocked=0`), so `wm dismiss-keyguard` gets past it
with no PIN. The screen-off timeout has been raised to never, but chaining costs
nothing and removes any window for the device to re-lock mid-sequence.

### Git Bash mangles device paths

`adb push x /data/local/tmp/` becomes `C:/Program Files/Git/data/local/tmp/`.
Prefix with `MSYS_NO_PATHCONV=1`.

---

## First: is this a planned break, or a fault?

Read the stop reason you were given. If it contains **`idle break`**, nothing is
broken. The bot deliberately stopped clicking for long enough that the game's own
5-minute idle timer logged the character out — a human-shaped break, taken on
purpose, and never on `transit`. The reason names which kind:

| Reason says | What it was | Typical length |
|---|---|---|
| `long idle break` | a toilet or errand break | 6–10 min |
| `lunch idle break` | lunch | 30–50 min |
| `dinner idle break` | dinner | 45–75 min |
| `sleep idle break` | overnight | 6–8 h |

By the time you are called the break is already over — the bot sits out the whole
thing before it stops — so there is nothing to wait for.

(It also takes *short* breaks of 20 s to 3 min. Those stay under the idle timer,
never log out, and never stop the run — you will not be called for one.)

What you will find: the tablet awake, the game running, sitting on the **login
screen** or the **lobby**. That is the expected state, not a symptom.

What to do: skip the diagnosis. Go straight to step 2, tap through to the course
(**never type credentials**), then steps 3–6 as normal. Do not go looking for a
network fault, do not restart anything on the PC, and do not report a problem —
the only thing wrong is that nobody is logged in.

Any other stop reason is a real fault. Start at step 1.

## Procedure

### 1. Establish where you are

```bash
adb shell "dumpsys power | grep mWakefulness; dumpsys window | grep -m1 mCurrentFocus="; adb shell pidof com.jagex.oldscape.android
```

Then snap and Read the screenshot. Say what you see before you act.

### 2. Get the game playable

One action, then re-snap and confirm. Never a planned blind sequence — a missed
tap makes every later step wrong, and re-reading costs nothing.

Known screens and the action for each:

| What you see | Action |
|---|---|
| Black / near-black screen | Not asleep necessarily — the display ramps brightness. Wake, wait ~1s, snap again |
| Lock screen | `wm dismiss-keyguard` |
| **"No response from server. Please try using a different world."** | Tap **Try again**. If it repeats, the tether is down — see below |
| Login screen with **Play Now** | Tap it. Already signed in as `Iron kastan`; **never type credentials** |
| **"TAP HERE TO PLAY"** (lobby) | Tap it |
| World select | Any world; World 327 is the usual |
| Loading bar | Wait, do not tap |
| Level-up / idle-logout notice | Tap to dismiss |
| Notification shade | `KEYCODE_BACK` |
| Update-required prompt | **Stop and report** — needs a store update. One is pending (3.0.302.0) |
| Player on the ground, no obstacle highlighted | Probably a failed obstacle. Normal. The game is fine |

**"No response from server" may mean the tether — but test it properly.**

> **Do NOT use ping.** gnirehtet relays TCP and UDP, **not ICMP**, so ping fails
>100% even when the tether is perfectly healthy. A previous diagnosis got this
> wrong and killed a working relay on the strength of it.

Test with a real TCP connection instead:

```bash
adb shell "netstat -tn 2>/dev/null | grep -i estab"
```

An ESTABLISHED connection to port **43594** (the OSRS game port) over `tun0`
means the tether is fine and the problem is elsewhere. Also useful:

```bash
adb shell "ip route; ip -o addr show tun0"
```

`tun0` present with a default route through it is the expected healthy state.

If the tether really is down, **report it — do not restart it.** The user runs
`START TETHER.bat` and has asked that it not be touched.

### 3. Set the camera to the canonical state

The location classifier learned one camera framing and the per-spot target rules
are fixed screen positions. Both drift the moment the camera does, so this is not
cosmetic — it is what makes the clicker's coordinates mean anything.

```bash
node greenbot/repair/camera.js
```

That faces north (taps the compass) and pitches fully up (`input keyevent 19`
×30 — arrow keys drive the camera).

**Zoom cannot be set over adb.** Every route fails on this client: `sendevent`
pinch is blocked by SELinux (needs root), `input mouse scroll` exits 0 but the
client ignores it, `KEYCODE_ZOOM_OUT` does nothing. A mouse wheel over scrcpy
does work, which suggests the client filters on the event's source device.
Zoom persists across logins, so if it looks wrong, say so in your report and ask
the user to set it once by hand — do not burn actions trying.

**Verifying a no-op needs a positive control.** If tapping the compass changes
nothing, that is ambiguous: already north, or the tap missed. Rotate deliberately
off-north with `input keyevent 21`, then tap the compass and confirm it snaps
back. Same for pitch: if UP does nothing, press DOWN (visible change), then
restore. Proves the input path works rather than assuming.

### 4. Restart the clicker

```bash
node greenbot/harness/control.js start
```

This asks the monitor panel to start the run. It honours the panel's current
mode — an outside caller **cannot** promote a dry run to live clicking. It waits
for the panel to actually act.

**If it reports the panel is not running, stop and report that.** The clicker
lives inside the Electron panel; with the panel closed there is nothing to start
and no amount of tapping the tablet will help. Do not try to launch the panel
yourself — the user starts it with `START MONITOR.bat`, and a panel started from
a repair would have no window they can see or stop.

Check first if you want to fail fast:

```bash
node greenbot/harness/control.js status
```

A stale or missing status means the panel is closed.

### 5. Watch it long enough to know it stuck

```bash
node greenbot/harness/control.js wait-healthy --timeout 180
```

Requires **both** more clicks *and* a changed location before it reports success.
A harness sitting on one obstacle clicking nothing looks "running" right up until
its own watchdog fires — that is not fixed.

**Check `dryRun` in the status first.** In dry run the clicker decides targets
and logs them but sends nothing to the tablet, so it can never make the game
progress and a watchdog stop is guaranteed. `wait-healthy` detects this and
fails with a clear message rather than passing on decisions that never happened.
If you find the panel in dry run, say so in your report — the user has to arm
LIVE themselves, and no amount of repair will make a dry run click.

Exit 0 means genuinely working. Non-zero gives a reason:

- *"no clicks in 180s"* — the clicker is running but not acting. Check the game is
  actually in the foreground and the camera is right.
- *"clicking but still at spot_03"* — clicks land but nothing happens. Usually the
  camera is wrong, or the game is not responding to taps.
- *"the harness stopped: ..."* — it broke again; the reason tells you how.

If it fails, go back to step 1 with what you learned. You have the action budget
below; use it.

### 6. Report

Plain text, logged verbatim by the supervisor:

- What was wrong
- What you did
- **Whether the clicker is running and confirmed healthy** — the wait-healthy result
- Anything the user needs to fix by hand (zoom, tether, pending update)

Be honest when unsure. "I got to the lobby but the world list would not load" is
far more useful than a wrong "it's fine".

---

---

## When it is stuck on one spot

Watchdog reason *"N clicks with no location change"*, or `wait-healthy` reporting
*"clicking but still at spot_03"*. The game is up and clicks are being issued,
but nothing progresses. This is a different problem from a disconnect and needs a
different ladder. Work down it, verifying each step before moving to the next.

> **Coordinate spaces differ — this trips people up.** The service's
> `target.cx/cy` from `/analyze/screen` are **PC screen** pixels (3440x1440),
> because the clicker drives nut-js through the scrcpy window. Your `adb shell
> input tap` coordinates are **tablet** pixels (2560x1600). **Do not tap the
> service's coordinates over adb.** Find the green platform in your own tablet
> screenshot and tap that.

### A. Camera — check this first, it causes most of them

The classifier learned one framing and the target rules are fixed positions, so a
drifted camera makes every target wrong while the clicker happily clicks nothing.

```bash
node greenbot/repair/camera.js
```

Then confirm with the positive-control trick: rotate off-north with
`input keyevent 21` ×8, screenshot, tap the compass, screenshot again. If the
needle does not snap back, the compass coordinate is wrong for your interface
scale — crop the top-right of a screenshot, measure the compass centre, and use
that instead of the configured one.

Also check zoom looks fully out. If not, ask the user — it cannot be set over adb.

### B. Play a few obstacles by hand

If the camera is right and it is still stuck, the player may be somewhere the
clicker cannot recover from — mid-animation, after a failed obstacle, or on a
roof the classifier does not recognise.

Do two or three obstacles manually to move the player past it:

1. Screenshot. Find the green-marked platform — it is a translucent green quad
   with a brighter outline.
2. Tap its centre **in tablet coordinates**.
3. Wait ~3-4 s, screenshot again, confirm the player moved. The view shifts and
   the previously marked platform is no longer marked.
4. Repeat for the next marked platform.

Watch the **Laps Completed** counter in the top-left overlay. If it increments,
you have completed a full lap by hand and the course is definitely working.

If a tap produces no response at all, the problem is input, not the game — say so
rather than tapping repeatedly.

### C. Restart and verify

```bash
node greenbot/harness/control.js start
node greenbot/harness/control.js wait-healthy --timeout 180
```

If it now progresses, you are done. Report that manual play was needed and what
you think caused the stall.

### D. Logout and log back in

If it stalls again in the same place, the account may be in a state a fresh login
clears — stuck in an animation, a desynced position, or a bad world.

1. Open the sidebar tab with the logout/door icon (bottom of the right-hand
   column). Find it in the screenshot rather than assuming a coordinate.
2. Tap **Logout**.
3. Log back in through the normal flow — **Play Now**, then
   **TAP HERE TO PLAY**. Credentials are saved; never type them.
4. The player usually returns near where they logged out. Walk to the course
   start if needed by tapping the ground.
5. Re-run the camera setup — a fresh login resets the camera.
6. Restart the clicker and verify again.

### E. Stop and report

If it is still stuck after a login cycle, stop. Report exactly which step you
reached, what the screen looked like, and your best read on why. Repeating the
ladder will not help, and the supervisor will call you again if the clicker stops
once more.

Two causes worth naming explicitly if you see them:

- **Zoom is not fully out.** Everything downstream assumes it and it cannot be
  fixed over adb, so it needs the user.
- **The green markers vanished.** They reset at random and only return after an
  obstacle is completed, which is precisely what step 2 does by hand.

## Hard rules

**Never type credentials.** No `adb shell input text`, no character keyevents,
ever. The account is signed in, so login is a tap. An empty login form means
something changed — stop and report.

**Never touch money, trades, the Grand Exchange, account settings, or purchases.**

**Never restart the tether.** Report it; the user owns that process.

**Cap yourself at 40 actions.** The stuck-on-one-spot ladder legitimately needs
more than a disconnect does — manual play plus a login cycle adds up. Past that,
stop and report. Flailing is worse than stopping, and the supervisor will call
you again if the clicker stops once more.

**Never repeat a step that already failed.** If manual play did not move the
player, doing it again will not either. Move down the ladder or stop.

**Stop and report** when: the app is not running (it normally survives sleep), an
update is required, you cannot identify the screen after two attempts, or
anything needs a human decision.

---

## Context

- Tablet: Xiaomi, Android 15, serial `a655gieylnibt8tk`, package
  `com.jagex.oldscape.android`. Screencap 2560x1600, 1:1 with taps.
- Account `Iron kastan`, usually World 327.
- **Rellekka Rooftop Course**: rooftop agility, level 80 Agility. Climb from
  street level, cross gaps and tightropes, drop back down to complete a lap.
  Marks of grace spawn on the roofs and are harmless. **Failing an obstacle drops
  you to street level** — routine, not a fault.
  The harness labels camera positions `spot_01`…`spot_06` plus `transit`; those
  are its own labels, not obstacle names. I am not certain of the exact obstacle
  order, so read the screen rather than trusting a remembered sequence.
- **Playable** = 3D world rendered, stat orbs top-right, minimap, and the
  Rellekka Rooftops overlay top-left showing laps.
- Sleep was the original root cause. Now fixed: `screen_off_timeout` is
  `2147483647` and `stay_on_while_plugged_in` is `3`. If the tablet is sleeping
  again, those settings were reverted — say so.
- Watchdog reasons and which path to take:
  - *"location unchanged for 300s"* → disconnected, frozen, or asleep. Normal
    repair flow from step 1.
  - *"N clicks with no location change"* → game is up but not progressing. Go to
    **"When it is stuck on one spot"** — suspect the camera first.
  - *"click cap"* / *"time cap"* → a normal finish, not a fault. The supervisor
    will not call you for these.
  - *"idle break"* → a planned break, not a fault. The character is logged out on
    purpose. Just log back in — see the top of this file.
- **Breaks.** Two kinds, all configurable in the panel:
  - *elapsed-play* (BREAKS section): **short**, every 15–35 min for 20 s to 3 min,
    stays under the 5-minute idle timer so it never logs out and never calls you;
    and **long**, every 2–4 h for 6–10 min, which does log out.
  - *wall-clock* (DAILY ROUTINE section): **lunch**, **dinner** and **sleep**, at
    configured times that drift by up to an hour each day. All three log out.

  None of them ever starts on `transit`, only on `spot_01`…`spot_06`, because
  going idle mid-obstacle leaves the character somewhere the classifier cannot
  place. Getting back in is *your* job — the clicker deliberately does not log
  itself in.
- Expect roughly **three calls a day** on the default routine: after lunch, after
  dinner, and in the morning after sleep. It plays about **14.5 hours in 24**. If
  you are being called far more often than that, something is genuinely wrong —
  read the watchdog reason rather than assuming it was a break.
