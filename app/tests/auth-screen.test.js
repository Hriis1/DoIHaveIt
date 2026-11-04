import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { validateCredentials } from '../src/modules/authValidation.js'

const source = readFileSync(new URL('../src/screens/auth/auth.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace('export function mountAuthScreen', 'function mountAuthScreen')
const settle = () => new Promise(resolve => setImmediate(resolve))

function mount(mode = 'login', signIn = async () => {}) {
  const nodes = new Map()
  const node = selector => {
    if (!nodes.has(selector)) {
      const listeners = new Map()
      nodes.set(selector, {
        value: '', hidden: false, disabled: false, textContent: '', attributes: {},
        addEventListener(event, handler, { signal }) {
          listeners.set(event, handler)
          signal.addEventListener('abort', () => listeners.delete(event), { once: true })
        },
        emit: (event = 'click') => listeners.get(event)?.({ preventDefault() {} }),
        setAttribute(name, value) { this.attributes[name] = value },
        removeAttribute(name) { delete this.attributes[name] }, focus() {}, remove() {},
      })
    }
    return nodes.get(selector)
  }
  const calls = []
  const navigations = []
  let authenticated = 0
  const context = { html: '', AbortController, validateCredentials,
    auth: { signIn: (...args) => { calls.push(args); return signIn(...args) } } }
  runInNewContext(source + '\nthis.mount = mountAuthScreen', context)
  const unmount = context.mount({ querySelector: () => ({ querySelector: node, remove() {} }) }, {
    mode, navigate: name => navigations.push(name), onAuthenticated: () => { authenticated++ },
  })
  return { node, calls, navigations, unmount, get authenticated() { return authenticated },
    fill() {
      node('#auth-email').value = ' User@Example.COM '
      node('#auth-password').value = 'Password!8'
      node('#auth-confirm-password').value = 'Password!8'
    }, submit: () => node('.auth-form').emit('submit') }
}

test('login and registration link to each other and only registration requires confirmation', () => {
  for (const mode of ['login', 'register']) {
    const ui = mount(mode)
    assert.equal(ui.node('.auth-confirm').hidden, mode === 'login')
    assert.equal(ui.node('#auth-confirm-password').required, mode === 'register')
    ui.node('.auth-switch').emit()
    assert.equal(ui.navigations[0], mode === 'login' ? 'register' : 'login')
    ui.unmount()
  }
})

test('empty fields and mismatched confirmation display errors without starting requests', () => {
  const ui = mount('register')
  ui.submit()
  assert.equal(ui.node('#auth-error').textContent, 'Email is required.')
  ui.fill()
  ui.node('#auth-confirm-password').value = 'Different!8'
  ui.submit()
  assert.equal(ui.node('#auth-error').textContent, 'Passwords do not match.')
  assert.equal(ui.calls.length, 0)
  ui.unmount()
})

test('pending forms prevent duplicate requests and navigation; success opens collections and clears secrets', async () => {
  let resolve
  const pending = new Promise(yes => { resolve = yes })
  const ui = mount('login', () => pending)
  ui.fill()
  ui.submit()
  ui.submit()
  ui.node('.auth-switch').emit()
  assert.equal(ui.calls.length, 1)
  assert.equal(ui.navigations.length, 0)
  assert.equal(ui.node('.auth-fields').disabled, true)
  assert.equal(ui.calls[0][0], 'login')
  assert.equal(ui.calls[0][1].email, 'user@example.com')
  assert.deepEqual(Object.keys(ui.calls[0][1]).sort(), ['email', 'password'])
  resolve()
  await settle()
  assert.equal(ui.authenticated, 1)
  assert.deepEqual(ui.navigations, ['collections'])
  assert.equal(ui.node('#auth-password').value, '')
  ui.unmount()
})

test('Worker errors display and permit retry; leaving aborts the request and ignores late responses', async () => {
  let fail = true
  const ui = mount('register', async () => { if (fail) throw new Error('An account with this email already exists.') })
  ui.fill()
  ui.submit()
  await settle()
  assert.equal(ui.node('#auth-error').textContent, 'An account with this email already exists.')
  assert.equal(ui.node('.auth-fields').disabled, false)
  fail = false
  ui.submit()
  await settle()
  assert.equal(ui.calls.length, 2)
  assert.equal(ui.authenticated, 1)
  ui.unmount()

  let resolve
  const pending = new Promise(yes => { resolve = yes })
  const leaving = mount('login', () => pending)
  leaving.fill()
  leaving.submit()
  const signal = leaving.calls[0][2].signal
  leaving.unmount()
  assert.equal(signal.aborted, true)
  assert.equal(leaving.node('#auth-password').value, '')
  resolve()
  await settle()
  assert.equal(leaving.authenticated, 0)
  assert.deepEqual(leaving.navigations, [])
})
