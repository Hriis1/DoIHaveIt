import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authFixture, credentials } from './auth-fixture.js'
import { deleteRevenueCatCustomer } from '../src/revenuecat.js'

async function setup(t) {
  const f = authFixture(t)
  f.database.exec(`CREATE TABLE purchases (
    id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, transaction_id TEXT UNIQUE
  );`)
  const first = await (await f.request('register', { body: credentials })).json()
  const second = await (await f.request('register', { body: { ...credentials, email: 'other@example.com' } })).json()
  await f.request('login', { body: credentials })
  f.env.REVENUECAT_SECRET_API_KEY = 'secret-for-tests'
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options])
    return new Response(null, { status: 404 })
  })
  return { ...f, first, second, calls,
    remove: options => f.request('delete', { token: first.token, body: { password: credentials.password }, ...options }) }
}

test('account deletion removes only its purchases, every session and wallet after RevenueCat cleanup', async t => {
  const f = await setup(t)
  f.database.exec(`INSERT INTO purchases VALUES (1, ${f.first.user.id}, 'first'), (2, ${f.second.user.id}, 'second');`)
  const response = await f.remove()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { success: true })
  assert.equal(f.calls[0][0], `https://api.revenuecat.com/v1/subscribers/${f.first.user.id}`)
  assert.equal(f.calls[0][1].method, 'DELETE')
  assert.equal(f.calls[0][1].headers.Authorization, 'Bearer secret-for-tests')
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(f.first.user.id).n, 0)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(f.first.user.id).n, 0)
  assert.equal(f.database.prepare('SELECT user_id FROM purchases').get().user_id, f.second.user.id)
  assert.equal((await f.request('me', { token: f.second.token })).status, 200)
  assert.equal((await f.request('me', { token: f.first.token })).status, 401)
  const recreated = await (await f.request('register', { body: credentials })).json()
  assert.notEqual(recreated.user.id, f.first.user.id)
  assert.equal(recreated.user.credits, 0)
})

test('no purchases and no RevenueCat customer do not prevent deletion', async t => {
  const f = await setup(t)
  assert.equal((await f.remove()).status, 200)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
})

test('wrong passwords, missing sessions, invalid bodies and throttling cannot delete or call RevenueCat', async t => {
  const f = await setup(t)
  assert.equal((await f.remove({ body: { password: 'Wrong!123' } })).status, 403)
  assert.equal((await f.remove({ token: null })).status, 401)
  assert.equal((await f.remove({ body: { password: credentials.password, user_id: f.second.user.id } })).status, 400)
  assert.equal((await f.remove({ body: { password: '' } })).status, 400)
  f.env.AUTH_RATE_LIMITER.limit = async () => ({ success: false })
  assert.equal((await f.remove()).status, 429)
  assert.equal(f.calls.length, 0)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2)
  assert.equal((await f.request('delete', { method: 'GET' })).status, 405)
  assert.equal((await f.request('delete', { method: 'OPTIONS' })).status, 204)
})

test('RevenueCat failure or missing secret leaves the account, purchases and sessions unchanged', async t => {
  const f = await setup(t)
  f.database.exec(`INSERT INTO purchases VALUES (1, ${f.first.user.id}, 'keep');`)
  const before = JSON.stringify(['users', 'sessions', 'purchases'].map(table => f.database.prepare(`SELECT * FROM ${table}`).all()))
  for (const status of [401, 429, 500]) {
    globalThis.fetch = async () => new Response('private upstream details', { status })
    const response = await f.remove()
    assert.equal(response.status, 503)
    assert.doesNotMatch(await response.text(), /private upstream details|secret-for-tests/)
  }
  globalThis.fetch = async () => { throw new Error('secret-for-tests') }
  assert.equal((await f.remove()).status, 503)
  delete f.env.REVENUECAT_SECRET_API_KEY
  assert.equal((await f.remove()).status, 503)
  assert.equal(JSON.stringify(['users', 'sessions', 'purchases'].map(table => f.database.prepare(`SELECT * FROM ${table}`).all())), before)
})

test('a database failure rolls back all local deletion even after RevenueCat was cleaned', async t => {
  const f = await setup(t)
  f.database.exec(`INSERT INTO purchases VALUES (1, ${f.first.user.id}, 'keep');
    CREATE TRIGGER fail_user_deletion BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'test failure'); END;`)
  assert.equal((await f.remove()).status, 503)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 3)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM purchases').get().n, 1)
})

test('RevenueCat queued deletion is verified by repeated DELETE; timeout and endless queuing fail', async () => {
  let attempts = 0
  const options = { pause: async () => {}, request: async () => new Response(null, { status: ++attempts < 3 ? 200 : 404 }) }
  await deleteRevenueCatCustomer(7, 'secret', options)
  assert.equal(attempts, 3)
  await assert.rejects(deleteRevenueCatCustomer(7, 'secret', { ...options, signal: AbortSignal.abort() }), /not been deleted/)
  await assert.rejects(deleteRevenueCatCustomer(7, 'secret', { ...options,
    request: async () => new Response(null, { status: 200 }) }), /not been deleted/)
})
