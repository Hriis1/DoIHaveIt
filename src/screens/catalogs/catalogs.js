import './catalogs.css'
import html from './catalogs.html?raw'

export function mountCatalogsScreen(container) {
  container.innerHTML = html
  const screen = container.querySelector('.catalogs-screen')
  const events = new AbortController()
  const listen = (element, event, handler) => element.addEventListener(event, handler, { signal: events.signal })
  const expand = screen.querySelector('.catalog-expand')
  const description = screen.querySelector('.catalog-description')
  const download = screen.querySelector('.catalog-download')
  const helpDialog = screen.querySelector('.catalogs-help-dialog')
  let highlightTimeout

  listen(expand, 'click', () => {
    const expanded = expand.getAttribute('aria-expanded') !== 'true'
    expand.setAttribute('aria-expanded', String(expanded))
    description.hidden = !expanded
  })

  // Acknowledge clicks
  listen(download, 'click', () => {
    clearTimeout(highlightTimeout)
    download.classList.add('is-clicked')
    highlightTimeout = setTimeout(() => download.classList.remove('is-clicked'), 600)
  })

  listen(screen.querySelector('.catalogs-help'), 'click', () => helpDialog.showModal())
  listen(screen.querySelector('.catalogs-help-close'), 'click', () => helpDialog.close())
  listen(screen.querySelector('.catalogs-help-done'), 'click', () => helpDialog.close())

  // Match the other screens' backdrop dismissal without closing on drags from inside
  let startedOutside = false
  const isOutside = event => {
    const bounds = helpDialog.getBoundingClientRect()
    return event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom
  }
  listen(helpDialog, 'pointerdown', event => {
    startedOutside = event.target === helpDialog && isOutside(event)
  })
  listen(helpDialog, 'click', event => {
    if (startedOutside && event.target === helpDialog && isOutside(event)) helpDialog.close()
    startedOutside = false
  })

  return () => {
    events.abort()
    clearTimeout(highlightTimeout)
    helpDialog.close()
    screen.remove()
  }
}
