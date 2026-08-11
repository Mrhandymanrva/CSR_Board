import { cfg, localDayWindow, localDayStart, dayLabel, localTimeLabel, localDateLabel } from '../config.js';
import { stGetAll } from '../st/client.js';
import { EP, PARAM, CALL } from '../st/endpoints.js';
import * as R from '../domain/rules.js';

/* ── State ─────────────────────────────────────────────────────────
   Everything lives in memory. No database: jobs carry their own dates,
   so history is recomputed from the API rather than accumulated. A
   restart costs one poll cycle, not the day's numbers. */

const state = {
  refs: { businessUnits: new Map(), employees: new Map(), jobTypes: new Map(), loadedAt: 0 },
  today: null,
  week: [],
  recovery: null,          // trailing missed-call recovery; see pollRecovery
  openingDispatch: null,   // dispatch count at first poll of the local day
  openingDay: null,
  openingLabel: null,      // local time of that first poll — see churn.since
  lastOk: 0,
  lastError: null,
};

/* ── Reference data (hourly) ──────────────────────────────────────── */
export async function pollRefs() {
  const [bus, emps, types] = await Promise.all([
    stGetAll(EP.businessUnits.module, EP.businessUnits.path),
    stGetAll(EP.employees.module, EP.employees.path),
    stGetAll(EP.jobTypes.module, EP.jobTypes.path),
  ]);
  state.refs = {
    businessUnits: new Map(bus.map((b) => [b.id, b])),
    employees: new Map(emps.map((e) => [e.id, e])),
    jobTypes: new Map(types.map((t) => [t.id, t])),
    loadedAt: Date.now(),
  };
  if (!cfg.rules.estimateJobTypeIds.length) {
    console.warn('[poll] ESTIMATE_JOB_TYPE_IDS is empty — every booking will count as work. Run `npm run probe`.');
  }
}

/* ── Jobs for a local day ─────────────────────────────────────────── */
async function jobsCreatedOn(offsetDays) {
  const w = localDayWindow(offsetDays);
  const P = PARAM.jobs;
  return stGetAll(EP.jobs.module, EP.jobs.path, {
    [P.createdOnOrAfter]: w.start,
    [P.createdBefore]: w.end,
  });
}

async function jobsScheduledOn(offsetDays) {
  const w = localDayWindow(offsetDays);
  const P = PARAM.jobs;
  return stGetAll(EP.jobs.module, EP.jobs.path, {
    [P.scheduledOnOrAfter]: w.start,
    [P.scheduledBefore]: w.end,
  });
}

/* ── Calls (best effort) ──────────────────────────────────────────
   Telecom provisioning varies. If this endpoint fails the board still
   renders: calls/opportunities show as unavailable and booking rate
   shows a dash. A missing denominator must never be faked. */
async function pollCalls(offsetDays = 0) {
  const w = localDayWindow(offsetDays);
  const P = PARAM.calls;
  try {
    const raw = await stGetAll(EP.calls.module, EP.calls.path, {
      [P.createdOnOrAfter]: w.start,
      [P.createdBefore]: w.end,
    });

    /* TWO SCOPES, deliberately different — do not unify them.

       DEMAND (the KPI strip) is inbound, in-hours: how reachable were we, and
       how many customers did we miss. Out-of-hours calls are excluded because
       nobody is there, so they are not a service failure.

       EFFORT (the CSR activity panel) is every call a person handled, inbound
       or outbound, any hour. Counting inbound only made the CSRs who do the
       follow-up calling look idle — AmyW ran 117 outbound against 5 inbound
       over 14 days and showed as 0. Outbound IS the human half of the
       text-back loop the recovery number depends on. */
    const inbound = raw.filter(R.isInbound);
    const calls = inbound.filter(R.inBusinessHours);
    const afterHours = inbound.length - calls.length;

    const callsBy = new Map();     // inbound answered, per CSR
    const outBy = new Map();       // outbound placed, per CSR
    const oppsBy = new Map();
    const convBy = new Map();
    const talkBy = new Map();      // phone seconds, BOTH directions
    const bump = (m, k) => k != null && m.set(k, (m.get(k) || 0) + 1);
    const addSecs = (k, secs) => {
      if (k == null || !Number.isFinite(secs) || secs <= 0) return;
      const t = talkBy.get(k) ?? { secs: 0, n: 0 };
      t.secs += secs; t.n++;
      talkBy.set(k, t);
    };

    // Outbound: effort only. Never scored, never in a rate, any hour.
    for (const c of raw) {
      if (R.isInbound(c)) continue;
      const emp = R.handledBy(c) ?? CALL.inner(c).createdBy?.id ?? null;
      bump(outBy, emp);
      addSecs(emp, CALL.durationSecs(c));
    }

    let abandoned = 0;
    let opportunities = 0;
    let converted = 0;

    // One missed CUSTOMER, not one missed call: a caller who tries three times
    // and gives up is one person we failed, and 36% of missed calls are retries.
    const missedCallers = new Set();
    const reachedCallers = new Set();

    for (const c of calls) {
      const emp = R.handledBy(c);
      bump(callsBy, emp);
      if (R.isAbandonedCall(c)) { abandoned++; missedCallers.add(R.callerDayKey(c)); }
      else reachedCallers.add(R.callerDayKey(c));

      // Call length accrues only for calls somebody actually answered —
      // abandoned calls carry a duration too, and it is hold time. See rules.js.
      if (R.isAnswered(c)) addSecs(emp, CALL.durationSecs(c));
      if (R.isOpportunity(c)) {
        opportunities++;
        bump(oppsBy, emp);
        if (R.isBookedCall(c)) { converted++; bump(convBy, emp); }
      }
    }

    // A caller who eventually got through is not a missed customer.
    for (const k of reachedCallers) missedCallers.delete(k);

    return {
      ok: true,
      handled: calls.length,
      outbound: raw.length - inbound.length,
      afterHours,
      missedCallers: missedCallers.size,
      reachedCallers: reachedCallers.size,
      opportunities,
      converted,
      callsBy,
      outBy,
      oppsBy,
      convBy,
      talkBy,
      avgCallSecs: R.avgCallSecs(calls),
      abandoned,
      abandonPct: calls.length ? (abandoned / calls.length) * 100 : 0,
      // Speed-to-answer is NOT in the telecom payload on this tenant — there is
      // no wait/queue/answer field on the record. Reporting it would mean
      // inventing it, so it stays null and the board omits it. See CLAUDE.md.
      asaSecs: null,
    };
  } catch (e) {
    console.warn('[poll] calls unavailable:', e.message);
    return {
      ok: false, handled: null, outbound: null, afterHours: null,
      missedCallers: null, reachedCallers: null, opportunities: null, converted: null,
      callsBy: new Map(), outBy: new Map(), oppsBy: new Map(), convBy: new Map(), talkBy: new Map(),
      avgCallSecs: null, abandoned: null, abandonPct: null, asaSecs: null,
    };
  }
}

/* ── Missed-call recovery (hourly) ────────────────────────────────
   The measure that replaced booking rate. Per-call conversion could only
   see 19% of booked work and scored intake as failure; this asks the
   question that actually matters for a text-back-and-follow-up business:
   of the callers we missed, how many did we get back?

   Necessarily a TRAILING measure — the median recovery lag is 2.1 days, so
   today's missed calls cannot be scored today. That is why it is not a live
   tile and why the board labels the window it covers. */
export async function pollRecovery() {
  /* Four windows back leaves ~3 windows of SETTLED calls to score. Two was
     enough to compute but not to be stable — it swung 16% against 22% on the
     same underlying data purely from the smaller sample. */
  const lookback = cfg.rules.recoveryDays * 4;
  const w = { start: localDayStart(-lookback).toISOString(), end: localDayStart(1).toISOString() };

  const [calls, jobs] = await Promise.all([
    stGetAll(EP.calls.module, EP.calls.path, {
      [PARAM.calls.createdOnOrAfter]: w.start, [PARAM.calls.createdBefore]: w.end,
    }, { pageSize: 500 }),
    stGetAll(EP.jobs.module, EP.jobs.path, {
      [PARAM.jobs.createdOnOrAfter]: w.start, [PARAM.jobs.createdBefore]: w.end,
    }, { pageSize: 500 }),
  ]);

  const jobsByCustomer = new Map();
  for (const j of jobs) {
    if (R.isCancelled(j) || j.customerId == null) continue;
    if (!jobsByCustomer.has(j.customerId)) jobsByCustomer.set(j.customerId, []);
    jobsByCustomer.get(j.customerId).push(Date.parse(j.createdOn));
  }

  const missed = calls.filter((c) => R.isMissed(c) && R.inBusinessHours(c));
  state.recovery = { ...R.recovery(missed, jobsByCustomer), days: cfg.rules.recoveryDays };
}

/* ── 7-day trend (hourly) ─────────────────────────────────────────── */
export async function pollWeek() {
  const out = [];
  for (let i = -6; i <= 0; i++) {
    const [created, scheduled] = await Promise.all([jobsCreatedOn(i), jobsScheduledOn(i)]);
    out.push({
      d: dayLabel(i),
      b: R.bookedToday(created).length,
      r: scheduled.filter(R.onTodaysBoard).length,
    });
  }
  state.week = out;
}

/* ── Any other day, on demand ─────────────────────────────────────
   The board is a live display, so only today is polled on a timer. Any other
   day is fetched when somebody asks for it, then cached — a finished day does
   not change, so the cache can be generous and the TV never pays for a second
   look at yesterday. */
const dayCache = new Map();          // offsetDays -> { at, day }
const DAY_TTL_MS = 15 * 60_000;
export const MAX_LOOKBACK_DAYS = 30;

export function clampDay(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.min(0, Math.max(-MAX_LOOKBACK_DAYS, n));
}

async function fetchDay(offsetDays) {
  const [created, scheduled, calls] = await Promise.all([
    jobsCreatedOn(offsetDays),
    jobsScheduledOn(offsetDays),
    pollCalls(offsetDays),
  ]);
  return {
    booked: R.bookedToday(created),
    dispatch: scheduled.filter(R.onTodaysBoard),
    calls,
    /* Churn is a LIVE measure: it compares the board now against the first
       poll of today. A finished day has no equivalent — the "opened at"
       figure was never recorded for it — so it is omitted rather than
       reconstructed from end-of-day totals, which would look identical and
       mean something else entirely. */
    churn: null,
  };
}

export async function getDay(offsetDays) {
  if (offsetDays === 0) return state.today;
  const hit = dayCache.get(offsetDays);
  if (hit && Date.now() - hit.at < DAY_TTL_MS) return hit.day;
  const day = await fetchDay(offsetDays);
  dayCache.set(offsetDays, { at: Date.now(), day });
  return day;
}

/* ── Today (every 60s) ────────────────────────────────────────────── */
export async function pollToday() {
  const [created, scheduled, calls] = await Promise.all([
    jobsCreatedOn(0),
    jobsScheduledOn(0),
    pollCalls(0),
  ]);

  const booked = R.bookedToday(created);
  const dispatch = scheduled.filter(R.onTodaysBoard);

  // Board churn: remember the first dispatch count seen today, then report
  // movement against it. Adds and cancellations are real and must show.
  const dayKey = localDayWindow(0).start;
  if (state.openingDay !== dayKey) {
    state.openingDay = dayKey;
    state.openingDispatch = dispatch.length;
    // "Opened at N" is only true from the moment this process first polled.
    // On a mid-day redeploy that is not 7am, so the board says when it is from.
    state.openingLabel = localTimeLabel();
  }
  const cancelledToday = scheduled.filter(R.isCancelled).length;
  const opened = state.openingDispatch ?? dispatch.length;
  const drift = dispatch.length - opened;

  state.today = {
    booked,
    dispatch,
    calls,
    churn: {
      open: opened,
      added: Math.max(drift + cancelledToday, 0),
      cancelled: cancelledToday,
      since: state.openingLabel ?? localTimeLabel(),
    },
  };
  state.lastOk = Date.now();
  state.lastError = null;
}

/* ── Snapshot: the contract the browser renders ─────────────────────
   Defaults to today so /healthz and the existing callers are unchanged.
   Pass a day from getDay() plus its offset to render history. */
export function snapshot(day = state.today, offsetDays = 0) {
  if (!day) return { ready: false, generatedAt: new Date().toISOString() };

  const { booked, dispatch, calls, churn } = day;
  const isToday = offsetDays === 0;
  const csrs = R.buildCsrRows(booked, {
    employees: state.refs.employees,
    opportunitiesByEmployee: calls.oppsBy,
    convertedByEmployee: calls.convBy,
    callsByEmployee: calls.callsBy,
    outboundByEmployee: calls.outBy,
    talkByEmployee: calls.talkBy,
  // Alphabetical. Sorting by any metric reinstates the ranking that was
  // removed, and a stable order lets a CSR find their own line from across
  // the room instead of hunting for it after every poll.
  }).sort((a, b) => a.n.localeCompare(b.n));

  const bus = R.buildBuRows(booked, dispatch, state.refs.businessUnits);

  return {
    ready: true,
    generatedAt: new Date().toISOString(),
    asOf: localTimeLabel(),

    /* Which day this is. `stale` means "the live poller has stopped" and can
       only ever apply to today — a finished day is not stale, it is done, and
       flagging it amber would train people to ignore a warning that matters. */
    day: offsetDays,
    isToday,
    dateLabel: localDateLabel(offsetDays),
    maxLookback: MAX_LOOKBACK_DAYS,
    stale: isToday ? Date.now() - state.lastOk > cfg.poll.today * 3 : false,
    error: isToday ? state.lastError : null,

    // No `target` and no `estCap`. There is no conversion target on this board
    // and no estimate-share cap — see rules.js on why both were removed.
    avgTicket: cfg.rules.avgTicket,

    callsHandled: calls.handled,
    outbound: calls.outbound,
    afterHours: calls.afterHours,
    avgCall: R.fmtSecs(calls.avgCallSecs),
    avgCallSecs: calls.avgCallSecs,
    missedCallers: calls.missedCallers,
    reachedCallers: calls.reachedCallers,
    opportunities: calls.opportunities,
    converted: calls.converted,
    abandoned: calls.abandoned,
    abandon: calls.abandonPct == null ? '—' : `${calls.abandonPct.toFixed(0)}%`,
    callsOk: calls.ok,
    recovery: state.recovery,

    churn,
    csrs,
    bus,
    week: state.week,
    ticker: buildTicker({ csrs, bus, week: state.week, churn, calls, recovery: state.recovery }),
  };
}

/* Ticker lines are generated, not hand-written: the board should always
   be saying something true about the current numbers. */
function buildTicker({ csrs, bus, week, churn, calls, recovery }) {
  const bits = [];
  const totalBooked = csrs.reduce((s, c) => s + c.booked, 0);
  const totalEst = csrs.reduce((s, c) => s + c.est, 0);

  /* The old ticker named the CSR with the highest estimate share. That was a
     dispatch-first reflex — booking an estimate is the correct outcome of an
     intake call here, and calling it out on a wall punishes the behaviour the
     business runs on. Replaced with the missed-call loop, which is real work
     nobody can see from their desk. */
  if (calls?.missedCallers > 0) {
    bits.push(`<b>${calls.missedCallers} caller${calls.missedCallers > 1 ? 's' : ''}</b> missed in hours today — text-back has them`);
  }
  if (recovery?.pct != null) {
    bits.push(`<b>${recovery.pct.toFixed(0)}%</b> of missed callers booked within ${recovery.days} days`);
  }

  const worst = bus.filter((b) => b.booked - b.disp < 0).sort((a, b) => (a.booked - a.disp) - (b.booked - b.disp))[0];
  if (worst) bits.push(`<b>${worst.n} ${worst.loc}</b> is ${Math.abs(worst.booked - worst.disp)} short of replacing today's board`);

  if (churn?.cancelled > 0) {
    bits.push(`<b>${churn.cancelled} cancellation${churn.cancelled > 1 ? 's' : ''}</b> off today's board — that work has to be re-booked to hold even`);
  }

  const wk = week.reduce((s, w) => s + w.b - w.r, 0);
  if (wk !== 0) bits.push(`7-day net ${wk > 0 ? '+' : '−'}${Math.abs(wk)} jobs`);
  if (totalBooked) bits.push(`${totalBooked - totalEst} work jobs booked today · ${totalEst} estimates`);

  return bits.join(' <span class="sep">◆</span> ') || 'Waiting for today\u2019s first booking.';
}

/* ── Scheduler ────────────────────────────────────────────────────── */
export function start() {
  const guard = (name, fn) => async () => {
    try { await fn(); }
    catch (e) {
      state.lastError = `${name}: ${e.message}`;
      console.error(`[poll] ${name} failed:`, e.message);
    }
  };

  const refs = guard('refs', pollRefs);
  const today = guard('today', pollToday);
  const week = guard('week', pollWeek);
  const recovery = guard('recovery', pollRecovery);

  (async () => {
    await refs();
    await today();
    await week();
    await recovery();
  })();

  setInterval(refs, cfg.poll.refs);
  setInterval(today, cfg.poll.today);
  setInterval(week, cfg.poll.week);
  setInterval(recovery, cfg.poll.week);
}

export const _state = state;
