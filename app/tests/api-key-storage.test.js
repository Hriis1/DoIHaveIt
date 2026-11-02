import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KeychainAccess } from '@aparajita/capacitor-secure-storage'
import { createApiKeyStorage } from '../src/modules/apiKeyStorage.js'

function nativeStore() {
  const values = new Map()
  const calls = []
  const storage = {
    async set(...args) { calls.push(['set', ...args]); values.set(args[0], args[1]) },
    async get(...args) { calls.push(['get', ...args]); return values.get(args[0]) ?? null },
    async remove(...args) { calls.push(['remove', ...args]); return values.delete(args[0]) },
  }
  return { storage, calls, api: createApiKeyStorage({ isNativePlatform: () => true }, storage) }
}

test('native keys stay separate by provider, can be replaced and deleted, and survive a new JS instance', async () => {
  const { api, storage } = nativeStore()
  assert.equal(await api.getApiKey('gemini'), null)
  await api.saveApiKey(' Gemini ', ' first-key ')
  await api.saveApiKey('openai', 'other-key')
  await api.saveApiKey('gemini', 'replacement')
  const restarted = createApiKeyStorage({ isNativePlatform: () => true }, storage)
  assert.equal(await restarted.getApiKey('GEMINI'), 'replacement')
  assert.equal(await restarted.getApiKey('openai'), 'other-key')
  await api.deleteApiKey('gemini')
  await api.deleteApiKey('gemini')
  assert.equal(await api.getApiKey('gemini'), null)
  assert.equal(await api.getApiKey('openai'), 'other-key')
})

test('native operations explicitly disable sync, date conversion, and migration', async () => {
  const { api, calls } = nativeStore()
  await api.saveApiKey('deepseek', '2026-11-02')
  assert.equal(await api.getApiKey('deepseek'), '2026-11-02')
  await api.deleteApiKey('deepseek')
  assert.deepEqual(calls, [
    ['set', 'doihaveit.api-key.deepseek', '2026-11-02', false, false, KeychainAccess.whenUnlockedThisDeviceOnly],
    ['get', 'doihaveit.api-key.deepseek', false, false],
    ['remove', 'doihaveit.api-key.deepseek', false],
  ])
})

test('browser keys live only in memory and never call the native plugin', async () => {
  const plugin = new Proxy({}, { get() { throw new Error('Plugin must not be used on the web') } })
  const platform = { isNativePlatform: () => false }
  const api = createApiKeyStorage(platform, plugin)
  await api.saveApiKey('gemini', 'temporary-key')
  assert.equal(await api.getApiKey('gemini'), 'temporary-key')
  const reloaded = createApiKeyStorage(platform, plugin)
  assert.equal(await reloaded.getApiKey('gemini'), null)
  await api.deleteApiKey('gemini')
  assert.equal(await api.getApiKey('gemini'), null)
})

test('invalid input is rejected before accessing storage', async () => {
  const { api, calls } = nativeStore()
  for (const provider of [null, '', ' ', 'gemini/openai', 12]) {
    await assert.rejects(api.saveApiKey(provider, 'key'), /valid API provider/)
    await assert.rejects(api.getApiKey(provider), /valid API provider/)
    await assert.rejects(api.deleteApiKey(provider), /valid API provider/)
  }
  for (const value of [null, '', ' ', 12]) {
    await assert.rejects(api.saveApiKey('gemini', value), /API key is required/)
  }
  assert.deepEqual(calls, [])
})

test('native failures are redacted, never treated as missing keys, and can be retried', async () => {
  const { api, storage } = nativeStore()
  for (const [method, invoke] of [
    ['set', () => api.saveApiKey('gemini', 'secret-key')],
    ['get', () => api.getApiKey('gemini')],
    ['remove', () => api.deleteApiKey('gemini')],
  ]) {
    const original = storage[method]
    storage[method] = async () => { throw new Error('Native error with secret-key') }
    await assert.rejects(invoke(), error => {
      assert.equal(error.message, 'Could not access secure API key storage. Please try again.')
      assert.equal(error.cause, undefined)
      return true
    })
    storage[method] = original
  }
  assert.equal(await api.getApiKey('gemini'), null)
  await api.saveApiKey('gemini', 'retry-key')
  assert.equal(await api.getApiKey('gemini'), 'retry-key')
})

test('corrupt non-string native data is rejected', async () => {
  const { api, storage } = nativeStore()
  storage.get = async () => ({ unexpected: 'data' })
  await assert.rejects(api.getApiKey('gemini'), /Could not access secure API key storage/)
})
