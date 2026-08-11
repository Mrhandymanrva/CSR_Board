import { techCfg } from './config.js';
import { CANCELLED_STATUSES } from '../st/endpoints.js';

/* ── Technician board business rules. Change them HERE, nowhere else. ──
   Every number on the tech board is produced by a function in this file.
   These decide what a technician is measured on, so they are the part
   somebody will want to argue with — which is exactly why they are
   together, commented, and out of the poller.

   RECONCILED against the ServiceTitan Liveboard on 2026-08-11: all 18
   technicians matched to the cent on dollars AND job count for Mon 8/10
   ($23,093.12 / 31 jobs). If you change anything below, re-run that
   comparison before trusting the board again. */

export const isCancelled = (job) => CANCELLED_STATUSES.includes(job.jobStatus);

/**
 * THE MONEY: `job.total`.
 *
 * Not an invoice total — the ServiceTitan app this runs under has no
 * Accounting scope, so `accounting/v2/invoices` returns 403 and invoice-level
 * technician splits are simply unavailable. `job.total` was measured against
 * the Liveboard and IS the same number, with no tax or invoice-date
 * adjustment needed. Do not "improve" this to an invoice lookup without
 * getting the scope added and re-reconciling.
 */
export const revenueOf = (job) => Number(job.total) || 0;

/**
 * THE DAY: when the job was COMPLETED.
 *
 * `completedOnOrAfter` / `completedBefore` are honoured by the jobs endpoint
 * (222 rows against 79,630 unfiltered, with a deliberately bogus control
 * parameter returning the full set — see st/endpoints.js on why that control
 * matters). Revenue lands on the board the day the work finished.
 */
export const isCallback = (job) => job.recallForId != null;
export const isNoCharge = (job) => job.noCharge === true;
export const isEstimateJob = (job) => techCfg.estimateJobTypeIds.includes(job.jobTypeId);

/**
 * ATTRIBUTION: the technicians actively assigned to the job.
 *
 * `dispatch/v2/appointment-assignments?jobId={id}` gives technicianId directly.
 * The obvious alternative — jobs → appointments → assignments — was built and
 * measured, and it is strictly worse: it attributed 29 of 31 jobs where the
 * direct call got 31 of 31, because a job can carry an assignment without the
 * appointment hop resolving. Do not reintroduce the appointments hop.
 *
 * `active: false` rows are dropped: those are assignments that were removed,
 * and counting them credits a technician who was taken off the job.
 */
export function techsOnJob(assignments) {
  const out = new Set();
  for (const a of assignments ?? []) {
    if (a?.active === false) continue;
    if (a?.technicianId) out.add(a.technicianId);
  }
  return [...out];
}

/**
 * SPLIT: a job worked by two technicians splits evenly between them.
 *
 * Decided with Mason 2026-08-11. The alternative — full credit to each — makes
 * the column totals larger than the day's actual revenue, which is the kind of
 * number that gets a board switched off the first time somebody adds it up.
 * Splitting keeps every column reconcilable against ServiceTitan.
 *
 * Currently near-hypothetical: every job in the sampled week had exactly one
 * technician. The rule exists so the first two-tech job does not silently
 * inflate the board.
 */
export function creditPerTech(job, techIds) {
  const n = techIds.length;
  return n ? revenueOf(job) / n : 0;
}

/**
 * NON-REVENUE WORK — the rule this board most needs to get right.
 *
 * A technician who ran three estimate visits invoiced nothing, and that is
 * the job working correctly, not a failure. 34 of 151 completed jobs in the
 * sampled week were zero-dollar: estimate visits and `noCharge` warranty
 * work. Rendering those as a red $0 against a $1,100 goal, on a screen on a
 * wall, is an accusation — and a false one.
 *
 * CRITICAL: this is a property of the DAY, not of the technician. Jarrod S
 * looked like a warranty-only tech across four sampled jobs and then sold
 * $1,253 the next day. Deciding it per technician was wrong within the hour.
 *
 * (This is the same class of defect as the call-center board showing AmyW as
 * "0 calls" on a day she made 117 outbound — see ../domain/rules.js.)
 */
export const isNonRevenueDay = (cell) => cell.jobs > 0 && cell.revenue === 0;

/** Labels a non-revenue day from what the jobs actually were. */
export function nonRevenueLabel(cell) {
  if (cell.estimates > 0 && cell.noCharge === 0) return 'estimates';
  if (cell.noCharge > 0 && cell.estimates === 0) return 'no charge';
  return 'no invoice';
}

/**
 * GOAL: ServiceTitan's own `dailyGoal` on the technician record.
 *
 * Real and populated (1100–1300 across the roster). This is the franchise's
 * number, not one this board invented, which is what makes it defensible.
 * A technician with no goal set gets no bar rather than a 0% one.
 */
export const goalOf = (tech) => Number(tech?.dailyGoal) || 0;

/**
 * Deliberately NO intraday pace marker.
 *
 * A tick at "the day is 46% elapsed" was built and removed. Revenue is
 * back-loaded — it lands when a job closes, so a linear pace line shows the
 * whole crew behind every morning and corrects itself by 4pm. An honest pace
 * curve needs the tenant's own intraday shape, which needs history this
 * board does not keep. Until then the bar is a plain percentage of goal, and
 * it is NEVER red: below goal renders neutral steel, because a technician at
 * 10am is not failing.
 */
export function goalPct(revenue, goal) {
  return goal > 0 ? Math.round((revenue / goal) * 100) : null;
}

/**
 * Rolls the technician × day matrix into render rows.
 *
 * `byDay` is an array of { offset, byTech: Map<techId, cell>, ... }, one entry
 * per column, Mon..Sat. A cell is { revenue, jobs, estimates, noCharge, callbacks }.
 *
 * ORDER IS ALPHABETICAL, from the server. ServiceTitan's own Liveboard sorts
 * this way and so does the call-center board, for the same two reasons:
 * sorting by revenue turns a status board into a league table, and a stable
 * order lets a technician find their own line from across the room instead of
 * hunting for it after every poll.
 */
export function buildTechRows(byDay, roster, todayIndex) {
  const seen = new Map();

  for (const day of byDay) {
    for (const [techId, cell] of day.byTech) {
      if (!seen.has(techId)) seen.set(techId, []);
    }
  }
  // Every technician who appears on ANY day of the week gets a row, so a tech
  // who worked Monday and is off today does not vanish from the board.
  for (const t of roster.values()) if (!seen.has(t.id) && !techCfg.hideIdle) seen.set(t.id, []);

  const rows = [];
  for (const techId of seen.keys()) {
    const tech = roster.get(techId);
    const name = tech?.name ?? `Technician ${techId}`;
    const goal = goalOf(tech);

    const cells = byDay.map((day) => {
      const c = day.byTech.get(techId);
      if (!c) return null;
      const cell = {
        revenue: Math.round(c.revenue * 100) / 100,
        jobs: c.jobs,
        estimates: c.estimates,
        noCharge: c.noCharge,
      };
      cell.nonRevenue = isNonRevenueDay(cell);
      if (cell.nonRevenue) cell.label = nonRevenueLabel(cell);
      return cell;
    });

    const weekRevenue = cells.reduce((s, c) => s + (c?.revenue ?? 0), 0);
    const weekJobs = cells.reduce((s, c) => s + (c?.jobs ?? 0), 0);
    const callbacks = byDay.reduce((s, d) => s + (d.byTech.get(techId)?.callbacks ?? 0), 0);
    const today = cells[todayIndex];

    rows.push({
      id: techId,
      n: name,
      i: initials(name),
      bu: tech?.businessUnitId ?? null,
      goal,
      cells,
      today: today?.revenue ?? 0,
      todayJobs: today?.jobs ?? 0,
      todayNonRevenue: today?.nonRevenue ?? false,
      todayLabel: today?.label ?? null,
      /* No jobs closed today → no percentage, not 0%.
         A technician who is off, or who simply has not closed anything yet, is
         not "0% of goal" — that reads as failing on a wall-mounted screen. The
         board can't tell a day off from a slow morning (nothing in the payload
         distinguishes them), so it says nothing rather than something false.
         Once a job closes there is a real number and the bar appears. */
      pct: today?.nonRevenue || !(today?.jobs > 0) ? null : goalPct(today.revenue, goal),
      weekRevenue: Math.round(weekRevenue * 100) / 100,
      weekJobs,
      callbacks,
    });
  }

  return rows.sort((a, b) => a.n.localeCompare(b.n));
}

/** Column and board totals. Sums the SAME split credit the rows show, so the
    footer always reconciles against the cells above it. */
export function totals(rows, dayCount) {
  const perDay = Array.from({ length: dayCount }, (_, i) => {
    let revenue = 0, jobs = 0;
    for (const r of rows) {
      revenue += r.cells[i]?.revenue ?? 0;
      jobs += r.cells[i]?.jobs ?? 0;
    }
    return { revenue: Math.round(revenue * 100) / 100, jobs };
  });
  return {
    perDay,
    weekRevenue: Math.round(perDay.reduce((s, d) => s + d.revenue, 0) * 100) / 100,
    weekJobs: perDay.reduce((s, d) => s + d.jobs, 0),
  };
}

function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase();
}

export const _test = { initials };
