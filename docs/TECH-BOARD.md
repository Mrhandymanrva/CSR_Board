# Technician board

A second wallboard in this repo, modelled on the legacy ServiceTitan Liveboard:
technicians down the side, days across the top, invoiced revenue in the cells.

It shares this repo's ServiceTitan client, timezone maths and pairing model with
the call-center board, and shares nothing else. Different rules, different
poller, different page, different cookie.

```
/board       call center   src/poll/index.js   + src/domain/rules.js
/techboard   technicians   src/techs/poll.js   + src/techs/rules.js
             shared        src/st/client.js, src/config.js (timezone), server.js
```

## Why it lives here and not in its own repo

A standalone repo would have started by copying ~300 lines: the token cache with
its 401 retry and 429 backoff, the pagination cap, the timezone day-window
helpers, and the pair-once cookie gate. None of that would ever differ, and two
copies of `localDayStart` is how one of them quietly keeps the 8pm rollover bug
after the other is fixed.

The cost is blast radius: a bad deploy takes down both TVs. Mitigated where it
can be — each poller is wrapped so a failing endpoint cannot stop the other, and
`/healthz` only returns 503 when **both** boards are down, so a technician-board
outage does not trigger a Railway restart that would drop a healthy call-center
board. It does not mitigate a syntax error. That is the trade.

## Where the numbers come from

⚠️ **There is no invoice data.** `accounting/v2/.../invoices` and
`payroll/v2/.../gross-pay-items` both return **403 Scope validation failed** —
the ServiceTitan app behind these credentials has neither scope. Getting them
means adding the scope in the Developer Portal and re-consenting in the tenant.
It is not a code change, and nothing here waits on it.

| | Source |
|---|---|
| Money | `jpm/v2/jobs` → `total` |
| Day | `jpm/v2/jobs` → `completedOn`, via `completedOnOrAfter` / `completedBefore` |
| Technician | `dispatch/v2/appointment-assignments?jobId={id}` → `technicianId` |
| Goal | `settings/v2/technicians` → `dailyGoal` (real, 1100–1300) |

**Reconciled against the real Liveboard on 2026-08-11 and it matches to the
cent.** All 18 technicians agreed on dollars *and* job count for Mon 8/10
($23,093.12 / 31 jobs). Re-run that comparison after changing anything in
`src/techs/rules.js`.

`job.total` therefore needs no tax or invoice-date adjustment. Do not "upgrade"
it to an invoice lookup without the scope and a fresh reconciliation.

## Traps this board already fell into

**The silent-drop trap, live.** The first version of the technician join used
`appointmentIds` on an endpoint that ignores it, got back 800 unrelated rows,
and reported **$0 for every technician** — a board that looked plausible and was
entirely wrong. `src/st/endpoints.js` now carries an `IGNORED_PARAMS` list of
every parameter verified to be silently dropped. Add to it; never trust a filter
you have not watched narrow, and pass `includeTotal=true` or `totalCount` comes
back null and the check passes on every row.

**The appointments hop is worse.** jobs → appointments → assignments attributed
29 of 31 jobs. The direct `?jobId=` call gets 31 of 31, in one request instead
of two. Do not reintroduce it.

**`total` = 0 does not mean a bad technician.** 34 of 151 completed jobs in a
sampled week were zero-dollar: estimate visits (job type `Estimate`) and
`noCharge` warranty work. Rendering those as a red $0 against a $1,100 goal, on
a screen on a wall, is a false accusation. Non-revenue days get a steel chip and
a visit count instead.

**It is a property of the DAY, not the technician.** Jarrod S looked like a
warranty-only tech across four sampled jobs and sold $1,253 the next day. The
first version hardcoded him as no-charge and was wrong within the hour.

## Decisions — decided, not open

| Rule | Decision | Why |
|---|---|---|
| Revenue day | Job `completedOn` | Matches the Liveboard |
| Cancelled jobs | Excluded | They come back inside the completed-on window (31 of 222); cancelled work is not revenue |
| Two techs on one job | **Split evenly** | Full-credit-each makes column totals exceed the day's real revenue, and a board that does not add up gets switched off |
| Row order | **Alphabetical** | ST's own Liveboard does this, as does the call-center board. Sorting by revenue turns a status board into a league table, and a stable order lets a tech find their line from across the room |
| Week | **Mon–Sat** | Sunday is not a work day here; an always-empty column costs ~150px for nothing |
| Goal bar below goal | **Neutral steel, never red** | A technician at 10am is not failing |
| No jobs closed today | **Dash, not 0%** | Nothing distinguishes a day off from a slow morning, so the board says nothing rather than something false |
| Intraday pace marker | **Removed** | Revenue is back-loaded — it lands when a job closes — so a linear pace line shows the whole crew behind every morning. An honest curve needs history this board does not keep |
| Unattributed jobs | **Shown in the footer** | A revenue board that quietly drops money it cannot place is worse than one that admits it. Currently 0 |

## Config

Nothing is required. Everything below has a working default.

| Var | Default | |
|---|---|---|
| `TECH_BOARD_TOKEN` | falls back to `BOARD_TOKEN` | Set it to keep the shop TV and the call-center TV genuinely separate. Each board has its own cookie either way |
| `TECH_POLL_TODAY_MS` | `90000` | ~32 requests a cycle against a 60/sec limit |
| `TECH_POLL_PRIOR_MS` | `900000` | Finished days barely change |
| `TECH_ESTIMATE_JOB_TYPE_IDS` | *(unset)* | Only upgrades the chip label from "no invoice" to "estimates". The non-revenue treatment itself is derived from the money and needs no config |
| `TECH_HIDE_IDLE` | `true` | `false` pins the full active roster |
| `TECH_MAX_LOOKBACK_WEEKS` | `8` | How far ‹ reaches |

## Pairing

Same model as the call-center board — pair once, then the bare path works.

```
/techboard?k=<TECH_BOARD_TOKEN>
```

sets a signed cookie and redirects to a clean `/techboard`. A device paired to
`/board` is **not** thereby paired to `/techboard`; they are separate cookies on
purpose. `/logout` clears both.

## Layout

`public/techboard.html` is a fixed 1920×1080 stage scaled to the viewport, same
as `board.html` — but it does **not** centre with `place-items:center`. A grid
refuses to centre an item larger than its track, so below 1920×1080 the stage
silently shifts by half the overflow. `board.html` still has this and should be
fixed the same way.

Row height is a 18-way split of the grid, about 37px. The day cells put the job
count **beside** the dollars rather than under them: a row is 37px tall and a
day column is 172px wide, so the horizontal space is the space that exists.
Adding a second line to a cell clips every row.
