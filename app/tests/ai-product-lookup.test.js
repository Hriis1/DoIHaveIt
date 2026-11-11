import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'

let settings
const getApiKey = mock.fn()
const getAiProviderSettings = mock.fn()
const lookupProduct = mock.fn()
const getCurrentUser = mock.fn()
const updateCredits = mock.fn()
const getSessionToken = mock.fn()
mock.module('../src/modules/auth.js', { namedExports: { auth: { getCurrentUser, updateCredits } } })
mock.module('../src/modules/sessionStorage.js', { namedExports: { getSessionToken } })
mock.module('../src/modules/aiProviderSettings.js', { namedExports: { getAiProviderSettings } })
mock.module('../src/modules/apiKeyStorage.js', { namedExports: { getApiKey } })
mock.module('../src/modules/ai/directProductLookup.js', { namedExports: { lookupProduct } })
const { lookupProductWithAi } = await import('../src/modules/aiProductLookup.js')

beforeEach(() => {
  settings = { useAppKey: true, provider: 'gemini' }
  getCurrentUser.mock.resetCalls()
  getCurrentUser.mock.mockImplementation(async () => ({ id: 1, credits: 10 }))
  updateCredits.mock.resetCalls()
  updateCredits.mock.mockImplementation(async () => {})
  getSessionToken.mock.resetCalls()
  getSessionToken.mock.mockImplementation(async () => 'a'.repeat(64))
  getAiProviderSettings.mock.mockImplementation(() => ({ ...settings }))
  getApiKey.mock.resetCalls()
  getApiKey.mock.mockImplementation(async () => null)
  lookupProduct.mock.resetCalls()
  lookupProduct.mock.mockImplementation(async () => product)
})

const product = { brand: ' Марка ', name: ' МЛЯКО ', size: ' 500 ML ' }

test('app credit lookups reject insufficient or missing cached balances before sending a request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ...product, credits: 0 }))
  for (const user of [null, { credits: 0 }, { credits: 9 }]) {
    getCurrentUser.mock.mockImplementation(async () => user)
    await assert.rejects(lookupProductWithAi('123'), error =>
      error.message === 'Not enough credits' && error.code === 'INSUFFICIENT_CREDITS')
  }
  assert.equal(fetch.mock.callCount(), 0)
  for (const credits of [10, 11]) {
    getCurrentUser.mock.mockImplementation(async () => ({ credits }))
    await lookupProductWithAi('123')
  }
  assert.equal(fetch.mock.callCount(), 2)
})

test('own keys bypass credit checks; cache failures and cancellation prevent app credit requests', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(product))
  getCurrentUser.mock.mockImplementation(async () => { throw new Error('Private storage details') })
  await assert.rejects(lookupProductWithAi('123'), /Could not read your credit balance/)
  settings.useAppKey = false
  getApiKey.mock.mockImplementation(async () => 'test-key')
  await lookupProductWithAi('123')
  assert.equal(getCurrentUser.mock.callCount(), 1)
  settings.useAppKey = true
  let finish
  getCurrentUser.mock.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const controller = new AbortController()
  const pending = lookupProductWithAi('123', { signal: controller.signal })
  controller.abort()
  finish({ credits: 10 })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(fetch.mock.callCount(), 0)
})

test('AI client sends the barcode with the app key option and returns normalized product fields', async t => {
  const controller = new AbortController()
  settings.provider = 'openai'
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://doihaveit-api.hrishd.workers.dev/products/lookup')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.equal(options.headers.Authorization, `Bearer ${'a'.repeat(64)}`)
    assert.equal(options.signal, controller.signal)
    assert.deepEqual(JSON.parse(options.body), { barcode: '004062139018352' })
    return Response.json({ ...product, credits: 0 })
  })
  assert.deepEqual(await lookupProductWithAi('004062139018352', { signal: controller.signal }), {
    brand: 'марка', name: 'мляко', size: '500 ml',
  })
  assert.equal(getApiKey.mock.callCount(), 0)
  assert.equal(lookupProduct.mock.callCount(), 0)
  assert.deepEqual(updateCredits.mock.calls.at(-1).arguments, [1, 0])
})

test('AI client reads the current selection and sends only that provider’s own key on each search', async t => {
  getApiKey.mock.mockImplementation(async provider => ` test-key-${provider} `)
  const requests = []
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body))
    return Response.json({ ...product, credits: 0 })
  })
  for (const provider of ['gemini', 'deepseek', 'openai']) {
    settings = { useAppKey: false, provider }
    assert.deepEqual(await lookupProductWithAi('123'), { brand: 'марка', name: 'мляко', size: '500 ml' })
    assert.deepEqual(lookupProduct.mock.calls.at(-1).arguments[0], {
      barcode: '123', model: provider, apiKey: `test-key-${provider}`, signal: undefined,
    })
  }
  assert.equal(fetch.mock.callCount(), 0)
  assert.deepEqual(getApiKey.mock.calls.map(call => call.arguments), [['gemini'], ['deepseek'], ['openai']])
  settings.useAppKey = true
  await lookupProductWithAi('123')
  assert.deepEqual(requests.at(-1), { barcode: '123' })
  assert.equal(getApiKey.mock.callCount(), 3)
  assert.equal(lookupProduct.mock.callCount(), 3)
  assert.equal(fetch.mock.callCount(), 1)
})

test('missing own keys prevent requests without falling back to the app key', async t => {
  settings = { useAppKey: false, provider: 'openai' }
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(product))
  for (const value of [null, '', ' ']) {
    getApiKey.mock.mockImplementation(async () => value)
    await assert.rejects(lookupProductWithAi('123'), /No API key saved.*AI Search/)
  }
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(lookupProduct.mock.callCount(), 0)
})

test('settings and key storage failures are actionable and do not send requests or expose native details', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(product))
  getAiProviderSettings.mock.mockImplementation(() => { throw new Error('Private storage details') })
  await assert.rejects(lookupProductWithAi('123'), {
    message: 'Could not read your AI Search settings. Open AI Search from the app menu and try again.',
  })
  getAiProviderSettings.mock.mockImplementation(() => ({ useAppKey: false, provider: 'deepseek' }))
  getApiKey.mock.mockImplementation(async () => { throw new Error('Private storage details') })
  await assert.rejects(lookupProductWithAi('123'), {
    message: 'Could not read your saved API key. Please check your AI Search settings and try again.',
  })
  assert.equal(fetch.mock.callCount(), 0)
})

test('cancelling before or during a key read prevents sending the key to a provider', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(product))
  const alreadyCancelled = new AbortController()
  alreadyCancelled.abort()
  await assert.rejects(lookupProductWithAi('123', { signal: alreadyCancelled.signal }), { name: 'AbortError' })
  assert.equal(getApiKey.mock.callCount(), 0)
  settings = { useAppKey: false, provider: 'openai' }
  for (const failRead of [false, true]) {
    let finishRead
    getApiKey.mock.mockImplementation(() => new Promise((resolve, reject) => {
      finishRead = () => failRead ? reject(new Error('Storage failed')) : resolve('test-only-key')
    }))
    const controller = new AbortController()
    const pending = lookupProductWithAi('123', { signal: controller.signal })
    controller.abort()
    finishRead()
    await assert.rejects(pending, { name: 'AbortError' })
  }
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(lookupProduct.mock.callCount(), 0)
})

test('direct lookup forwards cancellation, preserves errors and reports an unidentified product', async t => {
  settings = { useAppKey: false, provider: 'openai' }
  getApiKey.mock.mockImplementation(async () => 'test-key')
  t.mock.method(globalThis, 'fetch', () => assert.fail('Own keys must not reach the Worker'))
  const controller = new AbortController()
  lookupProduct.mock.mockImplementation(async options => {
    assert.equal(options.signal, controller.signal)
    return null
  })
  await assert.rejects(lookupProductWithAi('123', { signal: controller.signal }), { message: 'Product not found' })
  lookupProduct.mock.mockImplementation(async () => { throw new Error('AI provider rate limit exceeded.') })
  await assert.rejects(lookupProductWithAi('123'), /rate limit exceeded/)
})

test('AI client preserves null sizes and displays Worker error messages', async t => {
  const mockFetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ...product, size: null, credits: 0 }))
  assert.equal((await lookupProductWithAi('123')).size, null)
  for (const [status, message] of [[404, 'Product not found'], [503, 'AI provider rate limit exceeded.'], [502, 'Provider failed']]) {
    mockFetch.mock.mockImplementation(async () => Response.json({ error: message, credits: 10 }, { status }))
    await assert.rejects(lookupProductWithAi('123'), { message })
    assert.deepEqual(updateCredits.mock.calls.at(-1).arguments, [1, 10])
  }
})

test('server insufficient credits update the cache and expose Buy credits; missing sessions never send requests', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    error: 'Not enough credits', code: 'INSUFFICIENT_CREDITS', credits: 0,
  }, { status: 402 }))
  await assert.rejects(lookupProductWithAi('123'), error => error.code === 'INSUFFICIENT_CREDITS')
  assert.deepEqual(updateCredits.mock.calls.at(-1).arguments, [1, 0])
  getSessionToken.mock.mockImplementation(async () => null)
  await assert.rejects(lookupProductWithAi('123'), /log in again/)
  assert.equal(fetch.mock.callCount(), 1)
})

test('cache-write failures are visible and cancellation during session reads prevents dispatch', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ...product, credits: 0 }))
  updateCredits.mock.mockImplementation(async () => { throw new Error('disk full') })
  await assert.rejects(lookupProductWithAi('123'), /Could not update your saved credit balance/)
  let finish
  getSessionToken.mock.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const controller = new AbortController()
  const pending = lookupProductWithAi('123', { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  finish('a'.repeat(64))
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(fetch.mock.callCount(), 1)
})

test('AI client rejects malformed responses and incomplete product data', async t => {
  const mockFetch = t.mock.method(globalThis, 'fetch', async () => new Response('not JSON'))
  await assert.rejects(lookupProductWithAi('123'), /Could not read/)
  for (const value of [null, [], {}, { ...product, name: '' }, { ...product, brand: 1 },
    { brand: 'Brand', name: 'Name' }, { ...product, size: ' ' }, { ...product, size: 500 },
  ]) {
    mockFetch.mock.mockImplementation(async () => Response.json(value))
    await assert.rejects(lookupProductWithAi('123'), /invalid product data/)
  }
})

test('AI client reports network failures and passes cancellation to fetch', async t => {
  const mockFetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network disconnected') })
  await assert.rejects(lookupProductWithAi('123'), /Could not search/)
  const controller = new AbortController()
  mockFetch.mock.mockImplementation((url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const pending = lookupProductWithAi('123', { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})
