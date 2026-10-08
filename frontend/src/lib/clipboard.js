// Copy text to the clipboard. Returns true on success.
//
// navigator.clipboard only exists in a secure context (HTTPS or localhost).
// StalkerWeb is usually opened over plain HTTP on a LAN address
// (http://192.168.x.x:8983), where it is undefined — so fall back to the
// legacy execCommand('copy') on a temporary textarea, which browsers still
// allow on HTTP during a user gesture.
export async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* permission denied — try the legacy path */ }
  }

  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  // Off-screen but still selectable; position:fixed avoids scrolling the page.
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '-9999px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  const prevFocus = document.activeElement
  ta.select()
  ta.setSelectionRange(0, text.length) // iOS ignores select() alone
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(ta)
  prevFocus?.focus?.()
  return ok
}
