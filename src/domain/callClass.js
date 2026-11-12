import { CALL, CALL_TYPE } from '../st/endpoints.js';
import { partyNumber } from './phone.js';

/**
 * Answered vs missed, once a RingCentral account call-log (view=Detailed)
 * has been joined onto the ServiceTitan row.
 *
 * ServiceTitan's `Abandoned` is not "nobody picked up". A CSR can accept the
 * call in RingCentral and never disposition it; ST then stores Abandoned and
 * no agent. Those calls were being counted as misses (~50% in-hours abandonment
 * against ~18% once RingCentral's Accepted/Missed is the source of truth).
 *
 * `summary === null` means RingCentral matching is ON but this call did not
 * join to a log row. `summary` is never `undefined` here — the poller simply
 * does not set `_rc` when matching is off, and `isMissed` / `isAnswered` in
 * rules.js then keep the historical ServiceTitan behaviour.
 */

const HANDLED = new Set([
  CALL_TYPE.BOOKED,
  CALL_TYPE.UNBOOKED,
  CALL_TYPE.NOT_LEAD,
  CALL_TYPE.EXCUSED,
]);

function isInbound(call) {
  return /inbound/i.test(CALL.direction(call) ?? '');
}

export function isAnsweredResult(result) {
  const s = String(result ?? '').trim();
  if (!s) return false;
  if (/not\s+accepted|unanswered|not\s+answered/i.test(s)) return false;
  return /accepted|answered|call connected/i.test(s);
}

export function isUnansweredResult(result) {
  const s = String(result ?? '').trim();
  if (!s) return false;
  return /missed|no answer|voicemail|hang ?up|busy|rejected|declined|stopped|offline|gone|abandoned/i.test(s);
}

function mentionsOverflow(leg, overflow) {
  if (!leg || !overflow?.size) return false;
  const nums = [partyNumber(leg.to), partyNumber(leg.from), partyNumber(leg)];
  return nums.some((n) => n && overflow.has(n));
}

function hasInternalParty(leg) {
  const parties = [leg?.from, leg?.to, leg?.extension].filter(Boolean);
  return parties.some((p) => p && (p.extensionId || p.extensionNumber));
}

/**
 * Collapse every RingCentral session that belongs to one ServiceTitan call.
 * A leg answered at the Broadly / Nonstop number is overflow, not a CSR answer —
 * Broadly accepting the forward must not count as "reached a person".
 */
export function summarizeRc(records, overflow) {
  let accepted = false;
  let broadly = false;
  let unanswered = false;
  for (const rec of records ?? []) {
    const legs = rec?.legs ?? [];
    const recOverflow = mentionsOverflow(rec, overflow)
      || legs.some((leg) => mentionsOverflow(leg, overflow));
    let legAccept = false;
    for (const leg of legs) {
      const result = leg?.result;
      if (isUnansweredResult(result)) unanswered = true;
      if (isAnsweredResult(result) && !mentionsOverflow(leg, overflow) && hasInternalParty(leg)) {
        legAccept = true;
      }
    }
    if (isUnansweredResult(rec?.result)) unanswered = true;
    if (legAccept) accepted = true;
    else if (isAnsweredResult(rec?.result) && !recOverflow) accepted = true;
    if (recOverflow) broadly = true;
  }
  return { accepted, broadly, unanswered };
}

export function classifyCall(call, summary) {
  const stAgent = CALL.agentId(call) != null;
  const type = CALL.type(call);
  const stAbandoned = type === CALL_TYPE.ABANDONED;
  const stHandled = HANDLED.has(type);
  const rcAccepted = Boolean(summary?.accepted);
  const answered = rcAccepted || stAgent || stHandled;
  // Overflow is its own category only when nobody here actually took the call.
  const broadly = Boolean(summary?.broadly) && !answered;
  const matched = summary != null;
  let missed = false;
  if (isInbound(call) && !answered && !broadly) {
    if (!matched) missed = stAbandoned;
    else missed = Boolean(summary.unanswered) || stAbandoned;
  }
  return {
    answered,
    missed,
    broadly,
    answeredNoDisposition: isInbound(call) && answered && stAbandoned,
    matched,
  };
}
