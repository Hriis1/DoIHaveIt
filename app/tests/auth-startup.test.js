import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace('export function showScreen', 'function showScreen')
const settle = () => new Promise(resolve => setImmediate(resolve))

function mount(restoreSession) {
  const nodes = new Map()
  function node(selector) {
    if (!nodes.has(selector)) {
      const handlers = new Map()
      nodes.set(selector, { dataset: {}, hidden: false, disabled: false, open: false, textContent: '',
        addEventListener: (name, handler) => handlers.set(name, handler),
        emit: (name = 'click') => handlers.get(name)?.({}),
        querySelector: node, querySelectorAll: () => [], contains: () => false, focus() {} })
    }
    return nodes.get(selector)
  }
  const mounts = []
  const screen = name => (_container, options) => { mounts.push({ name, options }); return () => {} }
  const context = {
    document: { querySelector: node, addEventListener() {} }, window: { scrollTo() {} },
    Capacitor: { isNativePlatform: () => false }, auth: { restoreSession },
    mountCollectionsScreen: screen('collections'), mountCollectionScreen: screen('collection'),
    mountCatalogsScreen: screen('catalogs'), mountProductsScreen: screen('products'),
    mountAiProviderScreen: screen('ai-provider'), mountAuthScreen: screen('auth'),
    mountAccountScreen: screen('account'),
  }
  runInNewContext(source + '\nthis.show = showScreen', context)
  return { node, mounts, show: context.show }
}

test('startup requires login without a session and gates the app shell until authentication succeeds', async () => {
  const app = mount(async () => ({ state: 'login' }))
  await settle()
  assert.equal(app.mounts.at(-1).options.mode, 'login')
  assert.equal(app.node('.app-menu').hidden, true)
  assert.equal(app.node('.brand').disabled, true)
  app.show('collections')
  assert.equal(app.mounts.length, 1)
  app.mounts[0].options.onAuthenticated()
  app.mounts[0].options.navigate('collections')
  assert.equal(app.mounts.at(-1).name, 'collections')
  assert.equal(app.node('.app-menu').hidden, false)
})

test('authenticated and offline cached sessions open collections directly', async () => {
  for (const state of ['authenticated', 'offline']) {
    const app = mount(async () => ({ state }))
    await settle()
    assert.equal(app.mounts.at(-1).name, 'collections')
  }
})

test('startup errors offer retry or login without clearing local data', async () => {
  let fail = true
  const app = mount(async () => {
    if (fail) throw new Error('Could not connect.')
    return { state: 'authenticated' }
  })
  await settle()
  assert.equal(app.node('.error').textContent, 'Could not connect.')
  assert.equal(app.mounts.length, 0)
  fail = false
  app.node('.auth-retry').emit()
  await settle()
  assert.equal(app.mounts.at(-1).name, 'collections')
})
