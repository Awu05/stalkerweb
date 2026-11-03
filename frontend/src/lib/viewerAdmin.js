// The admin: one profile (at first the first one; marked `admin` in GET
// /api/viewers). It may delete anyone's recordings, and it can't be deleted
// itself — nor can the last profile. Only the admin makes someone else the
// admin (viewers/ViewersManager.js).

/** Whether Settings offers to delete profile `v`. */
export function canRemoveViewer(v, viewers) {
  return !v.admin && viewers.length > 1
}

/** Whether Settings offers to make profile `v` the admin: only to the admin (`meId`), for someone else. */
export function canMakeAdmin(v, viewers, meId) {
  return !v.admin && !!viewers.find((x) => x.id === meId)?.admin
}
