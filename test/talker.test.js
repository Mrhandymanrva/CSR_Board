import assert from 'node:assert/strict';
import test from 'node:test';
import { rcExtensionEmployeeId, rcExtToEmployeeMap, DEFAULT_RC_EXT_TO_EMPLOYEE } from '../src/config.js';
import { talkingExtension } from '../src/domain/callClass.js';
import { annotateInbound, reduceCalls } from '../src/domain/demand.js';
import { peopleForWindow, splitInboundHours } from '../src/domain/leads.js';
import { overflowNumbers } from '../src/rc/client.js';
import { indexRcRecords } from '../src/rc/match.js';

const AT = '2026-11-12T15:00:00.000Z'; // Thu 10:00 ET, in hours
const BEFORE = '2026-11-12T12:30:00.000Z'; // Thu 07:30 ET, before open
const DAY_START = Date.parse('2026-11-12T05:00:00.000Z');
const DAY_END = Date.parse('2026-11-13T05:00:00.000Z');
const OVERFLOW = overflowNumbers();

const CHERIE = 200002561;
const KRIS = 316690094;
const CLAIRE = 322116688;

const employees = new Map([
  [CHERIE, { id: CHERIE, name: 'Cherie McKesson' }],
  [KRIS, { id: KRIS, name: 'Kris Ranario' }],
  [CLAIRE, { id: CLAIRE, name: 'Claire Yu' }],
]);

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

function userLeg({ ext, name, result = 'Call connected', duration = 90, at = AT, master = false }) {
  return {
    direction: 'Inbound',
    result,
    duration,
    durationMs: duration * 1000,
    master,
    startTime: at,
    from: { extensionNumber: '51', name: 'Customer Care' },
    to: { extensionNumber: String(ext), extensionId: '1', name },
  };
}

function queueLeg({ duration = 200, name = 'Customer Care Queue', ext = '51', result = 'Accepted', at = AT }) {
  return {
    direction: 'Inbound',
    result,
    duration,
    durationMs: duration * 1000,
    master: true,
    startTime: at,
    from: { phoneNumber: '+18045550000' },
    to: { extensionNumber: ext, name },
  };
}

function rcSession({ id, from, at = AT, legs, result = 'Accepted', toExt = '51', toName = 'Customer Care Queue' }) {
  return {
    id,
    direction: 'Inbound',
    result,
    startTime: at,
    duration: 200,
    from: { phoneNumber: from },
    to: { extensionNumber: toExt, name: toName },
    legs,
  };
}

function people(calls, { csrIds = [CHERIE, KRIS], hideIds = [] } = {}) {
  return peopleForWindow({
    employees,
    calls,
    jobs: [],
    dayStart: DAY_START,
    dayEnd: DAY_END,
    trailStart: DAY_START - 29 * 86400000,
    trailEnd: DAY_END,
    now: DAY_END,
    leadsReady: true,
    csrIds,
    hideIds,
  });
}

function row(rows, name) {
  return rows.find((r) => r.n === name);
}

test('the committed extension map is the originating office, and a blank override keeps it', () => {
  const prev = process.env.RC_EXT_TO_EMPLOYEE_IDS;
  try {
    delete process.env.RC_EXT_TO_EMPLOYEE_IDS;
    assert.deepEqual(rcExtToEmployeeMap(), { ...DEFAULT_RC_EXT_TO_EMPLOYEE });
    assert.equal(rcExtensionEmployeeId('103'), CHERIE);
    assert.equal(rcExtensionEmployeeId('109'), 258517659);
    assert.equal(rcExtensionEmployeeId('110'), KRIS);
    assert.equal(rcExtensionEmployeeId('107'), 311921192);
    assert.equal(rcExtensionEmployeeId('105'), 310014743);
    assert.equal(rcExtensionEmployeeId('108'), 231746536);
    assert.equal(rcExtensionEmployeeId('102'), 223117800);
    assert.equal(rcExtensionEmployeeId('113'), CLAIRE);
    assert.equal(rcExtensionEmployeeId('115'), 322135443);
    assert.equal(rcExtensionEmployeeId('111'), 316508824);
    assert.equal(rcExtensionEmployeeId('999'), null);
    process.env.RC_EXT_TO_EMPLOYEE_IDS = '   ';
    assert.equal(rcExtensionEmployeeId('103'), CHERIE);
  } finally {
    if (prev == null) delete process.env.RC_EXT_TO_EMPLOYEE_IDS;
    else process.env.RC_EXT_TO_EMPLOYEE_IDS = prev;
  }
});

test('a non-empty extension override replaces the map instead of merging', () => {
  const prev = process.env.RC_EXT_TO_EMPLOYEE_IDS;
  try {
    process.env.RC_EXT_TO_EMPLOYEE_IDS = '103=1, 110 = 5,nope,108=abc';
    assert.equal(rcExtensionEmployeeId('103'), 1);
    assert.equal(rcExtensionEmployeeId('110'), 5);
    assert.equal(rcExtensionEmployeeId('109'), null);
    assert.equal(rcExtensionEmployeeId('108'), null);
  } finally {
    if (prev == null) delete process.env.RC_EXT_TO_EMPLOYEE_IDS;
    else process.env.RC_EXT_TO_EMPLOYEE_IDS = prev;
  }
});

test('Cherie is credited from the RingCentral talker when ServiceTitan stored no agent', () => {
  const from = '8045559103';
  const call = stCall({ from, type: 'Abandoned' });
  const index = indexRcRecords([
    rcSession({
      id: 'cherie',
      from,
      legs: [
        queueLeg({ duration: 220 }),
        userLeg({ ext: '103', name: 'Cherie McKesson', result: 'Call connected', duration: 140 }),
      ],
    }),
  ]);
  annotateInbound([call], index, OVERFLOW);
  assert.equal(call._rc.talkerExt, '103');
  assert.equal(call._rc.answered, true);
  const { rows } = people([call]);
  assert.equal(row(rows, 'Cherie McKesson').inbound, 1);
  assert.equal(row(rows, 'Kris Ranario').inbound, 0);
});

test('an unlabeled queue leg longer than the talker does not take the credit', () => {
  const from = '8045559104';
  const records = [rcSession({
    id: 'unlabeled',
    from,
    toExt: null,
    toName: 'Main',
    legs: [
      queueLeg({ duration: 300, name: 'Customer Care', ext: '51' }),
      userLeg({ ext: '103', name: 'Cherie McKesson', duration: 40 }),
    ],
  })];
  records[0].to = { phoneNumber: '+18045550000' };
  assert.equal(talkingExtension(records, OVERFLOW), '103');
});

test('the longer of two mapped talkers wins, including over a longer queue leg', () => {
  const from = '8045559105';
  const ext = talkingExtension([rcSession({
    id: 'two',
    from,
    legs: [
      queueLeg({ duration: 400 }),
      userLeg({ ext: '103', name: 'Cherie McKesson', duration: 25 }),
      userLeg({ ext: '110', name: 'Kris Ranario', result: 'Accepted', duration: 80 }),
    ],
  })], OVERFLOW);
  assert.equal(ext, '110');
});

test('a talk under 10 seconds is not a talker; the ServiceTitan agent is the fallback', () => {
  const from = '8045559106';
  const call = stCall({ from, type: 'Booked', agent: KRIS });
  annotateInbound([call], indexRcRecords([
    rcSession({
      id: 'short',
      from,
      legs: [
        queueLeg({ duration: 30 }),
        userLeg({ ext: '103', name: 'Cherie McKesson', duration: 9 }),
      ],
    }),
  ]), OVERFLOW);
  assert.equal(call._rc.talkerExt, null);
  const { rows } = people([call]);
  assert.equal(row(rows, 'Cherie McKesson').inbound, 0);
  assert.equal(row(rows, 'Kris Ranario').inbound, 1);
});

test('exactly 10 seconds counts, and durationMs is enough when duration is absent', () => {
  const leg = userLeg({ ext: '103', name: 'Cherie McKesson', duration: 10 });
  delete leg.duration;
  leg.durationMs = 10_000;
  assert.equal(talkingExtension([rcSession({
    id: 'ten',
    from: '8045559107',
    legs: [queueLeg({ duration: 40 }), leg],
  })], OVERFLOW), '103');
});

test('a mapped RingCentral talker wins over a different ServiceTitan agent', () => {
  const from = '8045559108';
  const call = stCall({ from, type: 'Abandoned', agent: KRIS });
  annotateInbound([call], indexRcRecords([
    rcSession({
      id: 'wins',
      from,
      legs: [userLeg({ ext: '103', name: 'Cherie McKesson', duration: 50 })],
    }),
  ]), OVERFLOW);
  assert.equal(call._rc.talkerExt, '103');
  const { rows } = people([call]);
  assert.equal(row(rows, 'Cherie McKesson').inbound, 1);
  assert.equal(row(rows, 'Kris Ranario').inbound, 0);
});

test('no RingCentral talker falls back to the ServiceTitan agent', () => {
  const from = '8045559109';
  const call = stCall({ from, type: 'Unbooked', agent: KRIS });
  annotateInbound([call], indexRcRecords([
    rcSession({
      id: 'miss',
      from,
      legs: [queueLeg({ duration: 20, result: 'Missed', name: 'Customer Care Queue' })],
    }),
  ]), OVERFLOW);
  assert.equal(call._rc.talkerExt, null);
  const { rows } = people([call]);
  assert.equal(row(rows, 'Kris Ranario').inbound, 1);
});

test('an unmapped talker falls back to the ServiceTitan agent', () => {
  const from = '8045559110';
  const call = stCall({ from, type: 'Booked', agent: KRIS });
  annotateInbound([call], indexRcRecords([
    rcSession({
      id: 'newhire',
      from,
      toExt: '120',
      toName: 'New Hire',
      legs: [userLeg({ ext: '120', name: 'New Hire', duration: 60, master: true })],
    }),
  ]), OVERFLOW);
  assert.equal(call._rc.talkerExt, '120');
  const { rows } = people([call]);
  assert.equal(row(rows, 'Kris Ranario').inbound, 1);
  assert.equal(row(rows, 'Cherie McKesson').inbound, 0);
});

test('overflow and forward-to-Broadly legs are not the talker', () => {
  const from = '8045559111';
  const broadly = '+1 (804) 781-4293';
  const records = [rcSession({
    id: 'fwd',
    from,
    legs: [
      queueLeg({ duration: 15, result: 'Missed' }),
      {
        direction: 'Outbound',
        result: 'Accepted',
        duration: 180,
        from: { extensionNumber: '51', name: 'Customer Care Queue' },
        to: { phoneNumber: broadly },
      },
    ],
  })];
  assert.equal(talkingExtension(records, OVERFLOW), null);

  const withUser = rcSession({
    id: 'fwd-user',
    from: '8045559112',
    legs: [
      userLeg({ ext: '103', name: 'Cherie McKesson', duration: 40 }),
      {
        direction: 'Outbound',
        result: 'Call connected',
        duration: 200,
        from: { extensionNumber: '103', name: 'Cherie McKesson' },
        to: { phoneNumber: '8046556490' },
      },
    ],
  });
  assert.equal(talkingExtension([withUser], OVERFLOW), '103');

  const call = stCall({ from, type: 'Abandoned' });
  annotateInbound([call], indexRcRecords(records), OVERFLOW);
  assert.equal(call._rc.broadly, true);
  assert.equal(call._rc.talkerExt, null);
  const { rows, team } = people([call]);
  assert.equal(row(rows, 'Cherie McKesson').inbound, 0);
  assert.equal(team.inbound, 0);
});

test('extension-to-extension stays out of inbound even when a talker extension is known', () => {
  const call = stCall({ from: '1002', type: 'Abandoned' });
  call._rc = { answered: true, missed: false, broadly: false, matched: true, talkerExt: '103' };
  const { rows, team } = people([call]);
  assert.equal(row(rows, 'Cherie McKesson').inbound, 0);
  assert.equal(team.inbound, 0);
});

test('a result of Answered is not a talk result', () => {
  assert.equal(talkingExtension([rcSession({
    id: 'answered-word',
    from: '8045559113',
    legs: [userLeg({ ext: '103', name: 'Cherie McKesson', result: 'Answered', duration: 60 })],
  })], OVERFLOW), null);
});

test('in-hours header split reconciles, and after-hours credit stays on the people column only', () => {
  const cherieIn = stCall({ from: '8045559201', type: 'Abandoned' });
  const krisIn = stCall({ from: '8045559202', type: 'Unbooked', agent: KRIS });
  const claireIn = stCall({ from: '8045559203', type: 'Abandoned' });
  const nobody = stCall({ from: '8045559204', type: 'Abandoned' });
  const missed = stCall({ from: '8045559205', type: 'Abandoned' });
  const broadly = stCall({ from: '8045559206', type: 'Abandoned' });
  const before = stCall({ from: '8045559207', type: 'Abandoned', at: BEFORE });
  const internal = stCall({ from: '1002', type: 'Abandoned' });
  internal._rc = { answered: true, missed: false, broadly: false, matched: true, talkerExt: '103' };

  const raw = [cherieIn, krisIn, claireIn, nobody, missed, broadly, before, internal];
  annotateInbound(raw.filter((c) => c !== internal), indexRcRecords([
    rcSession({
      id: 'c1', from: '8045559201',
      legs: [queueLeg({ duration: 100 }), userLeg({ ext: '103', name: 'Cherie McKesson', duration: 70 })],
    }),
    rcSession({
      id: 'c3', from: '8045559203',
      legs: [userLeg({ ext: '113', name: 'Claire Yu', duration: 60 })],
    }),
    rcSession({
      id: 'c4', from: '8045559204',
      legs: [userLeg({ ext: '120', name: 'New Hire', duration: 40 })],
    }),
    rcSession({
      id: 'c5', from: '8045559205', result: 'Missed',
      legs: [queueLeg({ duration: 12, result: 'Missed' })],
    }),
    rcSession({
      id: 'c6', from: '8045559206',
      legs: [{
        direction: 'Outbound', result: 'Accepted', duration: 30,
        from: { extensionNumber: '51' },
        to: { phoneNumber: '8047814293' },
      }],
    }),
    rcSession({
      id: 'c7', from: '8045559207', at: BEFORE,
      legs: [userLeg({ ext: '103', name: 'Cherie McKesson', duration: 45, at: BEFORE })],
    }),
  ]), OVERFLOW);

  const roster = { csrIds: [CHERIE, KRIS], hideIds: [] };
  const split = splitInboundHours(raw, roster);
  const tally = reduceCalls(raw, { rcEnabled: true });
  assert.equal(split.total, tally.handled);
  assert.equal(split.missed, tally.abandoned);
  assert.equal(split.teamAnswered + split.answeredByOthers + split.missed, split.total);

  const { rows, team } = people(raw, roster);
  const cherie = row(rows, 'Cherie McKesson');
  const kris = row(rows, 'Kris Ranario');
  assert.equal(rows.some((r) => r.n === 'Claire Yu'), false);
  assert.equal(cherie.inbound, 2);
  assert.equal(kris.inbound, 1);
  assert.equal(team.inbound, 3);
  assert.equal(split.total, 7);
  assert.equal(split.teamAnswered, 2);
  assert.equal(split.answeredByOthers, 4);
  assert.equal(split.missed, 1);
  assert.equal(split.teamAnswered, cherie.inbound + kris.inbound - 1);
  assert.equal(split.teamAnswered + split.answeredByOthers + split.missed, tally.handled);
});

test('a hidden employee is answered by others, and still in the people team total', () => {
  const call = stCall({ from: '8045559301', type: 'Abandoned' });
  annotateInbound([call], indexRcRecords([
    rcSession({
      id: 'hide',
      from: '8045559301',
      legs: [userLeg({ ext: '113', name: 'Claire Yu', duration: 50 })],
    }),
  ]), OVERFLOW);
  const roster = { csrIds: [CHERIE, CLAIRE], hideIds: [CLAIRE] };
  const { rows, team } = people([call], roster);
  assert.deepEqual(rows.map((r) => r.n), ['Cherie McKesson']);
  assert.equal(team.inbound, 1);
  const split = splitInboundHours([call], roster);
  assert.equal(split.teamAnswered, 0);
  assert.equal(split.answeredByOthers, 1);
  assert.equal(split.missed, 0);
  assert.equal(split.teamAnswered + split.answeredByOthers + split.missed, split.total);
});

test('the override map is what volume credit uses', () => {
  const prev = process.env.RC_EXT_TO_EMPLOYEE_IDS;
  try {
    process.env.RC_EXT_TO_EMPLOYEE_IDS = '103=1';
    const from = '8045559401';
    const call = stCall({ from, type: 'Abandoned' });
    annotateInbound([call], indexRcRecords([
      rcSession({
        id: 'ovr',
        from,
        legs: [
          queueLeg({ duration: 90, name: 'Customer Care' }),
          userLeg({ ext: '103', name: 'Cherie McKesson', duration: 40 }),
        ],
      }),
    ]), OVERFLOW);
    assert.equal(call._rc.talkerExt, '103');
    const { rows } = peopleForWindow({
      employees: new Map([[1, { id: 1, name: 'Override Person' }]]),
      calls: [call],
      jobs: [],
      dayStart: DAY_START,
      dayEnd: DAY_END,
      trailStart: DAY_START,
      trailEnd: DAY_END,
      now: DAY_END,
      leadsReady: false,
      csrIds: [1],
      hideIds: [],
    });
    assert.equal(rows[0].inbound, 1);
    assert.equal(rows[0].n, 'Override Person');
  } finally {
    if (prev == null) delete process.env.RC_EXT_TO_EMPLOYEE_IDS;
    else process.env.RC_EXT_TO_EMPLOYEE_IDS = prev;
  }
});
