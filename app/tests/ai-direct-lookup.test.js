import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'

const request = mock.fn()
mock.module('@capacitor/core', { namedExports: {
  Capacitor: { isNativePlatform: () => true }, CapacitorHttp: { request },
} })
const { lookupProduct } = await import('../src/modules/ai/directProductLookup.js')
const { ProductLookupError } = await import('../src/modules/ai/errors.js')

const product = { brand: ' Brand ', name: ' Product ', size: ' 330 ml ' }
const answers = {
  gemini: text => ({ candidates: [{ finishReason: 'STOP', content: { parts: [
    { thought: true, text: 'not the answer' }, { text },
  ] } }] }),
  deepseek: text => ({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [
    { type: 'server_tool_use', name: 'web_search' }, { type: 'text', text },
  ] }),
  openai: text => ({ status: 'completed', output: [
    { type: 'web_search_call', status: 'completed' },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
  ] }),
}
const input = model => ({ barcode: ' 070847891857 ', model, apiKey: 'test-only-key' })
beforeEach(() => request.mock.resetCalls())

test('all providers send the Worker-equivalent request through native HTTP and validate the generated product', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Direct calls must use native HTTP'))
  const expected = {
    gemini: ['https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent', 'gemini-3.5-flash-lite'],
    deepseek: ['https://api.deepseek.com/anthropic/v1/messages', 'deepseek-flash'],
    openai: ['https://api.openai.com/v1/responses', 'gpt-6-luna'],
  }
  for (const model of Object.keys(answers)) {
    request.mock.mockImplementation(async options => {
      assert.equal(options.url, expected[model][0])
      assert.equal(options.method, 'POST')
      assert.equal(options.connectTimeout, 30000)
      assert.equal(options.readTimeout, 30000)
      assert.equal(options.responseType, 'json')
      assert.equal(options.headers['Content-Type'], 'application/json')
      const body = options.data
      let prompt
      let schema
      if (model === 'gemini') {
        assert.equal(options.headers['x-goog-api-key'], 'test-only-key')
        assert.equal(options.headers.Authorization, undefined)
        assert.deepEqual(body.tools, [{ google_search: {} }])
        assert.equal(body.generationConfig.responseMimeType, 'application/json')
        prompt = body.contents[0].parts[0].text
        schema = body.generationConfig.responseJsonSchema
      } else {
        assert.equal(options.headers.Authorization, 'Bearer test-only-key')
        assert.equal(body.model, expected[model][1])
        assert.equal(body.stream, false)
        if (model === 'deepseek') {
          assert.equal(body.max_tokens, 1000)
          assert.deepEqual(body.thinking, { type: 'disabled' })
          assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }])
          const [instructions, jsonSchema] = body.messages[0].content.split('\nJSON Schema: ')
          prompt = instructions
          schema = JSON.parse(jsonSchema)
        } else {
          assert.equal(body.store, false)
          assert.equal(body.max_output_tokens, 1000)
          assert.equal(body.max_tool_calls, 3)
          assert.deepEqual(body.reasoning, { effort: 'none' })
          assert.deepEqual(body.tools, [{ type: 'web_search' }])
          assert.equal(body.tool_choice, 'required')
          assert.equal(body.text.format.type, 'json_schema')
          assert.equal(body.text.format.name, 'product_lookup')
          assert.equal(body.text.format.strict, true)
          prompt = body.input
          schema = body.text.format.schema
        }
      }
      assert.ok(prompt.includes('Barcode: "070847891857"'))
      assert.ok(prompt.includes('Exclude the brand name'))
      assert.ok(prompt.includes('Omit generic category descriptions'))
      assert.ok(prompt.includes('Do not guess missing information.'))
      assert.deepEqual(schema.required, ['product'])
      assert.deepEqual(schema.properties.product.anyOf[0].required, ['brand', 'name', 'size'])
      assert.deepEqual(schema.properties.product.anyOf[1], { type: 'null' })
      assert.equal(schema.properties.product.anyOf[0].additionalProperties, false)
      return { status: 200, data: answers[model](JSON.stringify({ product })) }
    })
    assert.deepEqual(await lookupProduct(input(model)), { brand: 'Brand', name: 'Product', size: '330 ml' })
    assert.equal(request.mock.callCount(), Object.keys(answers).indexOf(model) + 1)
  }
})

test('all providers preserve unknown sizes and unidentified products and reject invalid generated JSON', async () => {
  for (const model of Object.keys(answers)) {
    request.mock.mockImplementation(async () => ({ status: 200, data: answers[model](JSON.stringify({ product: { ...product, size: null } })) }))
    assert.equal((await lookupProduct(input(model))).size, null)
    request.mock.mockImplementation(async () => ({ status: 200, data: answers[model]('{"product":null}') }))
    assert.equal(await lookupProduct(input(model)), null)
    for (const text of ['bad json', '{}', 'null', '[]', '{"product":null,"extra":1}',
      JSON.stringify({ product: { ...product, name: '' } }), JSON.stringify({ product: { brand: 'Brand', name: 'Product' } }),
      JSON.stringify({ product: { ...product, size: 330 } }), JSON.stringify({ product: { ...product, extra: 'private details' } }),
    ]) {
      request.mock.mockImplementation(async () => ({ status: 200, data: answers[model](text) }))
      await assert.rejects(lookupProduct(input(model)), { message: 'AI provider returned invalid product data.' })
    }
  }
})

test('refusals and incomplete generations are controlled errors for each provider', async () => {
  const incomplete = {
    gemini: [{ candidates: [] }, { candidates: [{ finishReason: 'MAX_TOKENS' }] }, { candidates: [{ finishReason: 'STOP', content: {} }] }],
    deepseek: ['max_tokens', 'pause_turn', 'tool_use', 'refusal'].map(stop_reason => ({ ...answers.deepseek(''), stop_reason })),
    openai: [{ ...answers.openai(''), status: 'incomplete' }, { ...answers.openai(''), error: { message: 'private' } },
      { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'private' }] }] }],
  }
  for (const model of Object.keys(answers)) {
    for (const data of [null, {}, ...incomplete[model]]) {
      request.mock.mockImplementation(async () => ({ status: 200, data }))
      await assert.rejects(lookupProduct(input(model)), error => {
        assert.ok(error instanceof ProductLookupError)
        assert.equal(error.message, 'AI provider returned an incomplete response.')
        return true
      })
    }
  }
})

test('invalid models and barcodes do not start native calls', async () => {
  for (const model of ['other', 'toString', '__proto__']) {
    await assert.rejects(lookupProduct(input(model)), /Model is not supported/)
  }
  await assert.rejects(lookupProduct({ ...input('gemini'), barcode: '' }), /barcode is required/)
  assert.equal(request.mock.callCount(), 0)
})
