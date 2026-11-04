import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hashPassword, hashSessionToken, verifyPassword } from '../src/auth/credentials.js'
import { authFixture, credentials } from './auth-fixture.js'

test('registration creates a zero-credit user and hashed 256-bit session expiring in 30 days', async t => {
  const { request, database, limitKeys } = authFixture(t)
  const before = Date.now()
  const response = await request('register', { body: { ...credentials, email: ' User@Example.COM ' } })
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
  const result = await response.json()
  assert.deepEqual(Object.keys(result).sort(), ['token', 'user'])
  assert.deepEqual(result.user, { id: 1, email: credentials.email, credits: 0 })
  assert.match(result.token, /^[a-f0-9]{64}$/)
  const user = database.prepare('SELECT * FROM users').get()
  assert.notEqual(user.password_hash, credentials.password)
  assert.match(user.password_hash, /^sha256\$[a-f0-9]{32}\$[a-f0-9]{64}$/)
  assert.equal(verifyPassword(credentials.password, user.password_hash), true)
  const session = database.prepare('SELECT * FROM sessions').get()
  assert.equal(session.user_id, 1)
  assert.equal(session.token_hash, hashSessionToken(result.token))
  assert.notEqual(session.token_hash, result.token)
  const expires = Date.parse(session.expires_at.replace(' ', 'T') + 'Z')
  assert.ok(expires >= before + 30 * 86400000 - 1000)
  assert.ok(expires <= Date.now() + 30 * 86400000)
  assert.deepEqual(limitKeys, ['192.0.2.1'])
  assert.equal(JSON.stringify(result).includes('password'), false)
})

test('login keeps other devices signed in and me reads current credits without extending expiry', async t => {
  const { request, database } = authFixture(t)
  const first = await (await request('register', { body: credentials })).json()
  const login = await request('login', { body: { ...credentials, email: 'USER@EXAMPLE.COM' } })
  assert.equal(login.status, 200)
  const second = await login.json()
  assert.notEqual(second.token, first.token)
  assert.deepEqual(second.user, first.user)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 2)
  database.exec('UPDATE users SET credits = 19;')
  const expiry = database.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hashSessionToken(first.token)).expires_at
  for (const token of [first.token, second.token]) {
    const me = await request('me', { token })
    assert.equal(me.status, 200)
    assert.equal(me.headers.get('Cache-Control'), 'no-store')
    assert.deepEqual(await me.json(), { user: { id: 1, email: credentials.email, credits: 19 } })
  }
  assert.equal(database.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hashSessionToken(first.token)).expires_at, expiry)
})

test('unknown email and wrong password return the same safe error without creating sessions', async t => {
  const { request, database } = authFixture(t)
  await request('register', { body: credentials })
  for (const body of [{ ...credentials, password: 'Wrong!123' }, { ...credentials, email: 'unknown@example.com' }]) {
    const response = await request('login', { body })
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Email or password is incorrect.' })
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1)
})

test('logout revokes only the presented session and is safe to repeat', async t => {
  const { request, database } = authFixture(t)
  const first = await (await request('register', { body: credentials })).json()
  const second = await (await request('login', { body: credentials })).json()
  for (let retry = 0; retry < 2; retry++) {
    const logout = await request('logout', { token: first.token })
    assert.equal(logout.status, 200)
    assert.deepEqual(await logout.json(), { success: true })
  }
  assert.equal((await request('me', { token: first.token })).status, 401)
  assert.equal((await request('me', { token: second.token })).status, 200)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
})

test('me rejects missing, malformed, unknown and expired tokens', async t => {
  const { request, database } = authFixture(t)
  for (const token of [undefined, 'bad', '0'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
    assert.equal((await request('me', { token })).status, 401)
  }
  assert.equal((await request('logout')).status, 401)
  const registered = await (await request('register', { body: credentials })).json()
  database.exec("UPDATE sessions SET expires_at = datetime('now', '-1 second');")
  const expired = await request('me', { token: registered.token })
  assert.equal(expired.status, 401)
  assert.match((await expired.json()).error, /expired or is invalid/)
  assert.equal((await request('me', { headers: { Authorization: `Basic ${registered.token}` } })).status, 401)
})

test('registration rejects duplicate emails including case differences and concurrent requests', async t => {
  const { request, database } = authFixture(t)
  const responses = await Promise.all([
    request('register', { body: credentials }),
    request('register', { body: { ...credentials, email: 'USER@EXAMPLE.COM', password: 'Other!123' } }),
  ])
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409])
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1)
  const duplicate = responses.find(response => response.status === 409)
  assert.deepEqual(await duplicate.json(), { error: 'An account with this email already exists.' })
})

test('first-session database failure rolls back registration and never exposes database details', async t => {
  const { request, database } = authFixture(t)
  database.exec("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'private database details'); END;")
  const response = await request('register', { body: credentials })
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'Authentication could not be completed. Please try again.' })
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0)
})

test('credential input rejects short passwords, whitespace, controls, invalid email and injected credit fields', async t => {
  const { request, database } = authFixture(t)
  for (const action of ['register', 'login']) {
    for (const body of [null, [], {}, 'text', { email: credentials.email }, { ...credentials, email: 'not-an-email' },
      { ...credentials, email: 'user\u0000@example.com' },
      { ...credentials, email: 'a'.repeat(255) + '@example.com' }, { ...credentials, password: 12345678 },
      ...['1234567', '12345678 ', ' 12345678', '1234 678', '1234\t678', '1234\n678', '1234\u0000678', 'a'.repeat(129)]
        .map(password => ({ ...credentials, password })),
      { ...credentials, credits: 500 }, { ...credentials, id: 1 }, { ...credentials, token: 'arbitrary' },
    ]) {
      const response = await request(action, { body })
      assert.equal(response.status, 400, JSON.stringify(body))
    }
    assert.equal((await request(action, { raw: '{' })).status, 400)
    assert.equal((await request(action, { raw: 'x'.repeat(4097) })).status, 413)
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)
})

test('eight visible characters are sufficient, Unicode is supported and values are parameterized', async t => {
  const { request } = authFixture(t)
  const body = { email: "o'connor@example.com", password: 'Парола!8' }
  assert.equal((await request('register', { body })).status, 201)
  assert.equal((await request('login', { body })).status, 200)
})

test('rate limiting stops registration and login before any database writes and returns a retry delay', async t => {
  const { request, database, env } = authFixture(t)
  env.AUTH_RATE_LIMITER.limit = async () => ({ success: false })
  for (const action of ['register', 'login']) {
    const response = await request(action, { body: credentials })
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('Retry-After'), '60')
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)
})

test('routes allow only their intended methods and CORS preflight requires no database', async t => {
  const { request } = authFixture(t)
  for (const action of ['register', 'login', 'me', 'logout']) {
    const method = action === 'me' ? 'GET' : 'POST'
    const preflight = await request(action, { method: 'OPTIONS', bindings: {} })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), `${method}, OPTIONS`)
    assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type, Authorization')
    assert.equal(await preflight.text(), '')
    const wrong = await request(action, { method: method === 'GET' ? 'POST' : 'GET', bindings: {} })
    assert.equal(wrong.status, 405)
    assert.equal(wrong.headers.get('Allow'), `${method}, OPTIONS`)
  }
  assert.equal((await request('unknown', { method: 'GET' })).status, 404)
})

test('missing bindings and database errors return controlled failures', async t => {
  const { request, env } = authFixture(t)
  assert.equal((await request('me', { token: 'a'.repeat(64), bindings: {} })).status, 503)
  assert.equal((await request('login', { body: credentials, bindings: { DB: env.DB } })).status, 503)
  env.DB.prepare = () => { throw new Error('private password_hash and token details') }
  const response = await request('me', { token: 'a'.repeat(64) })
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'Authentication could not be completed. Please try again.' })
})

test('password hashes use unique salts and reject malformed hash metadata', () => {
  const first = hashPassword(credentials.password)
  const second = hashPassword(credentials.password)
  assert.notEqual(first, second)
  assert.equal(verifyPassword(credentials.password, first), true)
  assert.equal(verifyPassword('Wrong!123', first), false)
  assert.equal(verifyPassword(credentials.password, first.replace('sha256$', 'unknown$')), false)
  assert.equal(verifyPassword(credentials.password, first + '$extra'), false)
  assert.equal(verifyPassword(credentials.password, null), false)
  assert.equal(verifyPassword(credentials.password, 'broken'), false)
})
