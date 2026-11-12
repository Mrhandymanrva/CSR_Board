import { CALL } from '../st/endpoints.js';

/** Phone keys for lead grouping and RingCentral matching.
 *  NANP only: a 10-digit national number. Extensions (51, 1002) are not keys. */

export function phoneKey(value) {
  if (value == null) return null;
  const raw = typeof value === 'object'
    ? (value.phoneNumber ?? value.phone ?? value.number ?? '')
    : value;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  else if (digits.length > 11) digits = digits.slice(-10);
  return digits.length === 10 ? digits : null;
}

export function partyNumber(party) {
  if (party == null) return null;
  if (typeof party === 'string' || typeof party === 'number') return phoneKey(party);
  return phoneKey(party.phoneNumber ?? party.phone ?? party.number ?? null);
}

/** The other party's number. Inbound: the caller. Outbound: who we dialled. */
export function externalPhone(call) {
  const inbound = /inbound/i.test(CALL.direction(call) ?? '');
  const from = CALL.from(call);
  const to = CALL.to(call);
  const primary = inbound ? from : (to ?? from);
  const secondary = inbound ? to : from;
  return partyNumber(primary) || partyNumber(secondary);
}
