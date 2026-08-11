# Giving this to another franchise

Every deployment is **fully independent**: its own ServiceTitan app, its own
credentials, its own Railway service, its own data. Nothing is shared between
franchises and there is no central server. That is deliberate — the moment one
owner holds another owner's ServiceTitan credentials, somebody has taken on a
security burden nobody is being paid for.

## What the new owner needs

1. **Their own ServiceTitan Private App.** Credentials are tenant-scoped; yours
   cannot read their data and theirs cannot read yours. At
   developer.servicetitan.io → My Apps → New App:
   - App type **Private App** (single tenant, skips public-app review)
   - Their Tenant ID
   - Scopes: **JPM (read)**, **Telecom (read)**, **Settings (read)**
   - Copy the Application Key; generate Client ID and Client Secret
2. **A Railway account** — about $5/month for this service.
3. **A screen.** A ~$150 mini PC or Pi running Chromium in kiosk mode. Smart TV
   browsers drop sessions and fight you on sleep timers.

## Handing over the code

Do **not** hand over a copy of this working directory. Ship a clean clone:

```bash
git clone --depth 1 <this-repo> wallboard-share && cd wallboard-share
rm -rf .git docs/RICHMOND-FINDINGS.md .env .claude
git init -b main && git add -A && git commit -m "Call center wallboard"
```

Then push that to their own repo, or publish it once as a GitHub **template repo**
and have each owner click "Use this template".

**Check before you push:** `.env` must be absent (it holds your ServiceTitan
secret), and `docs/RICHMOND-FINDINGS.md` must be absent (it holds staff names,
your tenant ID and an internal call-disposition audit). `.gitignore` already
covers `.env`; the findings file is the one you have to remember.

## Their setup, in order

```bash
cp .env.example .env      # fill in the four ST_* values
npm install
npm run probe             # ← before anything else
```

The probe verifies credentials, confirms every endpoint resolves, proves the query
filters actually filter, and prints their job-type / business-unit / employee IDs.
It must end in `✅` — see the README on why a silently-ignored filter is the most
likely way this ships broken.

Then fill in, from the probe output and their own operation:

| Variable | Notes |
|---|---|
| `ESTIMATE_JOB_TYPE_IDS` | their estimate job types — IDs differ per tenant |
| `CSR_EMPLOYEE_IDS` | their CSR roster; pin it, or an automation account appears as a phantom top performer |
| `BRAND_NAME` `MARKET_LABEL` `BOARD_SUBTITLE` | header text |
| `BU_LOCATION_TAGS` | `match=TAG` pairs for their business-unit naming |
| `BUSINESS_OPEN_HOUR` `BUSINESS_CLOSE_HOUR` `BUSINESS_DAYS` | **their** hours, not yours |
| `TZ` | their timezone — required |
| `BOARD_TOKEN` | `openssl rand -hex 24`, unique per deployment |

## What will not transfer

**The metric decisions are findings about one franchise, not general truths.**
Read `CLAUDE.md` § The measurement stance. In particular:

- **Booking rate was removed** because a call-based rate could only see 19% of that
  tenant's booked jobs. A more dispatch-first operation may legitimately close on
  the call, and a booking rate would be fair there.
- **"Missed → booked" assumes a missed-call text-back loop** (Nonstop.ai) plus human
  follow-up. Without one it still computes, but it is measuring whether missed
  callers happen to come back — a different question with the same label. Relabel
  it or drop the tile.
- **Business hours were derived from one tenant's abandon curve.** Re-derive; the
  probe's hourly output shows where the real step is.

Tell them to re-run the analysis on their own data before inheriting any threshold.
The method transfers; the numbers do not.

## Support expectations

Set them early. Self-hosted means each owner owns their own uptime, their own
credential rotation, and their own Railway bill. If you intend to be the person
who fixes it, say so deliberately — otherwise you have accidentally become
support for the franchise network.
