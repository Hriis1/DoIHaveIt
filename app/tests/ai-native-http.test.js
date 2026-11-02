import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'

let native = true
const request = mock.fn()
mock.module('@capacitor/core', { namedExports: {
  Capacitor: { isNativePlatform: () => native }, CapacitorHttp: { request },
} })
const { requestProviderJson } = await import('../src/modules/ai/http.js')
const options = { headers: { Authorization: 'Bearer test-only-key' }, data: { model: 'test' } }
const call = signal => requestProviderJson('https://api.example.com/lookup', { ...options, signal })
const settle = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => { native = true; request.mock.resetCalls() })

test('native JSON objects and string responses are parsed; invalid JSON is rejected', async () => {
  for (const data of [{ product: null }, '{"product":null}']) {
    request.mock.mockImplementation(async () => ({ status: 200, data }))
    assert.deepEqual(await call(), { product: null })
  }
  request.mock.mockImplementation(async () => ({ status: 200, data: 'not json' }))
  await assert.rejects(call(), /invalid product data/)
})

test('HTTP and native failures do not expose upstream bodies or credentials', async () => {
  for (const status of [301, 400, 401, 403, 429, 500]) {
    request.mock.mockImplementation(async () => ({ status, data: { error: 'private test-only-key' } }))
    await assert.rejects(call(), { message: status === 429
      ? 'AI provider rate limit exceeded. Please try again later.'
      : 'AI provider could not complete the lookup. Check API access and try again.' })
  }
  request.mock.mockImplementation(async () => { throw new Error('private test-only-key') })
  await assert.rejects(call(), { message: 'AI provider could not complete the lookup. Please try again.' })
  request.mock.mockImplementation(async () => { throw new Error('Read timed out: private test-only-key') })
  await assert.rejects(call(), { message: 'Product lookup timed out or was cancelled. Please try again.' })
})

test('browser mode and cancellation before native dispatch never start a request', async () => {
  native = false
  await assert.rejects(call(), /Open the Android or iOS app/)
  native = true
  const before = new AbortController()
  before.abort()
  await assert.rejects(call(before.signal), { name: 'AbortError' })
  const duringDispatch = new AbortController()
  const pending = call(duringDispatch.signal)
  duringDispatch.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(request.mock.callCount(), 0)
})

test('in-flight cancellation settles immediately and consumes late success or failure', async () => {
  for (const fail of [false, true]) {
    const response = deferred()
    request.mock.mockImplementation(() => response.promise)
    const controller = new AbortController()
    const removeListener = mock.method(controller.signal, 'removeEventListener')
    const pending = call(controller.signal)
    await Promise.resolve()
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(removeListener.mock.callCount(), 1)
    if (fail) response.reject(new Error('private late error'))
    else response.resolve({ status: 200, data: { product: null } })
    await settle()
  }
})

test('the total deadline is 30 seconds and consumes a later native rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const response = deferred()
  request.mock.mockImplementation(() => response.promise)
  const pending = call()
  const rejected = assert.rejects(pending, { message: 'Product lookup timed out or was cancelled. Please try again.' })
  await Promise.resolve()
  t.mock.timers.tick(30000)
  await rejected
  response.reject(new Error('private late failure'))
  await settle()
})

test('a completed request removes its abort listener and clears the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  request.mock.mockImplementation(async () => ({ status: 200, data: { product: null } }))
  const controller = new AbortController()
  const removeListener = t.mock.method(controller.signal, 'removeEventListener')
  assert.deepEqual(await call(controller.signal), { product: null })
  assert.equal(removeListener.mock.callCount(), 1)
  controller.abort()
  t.mock.timers.tick(30000)
  await settle()
})
