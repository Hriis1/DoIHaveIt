import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createPopup } from '../src/modules/popup.js'
import { dismissActiveOverlay } from '../src/modules/navigation.js'

const source = readFileSync(new URL('../src/screens/account/account.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace('export function mountAccountScreen', 'function mountAccountScreen')
const settle = () => new Promise(resolve => setImmediate(resolve))

function mount(remove = async () => {}) {
  const nodes = new Map()
  const node = selector => {
    if (!nodes.has(selector)) {
      const handlers = new Map()
      nodes.set(selector, {
        value: '', textContent: '', hidden: true, open: false, disabled: false,
        addEventListener: (name, handler) => handlers.set(name, handler),
        removeEventListener: name => handlers.delete(name),
        emit(name = 'click', data = {}) { handlers.get(name)?.({ target: this, preventDefault() {}, ...data }) },
        showModal() { this.open = true }, close() { this.open = false; this.emit('close') },
        getBoundingClientRect: () => ({ left: 10, top: 10, right: 400, bottom: 600 }),
        focus() {}, remove() {},
      })
    }
    return nodes.get(selector)
  }
  const navigation = []
  const calls = []
  const context = { html: '', createPopup,
    auth: {
      subscribeCreditBalance: () => () => {},
      refreshCredits: async () => ({ id: 3, email: 'user@example.com', credits: 12 }),
      deleteAccount: async password => { calls.push(password); await remove() },
    },
  }
  runInNewContext(source + '\nthis.mount = mountAccountScreen', context)
  const unmount = context.mount({ querySelector: () => ({ querySelector: node, remove() {} }) }, {
    navigate: (...args) => navigation.push(args),
  })
  return { node, calls, navigation, unmount }
}

test('confirmation requires a password; cancel and Android Back clear it without deleting', async () => {
  const ui = mount()
  await settle()
  ui.node('.account-delete').emit()
  assert.equal(ui.node('.account-delete-dialog').open, true)
  ui.node('.account-delete-form').emit('submit')
  assert.equal(ui.node('.account-delete-error').textContent, 'Enter your password.')
  assert.deepEqual(ui.calls, [])
  ui.node('#account-delete-password').value = 'Secret!123'
  ui.node('.account-delete-cancel').emit()
  assert.equal(ui.node('#account-delete-password').value, '')
  ui.node('.account-delete').emit()
  ui.node('#account-delete-password').value = 'Secret!123'
  dismissActiveOverlay()
  assert.equal(ui.node('.account-delete-dialog').open, false)
  assert.equal(ui.node('#account-delete-password').value, '')
  ui.unmount()
})

test('successful deletion blocks duplicate requests and dismissal until login navigation', async () => {
  let finish
  const ui = mount(() => new Promise(resolve => { finish = resolve }))
  await settle()
  ui.node('.account-delete').emit()
  ui.node('#account-delete-password').value = 'Secret!123'
  ui.node('.account-delete-form').emit('submit')
  ui.node('.account-delete-form').emit('submit')
  ui.node('.account-delete-close').emit()
  dismissActiveOverlay()
  assert.equal(ui.calls.length, 1)
  assert.equal(ui.node('.account-delete-dialog').open, true)
  assert.equal(ui.node('.account-delete-confirm').disabled, true)
  finish()
  await settle()
  assert.deepEqual(ui.navigation, [['login']])
  assert.equal(ui.node('#account-delete-password').value, '')
  ui.unmount()
})

test('failure stays in the popup, clears the password and allows retry', async () => {
  const ui = mount(async () => { throw new Error('Password is incorrect.') })
  await settle()
  ui.node('.account-delete').emit()
  ui.node('#account-delete-password').value = 'Wrong!123'
  ui.node('.account-delete-form').emit('submit')
  await settle()
  assert.equal(ui.node('.account-delete-error').textContent, 'Password is incorrect.')
  assert.equal(ui.node('.account-delete-dialog').open, true)
  assert.equal(ui.node('.account-delete-confirm').disabled, false)
  assert.equal(ui.node('#account-delete-password').value, '')
  assert.deepEqual(ui.navigation, [])
  ui.unmount()
})
