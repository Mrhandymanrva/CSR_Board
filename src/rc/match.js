import { CALL } from '../st/endpoints.js';
import { externalPhone, partyNumber } from '../domain/phone.js';

/** Findings matched ServiceTitan to the queue log within 120 seconds. */
export const MATCH_WINDOW_MS = 120_000;
/** IVR and the queue are separate sessions a few seconds apart. A retry is not. */
const CLUSTER_FLOOR_MS = 45_000;

function recStart(rec) {
  const t = Date.parse(rec?.startTime ?? '');
  return Number.isFinite(t) ? t : null;
}

function recSpan(rec) {
  const ms = Number(rec?.durationMs);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(rec?.duration);
  if (Number.isFinite(s) && s > 0) return s * 1000;
  return 0;
}

/** Index inbound account-log sessions by the caller's 10-digit number. */
export function indexRcRecords(records) {
  const byPhone = new Map();
  for (const rec of records ?? []) {
    if (!/^inbound$/i.test(rec?.direction ?? '')) continue;
    if (recStart(rec) == null) continue;
    const phone = partyNumber(rec.from);
    if (!phone) continue;
    if (!byPhone.has(phone)) byPhone.set(phone, []);
    byPhone.get(phone).push(rec);
  }
  for (const list of byPhone.values()) {
    list.sort((a, b) => recStart(a) - recStart(b));
  }
  return byPhone;
}

/**
 * Sessions for one ServiceTitan call: closest start within the window, plus
 * any sibling session that overlaps that one (IVR then queue). A later retry
 * from the same number stays on its own ServiceTitan row.
 */
export function matchCall(call, index, windowMs = MATCH_WINDOW_MS) {
  if (!index) return null;
  const phone = externalPhone(call);
  const t = CALL.receivedAt(call);
  if (!phone || t == null) return null;
  const list = index.get(phone);
  if (!list?.length) return null;

  let best = null;
  let bestDt = Infinity;
  const near = [];
  for (const rec of list) {
    const s = recStart(rec);
    const dt = Math.abs(s - t);
    if (dt <= windowMs) {
      near.push(rec);
      if (dt < bestDt) { best = rec; bestDt = dt; }
    } else if (s > t + windowMs) break;
  }
  if (!best) return null;
  const anchor = recStart(best);
  const span = Math.max(recSpan(best), CLUSTER_FLOOR_MS);
  return near.filter((rec) => Math.abs(recStart(rec) - anchor) <= span);
}
