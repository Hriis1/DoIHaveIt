import './catalogs.css'
import html from './catalogs.html?raw'
import { Catalog } from '../../modules/catalog/catalog.js'

export function mountCatalogsScreen(container, { isNative = false, databaseReady = Promise.resolve() } = {}) {
  container.innerHTML = html
  const screen = container.querySelector('.catalogs-screen')
  const events = new AbortController()
  const listen = (element, event, handler) => element.addEventListener(event, handler, { signal: events.signal })
  const expand = screen.querySelector('.catalog-expand')
  const description = screen.querySelector('.catalog-description')
  const helpDialog = screen.querySelector('.catalogs-help-dialog')
  const catalog = new Catalog('drinsAndFoodData')
  const action = screen.querySelector('.catalog-download')
  const installedLabel = screen.querySelector('.catalog-installed')
  const operationDialog = screen.querySelector('.catalog-operation-dialog')
  const removeDialog = screen.querySelector('.catalog-remove-dialog')
  const status = screen.querySelector('#catalog-operation-status')
  const cancel = screen.querySelector('.catalog-operation-cancel')
  const spinner = screen.querySelector('.catalog-spinner')
  const errorMessage = screen.querySelector('.catalog-error')
  let active = true
  let installed = false
  let busy = false
  let cancellable = true
  let controller

  function renderInstalled(value) {
    installed = value
    installedLabel.hidden = !value
    action.setAttribute('aria-label', `${value ? 'Remove' : 'Download'} Food & drinks full catalog`)
    action.querySelector('use').setAttribute('href', value ? '#icon-trash' : '#icon-download')
  }

  const phases = {
    preparing: 'Preparing…', downloading: 'Downloading…', importing: 'Importing…',
    removing: 'Removing…', cancelling: 'Cancelling…', rollingBack: 'Reverting changes…',
    finishing: 'Finishing…', complete: 'Complete',
  }

  function onProgress(phase) {
    if (!active) return
    status.textContent = phases[phase] ?? phase
    cancellable = !['finishing', 'cancelling', 'rollingBack', 'complete'].includes(phase)
    cancel.disabled = !cancellable
  }

  async function runOperation(remove) {
    if (busy) return
    removeDialog.close()
    errorMessage.hidden = true
    busy = true
    controller = new AbortController()
    cancel.textContent = 'Cancel'
    spinner.hidden = false
    onProgress('preparing')
    operationDialog.showModal()
    try {
      await databaseReady
      await catalog[remove ? 'down' : 'up']({ signal: controller.signal, onProgress })
      if (!active) return
      renderInstalled(!remove)
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
  listen(action, 'click', () => {
    if (!isNative) {
      errorMessage.textContent = 'Catalogs are available in the Android and iOS app.'
      errorMessage.hidden = false
      return
    }
    if (installed) removeDialog.showModal()
    else runOperation(false)
  })
  listen(screen.querySelector('.catalog-remove-cancel'), 'click', () => removeDialog.close())
  listen(screen.querySelector('.catalog-remove-confirm'), 'click', () => runOperation(true))

  if (isNative) {
    action.disabled = true
    databaseReady.then(() => catalog.getInstalled()).then(value => {
      if (active) renderInstalled(value)
    }).catch(error => {
      if (active) {
        errorMessage.textContent = error.message || 'Could not load installed catalogs.'
        errorMessage.hidden = false
      }
    }).finally(() => { if (active) action.disabled = false })
  }

  listen(expand, 'click', () => {
    const expanded = expand.getAttribute('aria-expanded') !== 'true'
    expand.setAttribute('aria-expanded', String(expanded))
    description.hidden = !expanded
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
    active = false
    events.abort()
    helpDialog.close()
    operationDialog.close()
    removeDialog.close()
    screen.remove()
  }
}
