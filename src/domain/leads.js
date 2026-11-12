import { cfg } from '../config.js';
import { CALL, CALL_TYPE } from '../st/endpoints.js';
import { externalPhone } from './phone.js';
import { bookedBy, bookedToday, initials, isCancelled, isEstimate } from './rules.js';

/**
 * Lead episodes — Command Center's rules (server/data/leads.ts).
 *
 * The Command Center repo is private and was not readable from this
 * environment. The rules below are the ones that file implements, as recorded
 * in the 12 Nov 2026 investigation (which read that source):
 *
 *   - A lead is an episode, not a call. Every Booked or Unbooked call, inbound
 *     or outbound, for the same customer — or the same phone when no customer
 *     is known — within 30 days of the FIRST such call, is one lead.
 *   - NotLead and Excused are not leads.
 *   - Booked (closed) if any call in the window is Booked, OR a non-cancelled
 *     job for that customer is created within 30 days of the first call. A job
 *     up to two hours before the first call still counts.
 *   - Owner is the person on the first call, not whoever later books and not
 *     the job's createdById.
 *   - Closing % = booked / leads. A lead with no customer whose 30 days have
 *     passed drops out of the denominator only. Leads still inside 30 days are
 *     pending and stay in the rate.
 *
 * Jobs booked on the People table are NOT this. They are non-cancelled jobs
 * created that day by job.createdById — the board's existing attribution.
 */

export const LEAD_WINDOW_MS = 30 * 86400000;
export const JOB_GRACE_MS = 2 * 3600 * 1000;

export function isLeadCall(call) {
  const t = CALL.type(call);
  return t === CALL_TYPE.BOOKED || t === CALL_TYPE.UNBOOKED;
}

export function isNotLeadCall(call) {
  return CALL.type(call) === CALL_TYPE.NOT_LEAD;
}

/** Inbound agent, otherwise the outbound createdBy. Same join the poller used. */
export function callAgentId(call) {
  return CALL.agentId(call) ?? CALL.inner(call).createdBy?.id ?? null;
}

function numId(id) {
  if (id == null || id === '') return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : id;
}

/**
 * Replace rows whose timestamp falls in [startMs, endMs) with `fresh`.
 * History is refreshed hourly; today's slice is swapped in on the 60s poll
 * so the lead table moves without another 60-day download.
 */
export function mergeFresh(history, fresh, startMs, endMs, timeOf) {
  const prior = (history ?? []).filter((row) => {
    const t = timeOf(row);
    return !Number.isFinite(t) || t < startMs || t >= endMs;
  });
  return prior.concat(fresh ?? []);
}

function leadKey(call, phoneToCustomer) {
  const phone = externalPhone(call);
  const cust = numId(CALL.customerId(call)) ?? (phone ? phoneToCustomer.get(phone) ?? null : null);
  if (cust != null) return `c:${cust}`;
  if (phone) return `p:${phone}`;
  return `call:${call?.id ?? CALL.receivedAt(call)}`;
}

/**
 * @returns episodes sorted by first call. Each has ownerId, customerId, booked,
 *   inDenominator, pending, noCustomerExpired, firstAt, calls.
 */
export function buildEpisodes(calls, jobs, now = Date.now()) {
  const eligible = [];
  for (const call of calls ?? []) {
    if (!isLeadCall(call)) continue;
    if (CALL.receivedAt(call) == null) continue;
    eligible.push(call);
  }

  const phoneToCustomer = new Map();
  for (const call of eligible) {
    const cust = numId(CALL.customerId(call));
    const phone = externalPhone(call);
    if (cust != null && phone && !phoneToCustomer.has(phone)) phoneToCustomer.set(phone, cust);
  }

  const groups = new Map();
  for (const call of eligible) {
    const key = leadKey(call, phoneToCustomer);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(call);
  }

  const jobsByCustomer = new Map();
  for (const job of jobs ?? []) {
    if (isCancelled(job)) continue;
    const cust = numId(job.customerId);
    if (cust == null) continue;
    const t = Date.parse(job.createdOn ?? '');
    if (!Number.isFinite(t)) continue;
    if (!jobsByCustomer.has(cust)) jobsByCustomer.set(cust, []);
    jobsByCustomer.get(cust).push({ t, createdById: numId(job.createdById), id: job.id });
  }

  const episodes = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => CALL.receivedAt(a) - CALL.receivedAt(b) || (Number(a.id) || 0) - (Number(b.id) || 0));
    let current = null;
    for (const call of list) {
      const t = CALL.receivedAt(call);
      if (!current || t > current.firstAt + LEAD_WINDOW_MS) {
        current = {
          key,
          firstAt: t,
          calls: [],
          ownerId: numId(callAgentId(call)),
          customerId: numId(CALL.customerId(call)) ?? (key.startsWith('c:') ? numId(key.slice(2)) : null),
          bookedCall: false,
        };
        episodes.push(current);
      }
      current.calls.push(call);
      const cust = numId(CALL.customerId(call));
      if (current.customerId == null && cust != null) current.customerId = cust;
      if (CALL.type(call) === CALL_TYPE.BOOKED) current.bookedCall = true;
    }
  }

  for (const ep of episodes) {
    const custJobs = ep.customerId != null ? (jobsByCustomer.get(ep.customerId) ?? []) : [];
    const windowStart = ep.firstAt - JOB_GRACE_MS;
    const windowEnd = ep.firstAt + LEAD_WINDOW_MS;
    const closing = custJobs.filter((j) => j.t >= windowStart && j.t <= windowEnd);
    ep.bookedByJob = closing.length > 0;
    ep.booked = ep.bookedCall || ep.bookedByJob;
    ep.bookedForOthers = closing
      .map((j) => j.createdById)
      .filter((id) => id != null && id !== ep.ownerId);
    const expired = now - ep.firstAt >= LEAD_WINDOW_MS;
    ep.pending = !expired;
    ep.noCustomerExpired = ep.customerId == null && expired && !ep.booked;
    ep.inDenominator = !ep.noCustomerExpired;
    ep.unbooked = !ep.booked;
  }

  episodes.sort((a, b) => a.firstAt - b.firstAt);
  return episodes;
}

export function pctRounded(booked, denom) {
  if (!denom) return null;
  return Math.round((booked / denom) * 100);
}

function blank(id) {
  return {
    id,
    leads: 0,
    bookedLeads: 0,
    unbooked: 0,
    notLead: 0,
    rateLeads: 0,
    rateBooked: 0,
    trailLeads: 0,
    trailBooked: 0,
    booked: 0,
    est: 0,
  };
}

/**
 * People rows for one board day, plus a team total.
 * `leadsReady` false → episode columns are null (history not loaded yet).
 * Jobs booked still render; they come from the day's jobs alone.
 * `booked` on a row is JOBS, so the rest of the board's sums stay job counts.
 *
 * `hideIds` (default `CSR_HIDE_EMPLOYEE_IDS`) are accumulated exactly like
 * everyone else, then dropped from `rows` only. `team` still includes them.
 * An id the roster already rejects is not counted: when `CSR_EMPLOYEE_IDS`
 * is pinned, a hidden person has to be in that list too.
 */
export function buildPeopleRows({
  employees = new Map(),
  dayEpisodes = [],
  trailingEpisodes = [],
  notLeadByEmployee = new Map(),
  jobs = [],
  csrIds = null,
  hideIds = null,
  leadsReady = true,
}) {
  const want = (csrIds ?? cfg.rules.csrEmployeeIds).map(numId).filter((id) => id != null);
  const hide = new Set(
    (hideIds ?? cfg.rules.csrHideEmployeeIds).map(numId).filter((id) => id != null),
  );
  const acc = new Map();

  const ensure = (id) => {
    const key = numId(id);
    if (key == null) return null;
    if (want.length && !want.includes(key)) return null;
    if (!acc.has(key)) acc.set(key, blank(key));
    return acc.get(key);
  };

  for (const id of want) ensure(id);

  if (leadsReady) {
    for (const ep of dayEpisodes) {
      const row = ensure(ep.ownerId);
      if (!row) continue;
      row.leads++;
      if (ep.booked) row.bookedLeads++;
      else row.unbooked++;
      if (ep.inDenominator) {
        row.rateLeads++;
        if (ep.booked) row.rateBooked++;
      }
    }
    for (const ep of trailingEpisodes) {
      const row = ensure(ep.ownerId);
      if (!row) continue;
      if (!ep.inDenominator) continue;
      row.trailLeads++;
      if (ep.booked) row.trailBooked++;
    }
  }

  for (const [id, n] of notLeadByEmployee) {
    const row = ensure(id);
    if (!row) continue;
    row.notLead += n;
  }

  for (const job of bookedToday(jobs)) {
    const row = ensure(bookedBy(job));
    if (!row) continue;
    row.booked++;
    if (isEstimate(job)) row.est++;
  }

  const accumulated = [...acc.values()];
  const toRow = (r) => {
    const name = employees.get(r.id)?.name ?? employees.get(String(r.id))?.name ?? `Employee ${r.id}`;
    return {
      n: name,
      i: initials(name),
      leads: leadsReady ? r.leads : null,
      bookedLeads: leadsReady ? r.bookedLeads : null,
      unbooked: leadsReady ? r.unbooked : null,
      notLead: r.notLead,
      closingPct: leadsReady ? pctRounded(r.rateBooked, r.rateLeads) : null,
      trailPct: leadsReady ? pctRounded(r.trailBooked, r.trailLeads) : null,
      trailBooked: leadsReady ? r.trailBooked : null,
      trailLeads: leadsReady ? r.trailLeads : null,
      rateBooked: leadsReady ? r.rateBooked : null,
      rateLeads: leadsReady ? r.rateLeads : null,
      booked: r.booked,
      est: r.est,
      st: 'none',
      stl: '',
    };
  };
  const rows = accumulated
    .filter((r) => !hide.has(r.id))
    .map(toRow)
    .sort((a, b) => a.n.localeCompare(b.n));

  const team = {
    leads: 0, bookedLeads: 0, unbooked: 0, notLead: 0, booked: 0, est: 0,
    rateLeads: 0, rateBooked: 0, trailLeads: 0, trailBooked: 0,
  };
  for (const r of accumulated) {
    team.notLead += r.notLead || 0;
    team.booked += r.booked || 0;
    team.est += r.est || 0;
    if (!leadsReady) continue;
    team.leads += r.leads || 0;
    team.bookedLeads += r.bookedLeads || 0;
    team.unbooked += r.unbooked || 0;
    team.rateLeads += r.rateLeads || 0;
    team.rateBooked += r.rateBooked || 0;
    team.trailLeads += r.trailLeads || 0;
    team.trailBooked += r.trailBooked || 0;
  }

  return {
    ready: leadsReady,
    rows,
    team: {
      leads: leadsReady ? team.leads : null,
      bookedLeads: leadsReady ? team.bookedLeads : null,
      unbooked: leadsReady ? team.unbooked : null,
      notLead: team.notLead,
      booked: team.booked,
      est: team.est,
      closingPct: leadsReady ? pctRounded(team.rateBooked, team.rateLeads) : null,
      trailPct: leadsReady ? pctRounded(team.trailBooked, team.trailLeads) : null,
      trailBooked: leadsReady ? team.trailBooked : null,
      trailLeads: leadsReady ? team.trailLeads : null,
    },
  };
}

export function peopleForWindow({
  calls = [],
  jobs = [],
  employees,
  dayStart,
  dayEnd,
  trailStart,
  trailEnd,
  now = Date.now(),
  leadsReady = true,
  csrIds = null,
  hideIds = null,
}) {
  const notLeadByEmployee = new Map();
  for (const call of calls) {
    if (!isNotLeadCall(call)) continue;
    const t = CALL.receivedAt(call);
    if (t == null || t < dayStart || t >= dayEnd) continue;
    const id = numId(callAgentId(call));
    if (id == null) continue;
    notLeadByEmployee.set(id, (notLeadByEmployee.get(id) || 0) + 1);
  }

  const dayJobs = (jobs ?? []).filter((job) => {
    const t = Date.parse(job.createdOn ?? '');
    return Number.isFinite(t) && t >= dayStart && t < dayEnd;
  });

  let dayEpisodes = [];
  let trailingEpisodes = [];
  if (leadsReady) {
    const episodes = buildEpisodes(calls, jobs, now);
    dayEpisodes = episodes.filter((ep) => ep.firstAt >= dayStart && ep.firstAt < dayEnd);
    trailingEpisodes = episodes.filter((ep) => ep.firstAt >= trailStart && ep.firstAt < trailEnd);
  }

  return buildPeopleRows({
    employees,
    dayEpisodes,
    trailingEpisodes,
    notLeadByEmployee,
    jobs: dayJobs,
    csrIds,
    hideIds,
    leadsReady,
  });
}
