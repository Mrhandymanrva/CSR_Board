# CLAUDE.md — st-wallboard

Context for whoever (human or agent) picks this repo up. Read before changing anything.

## What this is

A TV wallboard for the Mr. Handyman call center (Richmond + Hampton–Newport News,
single ServiceTitan tenant). It answers one question for the CSRs, continuously:

> **Are we booking work faster than we're running it?**

Everything else on the board supports that question.

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
| Caller counting | One caller per day, not one call | 36% of missed calls are the same person retrying |
| Average call length | Mean `leadCall.duration` over ANSWERED inbound calls | Not "talk time" — the field includes pre-answer time. See below |
| Net = 0 | **"Even" — amber, third state** | Zero is not ahead. Do not collapse `netState()` to a boolean |

## What replaced booking rate

**Decided with Mason, 2026-07-29. Do not put a per-call conversion percentage back
on this board without re-reading this section.**

Mr. Handyman is not dispatch-first. A CSR call is often intake — gathering what an
estimate needs — and the booking lands days later, if it lands on that call at all.
A first-call-close rate measures an HVAC business. Three findings from the tenant's
own 14–28 day history, not from opinion:

**1. The call funnel explains a fifth of the work.** Of 398 live jobs created in 14
days, **75 (19%) carry a `leadCallId`**. 24 more came from online booking. The other
~300 arrive from repeat customers, callbacks and follow-up with no call attached. Any
per-call rate is blind to 81% of what gets booked.

**2. ServiceTitan's `Booked` means booked DURING the call.** All 75 job-to-call lags
were under an hour — not one over. There is no field recording "this call led to a
booking on Thursday", so the metric can only ever be a first-call-close rate.

**3. Intake works, and the old rate scored it as failure.** Booked within 7 days,
matched per customer:

| Cohort | Books later | Median lag |
|---|---|---|
| Missed, in hours | 22% | 2.1 d |
| Missed, after hours | 17% | 0.8 d |
| Unbooked (answered) | 26% | 1.0 d |
| NotLead (answered) | 32% | 2.0 d |
| **Booked (control)** | **3%** | — |

The Booked cohort at 3% is the control: it proves the signal is real follow-up
conversion and not repeat-customer background noise. Without it the other rows mean
nothing — keep it in any future version of this analysis.

**What the board shows instead:**
- **Missed → booked** (hero): of missed in-hours callers, the share with a job booked
  inside `RECOVERY_WINDOW_DAYS`. Trailing and per customer.
- **Reached a person**: deduped callers who got through, in hours.
- **CSR activity**: calls, average call length, time on the phone, jobs, estimates.
  No rate, no rank, no target, alphabetical.

## Two scopes — do not unify them

The board deliberately counts calls two different ways. Someone will eventually
notice and try to make them consistent. Don't.

| | Scope | Why |
|---|---|---|
| **Demand** — KPI strip: calls in hours, reached a person, missed | Inbound, in business hours | Measures how reachable we were and who we missed. Out-of-hours calls are not a service failure — nobody is there |
| **Effort** — CSR activity panel: in, out, avg call, phone time | Every call a person handled, both directions, any hour | Measures what a person actually did. If they were on the phone at 16:05 that is still work |

Counting inbound only in the activity panel was a real defect, caught 2026-07-29:
AmyW ran **117 outbound against 5 inbound** over 14 days and rendered as `0 calls`,
as did anyone else doing follow-up. Outbound is the human half of the text-back loop
that produces the 22% recovery number — showing it as idleness contradicts the
metric right next to it. `phoneSecs` on a CSR row sums BOTH directions; do not
re-derive phone time from `avgSecs × calls`, which is where the bug came from.

Outbound is effort only. It never enters a rate, a denominator, or a score.

**CarliH showing zero is usually correct.** She takes ~0.8 inbound calls a day and
mostly enters jobs (77 in 28 days). Before assuming an attribution bug, check the
raw calls — `leadCall.agent.id` does equal the employee `id` for every CSR. The
`agentId` field on the employee record is **0 for all 102 employees** and is not the
join key; it looks like one and is not.

**Open question worth chasing:** NotLead calls book later at 32% — the highest of any
cohort. Either they are being over-applied, or existing customers call about one thing
and book another. Until that is understood, treat any disposition-derived number with
suspicion; 55% of answered calls are dispositioned NotLead or Excused.

## Opportunities — superseded, kept for context

This was written up as the weak spot, with a plan to hand-fill
`OPPORTUNITY_CALL_REASON_IDS` from the tenant's own call reasons. That turned out to
be unnecessary. Telecom records here carry ServiceTitan's own per-call classification
— `Booked` / `Unbooked` / `Abandoned` / `NotLead` / `Excused` — and it is effectively
complete (525 of 526 calls across three days). `OPPORTUNITY_CALL_REASON_IDS` is now
unused; `reason.lead` covers only 16 of 61 calls and is not a substitute.

This section recorded an intermediate step: booking rate was first fixed from
jobs-created ÷ opportunity-calls (which read 75% where the honest number was 25%,
because jobs arrive from sources the call denominator never saw) to a clean
calls-to-calls ratio. That version was correct arithmetic and still the wrong
question — see § What replaced booking rate. `CALL_TYPE` remains the right way to
read a call outcome; only the rate built on it is gone.

**If telecom data is unavailable, the board shows a dash.** That rule outlives the
metric: never fabricate a denominator on a wall-mounted display.

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
