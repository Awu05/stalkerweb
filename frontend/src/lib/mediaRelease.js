// Letting go of a <video> when its player goes away (the live and VOD players).
//
// Destroying hls.js / mpegts.js isn't enough: a stream played straight from
// its URL (the "native" engine, progressive files) keeps its source — and its
// connection to the server — until the element is collected, and a play() still
// on its way (the muted-autoplay retry) can start a video no longer on the page:
// sound with nothing to see. So: pause, drop the source, and load() the empty
// element, which closes the connection.
export function releaseMedia(video) {
  if (!video) return
  try {
    video.pause()
    video.removeAttribute('src')
    video.load()
  } catch { /* the element is already gone */ }
}
