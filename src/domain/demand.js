import { CALL } from '../st/endpoints.js';
import { classifyCall, summarizeRc } from './callClass.js';
import { matchCall } from '../rc/match.js';
import * as R from './rules.js';

/**
 * Stamp `_rc` on inbound calls. Outbound is left untouched so effort math
 * (and the legacy isAnswered path) does not change for it.
 * `index === null` with this function still called means matching is on and
 * this call simply did not join — classifyCall then falls back to the
 * ServiceTitan row (agent present, or Abandoned with nobody on it).
 */
export function annotateInbound(raw, index, overflow) {
  for (const call of raw ?? []) {
    if (!R.isInbound(call)) continue;
    const hits = index ? matchCall(call, index) : null;
    const summary = hits?.length ? summarizeRc(hits, overflow) : null;
    call._rc = classifyCall(call, summary);
  }
  return raw;
}

/**
 * The demand tally. With no `_rc` on any call and `rcEnabled` false, the
 * missed / reached split is the historical one: in-hours inbound Abandoned
 * is a miss, everything else in hours is a reached caller.
 */
export function reduceCalls(raw, { rcEnabled = false } = {}) {
  const inbound = raw.filter(R.isInbound);
  const calls = inbound.filter(R.inBusinessHours);
  const afterHours = inbound.length - calls.length;
  const rcOn = rcEnabled || raw.some((c) => c && c._rc);

  const callsBy = new Map();
  const outBy = new Map();
  const oppsBy = new Map();
  const convBy = new Map();
  const talkBy = new Map();
  const bump = (m, k) => k != null && m.set(k, (m.get(k) || 0) + 1);
  const addSecs = (k, secs) => {
    if (k == null || !Number.isFinite(secs) || secs <= 0) return;
    const t = talkBy.get(k) ?? { secs: 0, n: 0 };
    t.secs += secs;
    t.n++;
    talkBy.set(k, t);
  };

  for (const c of raw) {
    if (R.isInbound(c)) continue;
    const emp = R.handledBy(c) ?? CALL.inner(c).createdBy?.id ?? null;
    bump(outBy, emp);
    addSecs(emp, CALL.durationSecs(c));
  }

  let abandoned = 0;
  let stAbandoned = 0;
  let opportunities = 0;
  let converted = 0;
  let broadly = 0;
  let undisp = 0;
  const missedCallers = new Set();
  const reachedCallers = new Set();

  for (const c of calls) {
    const emp = R.handledBy(c);
    bump(callsBy, emp);
    if (R.isAbandonedCall(c)) stAbandoned++;

    // Sent to Broadly is not a miss and not a person reached.
    if (c._rc?.broadly) {
      broadly++;
    } else if (R.isMissed(c)) {
      abandoned++;
      missedCallers.add(R.callerDayKey(c));
    } else {
      reachedCallers.add(R.callerDayKey(c));
    }

    if (c._rc?.answeredNoDisposition) undisp++;

    if (R.isAnswered(c)) addSecs(emp, CALL.durationSecs(c));
    if (R.isOpportunity(c)) {
      opportunities++;
      bump(oppsBy, emp);
      if (R.isBookedCall(c)) { converted++; bump(convBy, emp); }
    }
  }

  // A caller who eventually got through is not a missed customer.
  for (const k of reachedCallers) missedCallers.delete(k);

  let broadlyAfter = 0;
  if (rcOn) {
    for (const c of inbound) {
      if (R.inBusinessHours(c)) continue;
      if (c._rc?.broadly) broadlyAfter++;
    }
  }

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
    stAbandoned: rcOn ? stAbandoned : null,
    asaSecs: null,
    rcMatching: rcOn,
    broadly: rcOn ? broadly : null,
    answeredNoDisposition: rcOn ? undisp : null,
    broadlyAfterHours: rcOn ? broadlyAfter : null,
    rawCalls: raw,
  };
}
