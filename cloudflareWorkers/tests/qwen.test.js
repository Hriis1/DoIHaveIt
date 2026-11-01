import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../src/index.js'
import { callQwen } from '../src/ai/providers/qwen.js'

const product = { brand: 'Brand', name: 'Product', size: '500 ml' }
const input = { barcode: '4062139018352', model: 'quen', use_app_key: false, api_key: 'caller-secret' }
const request = (body = input, env = {}) => worker.fetch(new Request('https://example.com/products/lookup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env)
const event = (text, finish_reason = 'null') => ({ output: { choices: [{ finish_reason, message: { content: [{ text }] } }] } })
const sse = events => events.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('')
const stream = (source, fragmented = false) => {
  const bytes = new TextEncoder().encode(source)
  return new Response(new ReadableStream({
    start(controller) {
      if (fragmented) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      } else controller.enqueue(bytes)
      controller.close()
    },
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}
const answer = value => stream(sse([event(JSON.stringify({ product: value }), 'stop')]))

test('quen uses the caller key and Singapore multimodal turbo search with the shared product schema', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++
    assert.equal(url, 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer caller-secret')
    assert.equal(options.headers['X-DashScope-SSE'], 'enable')
    assert.ok(options.signal instanceof AbortSignal)
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'qwen3.8-flash')
    assert.ok(body.input.messages[0].content[0].text.includes('"4062139018352"'))
    assert.equal(body.parameters.incremental_output, true)
    assert.equal(body.parameters.enable_search, true)
    assert.deepEqual(body.parameters.search_options, { search_strategy: 'turbo', forced_search: true })
    const format = body.parameters.response_format
    assert.equal(format.type, 'json_schema')
    assert.equal(format.json_schema.strict, true)
    assert.deepEqual(format.json_schema.schema.properties.product.anyOf[0].required, ['brand', 'name', 'size'])
    return answer(product)
  })
  const response = await request(input, { QUEN_API_KEY: 'ignored-app-key' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), product)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(calls, 1)
})

test('quen is caller-key only and rejects missing keys before calling Alibaba', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Must not call provider'))
  for (const body of [{ ...input, use_app_key: true }, { ...input, api_key: undefined }, { ...input, api_key: ' ' }]) {
    const response = await request(body, { QUEN_API_KEY: 'app-key' })
    assert.equal(response.status, 400)
  }
})

test('fragmented SSE preserves Unicode and ignores reasoning and search metadata', async t => {
  const value = { brand: 'марка', name: 'мляко', size: null }
  const text = JSON.stringify({ product: value })
  t.mock.method(globalThis, 'fetch', async () => stream(': keepalive\r\n\r\n' + sse([
    { output: { search_info: { search_results: [] } } },
    { output: { choices: [{ finish_reason: 'null', message: { reasoning_content: 'private reasoning' } }] } },
    event(text.slice(0, 15)), event(text.slice(15), 'stop'),
  ]) + 'data: [DONE]\r\n\r\n', true))
  const response = await request()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), value)
})

test('quen no-match returns the existing 404 response', async t => {
  t.mock.method(globalThis, 'fetch', async () => answer(null))
  const response = await request()
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Product not found' })
})

test('quen rejects incomplete streams, in-stream errors and invalid products', async t => {
  for (const source of ['', sse([event('{}')]), sse([event('{}', 'length')]),
    sse([event('not JSON', 'stop')]), sse([event('{"product":{}}', 'stop')]),
    sse([event(JSON.stringify({ product }), 'stop'), { code: 'InvalidApiKey', message: 'caller-secret' }]),
    'data: not JSON\n\n', sse([event(JSON.stringify({ product }), 'stop')]).replace('data:', 'event:'),
  ]) {
    const provider = t.mock.method(globalThis, 'fetch', async () => stream(source))
    try {
      const response = await request()
      assert.equal(response.status, 502)
      assert.ok(!(await response.text()).includes('caller-secret'))
    } finally {
      provider.mock.restore()
    }
  }
})

test('quen accepts a final SSE event without a trailing blank line', async t => {
  t.mock.method(globalThis, 'fetch', async () => stream(sse([event(JSON.stringify({ product }), 'stop')]).trimEnd()))
  assert.equal((await request()).status, 200)
})

test('quen sanitizes upstream HTTP errors, network errors and invalid content types', async t => {
  for (const [response, status] of [[new Response('caller-secret', { status: 401 }), 502],
    [new Response('caller-secret', { status: 429 }), 503], [new Response('caller-secret', { status: 500 }), 502],
    [new Response(JSON.stringify({ product })), 502]]) {
    const provider = t.mock.method(globalThis, 'fetch', async () => response)
    try {
      const result = await request()
      assert.equal(result.status, status)
      assert.ok(!(await result.text()).includes('caller-secret'))
    } finally {
      provider.mock.restore()
    }
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('caller-secret') })
  const result = await request()
  assert.equal(result.status, 502)
  assert.ok(!(await result.text()).includes('caller-secret'))
})

test('quen maps timeouts and cancellation to the shared timeout error', async t => {
  for (const name of ['TimeoutError', 'AbortError']) {
    const provider = t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('caller-secret', name) })
    try {
      const result = await request()
      assert.equal(result.status, 504)
      assert.ok(!(await result.text()).includes('caller-secret'))
    } finally {
      provider.mock.restore()
    }
  }
  const controller = new AbortController()
  controller.abort()
  t.mock.method(globalThis, 'fetch', () => assert.fail('Cancelled request must not call Alibaba'))
  await assert.rejects(callQwen({ model: 'qwen3.8-flash', apiKey: 'caller-secret', signal: controller.signal }),
    error => error.status === 504)
})
