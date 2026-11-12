import { cfg, localDayWindow, localDayStart, dayLabel, localTimeLabel, localDateLabel } from '../config.js';
import { stGetAll } from '../st/client.js';
import { EP, PARAM, CALL } from '../st/endpoints.js';
import * as R from '../domain/rules.js';
import { annotateInbound, reduceCalls } from '../domain/demand.js';
import { mergeFresh, peopleForWindow } from '../domain/leads.js';
import { indexRcRecords } from '../rc/match.js';
import { loadCallLog, logRcModeOnce, overflowNumbers } from '../rc/client.js';

/* ── State ─────────────────────────────────────────────────────────
   Everything lives in memory. No database: jobs carry their own dates,
   so history is recomputed from the API rather than accumulated. A
   restart costs one poll cycle, not the day's numbers. */

const state = {
  refs: { businessUnits: new Map(), employees: new Map(), jobTypes: new Map(), loadedAt: 0 },
  today: null,
  week: [],
  recovery: null,          // trailing missed-call recovery; see pollRecovery
  history: null,           // ~60 days of calls + jobs, hourly. Not the 60s poll.
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

function callsUnavailable() {
  return {
    ok: false, handled: null, outbound: null, afterHours: null,
    missedCallers: null, reachedCallers: null, opportunities: null, converted: null,
    callsBy: new Map(), outBy: new Map(), oppsBy: new Map(), convBy: new Map(), talkBy: new Map(),
    avgCallSecs: null, abandoned: null, abandonPct: null, asaSecs: null,
    rcMatching: false, broadly: null, answeredNoDisposition: null, broadlyAfterHours: null,
    stAbandoned: null, rawCalls: [],
  };
}

/* ── Calls (best effort) ──────────────────────────────────────────
   Telecom provisioning varies. If this endpoint fails the board still
   renders: calls show as unavailable. A missing denominator must never
   be faked.

   DEMAND (the KPI strip) is inbound, in business hours. Out-of-hours calls
   are counted and never scored — nobody is there.

   RingCentral, when configured, is joined here and nowhere else. The join
   is cached (5 minutes for today, hourly for a finished day). It is not
   refetched on every 60-second poll. With the env vars unset, `loadCallLog`
   returns null and reduceCalls keeps the ServiceTitan-only rules. */
async function pollCalls(offsetDays = 0) {
  const w = localDayWindow(offsetDays);
  const P = PARAM.calls;
  try {
    const raw = await stGetAll(EP.calls.module, EP.calls.path, {
      [P.createdOnOrAfter]: w.start,
      [P.createdBefore]: w.end,
    });
    const ttl = offsetDays === 0 ? cfg.poll.rcToday : cfg.poll.week;
    const records = await loadCallLog(w.start, w.end, ttl, { maxPages: offsetDays === 0 ? 4 : 8 });
    if (records != null) annotateInbound(raw, indexRcRecords(records), overflowNumbers());
    return reduceCalls(raw, { rcEnabled: records != null });
  } catch (e) {
    console.warn('[poll] calls unavailable:', e.message);
    return callsUnavailable();
  }
}

/* ── Lead corpus (hourly) ─────────────────────────────────────────
   Episodes look back 30 days, and the board can open a day 30 days ago,
   so the corpus is 60 local days. Refreshed with the week poll, never with
   the 60-second today poll — today's slice is spliced in from the calls
   and jobs that poll already fetched. pageSize 500, 40 pages: 20k rows,
   sequential, once an hour. The default 25-page cap would clip a busy
   60-day window; this override is only for the backfill. */
const HISTORY_DAYS = 60;

export async function pollHistory() {
  const w = {
    start: localDayStart(-HISTORY_DAYS).toISOString(),
    end: localDayStart(1).toISOString(),
  };
  const [calls, jobs] = await Promise.all([
    stGetAll(EP.calls.module, EP.calls.path, {
      [PARAM.calls.createdOnOrAfter]: w.start,
      [PARAM.calls.createdBefore]: w.end,
    }, { pageSize: 500, maxPages: 40 }),
    stGetAll(EP.jobs.module, EP.jobs.path, {
      [PARAM.jobs.createdOnOrAfter]: w.start,
      [PARAM.jobs.createdBefore]: w.end,
    }, { pageSize: 500, maxPages: 40 }),
  ]);
  state.history = { calls, jobs, at: Date.now() };
  if (state.today) attachPeople(state.today, 0);
}

function jobTime(job) {
  const t = Date.parse(job?.createdOn ?? '');
  return Number.isFinite(t) ? t : null;
}

function attachPeople(day, offsetDays) {
  const dayStart = localDayStart(offsetDays).getTime();
  const dayEnd = localDayStart(offsetDays + 1).getTime();
  const trailStart = localDayStart(offsetDays - 29).getTime();
  const ready = Boolean(state.history?.calls && state.history?.jobs);
  let calls = day.rawCalls ?? [];
  let jobs = day.createdJobs ?? [];
  if (ready) {
    // A failed call fetch must not wipe that day's rows out of the corpus.
    calls = day.calls?.ok
      ? mergeFresh(state.history.calls, day.rawCalls ?? [], dayStart, dayEnd, (c) => CALL.receivedAt(c))
      : state.history.calls;
    jobs = Array.isArray(day.createdJobs)
      ? mergeFresh(state.history.jobs, day.createdJobs, dayStart, dayEnd, jobTime)
      : state.history.jobs;
    if (offsetDays !== 0 && Array.isArray(state.today?.createdJobs)) {
      const t0 = localDayStart(0).getTime();
      const t1 = localDayStart(1).getTime();
      jobs = mergeFresh(jobs, state.today.createdJobs, t0, t1, jobTime);
    }
  }
  day.people = peopleForWindow({
    calls, jobs,
    employees: state.refs.employees,
    dayStart, dayEnd, trailStart, trailEnd: dayEnd,
    leadsReady: ready,
  });
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

  /* Same ServiceTitan window as before. RingCentral for that window is an
     hourly fetch (POLL_WEEK_MS), not a per-minute one. Unset credentials
     leave every call unclassified and isMissed on the ServiceTitan flag. */
  const records = await loadCallLog(w.start, w.end, cfg.poll.week, { maxPages: 20 });
  if (records != null) annotateInbound(calls, indexRcRecords(records), overflowNumbers());

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
  const day = {
    booked: R.bookedToday(created),
    dispatch: scheduled.filter(R.onTodaysBoard),
    calls,
    rawCalls: calls.rawCalls ?? [],
    createdJobs: created,
    /* Churn is a LIVE measure: it compares the board now against the first
       poll of today. A finished day has no equivalent — the "opened at"
       figure was never recorded for it — so it is omitted rather than
       reconstructed from end-of-day totals, which would look identical and
       mean something else entirely. */
    churn: null,
  };
  attachPeople(day, offsetDays);
  return day;
}

export async function getDay(offsetDays) {
  if (offsetDays === 0) return state.today;
  const hit = dayCache.get(offsetDays);
  if (hit && Date.now() - hit.at < DAY_TTL_MS && hit.day.people?.ready) return hit.day;
  const day = await fetchDay(offsetDays);
  if (day.people?.ready) dayCache.set(offsetDays, { at: Date.now(), day });
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
    rawCalls: calls.rawCalls ?? [],
    createdJobs: created,
    churn: {
      open: opened,
      added: Math.max(drift + cancelledToday, 0),
      cancelled: cancelledToday,
      since: state.openingLabel ?? localTimeLabel(),
    },
  };
  attachPeople(state.today, 0);
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
  /* Alphabetical, from buildPeopleRows. Sorting by any metric is a ranking.
     `booked` on each row is jobs created today (createdById), not leads. */
  const people = day.people ?? { ready: false, rows: [], team: null };
  const csrs = people.rows ?? [];

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
    brand: cfg.brand.name,
    market: cfg.brand.market,
    subtitle: cfg.brand.subtitle,

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
    rcMatching: calls.rcMatching === true,
    broadly: calls.broadly ?? null,
    answeredNoDisposition: calls.answeredNoDisposition ?? null,
    leadsReady: people.ready === true,

    churn,
    csrs,
    team: people.team,
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
  const history = guard('history', pollHistory);

  logRcModeOnce();

  (async () => {
    await refs();
    await today();
    await Promise.all([week(), history(), recovery()]);
  })();

  setInterval(refs, cfg.poll.refs);
  setInterval(today, cfg.poll.today);
  setInterval(week, cfg.poll.week);
  setInterval(history, cfg.poll.week);
  setInterval(recovery, cfg.poll.week);
}

export const _state = state;
