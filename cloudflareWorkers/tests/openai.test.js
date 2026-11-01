import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../src/index.js'
import { callOpenAI } from '../src/ai/providers/openai.js'

const product = { brand: 'Brand', name: 'Product', size: '500 ml' }
const input = { barcode: '070847891857', model: 'openai', use_app_key: false, api_key: 'caller-secret' }
const request = (body = input, env = {}, signal) => worker.fetch(new Request('https://example.com/products/lookup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
}), env)
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const message = content => ({ type: 'message', role: 'assistant', status: 'completed', content })
const answer = (value = product) => ({ status: 'completed', output: [message([
  { type: 'output_text', text: JSON.stringify({ product: value }) },
])] })

test('OpenAI sends one caller-key Responses request with required web search and shared schema', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++
    assert.equal(url, 'https://api.openai.com/v1/responses')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer caller-secret')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.ok(options.signal instanceof AbortSignal)
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'gpt-6-luna')
    assert.equal(body.stream, false)
    assert.equal(body.store, false)
    assert.deepEqual(body.reasoning, { effort: 'none' })
    assert.equal(body.max_output_tokens, 1000)
    assert.equal(body.max_tool_calls, 3)
    assert.deepEqual(body.tools, [{ type: 'web_search' }])
    assert.equal(body.tool_choice, 'required')
    assert.ok(body.input.includes('"070847891857"'))
    const format = body.text.format
    assert.equal(format.type, 'json_schema')
    assert.equal(format.strict, true)
    assert.deepEqual(format.schema.properties.product.anyOf[0].required, ['brand', 'name', 'size'])
    return json(answer())
  })
  const response = await request(input, { OPENAI_API_KEY: 'ignored-app-key' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), product)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(calls, 1)
})

test('OpenAI rejects app-key requests and missing caller keys without calling the provider', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Must not call provider'))
  for (const body of [{ ...input, use_app_key: true }, { ...input, api_key: undefined }, { ...input, api_key: ' ' }]) {
    assert.equal((await request(body, { OPENAI_API_KEY: 'app-key' })).status, 400)
  }
})

test('OpenAI extracts raw REST answer blocks, ignoring tool and reasoning output', async t => {
  const text = JSON.stringify({ product: { brand: ' марка ', name: ' мляко ', size: null } })
  t.mock.method(globalThis, 'fetch', async () => json({ status: 'completed', output: [
    { type: 'reasoning', summary: [] },
    { type: 'web_search_call', status: 'completed', action: { type: 'search', query: input.barcode } },
    message([{ type: 'output_text', text: text.slice(0, 15) }, { type: 'output_text', text: text.slice(15), annotations: [] }]),
  ] }))
  const response = await request()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { brand: 'марка', name: 'мляко', size: null })
})

test('OpenAI null product returns the shared not-found response', async t => {
  t.mock.method(globalThis, 'fetch', async () => json(answer(null)))
  const response = await request()
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Product not found' })
})

test('OpenAI rejects refusals, incomplete responses and malformed products', async t => {
  for (const value of [null, {}, { ...answer(), status: 'incomplete' }, { ...answer(), status: 'failed' },
    { ...answer(), error: { message: 'caller-secret' } }, { ...answer(), output: null }, { ...answer(), output: [] },
    { ...answer(), output: [{ ...answer().output[0], status: 'incomplete' }] },
    { ...answer(), output: [message([{ type: 'refusal', refusal: 'caller-secret' }])] },
    { ...answer(), output: [message([{ type: 'output_text', text: 'not JSON' }])] },
    { ...answer(), output: [message([])] },
    answer({ ...product, size: 500 }), answer({ ...product, brand: '' }),
    answer({ brand: 'Brand', name: 'Product' }), answer({ ...product, extra: true }),
  ]) {
    const provider = t.mock.method(globalThis, 'fetch', async () => json(value))
    try {
      const response = await request()
      assert.equal(response.status, 502, JSON.stringify(value))
      assert.ok(!(await response.text()).includes('caller-secret'))
    } finally {
      provider.mock.restore()
    }
  }
})

test('OpenAI sanitizes HTTP errors and malformed upstream JSON', async t => {
  t.mock.method(console, 'error', () => {})
  for (const [status, expected] of [[400, 502], [401, 502], [403, 502], [429, 503], [500, 502]]) {
    const provider = t.mock.method(globalThis, 'fetch', async () => new Response('private caller-secret', { status }))
    try {
      const response = await request()
      assert.equal(response.status, expected)
      assert.ok(!(await response.text()).includes('caller-secret'))
    } finally {
      provider.mock.restore()
    }
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('not JSON'))
  assert.equal((await request()).status, 502)
})

test('temporary OpenAI diagnostics log upstream details without exposing keys or changing public errors', async t => {
  const logs = []
  t.mock.method(console, 'error', (...args) => logs.push(args))
  for (const status of [400, 401, 429, 500]) {
    const provider = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      error: { code: 'test_error', message: 'Rejected caller-secret and sk-proj-masked***key' },
    }), { status, headers: { 'x-request-id': 'req-test' } }))
    try {
      const response = await request()
      assert.equal(response.status, status === 429 ? 503 : 502)
      assert.ok(!(await response.text()).includes('test_error'))
      const [label, details] = logs.at(-1)
      assert.equal(label, 'OpenAI lookup upstream error')
      assert.equal(details.status, status)
      assert.equal(details.requestId, 'req-test')
      assert.equal(details.model, 'gpt-6-luna')
      assert.ok(details.body.includes('test_error'))
      assert.ok(details.body.includes('[REDACTED]'))
      assert.ok(!details.body.includes('caller-secret'))
      assert.ok(!details.body.includes('sk-proj-'))
    } finally {
      provider.mock.restore()
    }
  }
  assert.equal(logs.length, 4)
})

test('OpenAI maps timeout, cancellation and network failures to controlled errors', async t => {
  for (const [error, status] of [[new DOMException('caller-secret', 'TimeoutError'), 504],
    [new DOMException('caller-secret', 'AbortError'), 504], [new Error('caller-secret'), 502]]) {
    const provider = t.mock.method(globalThis, 'fetch', async () => { throw error })
    try {
      const response = await request()
      assert.equal(response.status, status)
      assert.ok(!(await response.text()).includes('caller-secret'))
    } finally {
      provider.mock.restore()
    }
  }
})

test('OpenAI passes cancellation upstream and skips already cancelled requests', async t => {
  const controller = new AbortController()
  let upstreamSignal
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    upstreamSignal = options.signal
    controller.abort()
    options.signal.throwIfAborted()
  })
  assert.equal((await request(input, {}, controller.signal)).status, 504)
  assert.equal(upstreamSignal.aborted, true)
  t.mock.method(globalThis, 'fetch', () => assert.fail('Must not call provider'))
  await assert.rejects(callOpenAI({ model: 'gpt-6-luna', signal: controller.signal }), error => error.status === 504)
})
