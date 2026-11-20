import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPurchaseApi } from '../src/modules/purchaseApi.js'

test('purchase status uses the session token and URL-encoded transaction, validating the response', async () => {
  const calls = []
  const api = createPurchaseApi({ getToken: async () => 'session', request: async (url, options) => {
    calls.push({ url, ...options })
    return Response.json({ status: 'granted', credits: 100 })
  } })
  assert.deepEqual(await api('order/a?b'), { status: 'granted', credits: 100 })
  assert.match(calls[0].url, /order%2Fa%3Fb$/)
  assert.equal(calls[0].headers.Authorization, 'Bearer session')
})

test('purchase status rejects missing sessions, malformed responses and upstream error details', async () => {
  await assert.rejects(createPurchaseApi({ getToken: async () => null })('order'), /log in/)
  for (const response of [Response.json({ status: 'unknown', credits: 100 }),
    Response.json({ status: 'granted', credits: -1 }), new Response('bad JSON'),
    Response.json({ error: 'private' }, { status: 401 })]) {
    const api = createPurchaseApi({ getToken: async () => 'token', request: async () => response })
    await assert.rejects(api('order'), /Could not confirm/)
  }
})

test('cancellation before dispatch and while waiting stops purchase status requests', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const api = createPurchaseApi({ getToken: async () => 'token', request: async () => { calls++; return Response.json({}) } })
  await assert.rejects(api('order', { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls, 0)
  const pendingController = new AbortController()
  const waiting = createPurchaseApi({ getToken: async () => 'token', request: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) })
  const request = waiting('order', { signal: pendingController.signal })
  await new Promise(resolve => setImmediate(resolve))
  pendingController.abort()
  await assert.rejects(request, { name: 'AbortError' })
})
