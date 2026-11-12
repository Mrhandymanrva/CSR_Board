import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCall, summarizeRc } from '../src/domain/callClass.js';
import { annotateInbound, reduceCalls } from '../src/domain/demand.js';
import { isAnswered, isMissed } from '../src/domain/rules.js';
import { phoneKey } from '../src/domain/phone.js';
import { indexRcRecords, matchCall } from '../src/rc/match.js';
import { createRcCache } from '../src/rc/cache.js';
import { overflowNumbers, rcMode } from '../src/rc/client.js';

const AT = '2026-11-12T15:00:00.000Z'; // Thu 10:00 ET, in hours
const AFTER = '2026-11-12T23:30:00.000Z'; // Thu 18:30 ET
const SAT = '2026-11-14T15:00:00.000Z'; // Saturday
const OVERFLOW = overflowNumbers();

let seq = 1;
function stCall({ type = 'Abandoned', from, at = AT, agent = null, direction = 'Inbound' }) {
  return {
    id: seq++,
    leadCall: {
      direction,
      callType: type,
      from,
      receivedOn: at,
      duration: '00:02:00',
      agent: agent ? { id: agent, name: 'Agent' } : null,
    },
  };
}

function rcCall({ id, from, at = AT, result = 'Accepted', broadly = null, duration = 90 }) {
  const legs = [];
  if (broadly) {
    legs.push({
      direction: 'Inbound',
      result: 'Missed',
      from: { phoneNumber: from },
      to: { extensionNumber: '51', extensionId: '2705822027' },
    });
    legs.push({
      direction: 'Outbound',
      result: 'Accepted',
      from: { extensionNumber: '51' },
      to: { phoneNumber: broadly },
    });
  } else if (/accept|answered|connected/i.test(result)) {
    legs.push({
      direction: 'Inbound',
      result: 'Accepted',
      from: { phoneNumber: from },
      to: { extensionNumber: '101', extensionId: '42', name: 'Jordan Hale' },
    });
  } else {
    legs.push({
      direction: 'Inbound',
      result,
      from: { phoneNumber: from },
      to: { extensionNumber: '51', extensionId: '2705822027' },
    });
  }
  return {
    id,
    direction: 'Inbound',
    result: broadly ? 'Accepted' : result,
    startTime: at,
    duration,
    from: { phoneNumber: from },
    to: { phoneNumber: '+18045550000', extensionNumber: '51' },
    legs,
  };
}

test('phone keys ignore extensions and punctuation', () => {
  assert.equal(phoneKey('+1 (804) 781-4293'), '8047814293');
  assert.equal(phoneKey('804-655-6490'), '8046556490');
  assert.equal(phoneKey('51'), null);
  assert.equal(phoneKey('1002'), null);
});

test('overflow defaults are Broadly and the old Nonstop number', () => {
  const prev = process.env.RC_OVERFLOW_NUMBERS;
  delete process.env.RC_OVERFLOW_NUMBERS;
  try {
    const nums = overflowNumbers();
    assert.equal(nums.has('8047814293'), true);
    assert.equal(nums.has('8046556490'), true);
    process.env.RC_OVERFLOW_NUMBERS = '';
    assert.equal(overflowNumbers().size, 0);
  } finally {
    if (prev == null) delete process.env.RC_OVERFLOW_NUMBERS;
    else process.env.RC_OVERFLOW_NUMBERS = prev;
  }
});

test('rc mode is off unless the owner sets a source, and command center wins', () => {
  const saved = ['CC_RC_LOG_URL', 'CC_RC_LOG_KEY', 'RC_CLIENT_ID', 'RC_CLIENT_SECRET', 'RC_JWT']
    .map((k) => [k, process.env[k]]);
  for (const [k] of saved) delete process.env[k];
  try {
    assert.equal(rcMode(), 'off');
    process.env.RC_CLIENT_ID = 'id';
    process.env.RC_CLIENT_SECRET = 'secret';
    process.env.RC_JWT = 'jwt';
    assert.equal(rcMode(), 'ringcentral');
    process.env.CC_RC_LOG_URL = 'https://cc.example/rc-log';
    process.env.CC_RC_LOG_KEY = 'key';
    assert.equal(rcMode(), 'command-center');
  } finally {
    for (const [k, v] of saved) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('without RingCentral, Abandoned is a miss even if a parallel log would say Accepted', () => {
  const call = stCall({ from: '8045551000' });
  call.wouldBeAccepted = true;
  assert.equal(isMissed(call), true);
  assert.equal(isAnswered(call), false);
  const tally = reduceCalls([call], { rcEnabled: false });
  assert.equal(tally.abandoned, 1);
  assert.equal(tally.rcMatching, false);
  assert.equal(tally.broadly, null);
  assert.equal(tally.answeredNoDisposition, null);
});

test('an agent on an Abandoned call is still a miss when matching is off', () => {
  const call = stCall({ from: '8045551001', agent: 7 });
  assert.equal(isMissed(call), true);
  assert.equal(isAnswered(call), false);
});

test('RingCentral Accepted on an Abandoned call is answered, with no disposition', () => {
  const from = '+1 804-555-2000';
  const call = stCall({ from, type: 'Abandoned' });
  const index = indexRcRecords([rcCall({ id: 'A', from, result: 'Accepted' })]);
  annotateInbound([call], index, OVERFLOW);
  assert.equal(isMissed(call), false);
  assert.equal(isAnswered(call), true);
  assert.equal(call._rc.answeredNoDisposition, true);
  assert.equal(call._rc.broadly, false);
});

test('RingCentral Missed stays a miss; a ServiceTitan agent overrides that', () => {
  const missed = stCall({ from: '8045552001' });
  const withAgent = stCall({ from: '8045552002', agent: 4 });
  const index = indexRcRecords([
    rcCall({ id: 'M1', from: '8045552001', result: 'Missed' }),
    rcCall({ id: 'M2', from: '8045552002', result: 'Missed' }),
  ]);
  annotateInbound([missed, withAgent], index, OVERFLOW);
  assert.equal(isMissed(missed), true);
  assert.equal(isAnswered(withAgent), true);
  assert.equal(withAgent._rc.answeredNoDisposition, true);
});

test('no RingCentral row and Abandoned with no agent is still a miss', () => {
  const call = stCall({ from: '8045552003' });
  annotateInbound([call], indexRcRecords([]), OVERFLOW);
  assert.equal(call._rc.matched, false);
  assert.equal(isMissed(call), true);
});

test('sent to Broadly, including the old Nonstop number, is not a miss', () => {
  const broadly = stCall({ from: '8045553001' });
  const nonstop = stCall({ from: '8045553002' });
  const after = stCall({ from: '8045553003', at: AFTER });
  const saturday = stCall({ from: '8045553004', at: SAT });
  const index = indexRcRecords([
    rcCall({ id: 'B1', from: '8045553001', broadly: '+1 (804) 781-4293' }),
    rcCall({ id: 'B2', from: '8045553002', broadly: '804-655-6490' }),
    rcCall({ id: 'B3', from: '8045553003', at: AFTER, broadly: '8047814293' }),
    rcCall({ id: 'B4', from: '8045553004', at: SAT, broadly: '18047814293' }),
  ]);
  const raw = [broadly, nonstop, after, saturday];
  annotateInbound(raw, index, OVERFLOW);
  const tally = reduceCalls(raw, { rcEnabled: true });

  assert.equal(broadly._rc.broadly, true);
  assert.equal(isMissed(broadly), false);
  assert.equal(nonstop._rc.broadly, true);
  assert.equal(tally.broadly, 2);
  assert.equal(tally.abandoned, 0);
  assert.equal(tally.missedCallers, 0);
  assert.equal(tally.reachedCallers, 0);
  assert.equal(tally.handled, 2);
  assert.equal(tally.afterHours, 2);
  assert.equal(tally.broadlyAfterHours, 2);
  assert.equal(isMissed(after), false);
});

test('a CSR accept wins over a later forward to Broadly', () => {
  const from = '8045553010';
  const rec = rcCall({ id: 'BOTH', from, result: 'Accepted' });
  rec.legs.push({
    direction: 'Outbound',
    result: 'Accepted',
    from: { extensionNumber: '101' },
    to: { phoneNumber: '+18047814293' },
  });
  const summary = summarizeRc([rec], OVERFLOW);
  assert.equal(summary.accepted, true);
  assert.equal(summary.broadly, true);
  const call = stCall({ from, type: 'Abandoned' });
  call._rc = classifyCall(call, summary);
  assert.equal(call._rc.answered, true);
  assert.equal(call._rc.broadly, false);
  assert.equal(call._rc.answeredNoDisposition, true);
});

test('session Accepted with no legs counts; a forward-only session does not', () => {
  const plain = summarizeRc([{
    direction: 'Inbound', result: 'Accepted', duration: 40,
    from: { phoneNumber: '+18045553020' },
    to: { extensionNumber: '51' },
  }], OVERFLOW);
  assert.equal(plain.accepted, true);

  const forwarded = summarizeRc([{
    direction: 'Inbound', result: 'Accepted', duration: 70,
    from: { phoneNumber: '+18045553021' },
    to: { phoneNumber: '+18047814293' },
  }], OVERFLOW);
  assert.equal(forwarded.accepted, false);
  assert.equal(forwarded.broadly, true);
});

test('matching uses caller plus 120s, and a retry is not the previous call', () => {
  const t = Date.parse(AT);
  const first = rcCall({ id: 'S1', from: '8045554000', at: new Date(t).toISOString(), duration: 20 });
  const queue = rcCall({ id: 'S2', from: '8045554000', at: new Date(t + 15_000).toISOString(), duration: 80 });
  const retry = rcCall({ id: 'S3', from: '8045554000', at: new Date(t + 90_000).toISOString(), result: 'Missed', duration: 20 });
  const other = rcCall({ id: 'S4', from: '8045554999', at: AT });
  const outbound = { ...rcCall({ id: 'S5', from: '8045554000', at: AT }), direction: 'Outbound' };
  const index = indexRcRecords([first, queue, retry, other, outbound]);

  const call = stCall({ from: '(804) 555-4000', at: AT });
  const hits = matchCall(call, index).map((r) => r.id);
  assert.deepEqual(hits, ['S1', 'S2']);

  const retryCall = stCall({ from: '8045554000', at: new Date(t + 90_000).toISOString() });
  assert.deepEqual(matchCall(retryCall, index).map((r) => r.id), ['S3']);

  const farIndex = indexRcRecords([
    rcCall({ id: 'FAR', from: '8045554001', at: new Date(t).toISOString() }),
  ]);
  const late = stCall({ from: '8045554001', at: new Date(t + 121_000).toISOString() });
  assert.equal(matchCall(late, farIndex), null);
  const edge = stCall({ from: '8045554001', at: new Date(t + 120_000).toISOString() });
  assert.equal(matchCall(edge, farIndex)[0].id, 'FAR');
  assert.equal(matchCall(stCall({ from: '8045554888', at: AT }), index), null);
});

test('last week in-hours abandonment falls from 50% to 18% once Accepted calls are not misses', () => {
  const raw = [];
  const records = [];
  for (let i = 0; i < 301; i++) {
    raw.push(stCall({ type: i % 2 ? 'Booked' : 'Unbooked', from: String(5550000000 + i), agent: 1 }));
  }
  for (let i = 0; i < 197; i++) {
    const from = String(5551000000 + i);
    raw.push(stCall({ type: 'Abandoned', from }));
    records.push(rcCall({ id: `ACC${i}`, from, result: 'Accepted' }));
  }
  for (let i = 0; i < 107; i++) {
    const from = String(5552000000 + i);
    raw.push(stCall({ type: 'Abandoned', from }));
    records.push(rcCall({ id: `MIS${i}`, from, result: 'Missed' }));
  }
  for (let i = 0; i < 100; i++) {
    raw.push(stCall({ type: 'Abandoned', from: String(5553000000 + i), at: AFTER }));
  }
  for (let i = 0; i < 40; i++) {
    raw.push(stCall({ type: 'Abandoned', from: String(5554000000 + i), at: SAT }));
  }
  raw.push(stCall({ type: 'Booked', from: '5555000000', direction: 'Outbound', agent: 1 }));

  const legacy = reduceCalls(raw.map((c) => structuredClone(c)), { rcEnabled: false });
  assert.equal(legacy.handled, 605);
  assert.equal(legacy.abandoned, 304);
  assert.equal(Math.round(legacy.abandonPct), 50);
  assert.equal(legacy.afterHours, 140);
  assert.equal(legacy.rcMatching, false);

  const joined = structuredClone(raw);
  annotateInbound(joined, indexRcRecords(records), OVERFLOW);
  const fixed = reduceCalls(joined, { rcEnabled: true });
  assert.equal(fixed.handled, 605);
  assert.equal(fixed.stAbandoned, 304);
  assert.equal(fixed.abandoned, 107);
  assert.equal(fixed.answeredNoDisposition, 197);
  assert.equal(Math.round(fixed.abandonPct), 18);
  assert.equal(fixed.missedCallers, 107);
  assert.equal(fixed.reachedCallers, 498);
  assert.equal(fixed.afterHours, 140);
  assert.equal(fixed.broadlyAfterHours, 0);
  assert.equal(fixed.rcMatching, true);
});

test('a caller who is answered later is not still a missed customer', () => {
  const from = '8045556000';
  const first = stCall({ from, at: AT });
  const second = stCall({ from, at: '2026-11-12T15:10:00.000Z', type: 'Booked', agent: 1 });
  const index = indexRcRecords([
    rcCall({ id: 'C1', from, at: AT, result: 'Missed' }),
    rcCall({ id: 'C2', from, at: '2026-11-12T15:10:00.000Z', result: 'Accepted' }),
  ]);
  annotateInbound([first, second], index, OVERFLOW);
  const tally = reduceCalls([first, second], { rcEnabled: true });
  assert.equal(tally.abandoned, 1);
  assert.equal(tally.missedCallers, 0);
  assert.equal(tally.reachedCallers, 1);
});

test('the call-log cache does not refetch inside the TTL, and concurrent loads share one fetch', async () => {
  let fetches = 0;
  let now = 1_000;
  const loadCached = createRcCache({ now: () => now });
  const load = () => loadCached('today', 300_000, async () => {
    fetches++;
    return [{ id: fetches }];
  });
  const [a, b] = await Promise.all([load(), load()]);
  assert.equal(fetches, 1);
  assert.equal(a[0].id, 1);
  assert.equal(b[0].id, 1);
  now += 60_000;
  await load();
  assert.equal(fetches, 1);
  now += 300_000;
  const again = await load();
  assert.equal(fetches, 2);
  assert.equal(again[0].id, 2);
});

test('a failed refresh keeps the previous window', async () => {
  let now = 0;
  let fail = false;
  const loadCached = createRcCache({ now: () => now });
  const load = () => loadCached('week', 1000, async () => {
    if (fail) throw new Error('down');
    return [{ id: 'ok' }];
  });
  assert.deepEqual(await load(), [{ id: 'ok' }]);
  now = 1000;
  fail = true;
  assert.deepEqual(await load(), [{ id: 'ok' }]);
});
