import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';
import { start, snapshot, getDay, clampDay, _state } from './poll/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

/* ── Access ────────────────────────────────────────────────────────
   The board is on the public internet — Railway gives it a TLS URL anyone
   can hit — and it shows staff first names next to their call and booking
   counts. That should not be reachable by guessing a hostname. But the
   original design made you carry a 48-character token in the URL forever,
   which on a wall-mounted TV is genuinely unusable.

   So: PAIR ONCE, then the bare URL works on that device.

     1. At setup, open  /board?k=<BOARD_TOKEN>  once.
     2. The server sets a signed, long-lived cookie and redirects to the
        clean  /board  — the token leaves the address bar entirely, so
        nobody reads it off the screen or out of browser history.
     3. From then on the TV just loads  https://<domain>/  and gets the
        board. A device without the cookie still gets a 404.

   The cookie is an HMAC of a fixed label under BOARD_TOKEN, so rotating
   BOARD_TOKEN invalidates every paired device — which is the intended way
   to revoke access. It carries no session state and grants nothing beyond
   read access to this one page. */

const COOKIE = 'wb';
const PAIR_VALUE = crypto.createHmac('sha256', cfg.boardToken).update('paired-device-v1').digest('hex');
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function cookieToken(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

/** Constant-time compare so the cookie can't be probed byte by byte. */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const isPaired = (req) => same(cookieToken(req), PAIR_VALUE);
const hasToken = (req) => same(req.query.k, cfg.boardToken) || same(req.get('x-board-token') ?? '', cfg.boardToken);

function pair(req, res) {
  res.cookie(COOKIE, PAIR_VALUE, {
    maxAge: ONE_YEAR_MS,
    httpOnly: true,
    sameSite: 'lax',
    // Railway terminates TLS upstream, so trust the forwarded proto.
    secure: (req.get('x-forwarded-proto') ?? req.protocol) === 'https',
  });
}

/** Pages: a valid token pairs the device, then we redirect to the clean URL. */
function gatePage(req, res, next) {
  if (hasToken(req)) {
    pair(req, res);
    return res.redirect(302, req.path);
  }
  if (isPaired(req)) return next();
  return res.status(404).send('Not found');
}

/** Data: no redirect dance — the page fetches this with its cookie. */
function gateApi(req, res, next) {
  if (isPaired(req) || hasToken(req)) return next();
  return res.status(404).send('Not found');
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

/* `?day=-1` is yesterday, `-2` the day before, clamped at MAX_LOOKBACK_DAYS.
   Today comes from the live poller; anything else is fetched on demand and
   cached, so paging back is one API round trip and then free. */
app.get('/api/snapshot', gateApi, async (req, res) => {
  const day = clampDay(req.query.day);
  res.set('Cache-Control', 'no-store');
  try {
    res.json(snapshot(await getDay(day), day));
  } catch (e) {
    console.error('[api] day', day, 'failed:', e.message);
    res.status(502).json({ ready: false, day, error: `Could not load that day: ${e.message}` });
  }
});

app.get('/board', gatePage, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'board.html'));
});

/* A paired TV can be pointed at the bare domain and just work — that is the
   whole point of pairing. Everyone else still lands on the health check. */
app.get('/', (req, res) => {
  if (hasToken(req)) { pair(req, res); return res.redirect(302, '/board'); }
  return res.redirect(302, isPaired(req) ? '/board' : '/healthz');
});

/* Unpair this device — for handing a laptop back, or after rotating the token. */
app.get('/logout', (_req, res) => {
  res.clearCookie(COOKIE);
  res.send('Unpaired. Reopen /board?k=<BOARD_TOKEN> to pair again.');
});

start();

app.listen(cfg.port, () => {
  console.log(`[wallboard] listening on :${cfg.port}  TZ=${cfg.tz}  tenant=${cfg.st.tenantId}`);
  console.log(`[wallboard] pair a device once at /board?k=<BOARD_TOKEN>`);
  console.log(`[wallboard] after that the bare URL works on that device`);
});
