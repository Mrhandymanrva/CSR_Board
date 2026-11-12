import { cfg, localHourDow, localDayKey } from '../config.js';
import { DISPATCH_STATUSES, CANCELLED_STATUSES, CALL, CALL_TYPE } from '../st/endpoints.js';

/* ── Business rules. Change them HERE, nowhere else. ──────────────
   Every number on the wallboard is produced by a function in this file.
   Keeping them together is what makes the board defensible when a CSR
   disputes their score. */

export const isCancelled = (job) => CANCELLED_STATUSES.includes(job.jobStatus);

export const isEstimate = (job) =>
  cfg.rules.estimateJobTypeIds.includes(job.jobTypeId);

export const onTodaysBoard = (job) =>
  !isCancelled(job) && DISPATCH_STATUSES.includes(job.jobStatus);

/**
 * ATTRIBUTION: a booking belongs to the employee who created the job.
 *
 * Decided with Mason. The alternatives were considered and rejected:
 *   - "whoever the call was routed to" splits credit on transfers
 *   - "whoever owns the customer" credits the wrong person on repeats
 * createdById is the person who typed it in, which is the behaviour we
 * are trying to reward. Callback bookings therefore credit the CSR who
 * closed it, not the one who took the original call.
 */
export const bookedBy = (job) => job.createdById ?? null;

/**
 * BOOKED TODAY: job created during the local day, not cancelled.
 * A job booked today for a date three weeks out counts today — this is
 * a replacement measure, not a same-day measure. See CLAUDE.md.
 */
export const bookedToday = (jobs) => jobs.filter((j) => !isCancelled(j));

/** Net replacement: booked today minus what today's board is consuming. */
export function net(bookedCount, dispatchCount) {
  return bookedCount - dispatchCount;
}

/** Three states. Zero is EVEN, not ahead — do not collapse this to a boolean. */
export function netState(n) {
  return n < 0 ? 'neg' : n > 0 ? 'pos' : 'even';
}

/* ── Call rules ───────────────────────────────────────────────────
   THIS IS NOT A DISPATCH-FIRST BUSINESS. Decided with Mason 2026-07-29,
   after the per-call booking rate was measured and thrown out. Read this
   before reintroducing any "did this call book?" percentage.

   Three findings killed it, all from the tenant's own 14-28 day history:

   1. The call funnel explains a FIFTH of the work. Of 398 live jobs in 14
      days, 75 (19%) carried a leadCallId at all. 24 came from online
      booking. The other ~300 arrive from repeat customers, callbacks and
      follow-up with no call attached. A per-call rate cannot see them.

   2. ServiceTitan's "Booked" means booked DURING the call. Every one of
      those 75 job-to-call lags was under an hour. There is no field that
      records "this call led to a booking on Thursday", so the metric is
      structurally a first-call-close rate — an HVAC measure.

   3. Intake works, and the rate scores it as failure. Missed and unbooked
      callers come back: 22% of in-hours missed callers, 26% of Unbooked
      and 32% of NotLead are booked within 7 days, median lag ~2 days.
      The Booked cohort re-books at 3%, which is the control proving the
      signal is real and not repeat-customer background noise.

   So there is still no per-call booking rate and no rank. Recovery stays a
   trailing customer measure. The People table (owner-approved mockup D,
   2026-11-12) is that same customer-level measure: one lead per customer
   over 30 days, closing % with pending leads kept in. It is not the
   deleted per-call rate. See src/domain/leads.js. */

/**
 * Calls outside opening hours are not a service failure — nobody is there.
 * 97% of the 951 out-of-hours calls in a 28-day window went unanswered, and
 * counting them reported 53% abandonment against a real in-hours 35%.
 */
export function inBusinessHours(call) {
  const ts = CALL.receivedAt(call);
  if (!ts) return false;
  const { hour, dow } = localHourDow(new Date(ts));
  return cfg.rules.openDays.includes(dow) && hour >= cfg.rules.openHour && hour < cfg.rules.closeHour;
}

/**
 * MISSED, not lost. Never label these "lost" — 1 in 5 becomes a booking
 * inside a week. They hand off to text-back, or, on overflow, to Broadly.
 *
 * With no RingCentral annotation this is the historical rule: inbound and
 * ServiceTitan `Abandoned`. That flag is not "nobody picked up" — a CSR can
 * accept the call and never disposition it — but without the call log it is
 * the only signal we have, and the board must keep using it.
 *
 * When the poller has joined a RingCentral log it sets `call._rc` and this
 * follows that classification instead: answered if any non-overflow leg was
 * Accepted or an agent is present; missed only when the call was truly
 * unanswered; overflow to Broadly/Nonstop is not a miss.
 */
export const isMissed = (call) => {
  if (call?._rc) return call._rc.missed === true;
  return isInbound(call) && isAbandonedCall(call);
};

/** One row per caller per day: three retries by one person is one missed customer. */
export const callerDayKey = (call) =>
  `${CALL.inner(call).from ?? '?'}|${localDayKey(new Date(CALL.receivedAt(call) ?? 0))}`;

/**
 * MISSED-CALL RECOVERY — the measure that replaced booking rate.
 *
 * Of the callers we missed during opening hours, how many had a job booked
 * for them within `recoveryDays`? Counted per customer, not per call.
 *
 * Only calls with a full recovery window behind them are scored, so a
 * follow-up still in progress is never counted as a failure. Callers with no
 * ServiceTitan customer record (40% of missed calls — unknown numbers) cannot
 * be matched and are reported separately rather than silently assumed lost.
 */
export function recovery(missedCalls, jobsByCustomer, now = Date.now()) {
  const DAY = 86400000;
  const windowMs = cfg.rules.recoveryDays * DAY;
  let scored = 0, recovered = 0, unmatchable = 0, pending = 0;

  for (const c of missedCalls) {
    const t0 = CALL.receivedAt(c);
    if (t0 == null) continue;
    if (now - t0 < windowMs) { pending++; continue; }
    const cust = CALL.inner(c).customer?.id;
    if (cust == null) { unmatchable++; continue; }
    scored++;
    const hit = (jobsByCustomer.get(cust) ?? [])
      .some((t) => t > t0 + 3600e3 && t < t0 + windowMs);
    if (hit) recovered++;
  }

  return {
    scored,
    recovered,
    unmatchable,
    pending,
    pct: scored > 0 ? (recovered / scored) * 100 : null,
  };
}

export const isInbound = (call) => /inbound/i.test(CALL.direction(call) ?? '');
export const isBookedCall = (call) => CALL.type(call) === CALL_TYPE.BOOKED;
export const isAbandonedCall = (call) => CALL.type(call) === CALL_TYPE.ABANDONED;

/**
 * An OPPORTUNITY is an inbound lead call somebody could have booked.
 * Booked + Unbooked only. NotLead is not an opportunity, Excused was not
 * winnable. Abandoned is not an opportunity either — it is the missed tile.
 * Abandoned is not proof that nobody answered; see isMissed.
 */
export const isOpportunity = (call) =>
  isInbound(call) && [CALL_TYPE.BOOKED, CALL_TYPE.UNBOOKED].includes(CALL.type(call));

/** Attribution for inbound calls is the agent who answered. See CALL. */
export const handledBy = (call) => CALL.agentId(call);

/**
 * ANSWERED: somebody picked up.
 *
 * Without RingCentral: agent present and not Abandoned. Both were checked
 * because they agreed on the calls this board was built against.
 *
 * With `call._rc` (matching on): RingCentral Accepted on a non-overflow leg,
 * or a ServiceTitan agent, or a real disposition. Abandoned + Accepted is
 * answered with no disposition — it is not a miss, and it counts in the
 * average call length.
 */
export const isAnswered = (call) => {
  if (call?._rc) return call._rc.answered === true;
  return handledBy(call) != null && !isAbandonedCall(call);
};

/**
 * AVERAGE CALL LENGTH — over answered calls only.
 *
 * `leadCall.duration` is NOT pure talk time. Abandoned calls, which no agent
 * ever touched, still carry a duration (117s average, 779s max), so the field
 * plainly includes the time a caller spends on the line before pickup. For an
 * answered call it is therefore wait + talk, and the two cannot be separated
 * from this payload — there is no queue or answer timestamp on the record.
 *
 * So this is reported as average CALL LENGTH, not "talk time". Averaging every
 * inbound call instead would fold hold time on abandoned calls into a number
 * captioned as conversation, which is the same quiet kind of wrong as the
 * 0.0% abandon rate this board used to show.
 */
export function avgCallSecs(calls) {
  const ds = calls.filter(isAnswered).map(CALL.durationSecs).filter((d) => Number.isFinite(d) && d > 0);
  return ds.length ? Math.round(ds.reduce((a, b) => a + b, 0) / ds.length) : null;
}

/** 250 → "4m 10s", 47 → "47s". Kept short; the board has ~90px for it. */
export function fmtSecs(s) {
  if (s == null) return '—';
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/* `bookingRate()` and `estimateShare()` were removed on 2026-07-29 rather than
   left unused. Both encode the dispatch-first assumption this board rejected:
   that a call should close, and that booking an estimate is a lesser outcome.
   A dead helper is how a deleted metric comes back. If you need per-call
   conversion for analysis, compute it in a script, not here. */

/* People rows (leads, closing %, jobs booked) live in src/domain/leads.js.
   `booked` on those rows is still jobs created today by createdById — a
   volume count. It is not the lead's booked flag. One lead can book several
   jobs, and the person who owns the lead can differ from createdById. */

/** Groups jobs into the BU rows shown bottom-right. */
export function buildBuRows(bookedJobs, dispatchJobs, businessUnits) {
  const rows = new Map();
  const touch = (id) => {
    if (!rows.has(id)) {
      const bu = businessUnits.get(id);
      rows.set(id, { id, n: shortBuName(bu?.name ?? `BU ${id}`), loc: locTag(bu?.name ?? ''), booked: 0, est: 0, disp: 0 });
    }
    return rows.get(id);
  };

  for (const j of bookedToday(bookedJobs)) {
    const r = touch(j.businessUnitId);
    r.booked++;
    if (isEstimate(j)) r.est++;
  }
  for (const j of dispatchJobs.filter(onTodaysBoard)) touch(j.businessUnitId).disp++;

  return [...rows.values()].sort((a, b) => b.disp - a.disp || b.booked - a.booked);
}

/* ── Naming helpers ───────────────────────────────────────────────
   ServiceTitan BU names are long ("Richmond - Level 1 Service") and the
   board has ~500px for the column, so the location is split into a short
   tag and the rest is trimmed.

   Driven entirely by BU_LOCATION_TAGS so another franchise can deploy this
   without touching code. These used to be hardcoded Richmond/Hampton
   regexes, which is exactly the kind of thing that makes a tool
   un-shareable. With no config the tag is blank and the full name shows. */

function locTag(buName) {
  const name = String(buName).toLowerCase();
  return cfg.brand.locationTags.find((t) => name.includes(t.match))?.tag ?? '';
}

function shortBuName(buName) {
  let out = String(buName);
  // Drop a leading location prefix ("Richmond - Level 1" → "Level 1"), but
  // only when it is one we are already showing as a tag.
  for (const { match } of cfg.brand.locationTags) {
    const re = new RegExp(`^\\s*${match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^-–—:]*[-–—:]\\s*`, 'i');
    if (re.test(out)) { out = out.replace(re, ''); break; }
  }
  return out.replace(/\s*[-–—]\s*/g, ' — ').trim();
}

export function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase();
}

export const _test = { locTag, shortBuName, initials };
