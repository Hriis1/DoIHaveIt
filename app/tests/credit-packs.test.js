import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

mock.module('@capacitor/core', { namedExports: { Capacitor: {} } })
mock.module('@revenuecat/purchases-capacitor', { namedExports: { Purchases: {} } })
const { createCreditPacks } = await import('../src/modules/creditPacks.js')

function setup({ platform = 'android', configure = async () => {}, getOfferings, purchasePackage = async () => ({ transaction: { transactionIdentifier: 'order1' } }) } = {}) {
  const calls = []
  const store = createCreditPacks({
    capacitor: { getPlatform: () => platform },
    purchases: {
      configure: async options => { calls.push(['configure', options]); await configure() },
      logIn: async options => { calls.push(['login', options]) },
      logOut: async () => { calls.push(['logout']) },
      purchasePackage: async options => { calls.push(['purchase', options]); return purchasePackage(options) },
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

test('purchases use the original package and retain transaction confirmation per account', async () => {
  const store = setup()
  await store.getCreditPacks(12)
  assert.deepEqual(await store.purchaseCreditPack(12, 'credits_100'), { status: 'purchased', transactionId: 'order1' })
  assert.equal(store.calls.at(-1)[1].aPackage.identifier, 'credits_100')
  assert.equal(store.getPendingPurchase(12), 'order1')
  assert.equal(store.getPendingPurchase(13), undefined)
  store.clearPendingPurchase(12, 'wrong')
  assert.equal(store.getPendingPurchase(12), 'order1')
  store.clearPendingPurchase(12, 'order1')
  assert.equal(store.getPendingPurchase(12), undefined)
})

test('purchase errors distinguish cancellation and pending payment and sanitize other failures', async () => {
  for (const [code, expected] of [['1', 'cancelled'], ['20', 'pending'], ['2', null]]) {
    const store = setup({ purchasePackage: async () => { throw { code, message: 'private provider detail' } } })
    await store.getCreditPacks(12)
    if (expected) assert.deepEqual(await store.purchaseCreditPack(12, 'credits_100'), { status: expected })
    else await assert.rejects(store.purchaseCreditPack(12, 'credits_100'), error => !error.message.includes('private'))
    assert.equal(store.getPendingPurchase(12), undefined)
    assert.equal(store.isPurchasing(), false)
  }
})

test('purchase locking survives screen changes; stale packages cannot be purchased by another account', async () => {
  let resolve
  const store = setup({ purchasePackage: () => new Promise(yes => { resolve = yes }) })
  await store.getCreditPacks(12)
  const buying = store.purchaseCreditPack(12, 'credits_100')
  await new Promise(yes => setImmediate(yes))
  await assert.rejects(store.purchaseCreditPack(12, 'credits_100'), /already in progress/)
  resolve({ transaction: { transactionIdentifier: 'order' } })
  await buying
  await assert.rejects(store.purchaseCreditPack(13, 'credits_100'), /Reload/)
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

test('deletion detaches RevenueCat before server cleanup and clears purchase state only on success', async () => {
  const store = setup()
  await store.getCreditPacks(12)
  await store.purchaseCreditPack(12, 'credits_100')
  const finish = await store.prepareCreditPacksForDeletion(12)
  assert.deepEqual(store.calls.at(-1), ['logout'])
  assert.equal(store.getPendingPurchase(12), 'order1')
  await assert.rejects(store.getCreditPacks(12), /deletion is in progress/)
  await assert.rejects(store.purchaseCreditPack(12, 'credits_100'), /deletion is in progress/)
  finish(false)
  assert.equal(store.getPendingPurchase(12), 'order1')
  await store.getCreditPacks(12)
  assert.deepEqual(store.calls.at(-1), ['login', { appUserID: '12' }])
  const complete = await store.prepareCreditPacksForDeletion(12)
  complete(true)
  assert.equal(store.getPendingPurchase(12), undefined)
  await assert.rejects(store.purchaseCreditPack(12, 'credits_100'), /Reload/)
})

test('users who never initialized RevenueCat need no SDK logout', async () => {
  const store = setup()
  const finish = await store.prepareCreditPacksForDeletion(12)
  finish(true)
  assert.deepEqual(store.calls, [])
})
