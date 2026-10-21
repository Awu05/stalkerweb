'use strict';

// A web player's playback error, reported to the server log (POST
// /api/stream/report) — the reason a phone gives up otherwise stays on the
// phone, where its browser console is out of reach.

const clip = (v, n) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

/** "iPhone · Chrome (iOS 18.1)", "Windows · Edge", "Android · Firefox" — the browser, briefly. */
function browserOf(ua) {
  const s = String(ua || '');
  const device = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android'
    : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux|CrOS/.test(s) ? 'Linux' : 'unknown device';
  // iOS browsers all run Safari's engine; their own names come first in the string.
  const browser = /CriOS/.test(s) ? 'Chrome' : /FxiOS|Firefox/.test(s) ? 'Firefox' : /EdgiOS|Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari' : 'browser';
  const ios = /OS (\d+)[_.](\d+)/.exec(s);
  return `${device} · ${browser}${(device === 'iPhone' || device === 'iPad') && ios ? ` (iOS ${ios[1]}.${ios[2]})` : ''}`;
}

/**
 * The log line for a report: { channelId?, title?, engine, kind, detail?, attempt?, gaveUp? }.
 * Null for one with nothing to say.
 */
function reportLine(body, ua) {
  const b = body && typeof body === 'object' ? body : {};
  const kind = clip(b.kind, 120);
  if (!kind) return null;
  const what = b.channelId ? `ch ${clip(b.channelId, 20)}${b.title ? ` "${clip(b.title, 80)}"` : ''}` : b.title ? `"${clip(b.title, 120)}"` : 'a stream';
  const engine = clip(b.engine, 20) || 'player';
  const detail = clip(b.detail, 300);
  const attempt = Number.isInteger(b.attempt) && b.attempt > 0 ? ` (reconnect ${b.attempt})` : '';
  const gaveUp = b.gaveUp === true ? ' — the player gave up' : '';
  return `${what} on ${browserOf(ua)}: ${engine} ${kind}${detail ? ` — ${detail}` : ''}${attempt}${gaveUp}`;
}

/** At most `limit` reports a minute from one address (a stuck player retries). */
function rateLimiter(limit = 30, now = Date.now) {
  const seen = new Map();
  return (key) => {
    const t = now();
    const e = seen.get(key);
    if (!e || t - e.since > 60_000) {
      seen.set(key, { since: t, n: 1 });
      if (seen.size > 1000) seen.delete(seen.keys().next().value);
      return true;
    }
    return ++e.n <= limit;
  };
}

/** A report of a device unable to decode what it got (not a dropped connection). */
function isDecodeFailure(body) {
  const text = `${body?.kind ?? ''} ${body?.detail ?? ''}`;
  return /MediaError [34]\b|decode|bufferAppendError|not supported/i.test(text);
}

module.exports = { browserOf, reportLine, rateLimiter, isDecodeFailure };
