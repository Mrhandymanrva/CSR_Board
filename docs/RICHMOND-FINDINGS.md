# Richmond findings — PRIVATE, do not ship in the shared template

Tenant-specific analysis behind the metric decisions in `CLAUDE.md`. Contains
staff names, this tenant's ID and an internal call-disposition audit. Strip this
file (and `.env`) before handing the repo to another franchise — see
`docs/SHARING.md`.

Every number here was measured against tenant 412939912 over 14–28 days in late
July 2026. **They are findings about this franchise, not general truths.** Another
owner must re-measure before inheriting any of these conclusions.

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

