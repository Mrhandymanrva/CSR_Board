/**
 * ENDPOINT + PARAMETER MAP — single source of truth.
 *
 * ⚠️ READ THIS BEFORE WRITING POLLER CODE ⚠️
 *
 * The module/path values below follow the documented ServiceTitan v2
 * pattern: {api}/{module}/v2/tenant/{tenantId}/{path}
 *
 * The QUERY PARAMETER NAMES are the part most likely to be wrong. They
 * differ between endpoints and have changed across releases. DO NOT trust
 * them from memory or from this file alone.
 *
 * Step one of the build is:
 *     npm run probe
 *
 * which calls each endpoint with no filters, prints the response envelope
 * and the first record's keys, and then retries with the filters below so
 * you can confirm each one narrows the result set. Fix anything here that
 * the probe shows is wrong, in this file only. Nothing else references
 * literal parameter names.
 *
 * Authoritative reference: the Swagger/OpenAPI spec on the tenant's own
 * Developer Portal account (developer.servicetitan.io → API Reference).
 */

export const EP = {
  // ── Reference data (polled hourly) ──────────────────────────────
  businessUnits: { module: 'settings', path: 'business-units' },
  employees:     { module: 'settings', path: 'employees' },
  jobTypes:      { module: 'jpm',      path: 'job-types' },

  // ── Jobs (polled every 60s) ─────────────────────────────────────
  jobs: { module: 'jpm', path: 'jobs' },

  // ── Telecom: inbound calls (polled every 60s) ───────────────────
  // CONFIRMED against tenant 412939912: telecom/v2/tenant/{id}/calls answers
  // and paginates. (A v3 surface exists; v2 carries everything the board needs.)
  calls: { module: 'telecom', path: 'calls' },
};

/**
 * TELECOM RECORD SHAPE — confirmed against the live tenant, not assumed.
 *
 * A call row is NOT flat. Everything the board needs is nested one level down:
 *
 *   { id, jobNumber, projectId, businessUnit, type,
 *     leadCall: { direction, callType, duration, receivedOn,
 *                 agent:    { id, name },        ← who handled it
 *                 reason:   { id, name, lead },
 *                 customer: {...}, campaign: {...}, ... } }
 *
 * The first version of the poller read `call.direction`, `call.abandoned`,
 * `call.reasonId` and `call.createdById` at the top level. None of those exist.
 * Every one silently resolved to undefined, producing a board that showed a
 * 0.0% abandon rate and zero opportunities for every CSR — wrong, but wrong in
 * a way that looks like a quiet day. Read call fields through CALL below.
 *
 * `createdBy` is populated on OUTBOUND calls only (0 of 46 inbound carried it).
 * Inbound attribution is `leadCall.agent`. Abandoned calls have no agent at
 * all, which is correct — nobody picked up.
 */
export const CALL = {
  inner: (c) => c?.leadCall ?? {},
  direction: (c) => CALL.inner(c).direction,
  type: (c) => CALL.inner(c).callType,
  agentId: (c) => CALL.inner(c).agent?.id ?? null,
  agentName: (c) => CALL.inner(c).agent?.name ?? null,
  reasonId: (c) => CALL.inner(c).reason?.id ?? null,
  customerId: (c) => CALL.inner(c).customer?.id ?? null,
  durationSecs: (c) => hhmmssToSecs(CALL.inner(c).duration),
  /** Epoch ms the call arrived. `receivedOn` is the truth; `createdOn` backs it up. */
  receivedAt: (c) => {
    const t = Date.parse(CALL.inner(c).receivedOn ?? CALL.inner(c).createdOn ?? '');
    return Number.isFinite(t) ? t : null;
  },
};

/** Durations arrive as "00:03:46" (sometimes with fractional seconds). */
function hhmmssToSecs(d) {
  if (typeof d !== 'string') return null;
  const [h, m, s] = d.split(':');
  const secs = Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
  return Number.isFinite(secs) ? Math.round(secs) : null;
}

/**
 * ServiceTitan's own call classification — the thing that makes an honest
 * booking rate possible. Observed over three days: 525 of 526 calls carry one.
 *
 *   Booked    — lead call that produced a booking
 *   Unbooked  — lead call that did not              ← the miss
 *   Abandoned — caller hung up before an agent answered
 *   NotLead   — not a booking opportunity (vendor, wrong number, inquiry)
 *   Excused   — opportunity nobody could book for a legitimate reason
 *               (out of area, work we don't do) — kept out of the denominator
 */
export const CALL_TYPE = {
  BOOKED: 'Booked',
  UNBOOKED: 'Unbooked',
  ABANDONED: 'Abandoned',
  NOT_LEAD: 'NotLead',
  EXCUSED: 'Excused',
};

/**
 * Query parameter names, isolated so a rename is a one-line fix.
 * Values are ISO-8601 UTC strings produced by config.localDayWindow().
 */
export const PARAM = {
  jobs: {
    // Jobs CREATED in a window → "booked today"
    createdOnOrAfter: 'createdOnOrAfter',
    createdBefore: 'createdBefore',

    // Jobs SCHEDULED/appointed in a window → "on today's board"
    // NOTE: on some tenants the working filter is appointmentStartsOnOrAfter;
    // on others it is firstAppointmentStartsOnOrAfter. Probe confirms which.
    scheduledOnOrAfter: 'appointmentStartsOnOrAfter',
    scheduledBefore: 'appointmentStartsBefore',

    // Comma-separated status filter, e.g. "Scheduled,Dispatched,InProgress,Completed"
    jobStatus: 'jobStatus',
  },
  calls: {
    createdOnOrAfter: 'createdOnOrAfter',
    createdBefore: 'createdBefore',
  },
};

/**
 * Job statuses that count as "on today's board".
 * Canceled is excluded deliberately — a cancelled job is not work you
 * are running today, and counting it hides the hole it left.
 */
export const DISPATCH_STATUSES = ['Scheduled', 'Dispatched', 'InProgress', 'Completed'];

/** Statuses excluded from "booked today". A job booked then cancelled is not a booking. */
export const CANCELLED_STATUSES = ['Canceled', 'Cancelled'];
