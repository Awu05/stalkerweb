import { useEffect } from 'react'

// One tooltip for the whole site, in the theme's style (.app-tooltip in
// index.css): a button's name when the pointer rests on it or the keyboard
// reaches it. Mounted once (App.jsx); every button with a name gets it — its
// title, or its aria-label when it shows no text of its own (an icon). The
// button's attributes stay React's: only while the pointer is on it is its
// title set aside (so the browser's own tooltip doesn't show as well), and
// it's put back as soon as the pointer leaves. The apps' TipIconButton does
// the same. buttons.test.js keeps every icon button named.

const DELAY_MS = 500
const TARGET = 'button, [role="button"], a[href]'

// A button's tooltip: its title, else its aria-label when it shows no text.
function tipOf(el) {
  const title = el.getAttribute('title')
  if (title) return title
  const label = el.getAttribute('aria-label')
  return label && !el.textContent.trim() ? label : ''
}

// The title set aside while the pointer is on its button, and the button.
let setAside = null
function putBack() {
  if (setAside && !setAside.el.hasAttribute('title')) setAside.el.setAttribute('title', setAside.title)
  setAside = null
}

export default function TooltipLayer() {
  useEffect(() => {
    const tip = document.createElement('div')
    tip.className = 'app-tooltip'
    tip.setAttribute('role', 'tooltip')
    tip.hidden = true
    let timer = null
    let current = null

    // Above the button, or below it at the top of the screen; never off the side.
    // In the element shown full screen when there is one (the player): nothing else shows then.
    const place = (el) => {
      const host = document.fullscreenElement || document.body
      if (tip.parentNode !== host) host.appendChild(tip)
      tip.hidden = false
      const r = el.getBoundingClientRect()
      const w = tip.offsetWidth
      const h = tip.offsetHeight
      const top = r.top - h - 8 >= 4 ? r.top - h - 8 : r.bottom + 8
      const left = Math.max(4, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 4))
      tip.style.top = `${top}px`
      tip.style.left = `${left}px`
    }
    const show = (el, byPointer) => {
      const text = tipOf(el)
      if (!text) return
      putBack()
      // Under the pointer, the browser would show its own tooltip from the title too.
      if (byPointer && el.hasAttribute('title')) { setAside = { el, title: el.getAttribute('title') }; el.removeAttribute('title') }
      clearTimeout(timer)
      current = el
      timer = setTimeout(() => {
        if (current !== el || !el.isConnected) return
        tip.textContent = text
        place(el)
      }, DELAY_MS)
    }
    const hide = () => {
      clearTimeout(timer)
      current = null
      tip.hidden = true
      putBack()
    }

    const onOver = (e) => {
      if (e.pointerType === 'touch') return   // a tap is a press, not a rest
      const el = e.target.closest?.(TARGET)
      if (el && el !== current) show(el, true)
    }
    const onOut = (e) => {
      if (current && !current.contains(e.relatedTarget)) hide()
    }
    // The keyboard (and a TV remote) reaching a button — not a click's focus.
    const onFocus = (e) => {
      const el = e.target.closest?.(TARGET)
      if (el && el.matches(':focus-visible')) show(el, false)
    }
    const onKey = (e) => { if (e.key === 'Escape') hide() }

    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerout', onOut)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', hide)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', hide, true)
    return () => {
      hide()
      tip.remove()
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerout', onOut)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', hide, true)
    }
  }, [])
  return null
}
