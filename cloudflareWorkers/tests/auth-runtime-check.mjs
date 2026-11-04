import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { credentials, schema } from './auth-fixture.js'

// Run explicitly with node tests/auth-runtime-check.mjs; all database state is local and temporary
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:*'],
})
const runtime = new Miniflare(convertV4MiniflareOptions({
  name: 'auth-runtime-check',
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-10-17',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'auth-check' },
  ratelimits: { AUTH_RATE_LIMITER: { namespace_id: '428871001', simple: { limit: 10, period: 60 } } },
}))

try {
  const database = await runtime.getD1Database('DB')
  await database.batch(schema.split(';').map(sql => sql.trim()).filter(sql => sql && !sql.startsWith('PRAGMA'))
    .map(sql => database.prepare(sql)))
  const request = (action, { body, token } = {}) => runtime.dispatchFetch(`https://example.com/auth/${action}`, {
    method: action === 'me' ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const registered = await request('register', { body: credentials })
  assert.equal(registered.status, 201, await registered.clone().text())
  const first = await registered.json()
  const login = await request('login', { body: credentials })
  assert.equal(login.status, 200, await login.clone().text())
  const second = await login.json()
  assert.notEqual(first.token, second.token)
  const me = await request('me', { token: second.token })
  assert.equal(me.status, 200)
  assert.deepEqual(await me.json(), { user: first.user })
  assert.equal((await request('logout', { token: second.token })).status, 200)
  assert.equal((await request('me', { token: second.token })).status, 401)
  assert.equal((await request('me', { token: first.token })).status, 200)
  assert.equal((await request('register', { body: credentials })).status, 409)

  await database.prepare("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END;").run()
  const failed = await request('register', { body: { ...credentials, email: 'rollback@example.com' } })
  assert.equal(failed.status, 503)
  assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM users').first()).n, 1)
  console.log('Native auth runtime check passed: register, login, me, logout, multiple sessions, duplicate email, and D1 rollback.')
} finally {
  await runtime.dispose()
}
