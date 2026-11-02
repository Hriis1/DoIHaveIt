import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../src/index.js'
import { callDeepSeek } from '../src/ai/providers/deepseek.js'
import { lookupProduct } from '../src/ai/aiProductLookup.js'

const product = { brand: 'Brand', name: 'Product', size: '500 ml' }
const input = { barcode: '070847891857', model: 'deepseek', use_app_key: false, api_key: 'caller-secret' }
const publicRequest = (body = input, env = {}) => worker.fetch(new Request('https://example.com/products/lookup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env)
const request = signal => lookupProduct({ barcode: input.barcode, model: input.model, apiKey: input.api_key, signal })
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const answer = (value = product) => ({
  type: 'message', role: 'assistant', stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ product: value }) }],
})

test('DeepSeek sends one direct non-streaming lookup with caller key, bounded search and shared schema', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++
    assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer caller-secret')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.ok(options.signal instanceof AbortSignal)
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'deepseek-flash')
    assert.equal(body.stream, false)
    assert.equal(body.max_tokens, 1000)
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }])
    assert.equal(body.messages[0].role, 'user')
    const prompt = body.messages[0].content
    assert.ok(prompt.includes('"070847891857"'))
    const schema = JSON.parse(prompt.split('\nJSON Schema: ')[1])
    assert.deepEqual(schema.properties.product.anyOf[0].required, ['brand', 'name', 'size'])
    return json(answer())
  })
  assert.deepEqual(await request(), product)
  assert.equal(calls, 1)
})

test('the public route rejects DeepSeek options without calling the provider', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Must not call provider'))
  for (const body of [{ ...input, use_app_key: true }, { ...input, api_key: undefined }, { ...input, api_key: ' ' }]) {
    assert.equal((await publicRequest(body, { DEEPSEEK_API_KEY: 'app-key' })).status, 400)
  }
})

test('DeepSeek collects answer text blocks and ignores thinking and search metadata', async t => {
  const value = { brand: ' марка ', name: ' мляко ', size: null }
  const text = JSON.stringify({ product: value })
  t.mock.method(globalThis, 'fetch', async () => json({ ...answer(), content: [
    { type: 'thinking', thinking: 'private reasoning' },
    { type: 'server_tool_use', name: 'web_search', input: { query: input.barcode } },
    { type: 'web_search_tool_result', content: [] },
    { type: 'text', text: text.slice(0, 15) }, { type: 'text', text: text.slice(15) },
  ] }))
  assert.deepEqual(await request(), { brand: 'марка', name: 'мляко', size: null })
})

test('DeepSeek no-match remains available through the internal lookup', async t => {
  t.mock.method(globalThis, 'fetch', async () => json(answer(null)))
  assert.equal(await request(), null)
})

test('DeepSeek rejects malformed products and incomplete or paused generations', async t => {
  for (const value of [{}, null, { ...answer(), type: 'error' }, { ...answer(), content: null },
    ...['max_tokens', 'pause_turn', 'tool_use', 'refusal', null].map(stop_reason => ({ ...answer(), stop_reason })),
    { ...answer(), content: [] }, { ...answer(), content: [{ type: 'text', text: 'not JSON' }] },
    answer({ brand: '', name: 'Product', size: null }), answer({ ...product, size: 500 }),
    answer({ brand: 'Brand', name: 'Product' }), answer({ ...product, extra: true }),
  ]) {
    const provider = t.mock.method(globalThis, 'fetch', async () => json(value))
    try {
      await assert.rejects(request(), error => error.status === 502)
    } finally {
      provider.mock.restore()
    }
  }
})

test('DeepSeek sanitizes upstream HTTP errors and invalid JSON', async t => {
  for (const [status, expected] of [[400, 502], [401, 502], [403, 502], [429, 503], [500, 502]]) {
    const provider = t.mock.method(globalThis, 'fetch', async () => new Response('private caller-secret', { status }))
    try {
      await assert.rejects(request(), error => error.status === expected && !error.message.includes('caller-secret'))
    } finally {
      provider.mock.restore()
    }
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('not JSON'))
  await assert.rejects(request(), error => error.status === 502)
})

test('DeepSeek maps timeout, cancellation and network failures to controlled errors', async t => {
  for (const [error, status] of [[new DOMException('caller-secret', 'TimeoutError'), 504],
    [new DOMException('caller-secret', 'AbortError'), 504], [new Error('caller-secret'), 502]]) {
    const provider = t.mock.method(globalThis, 'fetch', async () => { throw error })
    try {
      await assert.rejects(request(), error => error.status === status && !error.message.includes('caller-secret'))
    } finally {
      provider.mock.restore()
    }
  }
})

test('DeepSeek passes request cancellation upstream and skips already cancelled requests', async t => {
  const controller = new AbortController()
  let upstreamSignal
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    upstreamSignal = options.signal
    controller.abort()
    options.signal.throwIfAborted()
  })
  await assert.rejects(request(controller.signal), error => error.status === 504)
  assert.equal(upstreamSignal.aborted, true)
  t.mock.method(globalThis, 'fetch', () => assert.fail('Must not call provider'))
  await assert.rejects(callDeepSeek({ model: 'deepseek-flash', signal: controller.signal }), error => error.status === 504)
})
