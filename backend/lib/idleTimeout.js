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

module.exports = { parseIdleMinutes, DEFAULT_IDLE_MINUTES, MAX_IDLE_MINUTES };
