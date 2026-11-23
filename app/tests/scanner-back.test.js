import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { registerBackHandler, dismissActiveOverlay } from '../src/modules/navigation.js'

const source = readFileSync(new URL('../src/modules/scan/scan.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace('export function createScanner', 'function createScanner')
const settle = () => new Promise(resolve => setImmediate(resolve))

class Element extends EventTarget {
  open = false
  fields = new Map()
  querySelector(selector) {
    if (!this.fields.has(selector)) this.fields.set(selector, new Element())
    return this.fields.get(selector)
  }
  showModal() { this.open = true }
  close() { this.open = false }
  remove() {}
}

function scanner(startScan = async () => {}) {
  const overlay = new Element()
  const calls = []
  const document = new EventTarget()
  document.createElement = () => ({ content: { firstElementChild: overlay } })
  document.body = { append() {} }
  document.documentElement = { classList: { add() {}, remove() {} } }
  const context = {
    html: '', registerBackHandler, AbortController, setTimeout, clearTimeout, document,
    window: new EventTarget(), Capacitor: { isNativePlatform: () => true }, LensFacing: { Back: 'back' },
    bannerAds: { pause: async () => async () => calls.push('resume banner') },
    BarcodeScanner: {
      isSupported: async () => ({ supported: true }), checkPermissions: async () => ({ camera: 'granted' }),
      addListener: async () => ({ remove: async () => calls.push('remove listener') }),
      startScan, stopScan: async () => calls.push('stop camera'),
    },
  }
  runInNewContext(source + '\nthis.create = createScanner', context)
  const api = context.create({ onScan: () => calls.push('scan'), onError: error => calls.push(error) })
  return { api, overlay, calls }
}

test('Android Back stops the camera, removes scanner listeners and resumes the banner', async () => {
  const ui = scanner()
  ui.api.open()
  await settle()
  assert.equal(ui.overlay.open, true)
  assert.equal(dismissActiveOverlay(), true)
  await settle()
  assert.equal(ui.overlay.open, false)
  assert.deepEqual(ui.calls, ['stop camera', 'remove listener', 'remove listener', 'resume banner'])
  assert.equal(dismissActiveOverlay(), false)
  await ui.api.destroy()
})

test('Back during scanner startup consumes repeated presses until camera cleanup completes', async () => {
  let ready
  const ui = scanner(() => new Promise(resolve => { ready = resolve }))
  ui.api.open()
  await settle()
  assert.equal(dismissActiveOverlay(), true)
  assert.equal(dismissActiveOverlay(), true)
  assert.equal(ui.overlay.open, true)
  ready()
  await settle()
  assert.equal(ui.overlay.open, false)
  assert.equal(ui.calls.filter(call => call === 'stop camera').length, 1)
  assert.equal(dismissActiveOverlay(), false)
  await ui.api.destroy()
})
