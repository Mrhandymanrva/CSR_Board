import { cfg } from '../config.js';

const HOSTS = {
  production: {
    auth: 'https://auth.servicetitan.io/connect/token',
    api: 'https://api.servicetitan.io',
  },
  integration: {
    auth: 'https://auth-integration.servicetitan.io/connect/token',
    api: 'https://api-integration.servicetitan.io',
  },
};

const host = HOSTS[cfg.st.env] || HOSTS.production;

/* ── Token cache ───────────────────────────────────────────────────
   Tokens are valid ~15 minutes. Cache and reuse; refresh 60s early.  */
let token = null;
let tokenExp = 0;
let inFlight = null;

async function getToken() {
  if (token && Date.now() < tokenExp) return token;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.st.clientId,
      client_secret: cfg.st.clientSecret,
    });
    const res = await fetch(host.auth, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Auth failed ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    token = json.access_token;
    tokenExp = Date.now() + (json.expires_in ?? 900) * 1000 - 60_000;
    inFlight = null;
    return token;
  })();

  return inFlight;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET one page from a ServiceTitan v2 endpoint.
 * URL shape: {api}/{module}/v2/tenant/{tenantId}/{path}
 */
export async function stGet(module, path, params = {}, attempt = 0) {
  const url = new URL(`${host.api}/${module}/v2/tenant/${cfg.st.tenantId}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      'ST-App-Key': cfg.st.appKey,
      Accept: 'application/json',
    },
  });

  // 401 once => token rejected; drop cache and retry a single time.
  if (res.status === 401 && attempt === 0) {
    token = null; tokenExp = 0;
    return stGet(module, path, params, attempt + 1);
  }

  // 429 / 5xx => exponential backoff, honouring Retry-After.
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const ra = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2 ** attempt * 750;
    await sleep(wait);
    return stGet(module, path, params, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`ST ${module}/${path} ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Page through an endpoint until exhausted.
 * Response envelope: { page, pageSize, hasMore, totalCount, data: [...] }
 * Hard cap prevents a bad filter turning into an unbounded crawl.
 */
export async function stGetAll(module, path, params = {}, { pageSize = 200, maxPages = 25 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const json = await stGet(module, path, { ...params, page, pageSize });
    const rows = json?.data ?? [];
    out.push(...rows);
    if (!json?.hasMore || rows.length === 0) return out;
  }
  console.warn(`[st] ${module}/${path} hit maxPages=${maxPages}; results truncated`);
  return out;
}

export const _internals = { host };
