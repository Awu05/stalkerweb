// The admin: one profile (at first the first one; marked `admin` in GET
// /api/viewers). It may delete anyone's recordings, and it can't be deleted
// itself — nor can the Default (`isDefault`: devices that pick no profile use
// it), nor the last one. Only the admin makes someone else the admin, from a
// device that sends its profile (viewers/ViewersManager.js).

/** Whether Settings offers to delete profile `v`. */
export function canRemoveViewer(v, viewers) {
  return !v.admin && !v.isDefault && viewers.length > 1
}

/** Whether Settings offers to make profile `v` the admin: only to the admin, for someone else. `meId`: the profile this device sends (none: not offered). */
export function canMakeAdmin(v, viewers, meId) {
  return !v.admin && !!viewers.find((x) => x.id === meId)?.admin
}
