import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

mock.module('@capacitor/core', { namedExports: { Capacitor: {} } })
mock.module('@capacitor/app', { namedExports: { App: {} } })
mock.module('@capacitor-community/admob', { namedExports: {
  AdMob: {}, BannerAdPluginEvents: { SizeChanged: 'size', FailedToLoad: 'failed' },
  BannerAdPosition: { TOP_CENTER: 'top' }, BannerAdSize: { ADAPTIVE_BANNER: 'adaptive' },
} })
const { createBannerAds } = await import('../src/modules/bannerAds.js')

function setup(platform = 'android') {
  const events = new Map()
  const heights = []
  const requests = []
  let initializations = 0
  let fail = false
  let removed = 0
  let bannersRemoved = 0
  const listen = async (event, handler) => {
    events.set(event, handler)
    return { remove: async () => { removed++ } }
  }
  const app = { addListener: listen }
  const ads = {
    addListener: listen,
    initialize: async () => { initializations++; if (fail) throw new Error('Unavailable') },
    showBanner: async options => { requests.push(options) },
    removeBanner: async () => { bannersRemoved++ },
  }
  const banner = createBannerAds({ capacitor: { getPlatform: () => platform }, app, ads,
    setHeight: height => heights.push(height), warn() {} })
  return { banner, app, ads, events, heights, requests, fail: value => { fail = value },
    initializations: () => initializations, removed: () => removed, bannersRemoved: () => bannersRemoved }
}

test('one shared Android banner uses test ads and the native height', async () => {
  const state = setup()
  await Promise.all([state.banner.setEnabled(true), state.banner.setEnabled(true)])
  assert.equal(state.initializations(), 1)
  assert.equal(state.requests.length, 1)
  assert.deepEqual(state.requests[0], { adId: 'ca-app-pub-8348138565431475/5548456015',
    isTesting: true, adSize: 'adaptive', position: 'top', margin: 0 })
  state.events.get('size')({ height: 60 })
  state.events.get('appStateChange')({ isActive: true })
  assert.equal(state.requests.length, 1)
  state.events.get('size')({ height: NaN })
  assert.deepEqual(state.heights, [60, 0])
})

test('load failures release space and retry on foreground without reinitializing', async () => {
  const state = setup()
  await state.banner.setEnabled(true)
  state.events.get('size')({ height: 60 })
  state.events.get('failed')({ message: 'No fill' })
  assert.equal(state.heights.at(-1), 0)
  state.events.get('appStateChange')({ isActive: false })
  assert.equal(state.requests.length, 1)
  state.events.get('appStateChange')({ isActive: true })
  assert.equal(state.requests.length, 2)
  assert.equal(state.initializations(), 1)
})

test('initialization failures do not reject startup and can recover', async () => {
  const state = setup()
  state.fail(true)
  await state.banner.setEnabled(true)
  assert.equal(state.requests.length, 0)
  assert.equal(state.heights.at(-1), 0)
  state.fail(false)
  state.events.get('appStateChange')({ isActive: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.requests.length, 1)
  assert.equal(state.initializations(), 2)
})

test('listener failures remove partial subscriptions and do not load ads', async () => {
  const state = setup()
  state.app.addListener = async () => { throw new Error('Unavailable') }
  await state.banner.setEnabled(true)
  assert.equal(state.removed(), 2)
  assert.equal(state.requests.length, 0)
})

test('browser and unconfigured iOS do not initialize native ads', async () => {
  for (const platform of ['web', 'ios']) {
    const state = setup(platform)
    await state.banner.setEnabled(true)
    assert.equal(state.initializations(), 0)
    assert.equal(state.events.size, 0)
  }
})

test('auth screens remove the banner and ignore late size and foreground events', async () => {
  const state = setup()
  await state.banner.setEnabled(false)
  assert.equal(state.initializations(), 0)
  await state.banner.setEnabled(true)
  state.events.get('size')({ height: 60 })
  await state.banner.setEnabled(false)
  assert.equal(state.bannersRemoved(), 1)
  state.events.get('size')({ height: 60 })
  state.events.get('appStateChange')({ isActive: true })
  assert.equal(state.heights.at(-1), 0)
  assert.equal(state.requests.length, 1)
  await state.banner.setEnabled(true)
  assert.equal(state.requests.length, 2)
  assert.equal(state.initializations(), 1)
})

test('leaving during banner initialization prevents the request', async () => {
  const state = setup()
  let finish
  state.ads.initialize = () => new Promise(resolve => { finish = resolve })
  const showing = state.banner.setEnabled(true)
  await new Promise(resolve => setImmediate(resolve))
  const hiding = state.banner.setEnabled(false)
  finish()
  await Promise.all([showing, hiding])
  assert.equal(state.requests.length, 0)
  assert.equal(state.heights.at(-1), 0)
})

test('scanner pauses suppress ads until all scanners close and preserve auth exclusions', async () => {
  const state = setup()
  await state.banner.setEnabled(true)
  state.events.get('size')({ height: 60 })
  const resume = await state.banner.pause()
  assert.equal(state.bannersRemoved(), 1)
  assert.equal(state.heights.at(-1), 0)
  state.events.get('appStateChange')({ isActive: true })
  assert.equal(state.requests.length, 1)
  const resumeSecond = await state.banner.pause()
  await resume()
  assert.equal(state.requests.length, 1)
  await resumeSecond()
  assert.equal(state.requests.length, 2)
  await resumeSecond()
  assert.equal(state.requests.length, 2)
  const resumeBeforeLogin = await state.banner.pause()
  await state.banner.setEnabled(false)
  await resumeBeforeLogin()
  assert.equal(state.requests.length, 2)
})
