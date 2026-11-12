import { phoneKey } from '../domain/phone.js';
import { createRcCache } from './cache.js';

/**
 * RingCentral account call log, view=Detailed.
 *
 * Prefer a Command Center export when the owner points us at one
 * (CC_RC_LOG_URL + CC_RC_LOG_KEY). Command Center stores this log; this
 * environment could not read that private repo, and the Nov 12 investigation
 * found no existing call-log export (COMMAND_CENTER_EXPORT_KEY gates
 * marketing-spend and Handoff only). The URL is therefore explicit — we do
 * not guess a path.
 *
 * Otherwise call RingCentral directly (JWT app auth).
 *
 * When neither pair is set, matching stays off: no request is made, and the
 * board classifies calls exactly as it did from ServiceTitan alone.
 */

const cache = createRcCache();
let loggedOff = false;
let token = null;
let tokenExp = 0;
let tokenFlight = null;

export function rcMode() {
  const ccUrl = process.env.CC_RC_LOG_URL?.trim();
  const ccKey = process.env.CC_RC_LOG_KEY?.trim();
  if (ccUrl && ccKey) return 'command-center';
  const id = process.env.RC_CLIENT_ID?.trim();
  const secret = process.env.RC_CLIENT_SECRET?.trim();
  const jwt = process.env.RC_JWT?.trim();
  if (id && secret && jwt) return 'ringcentral';
  return 'off';
}

export function logRcModeOnce() {
  const mode = rcMode();
  if (mode === 'off' && !loggedOff) {
    loggedOff = true;
    console.warn(
      '[rc] RingCentral matching is off — set CC_RC_LOG_URL and CC_RC_LOG_KEY, or RC_CLIENT_ID, RC_CLIENT_SECRET and RC_JWT. Missed calls follow ServiceTitan only.',
    );
  }
  return mode;
}

/** Broadly (804) 781-4293 and the old Nonstop forward (804) 655-6490.
 *  Override with RC_OVERFLOW_NUMBERS. An empty value disables the category. */
export function overflowNumbers() {
  const raw = process.env.RC_OVERFLOW_NUMBERS;
  const src = raw == null ? '8047814293,8046556490' : raw;
  return new Set(src.split(',').map((s) => phoneKey(s.trim())).filter(Boolean));
}

function rcServer() {
  return (process.env.RC_SERVER_URL?.trim() || 'https://platform.ringcentral.com').replace(/\/$/, '');
}

async function rcAccessToken() {
  if (token && Date.now() < tokenExp) return token;
  if (tokenFlight) return tokenFlight;
  tokenFlight = (async () => {
    try {
      const id = process.env.RC_CLIENT_ID.trim();
      const secret = process.env.RC_CLIENT_SECRET.trim();
      const jwt = process.env.RC_JWT.trim();
      const basic = Buffer.from(`${id}:${secret}`).toString('base64');
      const res = await fetch(`${rcServer()}/restapi/oauth/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`RingCentral auth ${res.status}: ${text.slice(0, 180)}`);
      }
      const json = await res.json();
      token = json.access_token;
      tokenExp = Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000;
      return token;
    } finally {
      tokenFlight = null;
    }
  })();
  return tokenFlight;
}

function extractRecords(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.records)) return json.records;
  if (Array.isArray(json?.calls)) return json.calls;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.rc_calls)) return json.rc_calls;
  return [];
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (res.status === 429 || res.status >= 500) {
    const ra = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500;
    await new Promise((r) => setTimeout(r, wait));
    const retry = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!retry.ok) throw new Error(`call log ${retry.status}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`call log ${res.status}`);
  return res.json();
}

/** One window of the account call log. `maxPages` stops a bad window crawling. */
export async function fetchCallLog(fromIso, toIso, { maxPages = 8 } = {}) {
  const mode = rcMode();
  if (mode === 'off') return null;

  if (mode === 'command-center') {
    const url = new URL(process.env.CC_RC_LOG_URL.trim());
    url.searchParams.set('dateFrom', fromIso);
    url.searchParams.set('dateTo', toIso);
    url.searchParams.set('view', 'Detailed');
    const key = process.env.CC_RC_LOG_KEY.trim();
    const json = await fetchJson(url, {
      Authorization: `Bearer ${key}`,
      'x-api-key': key,
      Accept: 'application/json',
    });
    return extractRecords(json);
  }

  const access = await rcAccessToken();
  const first = new URL(`${rcServer()}/restapi/v1.0/account/~/call-log`);
  first.searchParams.set('view', 'Detailed');
  first.searchParams.set('dateFrom', fromIso);
  first.searchParams.set('dateTo', toIso);
  first.searchParams.set('perPage', '1000');
  first.searchParams.set('type', 'Voice');

  const headers = { Authorization: `Bearer ${access}`, Accept: 'application/json' };
  const out = [];
  let next = first.toString();
  for (let page = 0; page < maxPages && next; page++) {
    const json = await fetchJson(next, headers);
    out.push(...extractRecords(json));
    next = json?.navigation?.nextPage?.uri ?? null;
    if (page === maxPages - 1 && next) {
      console.warn(`[rc] call log hit maxPages=${maxPages}; window truncated`);
    }
  }
  return out;
}

/**
 * Cached fetch. `null` means matching is off (do not annotate).
 * An empty array means matching is on but this window returned nothing —
 * unmatched ServiceTitan rows keep the no-match fallback.
 * A failed fetch reuses the last good window; if there is none, returns []
 * and the board keeps rendering.
 */
export async function loadCallLog(fromIso, toIso, ttlMs, opts) {
  const mode = logRcModeOnce();
  if (mode === 'off') return null;
  const key = `${mode}|${fromIso}|${toIso}`;
  try {
    return await cache(key, ttlMs, () => fetchCallLog(fromIso, toIso, opts));
  } catch (err) {
    console.warn('[rc] call log unavailable:', err.message);
    return [];
  }
}
