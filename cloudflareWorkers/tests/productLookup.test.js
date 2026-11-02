import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../src/index.js'
import { supported, supportedWithKey } from '../src/ai/models.js'

const input = { barcode: '0036000291452' }
const product = { brand: 'Brand', name: 'Product', size: '500 ml' }
const request = (body = input, env = { GEMINI_API_KEY: 'app-secret' }, method = 'POST') => worker.fetch(new Request('https://example.com/products/lookup', {
  method,
  ...(method === 'POST' ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
}), env)
const answer = (value = product) => ({
  candidates: [{
    finishReason: 'STOP',
    content: { parts: [{ text: JSON.stringify({ product: value }) }] },
  }],
})
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })

test('provider and key-source infrastructure remains available internally', () => {
  assert.deepEqual(supported, ['gemini'])
  assert.deepEqual(supportedWithKey, ['gemini', 'deepseek', 'openai'])
})

test('app-key lookup sends the exact barcode, search tool and schema once and accepts a product without source metadata', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['x-goog-api-key'], 'app-secret')
    assert.ok(!url.includes('app-secret'))
    assert.ok(options.signal instanceof AbortSignal)
    const body = JSON.parse(options.body)
    assert.deepEqual(body.tools, [{ google_search: {} }])
    assert.equal(body.generationConfig.responseMimeType, 'application/json')
    const schema = body.generationConfig.responseJsonSchema.properties.product.anyOf[0]
    assert.deepEqual(schema.required, ['brand', 'name', 'size'])
    assert.ok(body.contents[0].parts[0].text.includes('"0036000291452"'))
    return json(answer())
  })
  const response = await request({ barcode: ` ${input.barcode} ` }, { GEMINI_API_KEY: ' app-secret ', OPENAI_API_KEY: 'unused-key' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), product)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(calls, 1)
})

test('barcode-only lookup preserves null product sizes', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers['x-goog-api-key'], 'app-secret')
    return json(answer({ ...product, size: null }))
  })
  const response = await request()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ...product, size: null })
})

test('validation rejects missing or incorrectly typed fields without calling a provider', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Invalid requests must not call Gemini'))
  for (const body of [null, [], 'text', {},
    { ...input, barcode: undefined }, { ...input, barcode: 36000291452 }, { ...input, barcode: ' ' },
    { ...input, use_app_key: true }, { ...input, use_app_key: 'false' }, { ...input, use_app_key: 1 },
    { ...input, use_app_key: null }, { ...input, model: 'gemini' }, { ...input, model: '' },
    { ...input, model: 1 }, { ...input, model: 'other' }, { ...input, model: '__proto__' },
    { barcode: input.barcode, model: 'gemini', use_app_kay: true },
    { ...input, use_app_key: false }, { ...input, use_app_key: false, api_key: '' },
    { ...input, use_app_key: false, api_key: ' ' }, { ...input, use_app_key: false, api_key: 123 },
  ]) {
    const response = await request(body)
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(typeof (await response.json()).error, 'string')
  }
  const invalidJson = await worker.fetch(new Request('https://example.com/products/lookup', { method: 'POST', body: '{' }), {})
  assert.equal(invalidJson.status, 400)
})

test('a missing Gemini secret cannot fall back to another provider or caller key', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('A missing selected key must stop the request'))
  for (const env of [{}, { GEMINI_API_KEY: '' }, { GEMINI_API_KEY: ' ' }, { OPENAI_API_KEY: 'other-key' }]) {
    const missingApp = await request(input, env)
    assert.equal(missingApp.status, 503)
    assert.match((await missingApp.json()).error, /not configured/)
  }
  assert.equal((await request({ ...input, api_key: 'caller-secret' }, {})).status, 400)
})

test('the public route rejects model overrides, key-source selection and all other extra fields', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Extra fields must not reach any provider'))
  for (const extra of [{ model: 'openai' }, { model: 'deepseek' }, { model: 'gemini' },
    { use_app_key: true }, { use_app_key: false }, { api_key: 'caller-secret' }, { extra: true },
    { model: 'openai', use_app_key: false, api_key: 'caller-secret' }]) {
    const response = await request({ ...input, ...extra })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Only barcode is allowed in the request body.' })
  }
})

test('OPTIONS allows JSON POSTs and other methods are rejected without provider calls', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Must not call Gemini'))
  const preflight = await request(input, {}, 'OPTIONS')
  assert.equal(preflight.status, 204)
  assert.equal(await preflight.text(), '')
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS')
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type')
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const response = await request(input, {}, method)
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'POST, OPTIONS')
  }
})

test('a valid no-match result returns 404', async t => {
  t.mock.method(globalThis, 'fetch', async () => json(answer(null)))
  const response = await request()
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Product not found' })
})

test('malformed or incomplete results are failures rather than unknown products', async t => {
  const badText = text => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] })
  for (const value of [{}, { candidates: [] },
    { candidates: [{ ...answer().candidates[0], finishReason: 'MAX_TOKENS' }] },
    badText('not JSON'), badText('null'), badText('{}'), badText('{"product":null,"extra":true}'),
    answer({ brand: '', name: 'Product', size: null }), answer({ brand: 'Brand', name: ' ', size: null }),
    answer({ brand: 'Brand', name: 'Product' }), answer({ ...product, size: 500 }),
    answer({ ...product, size: '' }), answer({ ...product, extra: true }),
  ]) {
    const provider = t.mock.method(globalThis, 'fetch', async () => json(value))
    try {
      const response = await request()
      assert.equal(response.status, 502, JSON.stringify(value))
      assert.equal(typeof (await response.json()).error, 'string')
    } finally {
      provider.mock.restore()
    }
  }
})

test('provider failures do not leak API keys or upstream error bodies', async t => {
  for (const [status, expected] of [[400, 502], [401, 502], [403, 502], [429, 503], [500, 502]]) {
    const provider = t.mock.method(globalThis, 'fetch', async () => new Response('private details: app-secret, caller-secret', { status }))
    try {
      const response = await request()
      assert.equal(response.status, expected)
      const body = await response.text()
      assert.ok(!body.includes('app-secret'))
      assert.ok(!body.includes('caller-secret'))
      assert.ok(!body.includes('private details'))
    } finally {
      provider.mock.restore()
    }
  }
})

test('timeouts, network failures and invalid provider JSON produce controlled errors', async t => {
  for (const [error, status] of [[new DOMException('Timeout', 'TimeoutError'), 504],
    [new DOMException('Aborted', 'AbortError'), 504], [new Error('app-secret'), 502]]) {
    const provider = t.mock.method(globalThis, 'fetch', async () => { throw error })
    try {
      const response = await request()
      assert.equal(response.status, status)
      assert.ok(!(await response.text()).includes('app-secret'))
    } finally {
      provider.mock.restore()
    }
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('not JSON'))
  assert.equal((await request()).status, 502)
})
