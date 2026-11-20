import { rcExtensionEmployeeId } from '../config.js';
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

/** Dialable extension on a RingCentral party. Not `extension.id` — that is
 *  RingCentral's own id, not the number and not a ServiceTitan employee. */
function extensionNumberOf(party) {
  if (!party || typeof party !== 'object') return null;
  const n = party.extensionNumber;
  if (n == null) return null;
  const s = String(n).trim();
  return s || null;
}

function legSeconds(leg) {
  const ms = Number(leg?.durationMs);
  if (Number.isFinite(ms) && ms > 0) return ms / 1000;
  const s = Number(leg?.duration);
  if (Number.isFinite(s) && s > 0) return s;
  return 0;
}

/** The person who talked, not the queue that accepted the session. */
function isTalkResult(result) {
  const s = String(result ?? '').trim().toLowerCase();
  return s === 'accepted' || s === 'call connected';
}

function isSystemLeg(leg) {
  const text = [
    leg?.action, leg?.legType, leg?.reason, leg?.reasonDescription,
    leg?.to?.name, leg?.from?.name, leg?.extension?.name,
  ].filter(Boolean).join(' ');
  return /\b(queue|ivr|auto[- ]?attendant|voicemail|company greeting)\b/i.test(text);
}

/**
 * Extension of the person who talked on the RingCentral sessions already
 * matched to one ServiceTitan call.
 *
 * The longest user leg with result Accepted or "Call connected" and
 * duration of at least 10 seconds. Overflow and forward-to-Broadly legs
 * are out. So are queue, IVR, and voicemail legs — a queue session is
 * often the longest leg because it spans the whole call, and it is not a
 * person. A leg is treated as a queue/IVR/voicemail leg when its name or
 * action says so. An unlabeled queue extension is still not a user: when
 * any qualifying leg maps to an employee, extensions that are not in that
 * map are dropped before the longest leg is chosen.
 *
 * Returns null when no leg qualifies. The caller then falls back to
 * ServiceTitan's agent.
 */
export function talkingExtension(records, overflow) {
  const candidates = [];
  for (const rec of records ?? []) {
    for (const leg of rec?.legs ?? []) {
      if (!isTalkResult(leg?.result)) continue;
      if (mentionsOverflow(leg, overflow)) continue;
      if (isSystemLeg(leg)) continue;
      const secs = legSeconds(leg);
      if (secs < 10) continue;
      const to = extensionNumberOf(leg?.to);
      const from = extensionNumberOf(leg?.from);
      const ext = to || from;
      if (!ext) continue;
      const start = Date.parse(leg?.startTime ?? rec?.startTime ?? '');
      candidates.push({
        ext,
        secs,
        start: Number.isFinite(start) ? start : 0,
      });
    }
  }
  if (!candidates.length) return null;
  const mapped = candidates.filter((c) => rcExtensionEmployeeId(c.ext) != null);
  const pool = mapped.length ? mapped : candidates;
  pool.sort((a, b) => b.secs - a.secs || b.start - a.start || a.ext.localeCompare(b.ext));
  return pool[0].ext;
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
  return {
    accepted,
    broadly,
    unanswered,
    talkerExt: talkingExtension(records, overflow),
  };
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
    talkerExt: summary?.talkerExt ?? null,
  };
}
