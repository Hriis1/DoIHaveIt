import './catalogs.css'
import html from './catalogs.html?raw'
import { createPopup } from '../../modules/popup.js'
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

  const helpPopup = createPopup(helpDialog, {
    closeButtons: [screen.querySelector('.catalogs-help-close'), screen.querySelector('.catalogs-help-done')],
  })
  const removePopup = createPopup(removeDialog, {
    closeButtons: [...removeDialog.querySelectorAll('[data-popup-close]')],
  })
  const operationPopup = createPopup(operationDialog, {
    closeButtons: [cancel, screen.querySelector('.catalog-operation-close')],
    canClose: () => {
      if (!busy) return true
      requestCancel()
      return false
    },
  })

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
    removePopup.close()
    errorMessage.hidden = true
    busy = true
    controller = new AbortController()
    screen.querySelector('#catalog-operation-title').textContent = entry.name
    cancel.textContent = 'Cancel'
    spinner.hidden = false
    onProgress('preparing')
    operationPopup.open()
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
    if (!busy) operationPopup.close()
    else if (cancellable) {
      onProgress('cancelling')
      controller.abort()
    }
  }

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
        removePopup.open()
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

  listen(screen.querySelector('.catalogs-help'), 'click', () => helpPopup.open())

  return () => {
    active = false
    events.abort()
    helpPopup.destroy()
    operationPopup.destroy()
    removePopup.destroy()
    screen.remove()
  }
}
