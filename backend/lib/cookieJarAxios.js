'use strict';

// Cookies for an axios client, kept in a tough-cookie jar. The portal login
// leans on them (the identity cookies go out on every call, and anything the
// portal sets must come back), and the usual helper package for this wants
// Node 20 or newer — this is the little we need of it, so the server also
// runs on the Node 18 inside the all-in-one Android app.

/** The address a request's options (as a redirect hands them over) point at. */
function urlOf(options) {
  const port = options.port ? `:${options.port}` : '';
  return `${options.protocol}//${options.hostname || options.host}${port}${options.path}`;
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
    const cookie = jar.getCookieStringSync(url);
    if (cookie) config.headers.set('Cookie', cookie);
    // Each redirect: keep what the page we're leaving set, then send the
    // jar's cookies on to the next. `url` is where we are now.
    let here = url;
    const before = config.beforeRedirect;
    config.beforeRedirect = (options, details) => {
      store(details.headers, here);
      here = urlOf(options);
      const next = jar.getCookieStringSync(here);
      if (next) options.headers.cookie = next;
      else delete options.headers.cookie;
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

module.exports = { withCookieJar };
