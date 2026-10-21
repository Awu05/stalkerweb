// Casting from the web players: Chromecast (Google's Cast SDK, in Chrome and
// Edge — on a secure page only) and AirPlay (Safari's own picker). The TV opens
// the stream itself, so it gets a cast link from the server (api/stream/:id/cast,
// api/vod/cast): under the playback-only share token, live channels as HLS.

const CAST_SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'

/** Chrome or Edge (not on iOS), on https or localhost: the Cast SDK only works there. */
export function chromecastSupported(win = globalThis.window) {
  if (!win) return false
  const ua = win.navigator?.userAgent || ''
  return !!win.chrome && win.isSecureContext === true && !/iPhone|iPad|iPod/i.test(ua)
}

/** Safari with AirPlay (the playback-target picker on <video>). */
export function airplaySupported(win = globalThis.window) {
  return !!win?.WebKitPlaybackTargetAvailabilityEvent
}

let sdkPromise = null
/** Google's Cast SDK, loaded once (resolves false when it can't be). */
export function loadCastSdk(win = globalThis.window) {
  if (!chromecastSupported(win)) return Promise.resolve(false)
  if (sdkPromise) return sdkPromise
  sdkPromise = new Promise((resolve) => {
    if (win.cast?.framework) return resolve(true)
    win.__onGCastApiAvailable = (ok) => resolve(!!ok && !!win.cast?.framework)
    const s = win.document.createElement('script')
    s.src = CAST_SDK
    s.async = true
    s.onerror = () => resolve(false)
    win.document.head.appendChild(s)
  })
  return sdkPromise
}

/**
 * What the TV is sent for a cast link: { url, contentType, live, title,
 * subtitle, image, startSecs }. Throws when the link can't be opened by a TV
 * (the app was opened on localhost).
 */
export function castRequestOf(link, { title = '', subtitle = '', image = '', startSecs = 0 } = {}) {
  if (!link?.url) throw new Error("The server didn't give a link to cast")
  if (link.reachable === false) {
    throw new Error("The TV can't reach this address — open StalkerWeb by its network address (not localhost) to cast")
  }
  return {
    url: link.url,
    contentType: link.contentType || 'video/mp4',
    live: !!link.live,
    title,
    subtitle,
    // A TV fetches the picture itself: only an address it can open.
    image: /^https?:\/\//i.test(image) && !/^https?:\/\/(localhost|127\.)/i.test(image) ? image : '',
    startSecs: link.live ? 0 : Math.max(0, Number(startSecs) || 0),
  }
}

/**
 * Where the page picks a movie up once casting ends: where the TV got to — or
 * null (stay put) when it hadn't started, or was in its last 5%.
 */
export function resumeAfterCast(timeSecs, durationSecs) {
  if (!(timeSecs > 0)) return null
  if (durationSecs > 0 && timeSecs >= durationSecs * 0.95) return null
  return timeSecs
}
