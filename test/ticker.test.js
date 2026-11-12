import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshot } from '../src/poll/index.js';

test('the ticker counts jobs from the team total, not the visible rows', () => {
  const snap = snapshot({
    booked: [],
    dispatch: [],
    calls: { ok: true, handled: 0, missedCallers: 0, abandonPct: null },
    churn: null,
    people: {
      ready: true,
      rows: [{ n: 'Jordan Hale', booked: 1, est: 0 }],
      team: { booked: 4, est: 1 },
    },
  }, -1);

  assert.equal(snap.csrs.length, 1);
  assert.equal(snap.team.booked, 4);
  assert.equal(snap.team.est, 1);
  assert.match(snap.ticker, /3 work jobs booked today · 1 estimates/);
  assert.doesNotMatch(snap.ticker, /1 work jobs booked today · 0 estimates/);
});
