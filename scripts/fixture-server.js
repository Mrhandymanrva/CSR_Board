/** Serves the real board.html against example snapshot data.
 *  No ServiceTitan credentials. Not used in production. */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture-snapshot.js';

const port = Number(process.env.FIXTURE_PORT || 4173);
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = express();

app.get('/api/snapshot', (req, res) => {
  const day = Number.parseInt(req.query.day, 10);
  if (!Number.isFinite(day) || day === 0) return res.json(fixture);
  return res.json({
    ...fixture,
    day,
    isToday: false,
    dateLabel: 'Wed · Nov 11',
    stale: false,
    churn: null,
    example: true,
  });
});

app.get('/board', (_req, res) => {
  res.sendFile(path.join(pub, 'board.html'));
});

app.listen(port, '127.0.0.1', () => {
  console.log(`[fixture] board at http://127.0.0.1:${port}/board`);
});
