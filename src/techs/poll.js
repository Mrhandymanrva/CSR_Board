import { stGet, stGetAll } from '../st/client.js';
import { EP, PARAM } from '../st/endpoints.js';
import { cfg, localDayWindow, localTimeLabel } from '../config.js';
import { techCfg, weekOffsets, mondayOffset, dayColLabel, weekLabel, DAYS_IN_WEEK } from './config.js';
import * as R from './rules.js';

/* ── Technician board poller ──────────────────────────────────────
   Same shape as ../poll/index.js: no database, an in-memory snapshot
   recomputed from the API. A redeploy costs one poll cycle, not history.

   COST. One jobs call per day, then one assignments call per job. A weekday
   is ~31 jobs, so a live cycle is ~32 requests every 90s against a 60
   req/sec/app/tenant limit — nowhere near it. Prior days in the week are
   fetched once and cached, so the expensive part (five finished days, ~150
   requests) happens on boot and then every 15 minutes, not every cycle. */

const state = {
  refs: { technicians: new Map(), businessUnits: new Map() },
  days: new Map(),          // offset → { revenue, jobs, byTech, fetchedAt }
  lastOk: null,
  lastError: null,
};

/** Bounded concurrency. 6 keeps a full day's fan-out around a second. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

export async function pollRefs() {
  const [techs, bus] = await Promise.all([
    stGetAll(EP.technicians.module, EP.technicians.path, { active: 'True' }),
    stGetAll(EP.businessUnits.module, EP.businessUnits.path, { active: 'True' }),
  ]);
  state.refs.technicians = new Map(techs.map((t) => [t.id, t]));
  state.refs.businessUnits = new Map(bus.map((b) => [b.id, b]));
}

/**
 * Builds one day column: every completed job, split across its technicians.
 *
 * Cancelled jobs are dropped. They come back inside the completed-on window
 * (31 of 222 in the sampled week) and counting them would put cancelled work
 * on a revenue board.
 */
async function fetchDay(offset) {
  const { start, end } = localDayWindow(offset);
  const jobs = (await stGetAll(EP.jobs.module, EP.jobs.path, {
    [PARAM.jobsCompleted.completedOnOrAfter]: start,
    [PARAM.jobsCompleted.completedBefore]: end,
  })).filter((j) => !R.isCancelled(j));

  const assigned = await pool(jobs, 6, async (job) => {
    const res = await stGet(EP.appointmentAssignments.module, EP.appointmentAssignments.path, {
      [PARAM.assignments.jobId]: job.id,
      pageSize: 50,
    });
    return { job, techs: R.techsOnJob(res?.data) };
  });

  const byTech = new Map();
  let revenue = 0, unattributed = 0, unattributedRevenue = 0;

  for (const { job, techs } of assigned) {
    const money = R.revenueOf(job);
    revenue += money;

    // Surfaced, never silently dropped: a job nobody is assigned to is money
    // the board cannot place, and hiding it makes the columns stop adding up.
    if (!techs.length) { unattributed++; unattributedRevenue += money; continue; }

    const share = R.creditPerTech(job, techs);
    for (const id of techs) {
      if (!byTech.has(id)) byTech.set(id, { revenue: 0, jobs: 0, estimates: 0, noCharge: 0, callbacks: 0 });
      const cell = byTech.get(id);
      cell.revenue += share;
      cell.jobs++;
      if (R.isEstimateJob(job)) cell.estimates++;
      if (R.isNoCharge(job)) cell.noCharge++;
      if (R.isCallback(job)) cell.callbacks++;
    }
  }

  return {
    offset,
    revenue: Math.round(revenue * 100) / 100,
    jobs: jobs.length,
    byTech,
    unattributed,
    unattributedRevenue: Math.round(unattributedRevenue * 100) / 100,
    fetchedAt: Date.now(),
  };
}

/** Today is always refetched. A finished day is cached for `poll.priorDays`. */
async function getDay(offset) {
  const cached = state.days.get(offset);
  const ttl = offset === 0 ? 0 : techCfg.poll.priorDays;
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached;
  const day = await fetchDay(offset);
  state.days.set(offset, day);
  return day;
}

export async function pollToday() {
  state.days.set(0, await fetchDay(0));
  state.lastOk = Date.now();
  state.lastError = null;
}

/** Warms the finished days of the current week. */
export async function pollWeek() {
  for (const off of weekOffsets(0)) {
    if (off === 0 || off > 0) continue;         // today is the live poll; future days do not exist yet
    await getDay(off);
  }
}

/** `weeksBack` 0 = this week. Clamped so the ‹ button cannot walk off. */
export function clampWeek(raw) {
  const n = Number.parseInt(raw ?? '0', 10);
  if (!Number.isFinite(n)) return 0;
  return Math.min(0, Math.max(-techCfg.maxLookbackWeeks, n));
}

/* ── Snapshot: the contract public/techboard.html renders ──────────
   Change this and change render() in techboard.html in the same commit. */
export async function snapshot(weeksBack = 0) {
  const offsets = weekOffsets(weeksBack * 7);
  const isThisWeek = weeksBack === 0;

  // Future days of the current week are not fetched — they have not happened.
  const days = [];
  for (const off of offsets) {
    days.push(off > 0 ? { offset: off, revenue: 0, jobs: 0, byTech: new Map(), unattributed: 0, unattributedRevenue: 0, future: true }
                      : await getDay(off));
  }

  const todayIndex = offsets.indexOf(0);
  const rows = R.buildTechRows(days, state.refs.technicians, todayIndex);
  const tot = R.totals(rows, DAYS_IN_WEEK);

  const crewGoal = rows.reduce((s, r) => s + r.goal, 0);
  const todayRevenue = todayIndex >= 0 ? tot.perDay[todayIndex].revenue : 0;
  const todayJobs = todayIndex >= 0 ? tot.perDay[todayIndex].jobs : 0;
  const revenueJobs = rows.reduce((s, r) => s + (r.todayNonRevenue ? 0 : r.todayJobs), 0);
  const estimateVisits = rows.reduce((s, r) => s + (r.todayNonRevenue ? r.todayJobs : 0), 0);

  const unattributed = days.reduce((s, d) => s + (d.unattributed ?? 0), 0);

  return {
    ready: state.lastOk != null,
    generatedAt: new Date().toISOString(),
    asOf: localTimeLabel(),

    week: weeksBack,
    isThisWeek,
    weekLabel: weekLabel(weeksBack * 7),
    maxLookbackWeeks: techCfg.maxLookbackWeeks,
    /* `stale` can only ever mean "the live poller stopped", so it applies to
       this week only. A finished week is done, not stale — flagging it amber
       would train people to ignore the warning that matters. */
    stale: isThisWeek ? Date.now() - (state.lastOk ?? 0) > techCfg.poll.today * 3 : false,
    error: isThisWeek ? state.lastError : null,

    todayIndex,
    columns: offsets.map((off) => ({
      offset: off,
      label: dayColLabel(off),
      isToday: off === 0,
      isFuture: off > 0,
      isSaturday: off === mondayOffset(weeksBack * 7) + 5,
    })),

    kpi: {
      todayRevenue,
      todayJobs,
      revenueJobs,
      estimateVisits,
      crewGoal,
      crewPct: crewGoal > 0 ? Math.round((todayRevenue / crewGoal) * 100) : null,
      avgTicket: revenueJobs > 0 ? Math.round(todayRevenue / revenueJobs) : null,
      techsInvoicing: rows.filter((r) => r.today > 0).length,
      techsOnBoard: rows.length,
      weekRevenue: tot.weekRevenue,
      weekJobs: tot.weekJobs,
      callbacks: rows.reduce((s, r) => s + r.callbacks, 0),
    },

    rows,
    totals: tot,

    /* Shown in the footer. A revenue board that quietly drops money it cannot
       place is worse than one that admits it. 0 across the sampled week. */
    integrity: {
      unattributed,
      matched: tot.weekJobs,
      unattributedRevenue: Math.round(days.reduce((s, d) => s + (d.unattributedRevenue ?? 0), 0) * 100) / 100,
    },

    buNames: Object.fromEntries([...state.refs.businessUnits].map(([id, b]) => [id, b.name])),
  };
}

/* ── Scheduler ────────────────────────────────────────────────────
   Each task is wrapped so one failing endpoint cannot take the board down —
   and, because both boards run in one process, cannot take the call-center
   board down either. */
export function start() {
  const guard = (name, fn) => async () => {
    try { await fn(); }
    catch (e) {
      state.lastError = `${name}: ${e.message}`;
      console.error(`[techboard] ${name} failed:`, e.message);
    }
  };

  const refs = guard('refs', pollRefs);
  const today = guard('today', pollToday);
  const week = guard('week', pollWeek);

  (async () => { await refs(); await today(); await week(); })();

  setInterval(refs, techCfg.poll.refs);
  setInterval(today, techCfg.poll.today);
  setInterval(week, techCfg.poll.priorDays);
}

export const _state = state;
