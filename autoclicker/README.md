# autoclicker

A Raspberry Pi Zero 2 W that plugs into a target computer over USB, appears as an
ordinary USB mouse, and clicks when anything on the LAN hits `/click`.
The target computer needs no drivers or software — it only sees a mouse.

```
any LAN device ──HTTP POST /click──> Pi (autoclicker.py) ──3-byte report──> /dev/hidg0
                                                                                │ USB
                                                                                ▼
                                                                   target PC sees a mouse
```

## Files

| File | Installed to | Purpose |
|---|---|---|
| `hid-gadget.sh` | `/usr/local/bin/` | Builds the USB HID mouse gadget in configfs, binds it to the UDC |
| `hid-gadget.default.example` | `/etc/default/hid-gadget` | USB identity (vendor/product IDs, strings) |
| `autoclicker.py` | `/usr/local/bin/` | HTTP server on `:8080`, writes HID reports |
| `rival600.py` | `/usr/local/bin/` | The Rival 600 copy (FunctionFS) - see "Rival 600 identity" |
| `gadget-mode.sh` | `/usr/local/bin/gadget-mode` | Switches between the Logitech and Rival 600 identities |
| `systemd/hid-gadget.service` | `/etc/systemd/system/` | Runs the gadget script once at boot |
| `systemd/rival600.service` | `/etc/systemd/system/` | Runs `rival600.py` (instead of hid-gadget) in Rival mode |
| `systemd/autoclicker.service` | `/etc/systemd/system/` | Runs the server, restarts on failure |
| `networkmanager/wifi-powersave-off.conf` | `/etc/NetworkManager/conf.d/` | Turns WiFi power saving off: it made the first request after an idle spell up to 0.4 s late |
| `install.sh` | — | Run on the Pi; does everything below |
| `deploy.sh` | — | Run on your laptop; copies this folder to the Pi and runs `install.sh` |

## Deploy

From this folder, with the Pi on the network:

```bash
./deploy.sh                             # clicker@clicker.local
./deploy.sh clicker@192.168.0.42         # or by IP
```

One password prompt. On first run the installer edits `config.txt` and
`/etc/modules`, then reboots to load `dwc2`; the Pi is back in ~30 s.
Re-running later just reinstalls the files and restarts the services.

## API

| Request | Response |
|---|---|
| `GET` or `POST /click` | `204 No Content` — left button down, hold, up |
| `POST /moveclick` + JSON body | `200` + JSON stats — plays a movement with its clicks (below) |
| `POST /moveclick?noclick=1` | the same movement, no button presses |
| `POST /steer` + JSON body | while a `/moveclick` plays: bends the rest of it so the next press lands elsewhere, or calls the presses off (below) - `200` + JSON, `409` + JSON when there's nothing to steer |
| `GET /steer` | where the movement playing is: `200` + `{"playing", "at_ms", "press_ms", "end_ms"}` |
| `/moveclick` or `/steer` with a bad body | `400` + JSON `{"error": ...}` |
| either with USB unplugged or host not enumerated | `503 Service Unavailable` |
| any other path | `404 Not Found` |

Concurrent clicks and movements are serialised by a lock, so reports never
interleave; `/steer` doesn't wait for it - it acts on the movement playing.

```bash
curl -i -X POST http://clicker.local:8080/click
```

### /moveclick

The body is the output of mouse-sim's `POST /api/generate`, either form:
`{"pos": [[x, y], ...], "clicks": [{"down": ms, "up": ms}, ...]}` or
`{"changes": [[t, x, y], ...], "clicks": [...]}`. For remote play, ask mouse-sim
for `"skip_reaction": true` and `"no_misses": true`: the cursor then starts
moving at once instead of after a modelled reaction time (about 250 ms, at
times seconds), and there is exactly one click, on the target.

Playback starts (`t = 0`) as soon as the request has been read and checked:
measured 55-95 ms after it is sent for a 13 KB path over WiFi, the same after
the Pi has sat idle. About 18 ms of that is the Pi parsing the path; the rest is
the transfer. The shorter `skip_reaction` paths (450-700 ms) had the cursor
moving 31-40 ms after the request. From then on the Pi sends a relative report in every millisecond in
which the position or the button changes (`pos[t] - pos[t-1]`), presses at each
click's `down`, releases at its `up`, and answers after the last release:

```json
{"start": [1200, 640], "end_ms": 1017, "clicks": 1, "distance": [584, -228],
 "reports": 598, "events": 598, "duration_ms": 1017.3, "max_late_ms": 0.02}
```

`max_late_ms` is how far behind schedule a report went out at worst; when
playback falls behind, motion already due is merged into one report (never
across a button change), so the end position and the clicks stay exact.
`end` is where the pointer ended up from the start, `presses` how many presses
were sent and `steers` how many `/steer` bends it took - with steering, `end`
and the press can differ from the document's.

The movement is played one millisecond at a time from a plan (position and
buttons per ms), which is what lets `/steer` change the part not played yet.
Measured on the Pi: 0.00 ms late, with or without a steer during it; a steer
takes 0.45 ms there.

### /steer

While a `/moveclick` plays, `POST /steer` changes the rest of it - for a target
that moves after the movement was sent:

- `{"press": [x, y]}` (screen pixels, like the document) bends the rest of the
  movement so the next press lands on (x, y) - or, with no press left
  (`noclick`), so the movement ends there. The bend grows in smoothly from the
  next millisecond (a minimum-jerk curve, like a hand correcting itself) and
  runs until the movement before the press would have ended, but at least
  40 ms, or `"ms": N` if given. If that's past the press, the press - and the
  hold and release after it - waits until the bend is done. A later steer
  replaces the target of an earlier one, from where that one has got to.
- `{"cancel": true}` drops the presses still to come; the movement plays on.
  A press already down is released as planned.

Answers `200` with `{"at_ms", "press_ms", "end_ms", "bend": [from, to],
"moved": [dx, dy]}` (ms on the movement's own clock: `at_ms` the last one
played), or `{"at_ms", "dropped"}` for a cancel. `409` with `{"error"}` when
there's nothing playing, the button is down, or the movement is over. `GET
/steer` says where the movement is without changing it - `{"playing": false}`
when nothing plays. Over WiFi a steer took 20-40 ms there and back.

The mouse is relative, so two things are on the caller's side:

- **The cursor must already be at the start position** (`pos[0]`).
- **Windows "Enhance pointer precision" must be off** (Mouse settings →
  Additional mouse settings → Pointer Options), with the pointer speed at the
  middle notch (10 of 20 - `MouseSensitivity` 10). Then one unit is one pixel
  and the cursor follows `pos` exactly. With it on, Windows scales small
  per-millisecond moves down: a 237 px mouse-sim path came out as 134 px.
  Measured with it off: the pointer stopped on the planned pixel, every move
  landed on its planned pixel within 0.7 ms of its time, and the press and
  release came within 1 ms of `down` and `up`.

## Click hold

Each click holds for a fresh duration drawn from a log-normal distribution,
which is roughly the shape human click durations take: a floor, a peak a little
under 100 ms, and a long tail. A uniform draw would be flat across the range,
which no hand produces.

| Variable | Default | Meaning |
|---|---|---|
| `CLICK_HOLD_MEDIAN_MS` | 85 | Centre of the distribution |
| `CLICK_HOLD_SIGMA` | 0.28 | Spread; larger is wider |
| `CLICK_HOLD_MIN_MS` | 40 | Floor; draws below it are resampled |
| `CLICK_HOLD_MAX_MS` | 200 | Ceiling; draws above it are resampled |

Out-of-range draws are resampled rather than clamped, so probability does not
pile up at the two bounds. Setting min equal to max gives a fixed hold.

Measured over 20000 draws at the defaults: median 85, mean 88, p05 54, p95 134,
nothing clamped.

Set them in the service:

```
sudo systemctl edit autoclicker
```

```
[Service]
Environment=CLICK_HOLD_MEDIAN_MS=85
Environment=CLICK_HOLD_SIGMA=0.28
```

```
sudo systemctl restart autoclicker
```

## Report descriptor

The gadget presents 3 buttons, X, Y and a scroll wheel, in 4-byte reports.
Retail optical mice expose a wheel, so a wheel-less descriptor would contradict
whatever identity is set in `/etc/default/hid-gadget`.

The server reads the report width back from configfs at startup rather than
hardcoding it, so the two cannot drift apart and start rejecting writes. Change
`REPORT_LENGTH` and the descriptor together in `hid-gadget.sh`, restart
`hid-gadget`, then `autoclicker`.

## USB identity

The device reports whatever is in `/etc/default/hid-gadget`:

```
VENDOR_ID=0x1d6b
PRODUCT_ID=0x0104
DEVICE_REV=0x0100
MANUFACTURER="autoclicker"
PRODUCT="USB HID Mouse"
SERIAL="0123456789"
```

Edit, then `sudo systemctl restart hid-gadget`. The script notices the
descriptor changed, tears the gadget down and rebuilds it, so the host sees the
device disconnect and come back with the new identity. Unchanged values are a
no-op, so the service stays idempotent across reboots.

Write hex as `0xNNNN`. A bare leading zero (`046`) is read as octal and is
rejected with an error rather than silently becoming the wrong number.

The defaults `0x1d6b:0x0104` are the Linux Foundation's, which identify the
device as a generic Linux USB gadget — the giveaway that it is not a
retail mouse. Note that USB vendor IDs are assigned to specific companies by
the USB-IF; putting another company's ID here makes the device claim to be
their product.

## Rival 600 identity

A second identity: a copy of the owner's SteelSeries Rival 600 (1038:1724).
`rival600.py` builds it on FunctionFS rather than the stock HID function, so
it serves the real mouse's descriptors and answers the host's requests itself.
Switch between the two (as root):

```
gadget-mode rival600     # the Rival 600 copy (rival600.service)
gadget-mode logitech     # back to the Logitech gadget above (hid-gadget.service)
gadget-mode              # which one is active
```

The clicker follows the switch (`/etc/default/autoclicker`): in Rival mode it
sends the Rival's raw 8-byte mouse report through `/run/rival600/mouse.sock`,
and hands `/moveclick` movements to `rival600.py` through
`/run/rival600/play.sock`, which plays them itself - and `/steer` requests the
same way, each on its own connection, so they get in while a movement plays.

The raw mouse report is 8 bytes with **no report ID**: buttons, X (16-bit),
Y (16-bit), wheel, pan, a spare byte - measured: SteelSeries' sshid driver
reads byte 0 as the buttons and ignores 7-byte reports. A leading report ID
byte would be taken as "left button down". `rival600.py` rejects reports whose
first byte isn't a valid button state.

Checked from Windows against the real mouse plugged into the same PC:

| | |
|---|---|
| Device Manager | all 9 entries identical - names, classes, drivers (incl. SteelSeries' sshid driver on interface 1) |
| HID view (what apps see) | all 6 collections identical - report IDs, usages, sizes, ranges, report lengths |
| configuration descriptor | identical, byte for byte (3 interfaces, endpoints, 1 ms polling, bcdHID 1.11, remote wakeup, 200 mA) |
| strings, speed | identical ("SteelSeries", "SteelSeries Rival 600", no serial; full speed) |

Still different, visible only to USB descriptor viewers, all from the Linux
gadget framework: the device descriptor's serial-number string index (3 vs 0;
the string is empty, so Windows sees no serial either way), the device-qualifier
request (answered vs stalled), and string requests 3 and 4 (stalled vs the real
firmware's quirk of answering with its config and device descriptors).

The report descriptors are rebuilt, not copied: Windows can't read them raw
from user mode. They're built to give Windows' parser exactly the real mouse's
result, at the exact lengths the real HID descriptors declare (37/98/76).

SteelSeries GG sees the copy as a second Rival 600 and sends it commands on
interface 0; they're accepted and logged (`journalctl -u rival600`), not acted
on.

## Wiring

Micro-USB from the Pi's **inner** port (labelled `USB`, the data one) to the
target computer. The **outer** port (`PWR`) is power-only and will not
enumerate. The target's USB port powers the Pi; no separate supply needed.

## Verification

```bash
ls /sys/class/udc                       # must list a controller (e.g. 3f980000.usb)
ls -l /dev/hidg0                        # must exist
systemctl status hid-gadget autoclicker
journalctl -u autoclicker -f            # one line per request
```

- Target PC should show a new HID mouse a few seconds after plugging in.
- `curl -i -X POST http://clicker.local:8080/click` → `204`, cursor clicks in place.
- `curl -i http://clicker.local:8080/nope` → `404`.
- Unplug USB, hit `/click` → `503`.
- Power-cycle the Pi, touch nothing → both services come up, click works again.

## Notes

- `hid-gadget.sh` is idempotent: if the gadget is already bound it exits 0.
- The server opens `/dev/hidg0` with `O_NONBLOCK`, so an unresponsive USB host
  fails fast as a `503` instead of blocking a request thread forever.
- No auth, no HTTPS — anything on the LAN may click. That is by design for now.

## Troubleshooting

**`no UDC in /sys/class/udc`** — `dtoverlay=dwc2,dr_mode=peripheral` is missing
from `config.txt`, or the Pi has not rebooted since it was added.

**`/dev/hidg0` missing** — `hid-gadget.service` failed. `journalctl -u hid-gadget`.

**`503` on every click** — cable is in the `PWR` port, the cable is charge-only
(no data lines), or the target has not enumerated the device yet.

**`clicker.local` does not resolve** — use the IP. Find it on the router, or
`ping clicker.local` from a machine with mDNS. A Pi Zero 2 W is **2.4 GHz
only**; it cannot join a 5 GHz-only SSID.

## Later / nice-to-have

- Shared secret via `X-Token` header
- `/health` reporting HID availability
- `/move?dx=&dy=`, `/rightclick`, `/scroll`
- `ecm.usb0` in the same gadget so SSH works over the USB cable without WiFi
- DHCP reservation for a stable IP
