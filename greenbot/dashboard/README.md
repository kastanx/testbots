# greenbot dashboard

Status page **and remote control** for the clicker, deployed to Vercel. It holds
no logic of its own — the local Electron panel pushes what it knows and collects
whatever the page has been asked to do.

- **Status** — running / on a break / stopped / offline, and why
- **Time spent clicking** — last 24 h, last 7 days, and the current session
- **Breaks and repairs** — the last 60, with what each one was
- **Control** — everything the local panel's buttons do

The page refreshes itself every 15 s with a `<meta refresh>` and the controls are
plain HTML forms posting to server actions. There is no client-side JavaScript on
it at all.

## How control works

Vercel cannot reach a PC behind a router, so control is a **mailbox, not a
connection**:

1. A button writes a row into the `commands` table.
2. The panel's next heartbeat (every 10 s) collects it in the response.
3. The panel applies it through exactly the same code its own buttons use, and
   the outcome rides the following heartbeat back.

So a button press lands **within about ten seconds**, and the page shows
`pending → sent → done` (or the reason it was refused) underneath. A command
nobody collects within 10 minutes expires rather than firing hours later when the
PC wakes up.

What you can do remotely:

| Control | Notes |
|---|---|
| START / STOP | START honours the panel's current mode |
| dry run / LIVE | Two presses to click for real, same as locally. The panel still refuses a LIVE start with no F10 kill switch |
| auto-repair on/off, test, cancel | |
| break tiers on/off (short, long, lunch, dinner, sleep) | Applied as a route patch, through the same validator the local editor uses |
| test any break now | Only while the clicker is running; still never starts on `transit` |

Numeric settings — timings, watchdogs, meal times — stay local. They are edits you
make once, not things to reach for from a phone.

## Deploying

```bash
cd greenbot/dashboard
npx vercel
```

Then, in the Vercel project:

1. **Storage → Neon Postgres**, attach it. This sets `DATABASE_URL`.
   Tables are created on the first request; there is no migration step.
2. **Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `INGEST_TOKEN` | a long random string — the local panel must present it |
   | `DASHBOARD_PASSWORD` | what you type to open the page |

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. Redeploy so the new variables are picked up.

No blob store and no other services: there are no images any more.

## Pointing the local panel at it

Two environment variables on the PC that runs the panel, set **before** starting
it:

```bat
set GREENBOT_DASH_URL=https://your-app.vercel.app
set GREENBOT_DASH_TOKEN=<the same value as INGEST_TOKEN>
```

Optionally `GREENBOT_DASH_HEARTBEAT_MS` — it is both the reporting interval and
the control latency, so raising it to 30000 cuts requests by two-thirds and makes
every button take up to half a minute.

The panel's Run tab shows whether it is pushing. With either variable missing,
nothing is sent and nothing is logged — telemetry is off, not broken.

Secrets go in the environment rather than `route.json` on purpose: `route.json`
is a config file people copy around, and a token in it would travel with it.

## What it costs to run

At the default 10 s heartbeat: ~8 600 requests and rows a day. Heartbeats are
pruned to 7 days, events to 30, commands to 7 — so the database settles at about
60 k rows and stays there. That fits the Vercel and Neon free tiers, but if you
would rather it were a third of that, set `GREENBOT_DASH_HEARTBEAT_MS=30000` and
accept a slower STOP button.

## Notes

- **The page can start and stop the clicker.** Set `DASHBOARD_PASSWORD`. Without
  it the page is open to anyone with the URL and says so in a banner.
- **Two secrets, deliberately separate.** `INGEST_TOKEN` is what the machine
  presents and never appears in a browser; `DASHBOARD_PASSWORD` is what a person
  types. Every server action re-checks the session — the proxy is not the only
  gate, because a server action is its own entry point.
- **Only whitelisted actions exist.** A command name that is not on the list in
  `lib/commands.js` never reaches the panel, and the panel checks again on
  arrival.
- **`offline` and `stopped` mean different things.** Offline is no heartbeat for
  30 s — the PC is asleep or the panel is closed. Stopped is the panel reporting
  that the clicker is not running, and it comes with a reason.

## Tests

```bash
node greenbot/dashboard/selftest.mjs           # token handling, the ingest gate, the whitelist
node greenbot/dashboard/sqltest.mjs            # every query, against a real embedded Postgres
node greenbot/harness/telemetry-selftest.js    # the local pusher and command applier
```
