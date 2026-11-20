import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

mock.module('@capacitor/core', { namedExports: { Capacitor: {} } })
mock.module('@revenuecat/purchases-capacitor', { namedExports: { Purchases: {} } })
const { createCreditPacks } = await import('../src/modules/creditPacks.js')

function setup({ platform = 'android', configure = async () => {}, getOfferings } = {}) {
  const calls = []
  const store = createCreditPacks({
    capacitor: { getPlatform: () => platform },
    purchases: {
      configure: async options => { calls.push(['configure', options]); await configure() },
      logIn: async options => { calls.push(['login', options]) },
      getOfferings: getOfferings ?? (async () => ({ current: { availablePackages: [
        { identifier: 'credits_600', product: { priceString: '4,99 €' } },
        { identifier: 'unknown', product: { priceString: '100 €' } },
        { identifier: 'credits_100', product: { priceString: '$0.99' } },
        { identifier: 'credits_1300', product: { priceString: '9,99 €' } },
      ] } })),
    },
  })
  return { ...store, calls }
}

test('packs come from the current offering with localized prices and known credit amounts', async () => {
  const store = setup()
  assert.deepEqual(await store.getCreditPacks(12), [
    { identifier: 'credits_100', credits: 100, price: '$0.99' },
    { identifier: 'credits_600', credits: 600, price: '4,99 €' },
    { identifier: 'credits_1300', credits: 1300, price: '9,99 €' },
  ])
  assert.equal(store.calls[0][1].appUserID, '12')
  assert.match(store.calls[0][1].apiKey, /^goog_/)
})

test('concurrent loads configure once; changing accounts switches the RevenueCat identity', async () => {
  const store = setup()
  await Promise.all([store.getCreditPacks('first'), store.getCreditPacks('first')])
  assert.equal(store.calls.length, 1)
  await store.getCreditPacks('second')
  assert.deepEqual(store.calls[1], ['login', { appUserID: 'second' }])
})

test('failed initialization can be retried', async () => {
  let attempts = 0
  const store = setup({ configure: async () => { if (++attempts === 1) throw new Error('offline') } })
  await assert.rejects(store.getCreditPacks('user'), /offline/)
  assert.equal((await store.getCreditPacks('user')).length, 3)
  assert.equal(attempts, 2)
})

test('missing or empty default offerings do not show fabricated packs', async () => {
  for (const current of [null, { availablePackages: [] }]) {
    const store = setup({ getOfferings: async () => ({ current }) })
    await assert.rejects(store.getCreditPacks('user'), /No credit packs/)
  }
})

test('unsupported platforms and absent accounts never initialize purchases', async () => {
  const browser = setup({ platform: 'web' })
  await assert.rejects(browser.getCreditPacks('user'), /Android/)
  assert.deepEqual(browser.calls, [])
  const store = setup()
  await assert.rejects(store.getCreditPacks(null), /Log in/)
  assert.deepEqual(store.calls, [])
})
