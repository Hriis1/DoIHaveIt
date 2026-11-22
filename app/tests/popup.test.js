import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPopup } from '../src/modules/popup.js'

class Dialog extends EventTarget {
  open = false
  content = 'Caller-supplied content'
  showModal() { this.open = true }
  close() { this.open = false; this.dispatchEvent(new Event('close')) }
  getBoundingClientRect() { return { left: 10, top: 10, right: 100, bottom: 100 } }
  emit(type, coordinates = {}) {
    const event = new Event(type, { cancelable: true })
    Object.assign(event, coordinates)
    this.dispatchEvent(event)
    return event
  }
}

test('close buttons preserve caller content and notify once per opening', () => {
  const dialog = new Dialog()
  const button = new EventTarget()
  let closed = 0
  const popup = createPopup(dialog, { closeButtons: [button], onClose: () => closed++ })
  popup.open()
  popup.open()
  button.dispatchEvent(new Event('click'))
  popup.close()
  assert.equal(dialog.open, false)
  assert.equal(closed, 1)
  assert.equal(dialog.content, 'Caller-supplied content')
  popup.open()
  dialog.close()
  assert.equal(closed, 2)
  popup.destroy()
})

test('only a tap starting and ending on the backdrop dismisses the popup', () => {
  const dialog = new Dialog()
  const popup = createPopup(dialog)
  popup.open()
  dialog.emit('pointerdown', { clientX: 50, clientY: 50 })
  dialog.emit('click', { clientX: 0, clientY: 0 })
  assert.equal(dialog.open, true)
  dialog.emit('pointerdown', { clientX: 0, clientY: 0 })
  dialog.emit('click', { clientX: 50, clientY: 50 })
  assert.equal(dialog.open, true)
  dialog.emit('pointerdown', { clientX: 0, clientY: 0 })
  dialog.emit('click', { clientX: 0, clientY: 0 })
  assert.equal(dialog.open, false)
  popup.destroy()
})

test('saving guards block buttons, backdrop and native cancel dismissal', () => {
  const dialog = new Dialog()
  const button = new EventTarget()
  let saving = true
  const popup = createPopup(dialog, { closeButtons: [button], canClose: () => !saving })
  popup.open()
  button.dispatchEvent(new Event('click'))
  dialog.emit('pointerdown', { clientX: 0, clientY: 0 })
  dialog.emit('click', { clientX: 0, clientY: 0 })
  assert.equal(dialog.emit('cancel').defaultPrevented, true)
  assert.equal(dialog.open, true)
  saving = false
  dialog.emit('cancel')
  assert.equal(dialog.open, false)
  popup.destroy()
})

test('callers can consume cancel to close a dropdown before dismissing the popup', () => {
  const dialog = new Dialog()
  let dropdownOpen = true
  const popup = createPopup(dialog, { onCancel: () => {
    if (dropdownOpen) { dropdownOpen = false; return false }
  } })
  popup.open()
  dialog.emit('cancel')
  assert.equal(dialog.open, true)
  dialog.emit('cancel')
  assert.equal(dialog.open, false)
  popup.destroy()
})

test('destroy closes even while saving and removes listeners without repeated cleanup', () => {
  const dialog = new Dialog()
  const button = new EventTarget()
  let closed = 0
  let guards = 0
  const popup = createPopup(dialog, {
    closeButtons: [button], canClose: () => { guards++; return false }, onClose: () => closed++,
  })
  popup.open()
  popup.destroy()
  popup.destroy()
  popup.open()
  button.dispatchEvent(new Event('click'))
  assert.equal(dialog.open, false)
  assert.equal(closed, 1)
  assert.equal(guards, 0)
  assert.equal(dialog.emit('cancel').defaultPrevented, false)
})
