import { registerBackHandler } from './navigation.js'

// The caller supplies the dialog content and any screen-specific closing rules.
export function createPopup(dialog, { closeButtons = [], canClose = () => true, onClose = () => {}, onCancel } = {}) {
  const listeners = []
  let startedOutside = false
  let disposed = false
  let notified = true
  let releaseBack
  const listen = (element, event, handler) => {
    element.addEventListener(event, handler)
    listeners.push(() => element.removeEventListener(event, handler))
  }

  function close() {
    if (disposed || !dialog.open || !canClose()) return
    dialog.close()
    notifyClosed()
  }

  function notifyClosed() {
    if (notified || dialog.open) return
    notified = true
    releaseBack?.()
    releaseBack = undefined
    onClose()
  }

  function cancel() {
    if (onCancel?.() !== false) close()
  }

  listen(dialog, 'close', notifyClosed)

  const isOutside = event => {
    const bounds = dialog.getBoundingClientRect()
    return event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom
  }

  // A drag beginning inside the popup must not dismiss it on release outside.
  listen(dialog, 'pointerdown', event => {
    startedOutside = event.target === dialog && isOutside(event)
  })
  listen(dialog, 'click', event => {
    const dismiss = startedOutside && event.target === dialog && isOutside(event)
    startedOutside = false
    if (dismiss) close()
  })
  listen(dialog, 'cancel', event => {
    event.preventDefault()
    cancel()
  })
  for (const button of closeButtons) listen(button, 'click', close)

  return {
    open() {
      if (disposed || dialog.open) return
      startedOutside = false
      notified = false
      dialog.showModal()
      releaseBack = registerBackHandler(cancel)
    },
    close,
    destroy() {
      if (disposed) return
      disposed = true
      releaseBack?.()
      releaseBack = undefined
      for (const remove of listeners) remove()
      if (dialog.open) {
        dialog.close()
        notifyClosed()
      }
    },
  }
}
