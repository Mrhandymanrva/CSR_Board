import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';
import { start, snapshot, _state } from './poll/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

/* Token gate. The board is on the public internet — Railway gives it a
   TLS URL anyone can hit. Not a security boundary worth much, but CSR
   names and booking rates should not be reachable by guessing a URL. */
function gate(req, res, next) {
  const k = req.query.k || req.get('x-board-token');
  if (k !== cfg.boardToken) return res.status(404).send('Not found');
  next();
}

app.get('/healthz', (_req, res) => {
  const s = snapshot();
  res.status(s.ready && !s.stale ? 200 : 503).json({
    ready: s.ready,
    stale: s.stale ?? true,
    lastError: _state.lastError,
    lastOkAgoMs: _state.lastOk ? Date.now() - _state.lastOk : null,
  });
});

app.get('/api/snapshot', gate, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(snapshot());
});

app.get('/board', gate, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'board.html'));
});

app.get('/', (_req, res) => res.redirect(302, '/healthz'));

start();

app.listen(cfg.port, () => {
  console.log(`[wallboard] listening on :${cfg.port}  TZ=${cfg.tz}  tenant=${cfg.st.tenantId}`);
  console.log(`[wallboard] board at /board?k=<BOARD_TOKEN>`);
});
