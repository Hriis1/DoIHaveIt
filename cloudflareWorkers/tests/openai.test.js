import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../src/index.js'
import { callOpenAI } from '../src/ai/providers/openai.js'
import { lookupProduct } from '../src/ai/aiProductLookup.js'

const product = { brand: 'Brand', name: 'Product', size: '500 ml' }
const input = { barcode: '070847891857', model: 'openai', use_app_key: false, api_key: 'caller-secret' }
const publicRequest = (body = input, env = {}) => worker.fetch(new Request('https://example.com/products/lookup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env)
const request = signal => lookupProduct({ barcode: input.barcode, model: input.model, apiKey: input.api_key, signal })
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
  assert.deepEqual(await request(), product)
  assert.equal(calls, 1)
})

test('the public route rejects OpenAI options without calling the provider', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Must not call provider'))
  for (const body of [{ ...input, use_app_key: true }, { ...input, api_key: undefined }, { ...input, api_key: ' ' }]) {
    assert.equal((await publicRequest(body, { OPENAI_API_KEY: 'app-key' })).status, 400)
  }
})

test('OpenAI extracts raw REST answer blocks, ignoring tool and reasoning output', async t => {
  const text = JSON.stringify({ product: { brand: ' марка ', name: ' мляко ', size: null } })
  t.mock.method(globalThis, 'fetch', async () => json({ status: 'completed', output: [
    { type: 'reasoning', summary: [] },
    { type: 'web_search_call', status: 'completed', action: { type: 'search', query: input.barcode } },
    message([{ type: 'output_text', text: text.slice(0, 15) }, { type: 'output_text', text: text.slice(15), annotations: [] }]),
  ] }))
  assert.deepEqual(await request(), { brand: 'марка', name: 'мляко', size: null })
})

test('OpenAI null product remains available through the internal lookup', async t => {
  t.mock.method(globalThis, 'fetch', async () => json(answer(null)))
  assert.equal(await request(), null)
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
      await assert.rejects(request(), error => error.status === 502 && !error.message.includes('caller-secret'))
    } finally {
      provider.mock.restore()
    }
  }
})

test('OpenAI sanitizes HTTP errors and malformed upstream JSON', async t => {
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

test('OpenAI maps timeout, cancellation and network failures to controlled errors', async t => {
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

test('OpenAI passes cancellation upstream and skips already cancelled requests', async t => {
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
  await assert.rejects(callOpenAI({ model: 'gpt-6-luna', signal: controller.signal }), error => error.status === 504)
})
