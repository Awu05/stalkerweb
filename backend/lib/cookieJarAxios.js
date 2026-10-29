'use strict';

// Cookies for an axios client, kept in a tough-cookie jar. The portal login
// leans on them (the identity cookies go out on every call, and anything the
// portal sets must come back), and the usual helper package for this wants
// Node 20 or newer — this is the little we need of it, so the server also
// runs on the Node 18 inside the all-in-one Android app.

/**
 * The address a request's options (as a redirect hands them over) point at.
 * An IPv6 hostname comes bare (::1) and goes back in brackets.
 */
function urlOf(options) {
  const port = options.port ? `:${options.port}` : '';
  const host = options.hostname || options.host;
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${options.protocol}//${h}${port}${options.path}`;
}

/** Drops a header whatever its case (Cookie, cookie, COOKIE). */
function dropHeader(headers, name) {
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) delete headers[k];
}

/**
 * A Cookie header from the caller's and the jar's: the caller's cookies are
 * kept, the jar's win on the same name (the jar holds what the portal set).
 */
function mergeCookies(caller, jar) {
  if (!caller) return jar;
  if (!jar) return caller;
  const name = (pair) => pair.split('=')[0].trim();
  const fromJar = new Set(jar.split(';').map(name));
  const kept = caller.split(';').map((p) => p.trim()).filter((p) => p && !fromJar.has(name(p)));
  return kept.length ? `${kept.join('; ')}; ${jar}` : jar;
}

/** A response's set-cookie headers as a list (a lone one can arrive as text). */
function setCookiesOf(headers) {
  const raw = headers && (headers['set-cookie'] || headers['Set-Cookie']);
  return !raw ? [] : Array.isArray(raw) ? raw : [raw];
}

/**
 * Makes an axios instance send the jar's cookies and keep the ones the portal
 * sets — on each hop of a redirect too, so a cookie set by a 302 goes out with
 * the request it points to. Returns the instance.
 */
function withCookieJar(instance, jar) {
  const store = (headers, url) => {
    for (const c of setCookiesOf(headers)) jar.setCookieSync(c, url, { ignoreError: true });
  };

  instance.interceptors.request.use((config) => {
    const url = instance.getUri(config);
    const cookie = mergeCookies(config.headers.get('Cookie'), jar.getCookieStringSync(url));
    if (cookie) config.headers.set('Cookie', cookie);
    // Each redirect: keep what the page we're leaving set, then send the
    // jar's cookies on to the next. `url` is where we are now.
    let here = url;
    const before = config.beforeRedirect;
    config.beforeRedirect = (options, details) => {
      store(details.headers, here);
      here = urlOf(options);
      // The cookie the last hop sent goes, in whatever case it was set; only
      // the jar's cookies for the next address go out — none if it has none.
      const next = jar.getCookieStringSync(here);
      dropHeader(options.headers, 'cookie');
      if (next) options.headers.Cookie = next;
      if (before) before(options, details);
    };
    return config;
  });

  // The last page's cookies (a 4xx/5xx answer counts too).
  const keep = (res) => {
    const url = res?.request?.res?.responseUrl || (res?.config && instance.getUri(res.config));
    if (res && url) store(res.headers, url);
  };
  instance.interceptors.response.use(
    (res) => { keep(res); return res; },
    (err) => { keep(err.response); return Promise.reject(err); }
  );

  return instance;
}

module.exports = { withCookieJar, mergeCookies };
