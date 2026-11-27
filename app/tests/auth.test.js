import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createAuthApi, AuthRequestError } from '../src/modules/authApi.js'
import { createSessionStorage } from '../src/modules/sessionStorage.js'
import { validateCredentials } from '../src/modules/authValidation.js'
import { KeychainAccess } from '@aparajita/capacitor-secure-storage'

mock.module('@revenuecat/purchases-capacitor', { namedExports: { Purchases: {} } })
const { createAuth } = await import('../src/modules/auth.js')

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

function fixture(api = async () => ({ user, token }), preparePurchases = async () => () => {}) {
  let cached = null
  let savedToken = null
  const tokens = { getSessionToken: async () => savedToken, saveSessionToken: async value => { savedToken = value },
    deleteSessionToken: async () => { savedToken = null } }
  const users = { getCurrentUser: async () => cached, saveCurrentUser: async value => { cached = value },
    updateCurrentUserCredits: async (id, credits) => { if (cached?.id === id) cached = { ...cached, credits } },
    deleteCurrentUser: async () => { cached = null } }
  return { auth: createAuth({ api, tokens, users, preparePurchases, isNative: true }), tokens, users,
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

test('explicit balance refresh persists server credits and notifies subscribers, retaining cache offline', async () => {
  let offline = false
  const f = fixture(async action => {
    if (action === 'me' && offline) throw new Error('offline')
    return { user: action === 'me' ? { ...user, credits: 600 } : user, token }
  })
  await f.auth.signIn('login', credentials)
  const seen = []
  f.auth.subscribeCreditBalance(value => seen.push(value.credits))
  assert.equal((await f.auth.refreshCredits()).credits, 600)
  assert.equal(f.cached.credits, 600)
  assert.deepEqual(seen, [600])
  offline = true
  await assert.rejects(f.auth.refreshCredits(), /offline/)
  assert.equal(f.cached.credits, 600)
  assert.deepEqual(seen, [600])
})

test('a balance refresh cannot overwrite another account or a canceled session', async () => {
  let resolve
  const f = fixture(async action => action === 'me' ? new Promise(yes => { resolve = yes }) : { user, token })
  await f.auth.signIn('login', credentials)
  const refresh = f.auth.refreshCredits()
  await new Promise(yes => setImmediate(yes))
  await f.users.saveCurrentUser({ ...user, id: 5, credits: 20 })
  resolve({ user: { ...user, credits: 1000 } })
  await refresh
  assert.equal(f.cached.id, 5)
  assert.equal(f.cached.credits, 20)
  await f.users.saveCurrentUser(user)
  const controller = new AbortController()
  const canceled = f.auth.refreshCredits({ signal: controller.signal })
  await new Promise(yes => setImmediate(yes))
  controller.abort()
  resolve({ user: { ...user, credits: 1000 } })
  await assert.rejects(canceled, { name: 'AbortError' })
  assert.equal(f.cached.credits, user.credits)
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

test('credit responses update only the matching cached wallet and notify the badge after saving', async () => {
  const f = fixture()
  await f.auth.signIn('login', credentials)
  const updates = []
  const unsubscribe = f.auth.subscribeCreditBalance(value => {
    assert.equal(f.cached.credits, value.credits)
    updates.push(value)
  })
  await f.auth.updateCredits(user.id, 2)
  assert.deepEqual(f.cached, { ...user, credits: 2 })
  assert.deepEqual(updates, [{ ...user, credits: 2 }])
  await f.auth.updateCredits(user.id + 1, 100)
  assert.equal(f.cached.credits, 2)
  for (const invalid of [-1, '5', 1.5, null]) await assert.rejects(f.auth.updateCredits(user.id, invalid), /Invalid credit balance/)
  f.users.updateCurrentUserCredits = async () => { throw new Error('disk full') }
  await assert.rejects(f.auth.updateCredits(user.id, 0))
  assert.equal(updates.length, 1)
  unsubscribe()
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

test('delete API sends only a password and requires an explicit success response', async () => {
  let sent
  let response = Response.json({ success: true })
  const api = createAuthApi(async (url, options) => { sent = { url, ...options }; return response })
  assert.deepEqual(await api('delete', { token, credentials }), { success: true })
  assert.ok(sent.url.endsWith('/auth/delete'))
  assert.deepEqual(JSON.parse(sent.body), { password: credentials.password })
  assert.equal(sent.headers.Authorization, `Bearer ${token}`)
  response = Response.json({})
  await assert.rejects(api('delete', { token, credentials }), /did not confirm/)
  response = Response.json({ error: 'Password is incorrect.' }, { status: 403 })
  await assert.rejects(api('delete', { token, credentials }), error => error.status === 403)
})

test('account deletion clears only login state after server confirmation and notifies the badge', async () => {
  const calls = []
  const f = fixture(async (action, options) => {
    calls.push([action, options])
    return action === 'delete' ? { success: true } : { user, token }
  }, async id => { calls.push(['prepare', id]); return deleted => calls.push(['finish', deleted]) })
  await f.auth.signIn('login', credentials)
  const changes = []
  f.auth.subscribeCreditBalance(value => changes.push(value))
  await f.auth.deleteAccount(credentials.password)
  assert.equal(f.cached, null)
  assert.equal(f.token, null)
  assert.deepEqual(changes, [null])
  assert.deepEqual(calls[1], ['prepare', user.id])
  assert.deepEqual(calls[2], ['delete', { token, credentials: { password: credentials.password } }])
  assert.deepEqual(calls[3], ['finish', true])
  await f.auth.signIn('register', credentials)
  assert.deepEqual(await f.auth.getCurrentUser(), user)
})

test('failed deletion retains the login and releases purchase locking for retry', async () => {
  let fail = true
  const finished = []
  const f = fixture(async action => {
    if (action === 'delete') {
      if (fail) throw new Error('Cleanup failed')
      return { success: true }
    }
    return { user, token }
  }, async () => deleted => finished.push(deleted))
  await f.auth.signIn('login', credentials)
  await assert.rejects(f.auth.deleteAccount(''), /Enter your password/)
  await assert.rejects(f.auth.deleteAccount(credentials.password), /Cleanup failed/)
  assert.deepEqual(f.cached, user)
  assert.equal(f.token, token)
  assert.deepEqual(finished, [false])
  fail = false
  await f.auth.deleteAccount(credentials.password)
  assert.deepEqual(finished, [false, true])
})

test('phone cleanup failures can be retried without calling the deleted server account again', async () => {
  let remoteCalls = 0
  const f = fixture(async action => {
    if (action === 'delete') { remoteCalls++; return { success: true } }
    return { user, token }
  })
  await f.auth.signIn('login', credentials)
  const removeToken = f.tokens.deleteSessionToken
  f.tokens.deleteSessionToken = async () => { throw new Error('Storage unavailable') }
  await assert.rejects(f.auth.deleteAccount(credentials.password), /phone cleanup failed/)
  assert.equal(await f.auth.getCurrentUser(), null)
  assert.equal(f.cached, null)
  f.tokens.deleteSessionToken = removeToken
  await f.auth.deleteAccount(credentials.password)
  assert.equal(remoteCalls, 1)
  assert.equal(f.token, null)
})

test('duplicate deletion and late balance refresh cannot resurrect the deleted wallet', async () => {
  let finishDelete
  let finishRefresh
  const f = fixture(async action => {
    if (action === 'delete') return new Promise(resolve => { finishDelete = resolve })
    if (action === 'me') return new Promise(resolve => { finishRefresh = resolve })
    return { user, token }
  })
  await f.auth.signIn('login', credentials)
  const refreshing = f.auth.refreshCredits()
  await new Promise(resolve => setImmediate(resolve))
  const deleting = f.auth.deleteAccount(credentials.password)
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.auth.deleteAccount(credentials.password), /already in progress/)
  finishDelete({ success: true })
  await deleting
  finishRefresh({ user: { ...user, credits: 900 } })
  await refreshing
  assert.equal(f.cached, null)
  assert.equal(f.token, null)
})
