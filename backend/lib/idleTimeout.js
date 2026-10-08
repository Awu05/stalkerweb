'use strict';

// Idle auto-disconnect timeout, in whole minutes. 0 means never disconnect.
// IDLE_TIMEOUT_MINUTES sets the default; a value saved from the Settings page
// overrides it at runtime.

const DEFAULT_IDLE_MINUTES = 30;
const MAX_IDLE_MINUTES     = 7 * 24 * 60; // a week — anything longer is "never"

// Parses a minutes value from the env or a request body. Returns the integer
// minutes, or `fallback` when the value is missing or invalid.
function parseIdleMinutes(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_IDLE_MINUTES) return fallback;
  return n;
}

// IDLE_TIMEOUT_MINUTES, read leniently the way it always was: a leading whole
// number counts ("45m" → 45, "1.5" → 1), and anything over a week means never.
// Returns { minutes, warning } — warning is set when the value was adjusted or
// unreadable, so the caller can log it instead of changing it silently.
function parseIdleEnv(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { minutes: DEFAULT_IDLE_MINUTES, warning: null };
  }
  const n = parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n) || n < 0) {
    return { minutes: DEFAULT_IDLE_MINUTES, warning: `IDLE_TIMEOUT_MINUTES="${value}" is not a number of minutes — using ${DEFAULT_IDLE_MINUTES}` };
  }
  if (n > MAX_IDLE_MINUTES) {
    return { minutes: 0, warning: `IDLE_TIMEOUT_MINUTES=${n} is over a week — treating it as never (0)` };
  }
  const exact = String(n) === String(value).trim();
  return { minutes: n, warning: exact ? null : `IDLE_TIMEOUT_MINUTES="${value}" read as ${n} minutes` };
}

module.exports = { parseIdleMinutes, parseIdleEnv, DEFAULT_IDLE_MINUTES, MAX_IDLE_MINUTES };
