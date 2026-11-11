import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import worker from '../src/index.js'
import { supported, supportedWithKey } from '../src/ai/models.js'
import { authFixture } from './auth-fixture.js'
import { hashSessionToken } from '../src/auth/credentials.js'

const input = { barcode: '0036000291452' }
const product = { brand: 'Brand', name: 'Product', size: '500 ml' }
const token = 'a'.repeat(64)
let database
let bindings
let background
beforeEach(t => {
  const fixture = authFixture(t)
  database = fixture.database
  bindings = fixture.env
  background = []
  database.prepare('INSERT INTO users (id, email, password_hash, credits) VALUES (1, ?, ?, 1000)')
    .run('wallet@example.com', 'unused')
  database.prepare("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (1, ?, datetime('now', '+1 day'))")
    .run(hashSessionToken(token))
})

const request = (body = input, env = { GEMINI_API_KEY: 'app-secret' }, method = 'POST') => worker.fetch(new Request('https://example.com/products/lookup', {
  method,
  ...(method === 'POST' ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } } : {}),
}), { ...bindings, ...env }, { waitUntil: task => background.push(task) })
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
  assert.deepEqual(await response.json(), { ...product, credits: 990 })
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
  assert.deepEqual(await response.json(), { ...product, size: null, credits: 990 })
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
    assert.deepEqual(await response.json(), { error: 'Only barcode is allowed for this endpoint.' })
  }
})

test('OPTIONS allows JSON POSTs and other methods are rejected without provider calls', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Must not call Gemini'))
  const preflight = await request(input, {}, 'OPTIONS')
  assert.equal(preflight.status, 204)
  assert.equal(await preflight.text(), '')
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS')
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization')
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
  assert.deepEqual(await response.json(), { error: 'Product not found', credits: 990 })
  assert.equal(database.prepare('SELECT credits FROM users WHERE id = 1').get().credits, 990)
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

test('missing, unknown, revoked and expired sessions cannot spend credits or call Gemini', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Unauthenticated lookup reached Gemini'))
  for (const authorization of [undefined, 'Basic bad', 'Bearer bad', `Bearer ${'b'.repeat(64)}`]) {
    const response = await worker.fetch(new Request('https://example.com/products/lookup', {
      method: 'POST', body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
    }), { ...bindings, GEMINI_API_KEY: 'app-secret' })
    assert.equal(response.status, 401)
  }
  database.exec("UPDATE sessions SET expires_at = datetime('now', '-1 second');")
  assert.equal((await request()).status, 401)
  database.exec('DELETE FROM sessions;')
  assert.equal((await request()).status, 401)
  assert.equal(database.prepare('SELECT credits FROM users WHERE id = 1').get().credits, 1000)
})

test('concurrent requests can spend the final 10 credits only once', async t => {
  database.exec('UPDATE users SET credits = 10;')
  const provider = t.mock.method(globalThis, 'fetch', async () => json(answer()))
  const responses = await Promise.all([request(), request()])
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 402])
  const rejected = await responses.find(response => response.status === 402).json()
  assert.deepEqual(rejected, { error: 'Not enough credits', code: 'INSUFFICIENT_CREDITS', credits: 0 })
  assert.equal(provider.mock.callCount(), 1)
  assert.equal(database.prepare('SELECT credits FROM users WHERE id = 1').get().credits, 0)
})

test('all provider errors, invalid responses and timeouts refund exactly the original cost', async t => {
  const provider = t.mock.method(globalThis, 'fetch', async () => json(answer()))
  for (const fail of [
    async () => new Response('upstream failure', { status: 503 }),
    async () => { throw new DOMException('Timeout', 'TimeoutError') },
    async () => { throw new Error('Network failure') },
    async () => json({}),
    async () => json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'bad JSON' }] } }] }),
  ]) {
    provider.mock.mockImplementation(fail)
    const response = await request()
    assert.ok(response.status >= 500)
    assert.equal((await response.json()).credits, 1000)
    await Promise.all(background)
    assert.equal(database.prepare('SELECT credits FROM users WHERE id = 1').get().credits, 1000)
  }
})

test('disconnecting the phone leaves the provider running and preserves charge or refund by its outcome', async t => {
  for (const fail of [false, true]) {
    let complete
    let started
    const ready = new Promise(resolve => { started = resolve })
    const provider = t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
      assert.equal(signal.aborted, false)
      started(signal)
      return new Promise((resolve, reject) => {
        complete = () => fail ? reject(new Error('Provider failed')) : resolve(json(answer()))
      })
    })
    const controller = new AbortController()
    const task = worker.fetch(new Request('https://example.com/products/lookup', {
      method: 'POST', body: JSON.stringify(input), signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    }), { ...bindings, GEMINI_API_KEY: 'app-secret' }, { waitUntil: task => background.push(task) })
    const providerSignal = await ready
    assert.equal(database.prepare('SELECT credits FROM users WHERE id = 1').get().credits, 990)
    controller.abort()
    assert.equal(providerSignal.aborted, false)
    assert.equal(background.length, 1)
    complete()
    assert.equal((await task).status, fail ? 502 : 200)
    await Promise.all(background)
    assert.equal(database.prepare('SELECT credits FROM users WHERE id = 1').get().credits, fail ? 1000 : 990)
    database.exec('UPDATE users SET credits = 1000;')
    background = []
    provider.mock.restore()
  }
})

test('database failures stop provider calls and unconfirmed refunds are reported without claiming success', async t => {
  database.exec("CREATE TRIGGER fail_charge BEFORE UPDATE OF credits ON users WHEN new.credits < old.credits BEGIN SELECT RAISE(ABORT, 'private D1 failure'); END;")
  const provider = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Provider failed') })
  assert.equal((await request()).status, 503)
  assert.equal(provider.mock.callCount(), 0)
  assert.equal(database.prepare('SELECT credits FROM users WHERE id = 1').get().credits, 1000)
  database.exec("DROP TRIGGER fail_charge; CREATE TRIGGER fail_refund BEFORE UPDATE OF credits ON users WHEN new.credits > old.credits BEGIN SELECT RAISE(ABORT, 'private D1 failure'); END;")
  const log = t.mock.method(console, 'error', () => {})
  const response = await request()
  const result = await response.json()
  assert.equal(response.status, 503)
  assert.match(result.error, /refund could not be confirmed/)
  assert.equal(Object.hasOwn(result, 'credits'), false)
  assert.equal(log.mock.callCount(), 1)
  assert.equal(provider.mock.callCount(), 1)
})

test('the server deadline aborts a stalled provider and refunds before responding', async t => {
  const deadline = new AbortController()
  let started
  const ready = new Promise(resolve => { started = resolve })
  const timeouts = []
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    timeouts.push(milliseconds)
    return deadline.signal
  })
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    started()
  }))
  const pending = request()
  await ready
  deadline.abort(new DOMException('Timed out', 'TimeoutError'))
  const response = await pending
  assert.equal(response.status, 504)
  assert.equal((await response.json()).credits, 1000)
  assert.equal(timeouts[0], 25000)
  assert.equal(database.prepare('SELECT credits FROM users WHERE id = 1').get().credits, 1000)
})
