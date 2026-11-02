// The admin: the first profile (the server's default viewer, marked `admin` in
// GET /api/viewers). It may delete anyone's recordings, and it can't be
// deleted itself — nor can the last profile (viewers/ViewersManager.js).

/** Whether Settings offers to delete profile `v`. */
export function canRemoveViewer(v, viewers) {
  return !v.admin && viewers.length > 1
}
