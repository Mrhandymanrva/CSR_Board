import assert from 'node:assert/strict';
import test from 'node:test';
import { cfg } from '../src/config.js';
import {
  LEAD_WINDOW_MS,
  JOB_GRACE_MS,
  buildEpisodes,
  mergeFresh,
  peopleForWindow,
} from '../src/domain/leads.js';

const HOUR = 3600_000;
const DAY = 86400000;
const T0 = Date.parse('2026-11-12T15:00:00.000Z');

let seq = 1;
function call({
  type, at, agent, customer, from, to, direction = 'Inbound', outbound = false, id,
}) {
  const leadCall = {
    direction: outbound ? 'Outbound' : direction,
    callType: type,
    receivedOn: new Date(at).toISOString(),
    duration: '00:03:00',
    from: from ?? null,
    to: to ?? null,
  };
  if (customer != null) leadCall.customer = { id: customer };
  if (outbound) leadCall.createdBy = agent != null ? { id: agent } : null;
  else if (agent != null) leadCall.agent = { id: agent, name: 'Agent' };
  return { id: id ?? seq++, leadCall };
}

function job({ at, by, customer, typeId = 1, status = 'Scheduled', id }) {
  return {
    id: id ?? seq++,
    createdOn: new Date(at).toISOString(),
    createdById: by,
    customerId: customer,
    jobTypeId: typeId,
    jobStatus: status,
  };
}

const employees = new Map([
  [1, { id: 1, name: 'Jordan Hale' }],
  [2, { id: 2, name: 'Riley Chen' }],
  [3, { id: 3, name: 'Casey Morgan' }],
]);

function people(opts) {
  return peopleForWindow({
    employees,
    dayStart: T0 - 6 * HOUR,
    dayEnd: T0 + 6 * HOUR,
    trailStart: T0 - 29 * DAY,
    trailEnd: T0 + 6 * HOUR,
    now: T0 + HOUR,
    leadsReady: true,
    csrIds: [],
    calls: [],
    jobs: [],
    ...opts,
  });
}

test('one lead per customer within 30 days, inbound and outbound', () => {
  const episodes = buildEpisodes([
    call({ type: 'Unbooked', at: T0, agent: 1, customer: 10, from: '8045550100' }),
    call({ type: 'Unbooked', at: T0 + 2 * DAY, agent: 3, customer: 10, outbound: true, to: '8045550100' }),
    call({ type: 'Booked', at: T0 + 5 * DAY, agent: 3, customer: 10, from: '8045550100' }),
  ], [], T0 + 6 * DAY);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].ownerId, 1);
  assert.equal(episodes[0].booked, true);
  assert.equal(episodes[0].calls.length, 3);
});

test('a call after 30 days starts a new episode; the boundary call stays in the first', () => {
  const first = call({ type: 'Unbooked', at: T0, agent: 1, customer: 10, from: '8045550101' });
  const onBoundary = call({ type: 'Unbooked', at: T0 + LEAD_WINDOW_MS, agent: 2, customer: 10, from: '8045550101' });
  const joined = buildEpisodes([first, onBoundary], [], T0 + LEAD_WINDOW_MS);
  assert.equal(joined.length, 1);

  const after = call({ type: 'Booked', at: T0 + LEAD_WINDOW_MS + 1, agent: 2, customer: 10, from: '8045550101' });
  const split = buildEpisodes([first, after], [], T0 + LEAD_WINDOW_MS + DAY);
  assert.equal(split.length, 2);
  assert.equal(split[0].ownerId, 1);
  assert.equal(split[0].booked, false);
  assert.equal(split[1].ownerId, 2);
  assert.equal(split[1].booked, true);
});

test('NotLead and Excused are not leads; NotLead is a call count', () => {
  const { rows } = people({
    calls: [
      call({ type: 'NotLead', at: T0, agent: 1, from: '8045550102' }),
      call({ type: 'NotLead', at: T0 + 1000, agent: 1, from: '8045550103' }),
      call({ type: 'Excused', at: T0, agent: 1, customer: 11, from: '8045550104' }),
      call({ type: 'Unbooked', at: T0, agent: 1, customer: 12, from: '8045550105' }),
    ],
  });
  const jordan = rows.find((r) => r.n === 'Jordan Hale');
  assert.equal(jordan.leads, 1);
  assert.equal(jordan.notLead, 2);
  assert.equal(jordan.unbooked, 1);
});

test('booked when any call is Booked, or a non-cancelled job falls in the window', () => {
  const byCall = buildEpisodes([
    call({ type: 'Booked', at: T0, agent: 1, customer: 20, from: '8045550200' }),
  ], [], T0);
  assert.equal(byCall[0].booked, true);

  const byJob = buildEpisodes([
    call({ type: 'Unbooked', at: T0, agent: 1, customer: 21, from: '8045550201' }),
  ], [
    job({ at: T0 + 3 * DAY, by: 3, customer: 21 }),
  ], T0 + 3 * DAY);
  assert.equal(byJob[0].booked, true);
  assert.deepEqual(byJob[0].bookedForOthers, [3]);

  const cancelled = buildEpisodes([
    call({ type: 'Unbooked', at: T0, agent: 1, customer: 22, from: '8045550202' }),
  ], [
    job({ at: T0 + HOUR, by: 1, customer: 22, status: 'Canceled' }),
  ], T0 + HOUR);
  assert.equal(cancelled[0].booked, false);

  const early = buildEpisodes([
    call({ type: 'Unbooked', at: T0, agent: 1, customer: 23, from: '8045550203' }),
  ], [
    job({ at: T0 - JOB_GRACE_MS, by: 1, customer: 23 }),
  ], T0);
  assert.equal(early[0].booked, true);

  const tooEarly = buildEpisodes([
    call({ type: 'Unbooked', at: T0, agent: 1, customer: 24, from: '8045550204' }),
  ], [
    job({ at: T0 - JOB_GRACE_MS - 1, by: 1, customer: 24 }),
  ], T0);
  assert.equal(tooEarly[0].booked, false);

  const onTheDay = buildEpisodes([
    call({ type: 'Unbooked', at: T0, agent: 1, customer: 25, from: '8045550205' }),
  ], [
    job({ at: T0 + LEAD_WINDOW_MS, by: 1, customer: 25 }),
  ], T0 + LEAD_WINDOW_MS);
  assert.equal(onTheDay[0].booked, true);
});

test('closing % keeps pending leads and drops only no-customer after 30 days', () => {
  const pending = people({
    now: T0 + DAY,
    calls: [call({ type: 'Unbooked', at: T0, agent: 1, customer: 30, from: '8045550300' })],
  });
  assert.equal(pending.rows[0].closingPct, 0);
  assert.equal(pending.rows[0].leads, 1);

  const lost = people({
    now: T0 + LEAD_WINDOW_MS + DAY,
    calls: [call({ type: 'Unbooked', at: T0, agent: 1, customer: 31, from: '8045550301' })],
  });
  assert.equal(lost.rows[0].closingPct, 0);
  assert.equal(lost.rows[0].unbooked, 1);

  const noCustomer = people({
    now: T0 + LEAD_WINDOW_MS + DAY,
    calls: [call({ type: 'Unbooked', at: T0, agent: 1, from: '8045550302' })],
  });
  assert.equal(noCustomer.rows[0].leads, 1);
  assert.equal(noCustomer.rows[0].closingPct, null);

  const bookedAnyway = people({
    now: T0 + LEAD_WINDOW_MS + DAY,
    calls: [call({ type: 'Booked', at: T0, agent: 1, from: '8045550303' })],
  });
  assert.equal(bookedAnyway.rows[0].closingPct, 100);

  const mixed = people({
    now: T0 + LEAD_WINDOW_MS + DAY,
    calls: [
      call({ type: 'Booked', at: T0, agent: 1, customer: 32, from: '8045550304' }),
      call({ type: 'Unbooked', at: T0 + 1000, agent: 1, from: '8045550305' }),
    ],
  });
  assert.equal(mixed.rows[0].leads, 2);
  assert.equal(mixed.rows[0].closingPct, 100);
  assert.equal(mixed.rows[0].unbooked, 1);
});

test('same phone with no customer is one lead; a later customer id joins it', () => {
  const phoneOnly = buildEpisodes([
    call({ type: 'Unbooked', at: T0, agent: 1, from: '+1 (804) 555-0400' }),
    call({ type: 'Unbooked', at: T0 + DAY, agent: 1, from: '8045550400' }),
  ], [], T0 + DAY);
  assert.equal(phoneOnly.length, 1);

  const linked = buildEpisodes([
    call({ type: 'Unbooked', at: T0, agent: 2, from: '8045550401' }),
    call({ type: 'Unbooked', at: T0 + HOUR, agent: 2, customer: 40, from: '804-555-0401' }),
  ], [
    job({ at: T0 + 2 * HOUR, by: 2, customer: 40 }),
  ], T0 + 2 * HOUR);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].booked, true);
  assert.equal(linked[0].customerId, 40);

  const different = buildEpisodes([
    call({ type: 'Unbooked', at: T0, agent: 1, customer: 41, from: '8045550402' }),
    call({ type: 'Unbooked', at: T0, agent: 1, customer: 42, from: '8045550403' }),
  ], [], T0);
  assert.equal(different.length, 2);
});

test('jobs booked follow createdById, not the lead owner, and estimates are flagged', () => {
  cfg.rules.estimateJobTypeIds = [9];
  const { rows, team } = people({
    calls: [
      call({ type: 'Unbooked', at: T0, agent: 2, customer: 50, from: '8045550500' }),
    ],
    jobs: [
      job({ at: T0, by: 3, customer: 50, typeId: 1 }),
      job({ at: T0 + 1000, by: 3, customer: 50, typeId: 9 }),
      job({ at: T0 + 2000, by: 3, customer: 51, status: 'Canceled' }),
      job({ at: T0 - 2 * DAY, by: 3, customer: 50 }),
    ],
  });
  const riley = rows.find((r) => r.n === 'Riley Chen');
  const casey = rows.find((r) => r.n === 'Casey Morgan');
  assert.equal(riley.leads, 1);
  assert.equal(riley.bookedLeads, 1);
  assert.equal(riley.booked, 0);
  assert.equal(casey.leads, 0);
  assert.equal(casey.booked, 2);
  assert.equal(casey.est, 1);
  assert.equal(team.booked, 2);
  assert.equal(team.est, 1);
  assert.equal(team.bookedLeads, 1);
});

test('one lead can book two jobs, and the team rate is pooled', () => {
  const { rows, team } = people({
    now: T0 + HOUR,
    calls: [
      call({ type: 'Booked', at: T0, agent: 1, customer: 60, from: '8045550600' }),
      call({ type: 'Booked', at: T0 + 1000, agent: 1, customer: 60, from: '8045550600' }),
      ...Array.from({ length: 9 }, (_, i) => call({
        type: 'Booked', at: T0 + 2000 + i, agent: 1, customer: 70 + i, from: `80455507${String(i).padStart(2, '0')}`,
      })),
      call({ type: 'Unbooked', at: T0 + 5000, agent: 3, customer: 90, from: '8045550900' }),
    ],
    jobs: [
      job({ at: T0, by: 1, customer: 60 }),
      job({ at: T0 + 1000, by: 1, customer: 60 }),
    ],
  });
  const jordan = rows.find((r) => r.n === 'Jordan Hale');
  assert.equal(jordan.leads, 10);
  assert.equal(jordan.bookedLeads, 10);
  assert.equal(jordan.booked, 2);
  assert.equal(jordan.closingPct, 100);
  const casey = rows.find((r) => r.n === 'Casey Morgan');
  assert.equal(casey.closingPct, 0);
  assert.equal(team.leads, 11);
  assert.equal(team.bookedLeads, 10);
  assert.equal(team.closingPct, 91);
  assert.notEqual(team.closingPct, Math.round((100 + 0) / 2));
});

test('rows stay alphabetical and a pinned roster hides everyone else', () => {
  const open = people({
    calls: [
      call({ type: 'Unbooked', at: T0, agent: 1, customer: 1, from: '8045550001' }),
      call({ type: 'Unbooked', at: T0, agent: 3, customer: 2, from: '8045550002' }),
    ],
  });
  assert.deepEqual(open.rows.map((r) => r.n), ['Casey Morgan', 'Jordan Hale']);
  assert.equal(open.rows[0].i, 'CM');

  const pinned = people({
    csrIds: [1],
    calls: [
      call({ type: 'Unbooked', at: T0, agent: 1, customer: 1, from: '8045550003' }),
      call({ type: 'Unbooked', at: T0, agent: 3, customer: 2, from: '8045550004' }),
    ],
    jobs: [job({ at: T0, by: 3, customer: 2 })],
  });
  assert.deepEqual(pinned.rows.map((r) => r.n), ['Jordan Hale']);
  assert.equal(pinned.team.leads, 1);
  assert.equal(pinned.team.booked, 0);
});

test('trailing 30-day rate includes older episodes; today does not', () => {
  const { rows } = people({
    calls: [
      call({ type: 'Booked', at: T0 - 10 * DAY, agent: 1, customer: 80, from: '8045550800' }),
      call({ type: 'Unbooked', at: T0, agent: 1, customer: 81, from: '8045550801' }),
    ],
  });
  const jordan = rows.find((r) => r.n === 'Jordan Hale');
  assert.equal(jordan.leads, 1);
  assert.equal(jordan.bookedLeads, 0);
  assert.equal(jordan.closingPct, 0);
  assert.equal(jordan.trailLeads, 2);
  assert.equal(jordan.trailBooked, 1);
  assert.equal(jordan.trailPct, 50);
});

test('lead columns stay blank until the 30-day corpus is ready; jobs still count', () => {
  const { rows, ready, team } = people({
    leadsReady: false,
    calls: [call({ type: 'NotLead', at: T0, agent: 1, from: '8045550009' })],
    jobs: [job({ at: T0, by: 1, customer: 1 })],
  });
  assert.equal(ready, false);
  assert.equal(rows[0].leads, null);
  assert.equal(rows[0].closingPct, null);
  assert.equal(rows[0].booked, 1);
  assert.equal(rows[0].notLead, 1);
  assert.equal(team.leads, null);
  assert.equal(team.booked, 1);
});

test('hidden employees are absent from the grid and still inside the team total', () => {
  cfg.rules.estimateJobTypeIds = [9];
  const calls = [
    call({ type: 'Booked', at: T0, agent: 1, customer: 101, from: '8045551101' }),
    call({ type: 'Booked', at: T0 + 1000, agent: 1, customer: 102, from: '8045551102' }),
    call({ type: 'Unbooked', at: T0, agent: 2, customer: 201, from: '8045552201' }),
    call({ type: 'NotLead', at: T0, agent: 2, from: '8045552202' }),
    call({ type: 'Unbooked', at: T0 - 10 * DAY, agent: 2, customer: 202, from: '8045552203' }),
    call({ type: 'Booked', at: T0, agent: 3, customer: 301, from: '8045553301' }),
  ];
  const jobs = [
    job({ at: T0, by: 1, customer: 101 }),
    job({ at: T0, by: 2, customer: 299 }),
    job({ at: T0 + 1000, by: 2, customer: 298, typeId: 9 }),
    job({ at: T0, by: 3, customer: 301 }),
  ];
  const args = { calls, jobs, csrIds: [1, 2, 3] };
  const open = people({ ...args, hideIds: [] });
  const hidden = people({ ...args, hideIds: [2] });
  const hiddenAsString = people({ ...args, hideIds: ['2'] });

  assert.deepEqual(open.rows.map((r) => r.n), ['Casey Morgan', 'Jordan Hale', 'Riley Chen']);
  assert.deepEqual(hidden.rows.map((r) => r.n), ['Casey Morgan', 'Jordan Hale']);
  assert.deepEqual(hiddenAsString.rows.map((r) => r.n), hidden.rows.map((r) => r.n));
  assert.equal(hidden.rows.some((r) => r.n === 'Riley Chen'), false);

  assert.equal(hidden.team.booked, open.team.booked);
  assert.equal(hidden.team.leads, open.team.leads);
  assert.equal(hidden.team.bookedLeads, open.team.bookedLeads);
  assert.equal(hidden.team.closingPct, open.team.closingPct);
  assert.equal(hidden.team.est, open.team.est);
  assert.equal(hidden.team.notLead, open.team.notLead);
  assert.equal(hidden.team.trailPct, open.team.trailPct);
  assert.equal(hidden.team.trailBooked, open.team.trailBooked);
  assert.equal(hidden.team.trailLeads, open.team.trailLeads);

  assert.equal(hidden.team.booked, 4);
  assert.equal(hidden.rows.reduce((s, r) => s + r.booked, 0), 2);
  assert.equal(hidden.team.est, 1);
  assert.equal(hidden.rows.reduce((s, r) => s + r.est, 0), 0);
  assert.equal(hidden.team.leads, 4);
  assert.equal(hidden.rows.reduce((s, r) => s + r.leads, 0), 3);
  assert.equal(hidden.team.notLead, 1);
  assert.equal(hidden.rows.reduce((s, r) => s + r.notLead, 0), 0);
  // Pooled with the hidden unbooked lead. The visible rows alone would be 100.
  assert.equal(hidden.team.closingPct, 75);
  assert.equal(hidden.team.trailBooked, 3);
  assert.equal(hidden.team.trailLeads, 5);
  assert.equal(hidden.team.trailPct, 60);

  const unpinned = people({ calls, jobs, csrIds: [], hideIds: [2] });
  assert.deepEqual(unpinned.rows.map((r) => r.n), ['Casey Morgan', 'Jordan Hale']);
  assert.equal(unpinned.team.booked, hidden.team.booked);
  assert.equal(unpinned.team.leads, hidden.team.leads);
  assert.equal(unpinned.team.closingPct, hidden.team.closingPct);

  const pending = people({ ...args, hideIds: [2], leadsReady: false });
  assert.deepEqual(pending.rows.map((r) => r.n), ['Casey Morgan', 'Jordan Hale']);
  assert.equal(pending.team.booked, 4);
  assert.equal(pending.team.leads, null);
  assert.equal(pending.team.closingPct, null);
  assert.equal(pending.rows.reduce((s, r) => s + r.booked, 0), 2);
});

test('an empty hide list matches the full roster, totals and all', () => {
  assert.deepEqual(cfg.rules.csrHideEmployeeIds, []);
  cfg.rules.estimateJobTypeIds = [9];
  const args = {
    csrIds: [1, 2, 3],
    calls: [
      call({ type: 'Unbooked', at: T0, agent: 1, customer: 401, from: '8045554401' }),
      call({ type: 'Booked', at: T0, agent: 2, customer: 402, from: '8045554402' }),
      call({ type: 'Booked', at: T0 - 5 * DAY, agent: 2, customer: 403, from: '8045554403' }),
      call({ type: 'Booked', at: T0, agent: 3, customer: 404, from: '8045554404' }),
    ],
    jobs: [
      job({ at: T0, by: 2, customer: 402 }),
      job({ at: T0, by: 3, customer: 404, typeId: 9 }),
    ],
  };
  const empty = people({ ...args, hideIds: [] });
  const prev = cfg.rules.csrHideEmployeeIds;
  cfg.rules.csrHideEmployeeIds = [];
  let viaConfig;
  try {
    viaConfig = people(args);
  } finally {
    cfg.rules.csrHideEmployeeIds = prev;
  }
  assert.deepEqual(empty, viaConfig);
  assert.deepEqual(empty.rows.map((r) => r.n), ['Casey Morgan', 'Jordan Hale', 'Riley Chen']);
  assert.equal(empty.team.booked, empty.rows.reduce((s, r) => s + r.booked, 0));
  assert.equal(empty.team.leads, empty.rows.reduce((s, r) => s + r.leads, 0));
  assert.equal(empty.team.est, empty.rows.reduce((s, r) => s + r.est, 0));
  assert.equal(empty.team.bookedLeads, empty.rows.reduce((s, r) => s + r.bookedLeads, 0));
  assert.equal(empty.team.notLead, empty.rows.reduce((s, r) => s + r.notLead, 0));
  const rateBooked = empty.rows.reduce((s, r) => s + r.rateBooked, 0);
  const rateLeads = empty.rows.reduce((s, r) => s + r.rateLeads, 0);
  assert.equal(empty.team.closingPct, Math.round((rateBooked / rateLeads) * 100));
  const trailBooked = empty.rows.reduce((s, r) => s + r.trailBooked, 0);
  const trailLeads = empty.rows.reduce((s, r) => s + r.trailLeads, 0);
  assert.equal(empty.team.trailPct, Math.round((trailBooked / trailLeads) * 100));
});

test('a hidden id left off a pinned roster is not counted', () => {
  const calls = [
    call({ type: 'Unbooked', at: T0, agent: 1, customer: 501, from: '8045555501' }),
    call({ type: 'Booked', at: T0, agent: 2, customer: 502, from: '8045555502' }),
  ];
  const jobs = [
    job({ at: T0, by: 1, customer: 501 }),
    job({ at: T0, by: 2, customer: 502 }),
  ];
  const pinned = people({ csrIds: [1], hideIds: [], calls, jobs });
  const hiddenOutside = people({ csrIds: [1], hideIds: [2], calls, jobs });
  assert.deepEqual(hiddenOutside, pinned);
  assert.deepEqual(hiddenOutside.rows.map((r) => r.n), ['Jordan Hale']);
  assert.equal(hiddenOutside.team.leads, 1);
  assert.equal(hiddenOutside.team.booked, 1);
  assert.equal(hiddenOutside.team.bookedLeads, 1);
});

test('mergeFresh swaps only the window being refreshed', () => {
  const older = call({ type: 'Unbooked', at: T0 - DAY, agent: 1, customer: 1, from: '8045550010', id: 1 });
  const staleToday = call({ type: 'Unbooked', at: T0, agent: 1, customer: 1, from: '8045550011', id: 2 });
  const fresh = call({ type: 'Booked', at: T0 + 1000, agent: 1, customer: 2, from: '8045550012', id: 3 });
  const merged = mergeFresh(
    [older, staleToday],
    [fresh],
    T0 - HOUR,
    T0 + DAY,
    (c) => Date.parse(c.leadCall.receivedOn),
  );
  assert.deepEqual(merged.map((c) => c.id), [1, 3]);
});
