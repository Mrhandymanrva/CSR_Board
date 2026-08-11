# CLAUDE.md — st-wallboard

Context for whoever (human or agent) picks this repo up. Read before changing anything.

## What this is

A TV wallboard for a home-services call center, driven by one ServiceTitan tenant.
It answers one question for the CSRs, continuously:

> **Are we booking work faster than we're running it?**

Everything else on the board supports that question.

**Nothing in this repo is market-specific.** Branding, business hours and
business-unit tags all come from env — see `.env.example`. If you are adding a
franchise, `docs/SHARING.md` is the checklist; `docs/RICHMOND-FINDINGS.md` is the
originating tenant's private analysis and does not ship.

## Architecture

```
ServiceTitan API ──(creds, server-side only)──▶ poller ──▶ in-memory snapshot
                                                              │
                                          GET /api/snapshot ◀─┘
                                                              │
                                                    board.html on the TV
```

- **No database.** Deliberate. Jobs carry `createdOn` and appointment dates, so the
  7-day trend is recomputed from the API hourly rather than accumulated. A redeploy
  costs one poll cycle, not the day's history. Do not add Postgres "so we can keep
  history" without a real reporting requirement — it introduces a second source of
  truth that will disagree with ServiceTitan.
- **The browser never touches ServiceTitan.** No credentials reach the TV. It reads
  one JSON endpoint. This is not negotiable: the display hangs on a wall in a room
  people walk through.
- **Access is pair-once, not token-in-URL.** Opening `/board?k=<BOARD_TOKEN>` sets a
  signed httpOnly cookie and redirects to a clean `/board`; the bare domain then
  works on that device forever. The original design required the 48-character token
  in the URL on every load, which is unusable on a wall-mounted TV and left the
  token visible in the address bar of a screen people walk past. The cookie is an
  HMAC under `BOARD_TOKEN`, so rotating the token revokes every paired device.
  `board.html` holds no token and reads the cookie only implicitly, via a
  same-origin fetch — do not reintroduce a `k=` parameter in page JavaScript.
- **Snapshot shape IS the render contract.** `snapshot()` in `src/poll/index.js`
  returns exactly the object `render()` in `board.html` consumes. Change one, change
  the other in the same commit.

## Build order

1. `npm run probe` — **do this first, before trusting any poller code.** See below.
2. Fill `ESTIMATE_JOB_TYPE_IDS` and `CSR_EMPLOYEE_IDS` in `.env` from probe output.
3. Fix anything in `src/st/endpoints.js` that probe showed is wrong.
4. `npm start`, hit `/healthz`, then `/board?k=$BOARD_TOKEN`.

## Known traps

**Unknown query parameters are silently ignored, not rejected.** ServiceTitan does
not 400 on a misspelled filter — it returns the unfiltered set. A wrong parameter
name therefore shows up as a board reporting all-time totals that look plausible at
a glance. This is the single most likely way this project ships broken. `npm run probe`
compares filtered vs unfiltered counts specifically to catch it.

Two things about that check, learned the hard way on 2026-07-29:

- **`totalCount` is null unless you pass `includeTotal=true`.** The first version of
  the check compared `null` to `null` on every row and reported nothing, which is
  worse than not checking — it looked like a pass. It now requests the total.
- **It sends a deliberately bogus parameter as a control.** If the bogus filter
  returns the same count as no filter at all, silent-drop is confirmed live, and the
  real filters narrowing means they are genuinely being honoured. Keep the control.

**Telecom records are nested, jobs records are flat.** A call's useful fields live
under `leadCall` (`direction`, `callType`, `agent`, `reason`), not at the top level.
The first poller read `call.direction`, `call.abandoned`, `call.reasonId` and
`call.createdById` — none exist. They all resolved to `undefined` in expressions that
happily produced numbers, so the board showed a 0.0% abandon rate and zero
opportunities for every CSR: wrong, but wrong in a way that reads as a quiet day.
Go through the `CALL` accessors in `src/st/endpoints.js`; do not reach into a call
record directly. Attribution for inbound is `leadCall.agent` — `createdBy` is
populated on outbound only (0 of 46 inbound calls carried it).

**Timezone.** Railway containers run UTC. Without `TZ=America/New_York` the local day
rolls over at 8pm EDT and the board blanks mid-shift. Never compute the day boundary
with `toISOString().slice(0,10)`; use `localDayWindow()` in `src/config.js`.

**`createdById` may be an automation account.** Online booking, web forms, and
integrations create jobs under a service user, which would appear on the leaderboard
as a phantom CSR outbooking everyone. Verify during probe; use `CSR_EMPLOYEE_IDS`
to pin the roster.

**Tokens last ~15 minutes.** `src/st/client.js` caches and refreshes 60s early, and
de-duplicates concurrent refreshes. Don't add a second token path.

**Rate limit is 60 req/sec/app/tenant.** A 60-second poll is nowhere near it. The
constraint that matters is pagination depth, not frequency — `stGetAll` caps at
25 pages to stop a bad filter turning into an unbounded crawl.

## Business rules — decided, not open

All of these live in `src/domain/rules.js`. Changing them changes what CSRs are
measured on, so change them there and nowhere else.

| Rule | Decision | Why |
|---|---|---|
| Booking attribution | `createdById` — whoever typed the job in | Callbacks credit the CSR who closed it, not who took the first call |
| Booked today | Job `createdOn` inside the local day, not cancelled | |
| Booked for a future date | **Still counts today** | This is a replacement measure, not a same-day measure. Expect CSRs to ask why booked and dispatched don't reconcile — that's the honest answer |
| On today's board | Live count, re-polled every cycle, Canceled excluded | Adds and cancellations are real; the TRUE net is what matters |
| Estimates | Distinct `jobTypeId` values | Estimates are not immediately convertible revenue, and booking a free estimate is the easy way to inflate a booking rate |
| Per-call booking rate | **DELETED 2026-07-29 — do not reinstate** | Intake-first business. See § What replaced booking rate |
| CSR measurement | **Volume and effort only. No rate, no rank, no target** | A CSR gathering scope for an estimate is doing the job right |
| CSR activity scope | **Both directions, any hour** — inbound, outbound, phone time | Counting inbound only showed AmyW as idle on a day she made 117 outbound calls. See § Two scopes |
| CSR row order | **Alphabetical**, from the server | Sorting by any metric is a ranking. Stable order also lets someone find their own line from across the room |
| Missed calls | "Missed", never "lost" — they go to Nonstop.ai text-back | 1 in 5 books within a week. Calling them lost is factually wrong |
| Missed → booked | Per CUSTOMER, over a trailing 7 days, settled calls only | Median recovery lag is 2.1 days, so today's misses cannot be scored today |
| Business hours | Mon–Fri 08:00–15:59, configurable. Calls outside are counted, never scored | 97% of out-of-hours calls go unanswered because the office is shut |
| Viewing a past day | Allowed, up to 30 days back. Header turns amber, clock is replaced by "Yesterday" / "N days ago" | A finished day must never be mistakable for the live board |
| Churn on a past day | **Omitted, not reconstructed** | "Opened at N" was never recorded for a finished day; an end-of-day total would look identical and mean something else |
| Caller counting | One caller per day, not one call | 36% of missed calls are the same person retrying |
| Average call length | Mean `leadCall.duration` over ANSWERED inbound calls | Not "talk time" — the field includes pre-answer time. See below |
| Net = 0 | **"Even" — amber, third state** | Zero is not ahead. Do not collapse `netState()` to a boolean |

## The measurement stance — and why you must re-derive it

This board deliberately shows **no per-call booking rate** and **no conversion
target**, and ranks nobody. That was not a style choice; it was measured. The full
derivation, with the numbers, lives in `docs/RICHMOND-FINDINGS.md`.

The short version, and the part that generalises:

- **A call-based booking rate could only see 19% of booked jobs here.** Most work
  arrived from repeat customers, callbacks and follow-up with no call attached.
- **ServiceTitan's `Booked` means booked *during* the call** — every job-to-call lag
  measured under an hour. It is structurally a first-call-close rate.
- **Intake converts late.** Missed and unbooked callers came back days later. A
  same-day rate scores correct behaviour as failure.
- So CSRs are measured on **volume and effort**, and conversion is measured at the
  **customer level over a trailing window**, where delayed booking is visible.

**If you are deploying this for a different franchise, re-run the analysis before
trusting any of it.** A more dispatch-first operation may genuinely close on the
call, in which case a booking rate is a fair measure there. The transferable part is
the method, not the conclusion:

1. Check what share of your booked jobs are attributable to a call at all.
2. Measure conversion at the customer level over 7–14 days, not per call.
3. **Always include a control cohort.** Callers who already booked re-book at ~3%;
   without that baseline, "X% convert later" proves nothing.
4. Scope every call metric to business hours before believing an abandon rate.

## Viewing another day

`‹` / `›` in the header page back and forth, `Today` returns, and ←/→/Home do the
same from a keyboard. `/api/snapshot?day=-1` is yesterday, clamped to 30 days back.

Only today is polled on a timer. Any other day is fetched on demand and cached for
15 minutes (`dayCache` in `poll/index.js`) — a finished day does not change, so
paging back costs one round trip and is then free.

Three things keep history from being mistaken for live data, which is the whole
risk of this feature on a wall-mounted screen:

- The header goes amber, the status reads `Historical · <date>`, and the pulsing
  live dot stops.
- The **clock is replaced** by "Yesterday" / "N days ago". A ticking clock above
  finished numbers is the single most misleading thing this board could show.
- **It snaps back to today after 10 minutes idle.** Someone checks yesterday, walks
  away, and the TV is left lying to the room until somebody notices. Any click or
  keypress resets the timer.

`stale` is only ever computed for today — a finished day is done, not stale, and
flagging it amber would train people to ignore the warning that actually matters.

## Two scopes — do not unify them

The board deliberately counts calls two different ways. Someone will eventually
notice and try to make them consistent. Don't.

| | Scope | Why |
|---|---|---|
| **Demand** — KPI strip: calls in hours, reached a person, missed | Inbound, in business hours | Measures how reachable we were and who we missed. Out-of-hours calls are not a service failure — nobody is there |
| **Effort** — CSR activity panel: in, out, avg call, phone time | Every call a person handled, both directions, any hour | Measures what a person actually did. If they were on the phone at 16:05 that is still work |

Counting inbound only in the activity panel was a real defect: a CSR running 117
outbound against 5 inbound over 14 days rendered as `0 calls`, as did anyone else
doing follow-up. Outbound is the human half of the text-back loop that produces the
recovery number — showing it as idleness contradicts the metric beside it.
`phoneSecs` on a CSR row sums BOTH directions; do not re-derive phone time from
`avgSecs × calls`, which is where the bug came from.

Outbound is effort only. It never enters a rate, a denominator, or a score.

**A CSR showing zero calls is often correct.** Some enter jobs and rarely answer the
phone. Before assuming an attribution bug, check the raw calls — `leadCall.agent.id`
does equal the employee `id`. The `agentId` field on the employee record is **0 for
every employee** and is not the join key; it looks like one and is not.

## Not available from ServiceTitan

**Live CSR phone status** ("On call" / "Available" / "Wrap-up"). The mockups showed
this; it comes from the phone platform, not the API. With `STATUS_SOURCE=none` the
status line renders empty. Wiring it means a QUO integration — a separate piece of
work, not a config change. Don't fake it with "booked something in the last 5 minutes".

**Speed to answer.** There is no wait / queue / time-to-answer field on the telecom
record, so the KPI tile that showed it now shows abandonment instead — which is real,
comes from `callType`, and is more actionable anyway (28% today, 54% yesterday).

**Pure talk time.** Asked for on 2026-07-29; what shipped is average CALL LENGTH,
which is not the same thing. `leadCall.duration` is the only time field on the record,
and abandoned calls — which no agent ever touched — carry a duration too: 117s average
and 779s max today, 77s average across 102 abandoned calls yesterday. So the field
clearly runs from the moment the call arrives, not from pickup. An answered call's
duration is therefore wait + talk, and nothing on the payload can separate them.

Consequences, both deliberate:
- The average is taken over ANSWERED calls only (`isAnswered` in rules.js: agent
  present and not `Abandoned`). Averaging all inbound would fold hold time on
  abandoned calls into a number captioned as conversation.
- It is labelled "avg call", never "talk time". Do not relabel it without a real
  talk-time field to back it up.

Real talk time needs the phone platform (QUO), same integration as live CSR status.

## Layout

`public/board.html` is a fixed 1920×1080 stage scaled to the viewport. Panel heights
are a hand-balanced budget: header 104 + KPI 158 + footer 76 leaves 740 for the main
grid; the net panel takes 336 and the BU panel the remaining 402. **Adding content to
either right-hand panel will clip the bottom row.** If something new must go there,
take height from somewhere explicitly rather than shrinking type until it fits — that
was tried, and it just moves the break.

The leaderboard divides its height across however many CSRs exist, with density tiers
at 7+ and 10+. Above ~14 it stops being readable at distance; split the board by
location instead.

The leaderboard grid is seven tracks and should stay seven. Average call length was
added as a stacked caption inside the existing Calls column (`.callcell`, same shape
as `.estcell`) rather than as an eighth column, and the 16px it needed came off
Estimates so the total is unchanged. An eighth track comes out of the CSR name.
