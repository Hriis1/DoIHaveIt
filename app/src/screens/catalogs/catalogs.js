import './catalogs.css'
import html from './catalogs.html?raw'
import { Catalog } from '../../modules/catalog/catalog.js'

export function mountCatalogsScreen(container, { isNative = false, databaseReady = Promise.resolve() } = {}) {
  container.innerHTML = html
  const screen = container.querySelector('.catalogs-screen')
  const events = new AbortController()
  const listen = (element, event, handler) => element.addEventListener(event, handler, { signal: events.signal })
  const helpDialog = screen.querySelector('.catalogs-help-dialog')
  const catalogs = [...screen.querySelectorAll('.catalog-card')].map(card => ({
    card,
    catalog: new Catalog(card.dataset.catalog),
    compressed: card.dataset.compressed === 'true',
    name: card.querySelector('.catalog-name').textContent,
    action: card.querySelector('.catalog-download'),
    installedLabel: card.querySelector('.catalog-installed'),
    installed: false,
  }))
  const operationDialog = screen.querySelector('.catalog-operation-dialog')
  const removeDialog = screen.querySelector('.catalog-remove-dialog')
  const status = screen.querySelector('#catalog-operation-status')
  const cancel = screen.querySelector('.catalog-operation-cancel')
  const spinner = screen.querySelector('.catalog-spinner')
  const errorMessage = screen.querySelector('.catalog-error')
  let active = true
  let selectedCatalog
  let busy = false
  let cancellable = true
  let controller

  function renderInstalled(entry, value) {
    entry.installed = value
    entry.installedLabel.hidden = !value
    entry.action.setAttribute('aria-label', `${value ? 'Remove' : 'Download'} ${entry.name} catalog`)
    entry.action.querySelector('use').setAttribute('href', value ? '#icon-trash' : '#icon-download')
  }

  const phases = {
    preparing: 'Preparing…', downloading: 'Downloading…', importing: 'Importing…',
    decompressing: 'Decompressing…', checking: 'Checking catalog…',
    removing: 'Removing…', cancelling: 'Cancelling…', rollingBack: 'Reverting changes…',
    finishing: 'Finishing…', complete: 'Complete',
  }

  function onProgress(phase) {
    if (!active) return
    status.textContent = phases[phase] ?? phase
    cancellable = !['finishing', 'cancelling', 'rollingBack', 'complete'].includes(phase)
    cancel.disabled = !cancellable
  }

  async function runOperation(entry, remove) {
    if (busy) return
    removeDialog.close()
    errorMessage.hidden = true
    busy = true
    controller = new AbortController()
    screen.querySelector('#catalog-operation-title').textContent = entry.name
    cancel.textContent = 'Cancel'
    spinner.hidden = false
    onProgress('preparing')
    operationDialog.showModal()
    try {
      await databaseReady
      await entry.catalog[remove ? 'down' : 'up']({ signal: controller.signal, onProgress, compressed: entry.compressed })
      if (!active) return
      renderInstalled(entry, !remove)
      status.textContent = remove ? 'Catalog removed.' : 'Catalog added.'
    } catch (error) {
      if (active) status.textContent = error.name === 'AbortError' ? 'Cancelled. No changes were saved.' : error.message || 'The catalog operation failed.'
    } finally {
      busy = false
      if (active) {
        spinner.hidden = true
        cancel.textContent = 'Done'
        cancel.disabled = false
      }
    }
  }

  function requestCancel() {
    if (!busy) operationDialog.close()
    else if (cancellable) {
      onProgress('cancelling')
      controller.abort()
    }
  }

  listen(cancel, 'click', requestCancel)
  listen(operationDialog, 'cancel', event => {
    event.preventDefault()
    requestCancel()
  })
  listen(screen.querySelector('.catalog-remove-cancel'), 'click', () => removeDialog.close())
  listen(screen.querySelector('.catalog-remove-confirm'), 'click', () => runOperation(selectedCatalog, true))

  for (const entry of catalogs) {
    listen(entry.action, 'click', () => {
      if (busy) return
      if (!isNative) {
        errorMessage.textContent = 'Catalogs are available in the Android and iOS app.'
        errorMessage.hidden = false
        return
      }
      selectedCatalog = entry
      if (entry.installed) {
        screen.querySelector('#catalog-remove-description').textContent = `Remove ${entry.name}? Products already used in your collections will be kept.`
        removeDialog.showModal()
      } else runOperation(entry, false)
    })

    if (isNative) {
      entry.action.disabled = true
      databaseReady.then(() => entry.catalog.getInstalled()).then(value => {
        if (active) renderInstalled(entry, value)
      }).catch(error => {
        if (active) {
          errorMessage.textContent = error.message || 'Could not load installed catalogs.'
          errorMessage.hidden = false
        }
      }).finally(() => { if (active) entry.action.disabled = false })
    }

    const expand = entry.card.querySelector('.catalog-expand')
    const description = entry.card.querySelector('.catalog-description')
    listen(expand, 'click', () => {
      const expanded = expand.getAttribute('aria-expanded') !== 'true'
      expand.setAttribute('aria-expanded', String(expanded))
      description.hidden = !expanded
    })
  }

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
    active = false
    events.abort()
    helpDialog.close()
    operationDialog.close()
    removeDialog.close()
    screen.remove()
  }
}
