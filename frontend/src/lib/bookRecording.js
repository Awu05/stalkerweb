import { scheduleRecording } from '../stalkerApi'
import { showToast } from './toast'

/**
 * Booked on the server (routes/recordings.js): it records with every app closed. A clash past the
 * provider's stream limit is refused with what it clashes with. One that starts within 5 minutes
 * while the limit is in use (watching, casting) asks first, like Record now in the player.
 * `body`: { channelId, channelName, title, startAt, endAt } (ms). Settles once it's booked or not.
 */
export function bookRecording(body, onDone, force = false) {
  return scheduleRecording({ ...body, ...(force ? { force: true } : {}) })
    .then(() => { showToast(`"${body.title}" will be recorded — see Recordings`); onDone() })
    .catch((e) => {
      if (e.status === 409 && e.body?.takesStream) {
        if (window.confirm(e.message)) return bookRecording(body, onDone, true)
        return
      }
      showToast(e.message, 'error')
    })
}
