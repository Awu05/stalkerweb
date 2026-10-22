// Letting go of a <video> when its player goes away (the live and VOD players).
//
// Destroying hls.js / mpegts.js isn't enough: a stream played straight from
// its URL (the "native" engine, progressive files) keeps its source — and its
// connection to the server — until the element is collected, and a play() still
// on its way (the muted-autoplay retry) can start a video no longer on the page:
// sound with nothing to see. So: pause, drop the source, and load() the empty
// element, which closes the connection.
/**
 * A <video> about to play a plain link (its own HLS, a file): AirPlay may send
 * it. On an iPhone hls.js and mpegts.js turn remote playback off (Apple's
 * managed media source needs it) and never turn it back on — left off, the
 * AirPlay picker only offers audio routes. Every plain-link path calls this.
 */
export function allowRemotePlayback(video) {
  if (video) video.disableRemotePlayback = false
}

export function releaseMedia(video) {
  if (!video) return
  try {
    video.pause()
    video.removeAttribute('src')
    video.load()
  } catch { /* the element is already gone */ }
}
