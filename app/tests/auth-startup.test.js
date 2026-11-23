import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createNavigation, dismissActiveOverlay, registerBackHandler } from '../src/modules/navigation.js'

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace('export function showScreen', 'function showScreen')
const settle = () => new Promise(resolve => setImmediate(resolve))

function mount(restoreSession, platform = 'web') {
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
  const bannerVisibility = []
  let creditListener
  const nativeEvents = new Map()
  let exits = 0
  const screen = name => (_container, options) => { mounts.push({ name, options }); return () => {} }
  const context = {
    createNavigation, dismissActiveOverlay,
    App: { addListener: async (name, handler) => { nativeEvents.set(name, handler); return { remove() {} } },
      exitApp: async () => { exits++ } },
    initializeDatabase: async () => ({}), prepareCatalogCache: async () => {}, preparePhotoCache: async () => {},
    bannerAds: { setEnabled: async value => bannerVisibility.push(value) },
    document: { querySelector: node, addEventListener() {} }, window: { scrollTo() {} },
    Capacitor: { isNativePlatform: () => platform !== 'web', getPlatform: () => platform }, auth: { restoreSession, subscribeCreditBalance(listener) { creditListener = listener } },
    mountCollectionsScreen: screen('collections'), mountCollectionScreen: screen('collection'),
    mountCatalogsScreen: screen('catalogs'), mountProductsScreen: screen('products'),
    mountAiProviderScreen: screen('ai-provider'), mountAuthScreen: screen('auth'),
    mountAccountScreen: screen('account'),
    mountAddCreditScreen: screen('add-credit'),
  }
  runInNewContext(source + '\nthis.show = showScreen', context)
  return { node, mounts, bannerVisibility, show: context.show, updateCredits: user => creditListener(user),
    nativeEvents, exits: () => exits, back: () => mounts.at(-1).options.goBack() }
}

test('startup requires login without a session and gates the app shell until authentication succeeds', async () => {
  const app = mount(async () => ({ state: 'login' }))
  await settle()
  assert.equal(app.mounts.at(-1).options.mode, 'login')
  assert.equal(app.node('.app-menu').hidden, true)
  assert.equal(app.node('.brand').disabled, true)
  assert.equal(app.bannerVisibility.at(-1), false)
  app.show('register')
  assert.equal(app.bannerVisibility.at(-1), false)
  app.show('login')
  app.show('collections')
  assert.equal(app.mounts.length, 3)
  app.mounts[0].options.onAuthenticated()
  app.mounts[0].options.navigate('collections')
  assert.equal(app.mounts.at(-1).name, 'collections')
  assert.equal(app.node('.app-menu').hidden, false)
  assert.equal(app.bannerVisibility.at(-1), true)
})

test('authenticated and offline cached sessions open collections directly', async () => {
  for (const state of ['authenticated', 'offline']) {
    const app = mount(async () => ({ state, user: { credits: 12 } }))
    await settle()
    assert.equal(app.mounts.at(-1).name, 'collections')
    assert.equal(app.node('.credit-amount').textContent, '12')
    app.updateCredits({ credits: 2 })
    assert.equal(app.node('.credit-amount').textContent, '2')
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

test('the add-credit route uses the authenticated app shell', async () => {
  const app = mount(async () => ({ state: 'authenticated', user: { credits: 10 } }))
  await settle()
  app.show('add-credit')
  assert.equal(app.mounts.at(-1).name, 'add-credit')
  assert.equal(app.node('#app').dataset.screen, 'add-credit')
  assert.equal(app.node('.app-menu').hidden, false)
  assert.equal(app.bannerVisibility.at(-1), true)
})

test('Android Back restores collection parameters, closes menus first and leaves only at the root', async () => {
  const app = mount(async () => ({ state: 'authenticated', user: { credits: 10 } }), 'android')
  await settle()
  const back = app.nativeEvents.get('backButton')
  assert.equal(typeof back, 'function')
  const collection = { id: 7, name: 'Drinks' }
  app.show('collection', { collection })
  app.show('add-credit')
  app.node('.app-menu').open = true
  back()
  assert.equal(app.node('.app-menu').open, false)
  assert.equal(app.mounts.at(-1).name, 'add-credit')
  let dismissals = 0
  const release = registerBackHandler(() => dismissals++)
  back()
  assert.equal(dismissals, 1)
  assert.equal(app.mounts.at(-1).name, 'add-credit')
  release()
  back()
  assert.equal(app.mounts.at(-1).name, 'collection')
  assert.equal(app.mounts.at(-1).options.collection.id, 7)
  assert.equal(app.exits(), 0)
  back()
  assert.equal(app.mounts.at(-1).name, 'collections')
  back()
  assert.equal(app.exits(), 1)
})

test('authentication clears login/register history and returning home clears protected history', async () => {
  const app = mount(async () => ({ state: 'login' }), 'android')
  await settle()
  app.show('register')
  app.back()
  assert.equal(app.mounts.at(-1).options.mode, 'login')
  app.show('register')
  app.mounts.at(-1).options.onAuthenticated({ credits: 0 })
  app.show('collections')
  app.back()
  assert.equal(app.exits(), 1)
  assert.equal(app.mounts.at(-1).name, 'collections')
  app.show('account')
  app.node('.credit-badge').emit()
  app.back()
  assert.equal(app.mounts.at(-1).name, 'account')
  app.node('.brand').emit()
  app.back()
  assert.equal(app.exits(), 2)
})

test('iOS uses shared history without registering Android Back or exiting the app', async () => {
  const app = mount(async () => ({ state: 'authenticated', user: { credits: 0 } }), 'ios')
  await settle()
  assert.equal(app.nativeEvents.has('backButton'), false)
  app.show('account')
  app.back()
  assert.equal(app.mounts.at(-1).name, 'collections')
  app.back()
  assert.equal(app.exits(), 0)
})
