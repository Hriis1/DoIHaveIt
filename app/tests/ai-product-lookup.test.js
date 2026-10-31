import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lookupProductWithAi } from '../src/modules/aiProductLookup.js'

const product = { brand: ' Марка ', name: ' МЛЯКО ', size: ' 500 ML ' }

test('AI client sends the barcode with the app key option and returns normalized product fields', async t => {
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://doihaveit-api.hrishd.workers.dev/products/lookup')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.equal(options.signal, controller.signal)
    assert.deepEqual(JSON.parse(options.body), { barcode: '004062139018352', use_app_key: true, model: 'gemini' })
    return Response.json(product)
  })
  assert.deepEqual(await lookupProductWithAi('004062139018352', { signal: controller.signal }), {
    brand: 'марка', name: 'мляко', size: '500 ml',
  })
})

test('AI client preserves null sizes and displays Worker error messages', async t => {
  const mockFetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ...product, size: null }))
  assert.equal((await lookupProductWithAi('123')).size, null)
  for (const [status, message] of [[404, 'Product not found'], [503, 'AI provider rate limit exceeded.'], [502, 'Provider failed']]) {
    mockFetch.mock.mockImplementation(async () => Response.json({ error: message }, { status }))
    await assert.rejects(lookupProductWithAi('123'), { message })
  }
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
