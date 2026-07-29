# Call Center Wallboard

ServiceTitan → TV. Booking activity by CSR, and whether today's bookings are
replacing the work coming off today's dispatch board.

## Setup

### 1. ServiceTitan credentials

developer.servicetitan.io → Login as Production Environment User → My Apps → **+New App**

- App type: **Private App** (single tenant, skips the public-app review)
- Add your Tenant ID
- API scopes: **JPM** (read), **Telecom** (read), **Settings** (read)
- Copy the **Application Key** from Keys → Application Key
- Generate **Client ID** and **Client Secret**

### 2. Local config

```bash
cp .env.example .env      # fill in the four ST_* values
npm install
npm run probe             # ← do this before anything else
```

The probe verifies credentials, confirms every endpoint resolves, checks that the
query filters actually filter, and prints your job type / business unit / employee
IDs. Paste `ESTIMATE_JOB_TYPE_IDS` and `CSR_EMPLOYEE_IDS` back into `.env`.

**Read the probe's warning about filtered vs unfiltered counts.** ServiceTitan
ignores unknown query parameters instead of rejecting them, so a wrong parameter
name produces a board full of all-time totals that look believable. Section 2 sends
a deliberately bogus parameter as a control and names any filter being dropped. It
must end in `✅` before you trust a number on the board.

### 3. Run

```bash
npm start
open "http://localhost:3000/board?k=$BOARD_TOKEN"
```

## Deploy to Railway

```bash
railway init
railway up
```

Set these in the Railway service variables — not in the repo:

| Variable | Notes |
|---|---|
| `ST_CLIENT_ID` `ST_CLIENT_SECRET` `ST_APP_KEY` `ST_TENANT_ID` | from Dev Portal |
| `BOARD_TOKEN` | `openssl rand -hex 24` |
| `TZ` | **`America/New_York`** — required, see below |
| `ESTIMATE_JOB_TYPE_IDS` `CSR_EMPLOYEE_IDS` | from `npm run probe` |

`TZ` is the one that will bite you. Railway runs UTC by default, which makes
"today" roll over at 8pm and blanks the board mid-shift.

Health check is `/healthz` (already wired in `railway.json`). It returns 503 when
the snapshot is stale, so Railway restarts a wedged poller on its own.

## The TV

A ~$150 mini PC or Raspberry Pi running Chromium in kiosk mode. Smart TV browsers
drop sessions, ignore auto-reload, and fight you on sleep timers.

```bash
sudo cp scripts/kiosk.sh /usr/local/bin/ && sudo chmod +x /usr/local/bin/kiosk.sh
sudo cp scripts/wallboard-kiosk.service /etc/systemd/system/
sudo nano /etc/systemd/system/wallboard-kiosk.service   # set BOARD_URL
sudo systemctl enable --now wallboard-kiosk
```

## Endpoints

| Route | Purpose |
|---|---|
| `/board?k=TOKEN` | the display |
| `/api/snapshot?k=TOKEN` | JSON the display renders |
| `/healthz` | no token; 200 fresh, 503 stale |

## Where things live

```
src/config.js          env + timezone-correct day boundaries
src/st/client.js       OAuth, token cache, pagination, backoff
src/st/endpoints.js    ← every endpoint path and param name, in one place
src/st/probe.js        npm run probe
src/domain/rules.js    ← every business rule, in one place
src/poll/index.js      poll loops + snapshot assembly
src/server.js          Express
public/board.html      the display (self-contained, no build step)
```

Business rules, attribution, and the things ServiceTitan can't give you are
documented in **CLAUDE.md**. Read it before changing what the numbers mean.
