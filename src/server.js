import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';
import { start, snapshot, getDay, clampDay, _state } from './poll/index.js';
import { techCfg } from './techs/config.js';
import {
  start as startTechs,
  snapshot as techSnapshot,
  clampWeek,
  _state as _techState,
} from './techs/poll.js';

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

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Constant-time compare so the cookie can't be probed byte by byte. */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * One gate per board.
 *
 * Each board gets its OWN cookie, so a TV paired to the shop board is not
 * thereby paired to the call-center board — the two hang in different rooms
 * and show different people's numbers. Set TECH_BOARD_TOKEN to make them
 * genuinely separate secrets; leave it unset and both pair off BOARD_TOKEN,
 * but still one device at a time, one board at a time.
 *
 * The call-center board keeps cookie name `wb` and label `paired-device-v1`
 * unchanged. Do not "tidy" either: both feed the HMAC, so changing them
 * un-pairs every TV already on the wall.
 */
function makeGate({ cookie, token, label }) {
  const pairValue = crypto.createHmac('sha256', token).update(label).digest('hex');

  const cookieToken = (req) => {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === cookie) return part.slice(i + 1).trim();
    }
    return null;
  };

  const isPaired = (req) => same(cookieToken(req), pairValue);
  const hasToken = (req) =>
    same(req.query.k, token) || same(req.get('x-board-token') ?? '', token);

  const pair = (req, res) => {
    res.cookie(cookie, pairValue, {
      maxAge: ONE_YEAR_MS,
      httpOnly: true,
      sameSite: 'lax',
      // Railway terminates TLS upstream, so trust the forwarded proto.
      secure: (req.get('x-forwarded-proto') ?? req.protocol) === 'https',
    });
  };

  return {
    cookie,
    isPaired,
    hasToken,
    pair,
    /** Pages: a valid token pairs the device, then we redirect to the clean URL. */
    gatePage(req, res, next) {
      if (hasToken(req)) {
        pair(req, res);
        return res.redirect(302, req.path);
      }
      if (isPaired(req)) return next();
      return res.status(404).send('Not found');
    },
    /** Data: no redirect dance — the page fetches this with its cookie. */
    gateApi(req, res, next) {
      if (isPaired(req) || hasToken(req)) return next();
      return res.status(404).send('Not found');
    },
  };
}

const callCenter = makeGate({ cookie: 'wb', token: cfg.boardToken, label: 'paired-device-v1' });
const techs = makeGate({ cookie: 'tb', token: techCfg.boardToken, label: 'paired-tech-device-v1' });

const { gatePage, gateApi, isPaired, hasToken, pair } = callCenter;

/**
 * Railway restarts the container when this fails, so it reports on the
 * PROCESS, not on either board individually.
 *
 * Two boards now share one service. Returning 503 because the technician
 * poller is erroring would restart the container and take down a perfectly
 * healthy call-center board — and a restart does not fix a bad ServiceTitan
 * response anyway. So: 503 only when BOTH boards are down, which is the case
 * that actually indicates something systemic (auth, network, a bad deploy).
 * Per-board trouble is reported in the body and shown on the board itself.
 */
app.get('/healthz', (_req, res) => {
  const s = snapshot();
  const ccOk = Boolean(s.ready && !s.stale);
  const techFresh = _techState.lastOk
    ? Date.now() - _techState.lastOk < techCfg.poll.today * 3
    : false;

  res.status(ccOk || techFresh ? 200 : 503).json({
    callCenter: {
      ready: s.ready,
      stale: s.stale ?? true,
      lastError: _state.lastError,
      lastOkAgoMs: _state.lastOk ? Date.now() - _state.lastOk : null,
    },
    technicians: {
      ready: _techState.lastOk != null,
      stale: !techFresh,
      lastError: _techState.lastError,
      lastOkAgoMs: _techState.lastOk ? Date.now() - _techState.lastOk : null,
    },
    // Kept at the top level so anything already parsing this keeps working.
    ready: s.ready,
    stale: s.stale ?? true,
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

/* ── Technician board ───────────────────────────────────────────────
   Same pairing model, its own cookie and its own poller. `?week=-1` is
   last week, clamped by TECH_MAX_LOOKBACK_WEEKS. */

app.get('/api/tech-snapshot', techs.gateApi, async (req, res) => {
  const week = clampWeek(req.query.week);
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await techSnapshot(week));
  } catch (e) {
    console.error('[api] tech week', week, 'failed:', e.message);
    res.status(502).json({ ready: false, week, error: `Could not load that week: ${e.message}` });
  }
});

app.get('/techboard', techs.gatePage, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'techboard.html'));
});

/* A paired TV can be pointed at the bare domain and just work — that is the
   whole point of pairing. Everyone else still lands on the health check. */
app.get('/', (req, res) => {
  if (hasToken(req)) { pair(req, res); return res.redirect(302, '/board'); }
  return res.redirect(302, isPaired(req) ? '/board' : '/healthz');
});

/* Unpair this device — for handing a laptop back, or after rotating the token.
   Clears BOTH boards: someone reaching for /logout wants the screen to stop
   showing staff numbers, not to guess which of two cookies they hold. */
app.get('/logout', (_req, res) => {
  res.clearCookie(callCenter.cookie);
  res.clearCookie(techs.cookie);
  res.send('Unpaired. Reopen /board?k=<BOARD_TOKEN> or /techboard?k=<TECH_BOARD_TOKEN> to pair again.');
});

start();
startTechs();

app.listen(cfg.port, () => {
  console.log(`[wallboard] listening on :${cfg.port}  TZ=${cfg.tz}  tenant=${cfg.st.tenantId}`);
  console.log(`[wallboard] call center : pair once at /board?k=<BOARD_TOKEN>`);
  console.log(`[wallboard] technicians : pair once at /techboard?k=<${techCfg.separateToken ? 'TECH_BOARD_TOKEN' : 'BOARD_TOKEN'}>`);
  console.log(`[wallboard] after that the bare path works on that device`);
});
