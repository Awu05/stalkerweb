// Whether a channel matches what was typed in the Guide's station search:
// part of its name (any case), or the start of its channel number.
export function matchesStation(channel, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return true
  if (/^\d+$/.test(q) && channel.number > 0 && String(channel.number).startsWith(q)) return true
  return String(channel.name ?? '').toLowerCase().includes(q)
}
