import 'dotenv/config';

const req = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var: ${k}`);
  return v;
};
const int = (k, d) => (process.env[k] ? parseInt(process.env[k], 10) : d);
const ids = (k) =>
  (process.env[k] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);

export const cfg = {
  st: {
    clientId: req('ST_CLIENT_ID'),
    clientSecret: req('ST_CLIENT_SECRET'),
    appKey: req('ST_APP_KEY'),
    tenantId: req('ST_TENANT_ID'),
    env: process.env.ST_ENV || 'production',
  },
  boardToken: req('BOARD_TOKEN'),
  tz: process.env.TZ || 'America/New_York',
  port: int('PORT', 3000),

  /* ── Branding ────────────────────────────────────────────────────
     Everything market-specific lives here so another franchise can deploy
     this unchanged. Nothing below should ever be hardcoded in board.html
     or rules.js again. */
  brand: {
    name: process.env.BRAND_NAME || 'Call Center',
    market: process.env.MARKET_LABEL || '',
    subtitle: process.env.BOARD_SUBTITLE || 'Call center — booking performance, day to date',
    /* Maps a ServiceTitan business-unit name to the short tag shown on the
       board, as `match=TAG` pairs. BU names are long ("Richmond - Level 1
       Service") and the column has ~500px, so the location is split out.
         BU_LOCATION_TAGS=richmond=RIC,hampton=NN,newport=NN
       Leave empty and the tag column simply stays blank. */
    locationTags: (process.env.BU_LOCATION_TAGS || '')
      .split(',')
      .map((pair) => pair.split('='))
      .filter((p) => p.length === 2 && p[0].trim() && p[1].trim())
      .map(([match, tag]) => ({ match: match.trim().toLowerCase(), tag: tag.trim() })),
  },
  poll: {
    today: int('POLL_TODAY_MS', 60_000),
    refs: int('POLL_REFS_MS', 3_600_000),
    week: int('POLL_WEEK_MS', 3_600_000),
  },
  rules: {
    /* BOOKING_TARGET_PCT and ESTIMATE_SHARE_CAP_PCT are gone. There is no
       conversion target on this board and no cap on estimates. See rules.js. */
    avgTicket: int('AVG_TICKET_USD', 520),
    estimateJobTypeIds: ids('ESTIMATE_JOB_TYPE_IDS'),
    csrEmployeeIds: ids('CSR_EMPLOYEE_IDS'),
    opportunityCallReasonIds: ids('OPPORTUNITY_CALL_REASON_IDS'),
    statusSource: process.env.STATUS_SOURCE || 'none',
    /* Calls arriving when the office is shut are not a service failure — 97% of
       them go unanswered because nobody is there, and including them reported
       53% abandonment where the real in-hours figure is 35%. Every call metric
       is computed inside these hours. Derived from the tenant's own abandon
       curve, which steps cleanly from 33-49% in-hours to 95-100% outside. */
    openHour: int('BUSINESS_OPEN_HOUR', 8),
    closeHour: int('BUSINESS_CLOSE_HOUR', 16),
    openDays: (process.env.BUSINESS_DAYS || 'Mon,Tue,Wed,Thu,Fri')
      .split(',').map((s) => s.trim()).filter(Boolean),
    /* Days a missed caller gets to come back through the text-back loop before
       the opportunity counts as unrecovered. Observed median lag is 2.1 days. */
    recoveryDays: int('RECOVERY_WINDOW_DAYS', 7),
  },
};

/* ── Timezone-correct day boundaries ───────────────────────────────
   ServiceTitan stores timestamps in UTC. "Today" must mean today in
   America/New_York or the board rolls over at 8pm during EDT.
   Never use toISOString().slice(0,10) for this.                     */

function partsIn(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(
    f.formatToParts(date).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)])
  );
  if (p.hour === 24) p.hour = 0;
  return p;
}

function tzOffsetMs(date, tz) {
  const p = partsIn(date, tz);
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUTC - date.getTime();
}

/** Start of the local day, offset by N days, as a UTC Date. */
export function localDayStart(offsetDays = 0, at = new Date(), tz = cfg.tz) {
  const p = partsIn(at, tz);
  const guess = Date.UTC(p.year, p.month - 1, p.day + offsetDays, 0, 0, 0);
  const off = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - off);
}

/** ISO strings for a local-day window: [start, end) */
export function localDayWindow(offsetDays = 0) {
  return {
    start: localDayStart(offsetDays).toISOString(),
    end: localDayStart(offsetDays + 1).toISOString(),
  };
}

/** Full date label for the header, e.g. "Wed · Jul 29". */
export function localDateLabel(offsetDays = 0) {
  const d = localDayStart(offsetDays);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.tz, weekday: 'short', month: 'short', day: 'numeric',
  }).format(d).replace(',', ' ·');
}

/** Short weekday label in local tz, e.g. "Mon" / "Today" for offset 0. */
export function dayLabel(offsetDays) {
  if (offsetDays === 0) return 'Today';
  const d = localDayStart(offsetDays);
  return new Intl.DateTimeFormat('en-US', { timeZone: cfg.tz, weekday: 'short' }).format(d);
}

/** Local hour + weekday for a timestamp, used by the business-hours test. */
export function localHourDow(date, tz = cfg.tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(
    f.formatToParts(date).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value])
  );
  return { hour: Number(p.hour) % 24, dow: p.weekday };
}

/** Local calendar day key, e.g. "2026-07-29". Used to dedupe callers per day. */
export function localDayKey(date, tz = cfg.tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
}

export function localTimeLabel(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.tz, hour: 'numeric', minute: '2-digit',
  }).format(date);
}
