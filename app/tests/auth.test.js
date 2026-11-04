import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAuthApi, AuthRequestError } from '../src/modules/authApi.js'
import { createAuth } from '../src/modules/auth.js'
import { createSessionStorage } from '../src/modules/sessionStorage.js'
import { validateCredentials } from '../src/modules/authValidation.js'
import { KeychainAccess } from '@aparajita/capacitor-secure-storage'

const user = { id: 4, email: 'user@example.com', credits: 12 }
const token = 'a'.repeat(64)
const credentials = { email: user.email, password: 'Password!8', confirmPassword: 'Password!8' }

test('forms require filled fields, valid email, registration password rules and matching confirmation', () => {
  assert.equal(validateCredentials(credentials, true), null)
  assert.equal(validateCredentials({ ...credentials, email: ' USER@example.COM ' }, true), null)
  for (const [values, field] of [
    [{ email: ' ' }, 'email'], [{ password: '' }, 'password'], [{ confirmPassword: '' }, 'confirm-password'],
    [{ email: 'user..name@example.com' }, 'email'], [{ password: 'short' }, 'password'],
    [{ password: 'with space' }, 'password'], [{ password: '1234567\u0000' }, 'password'],
    [{ password: 'a'.repeat(129) }, 'password'], [{ confirmPassword: 'Different!8' }, 'confirm-password'],
  ]) assert.equal(validateCredentials({ ...credentials, ...values }, true).field, field)
  assert.equal(validateCredentials({ ...credentials, confirmPassword: '' }, false), null)
})

test('auth API sends only email/password for forms and a bearer token for me', async () => {
  const calls = []
  const api = createAuthApi(async (url, options) => {
    calls.push({ url, ...options })
    return Response.json({ user, token })
  })
  assert.deepEqual(await api('register', { credentials }), { user, token })
  assert.equal(calls[0].url, 'https://doihaveit-api.hrishd.workers.dev/auth/register')
  assert.deepEqual(JSON.parse(calls[0].body), { email: user.email, password: credentials.password })
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(await api('me', { token }), { user })
  assert.equal(calls[1].headers.Authorization, `Bearer ${token}`)
  assert.equal(calls[1].method, 'GET')
  assert.equal(calls[1].body, undefined)
})

test('auth API surfaces Worker errors, rejects malformed successes and supports retry', async () => {
  let response = Response.json({ error: 'Email or password is incorrect.' }, { status: 401 })
  const api = createAuthApi(async () => response)
  await assert.rejects(api('login', { credentials }), error => error.status === 401 && /incorrect/.test(error.message))
  response = new Response('invalid')
  await assert.rejects(api('login', { credentials }), /Could not read/)
  for (const invalid of [{}, { user, token: 'bad' }, { user: { ...user, credits: -1 }, token }]) {
    response = Response.json(invalid)
    await assert.rejects(api('login', { credentials }), /invalid account data/)
  }
  response = Response.json({ user, token })
  assert.deepEqual(await api('login', { credentials }), { user, token })
})

test('auth API aborts pending requests and does not expose transport errors', async () => {
  const controller = new AbortController()
  const api = createAuthApi((_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const pending = api('login', { credentials, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  await assert.rejects(createAuthApi(async () => { throw new Error('secret transport details') })('me', { token }), /Could not connect/)
})

function fixture(api = async () => ({ user, token })) {
  let cached = null
  let savedToken = null
  const tokens = { getSessionToken: async () => savedToken, saveSessionToken: async value => { savedToken = value },
    deleteSessionToken: async () => { savedToken = null } }
  const users = { getCurrentUser: async () => cached, saveCurrentUser: async value => { cached = value },
    deleteCurrentUser: async () => { cached = null } }
  return { auth: createAuth({ api, tokens, users, isNative: true }), tokens, users,
    get cached() { return cached }, get token() { return savedToken } }
}

test('successful sign-in stores only the session and wallet summary and restores updated credits', async () => {
  const calls = []
  const f = fixture(async (action, options) => {
    calls.push([action, options])
    return { user: action === 'me' ? { ...user, credits: 3 } : user, token }
  })
  assert.deepEqual(await f.auth.restoreSession(), { state: 'login' })
  await f.auth.signIn('register', credentials)
  assert.deepEqual(f.cached, user)
  assert.equal(f.token, token)
  assert.equal((await f.auth.restoreSession()).state, 'authenticated')
  assert.equal(f.cached.credits, 3)
  assert.equal(calls[1][1].token, token)
  assert.equal(calls[1][1].credentials, undefined)
})

test('expired sessions clear the wallet cache, while connection failures preserve offline access', async () => {
  let fail = false
  const f = fixture(async action => {
    if (action === 'me') throw new AuthRequestError('Unavailable', fail ? 401 : 503)
    return { user, token }
  })
  await f.auth.signIn('login', credentials)
  assert.deepEqual(await f.auth.restoreSession(), { state: 'offline', user })
  assert.equal(f.token, token)
  fail = true
  assert.equal((await f.auth.restoreSession()).state, 'login')
  assert.equal(f.cached, null)
  assert.equal(f.token, null)
})

test('cancelled sign-in never starts storage writes and failed wallet writes remove the new token', async () => {
  const controller = new AbortController()
  const f = fixture(async () => { controller.abort(); return { user, token } })
  await assert.rejects(f.auth.signIn('login', credentials, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(f.token, null)
  f.users.saveCurrentUser = async () => { throw new Error('disk full') }
  const other = createAuth({ api: async () => ({ user, token }), tokens: f.tokens, users: f.users, isNative: true })
  await assert.rejects(other.signIn('login', credentials), /Could not save your account/)
  assert.equal(f.token, null)
})

test('session storage survives native JS instances and disables sync and migration; web is memory only', async () => {
  const values = new Map()
  const calls = []
  const storage = {
    set: async (...args) => { calls.push(args); values.set(args[0], args[1]) },
    get: async key => values.get(key) ?? null,
    remove: async key => { values.delete(key) },
  }
  const native = { isNativePlatform: () => true }
  const first = createSessionStorage(native, storage)
  await first.saveSessionToken(token)
  assert.deepEqual(calls[0], ['doihaveit.auth.session', token, false, false, KeychainAccess.whenUnlockedThisDeviceOnly])
  const second = createSessionStorage(native, storage)
  assert.equal(await second.getSessionToken(), token)
  await second.deleteSessionToken()
  assert.equal(await first.getSessionToken(), null)
  storage.get = async () => { throw new Error(token) }
  await assert.rejects(first.getSessionToken(), error => !error.message.includes(token))
  const web = { isNativePlatform: () => false }
  const memory = createSessionStorage(web, storage)
  await memory.saveSessionToken(token)
  assert.equal(await memory.getSessionToken(), token)
  assert.equal(await createSessionStorage(web, storage).getSessionToken(), null)
})
