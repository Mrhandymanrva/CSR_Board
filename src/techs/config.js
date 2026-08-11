import { cfg, localDayStart } from '../config.js';

/* ── Technician board configuration ───────────────────────────────
   Deliberately a SEPARATE module rather than another block inside
   ../config.js. The two boards share infrastructure (the ServiceTitan
   client, the timezone day-window maths) but not their settings, and
   keeping tech settings out of the call-center config means neither
   board can break the other by renaming a key.

   Nothing here is tenant-specific by default. A franchise deploys this
   unchanged; the per-technician revenue goal comes from ServiceTitan's
   own `dailyGoal` field on the technician record, not from an env var. */

const int = (k, d) => (process.env[k] ? parseInt(process.env[k], 10) : d);
const ids = (k) =>
  (process.env[k] || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);

export const techCfg = {
  /* A device paired to the shop TV should not necessarily be able to pull up
     the call-center board, and vice versa. Set TECH_BOARD_TOKEN to keep them
     apart; leave it unset and both boards pair off the one BOARD_TOKEN. */
  boardToken: process.env.TECH_BOARD_TOKEN || cfg.boardToken,
  separateToken: Boolean(process.env.TECH_BOARD_TOKEN),

  poll: {
    /* Revenue moves when a job closes, which is a slower clock than a call
       arriving — 90s is plenty and keeps the per-job assignment fan-out
       comfortably inside the 60 req/sec/app rate limit. */
    today: int('TECH_POLL_TODAY_MS', 90_000),
    /* A finished day does not change. Re-read it occasionally anyway, because
       an invoice CAN be adjusted after the fact, but not every cycle. */
    priorDays: int('TECH_POLL_PRIOR_MS', 900_000),
    refs: int('TECH_POLL_REFS_MS', 3_600_000),
  },

  /* Only used to LABEL a non-revenue visit ("estimate" vs "no charge").
     The board's non-revenue treatment does not depend on it — that is derived
     from the money, so an unconfigured tenant still renders correctly. */
  estimateJobTypeIds: ids('TECH_ESTIMATE_JOB_TYPE_IDS'),

  /* Technicians with no activity all week are dropped rather than shown as a
     wall of dashes. Set false to pin the full active roster. */
  hideIdle: process.env.TECH_HIDE_IDLE !== 'false',

  /* How many past weeks the ‹ button can reach. */
  maxLookbackWeeks: int('TECH_MAX_LOOKBACK_WEEKS', 8),
};

/* ── Week shape ───────────────────────────────────────────────────
   Mon–Sat. Sunday is not a work day here and an always-empty seventh
   column costs ~150px of a 1920px board for nothing. Decided with Mason
   2026-08-11 against the ServiceTitan Liveboard, which runs Mon–Sun. */

export const DAYS_IN_WEEK = 6;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Local weekday index for a day offset. 0 = Sunday. */
export function localDow(offsetDays = 0) {
  const label = new Intl.DateTimeFormat('en-US', { timeZone: cfg.tz, weekday: 'short' })
    .format(localDayStart(offsetDays));
  return DOW.indexOf(label);
}

/**
 * Day offset of the Monday starting the week that contains `offsetDays`.
 * On a Sunday this returns the Monday of the week that just finished — the
 * six days of work you would actually want to look at, not an empty new week.
 */
export function mondayOffset(offsetDays = 0) {
  const dow = localDow(offsetDays);
  return offsetDays - ((dow + 6) % 7);
}

/** The six day offsets Mon..Sat for the week containing `offsetDays`. */
export function weekOffsets(offsetDays = 0) {
  const mon = mondayOffset(offsetDays);
  return Array.from({ length: DAYS_IN_WEEK }, (_, i) => mon + i);
}

/** "Mon 8/11" — the day column heading. */
export function dayColLabel(offsetDays) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.tz, weekday: 'short', month: 'numeric', day: 'numeric',
  }).format(localDayStart(offsetDays)).replace(',', '');
}

/** "Week of Aug 10" — the header stamp when paging back. */
export function weekLabel(offsetDays = 0) {
  return 'Week of ' + new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.tz, month: 'short', day: 'numeric',
  }).format(localDayStart(mondayOffset(offsetDays)));
}
