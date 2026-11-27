import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../src/index.js'
import { authFixture, credentials } from './auth-fixture.js'

const purchaseSchema = `
  CREATE TABLE purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    store TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('PRODUCTION', 'SANDBOX')),
    transaction_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    credits INTEGER NOT NULL CHECK (typeof(credits) = 'integer' AND credits > 0),
    status TEXT NOT NULL CHECK (status IN ('granted', 'refunded')),
    granted_at TEXT, refunded_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (store, environment, transaction_id)
  );
  CREATE INDEX purchases_user_id ON purchases(user_id);
`

async function setup(t) {
  const fixture = authFixture(t)
  fixture.database.exec(purchaseSchema)
  const { user, token } = await (await fixture.request('register', { body: credentials })).json()
  const env = { ...fixture.env, REVENUECAT_APP_ID: 'app123', REVENUECAT_WEBHOOK_SECRET: 'test-secret' }
  const event = { id: 'event1', type: 'NON_RENEWING_PURCHASE', app_id: 'app123', app_user_id: String(user.id),
    store: 'PLAY_STORE', environment: 'PRODUCTION', product_id: 'doihaveit_credits_100', transaction_id: 'order1' }
  const webhook = (changes = {}, bindings = env, authorization = 'Bearer test-secret') => worker.fetch(new Request('https://example.com/webhooks/revenuecat', {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ event: { ...event, ...changes } }),
  }), bindings)
  const status = (transaction = 'order1', authToken = token) => worker.fetch(new Request(`https://example.com/purchases/status?transaction_id=${encodeURIComponent(transaction)}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  }), env)
  const balance = () => fixture.database.prepare('SELECT credits FROM users WHERE id = ?').get(user.id).credits
  return { ...fixture, env, user, token, webhook, status, balance }
}

test('webhook grants each pack once, independent of event ID and client-supplied credit amounts', async t => {
  const f = await setup(t)
  for (const amount of [100, 600, 1300]) {
    const data = { transaction_id: `order${amount}`, product_id: `doihaveit_credits_${amount}`, credits: 999999 }
    const results = await Promise.all([f.webhook(data), f.webhook({ ...data, id: 'duplicate-event' })])
    assert.deepEqual(results.map(result => result.status), [200, 200])
  }
  assert.equal(f.balance(), 2000)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM purchases').get().count, 3)
  assert.ok(f.database.prepare('SELECT granted_at FROM purchases LIMIT 1').get().granted_at)
})

test('refunds subtract once, preserve unrelated remaining balance and never create debt', async t => {
  const f = await setup(t)
  await f.webhook()
  f.database.exec('UPDATE users SET credits = 180;')
  await Promise.all([f.webhook({ type: 'CANCELLATION' }), f.webhook({ type: 'CANCELLATION', id: 'second' })])
  assert.equal(f.balance(), 80)
  await f.webhook({ transaction_id: 'order2' })
  f.database.exec('UPDATE users SET credits = 20;')
  await f.webhook({ type: 'CANCELLATION', transaction_id: 'order2' })
  assert.equal(f.balance(), 0)
  await f.webhook({ transaction_id: 'order2' })
  assert.equal(f.balance(), 0)
})

test('refund before purchase is a tombstone and does not spend other credits', async t => {
  const f = await setup(t)
  f.database.exec('UPDATE users SET credits = 40;')
  await f.webhook({ type: 'CANCELLATION' })
  await f.webhook()
  assert.equal(f.balance(), 40)
  const purchase = f.database.prepare('SELECT * FROM purchases').get()
  assert.equal(purchase.status, 'refunded')
  assert.equal(purchase.granted_at, null)
  assert.ok(purchase.refunded_at)
})

test('sandbox purchases grant any existing user credits and support duplicate protection and refunds', async t => {
  const f = await setup(t)
  const other = await (await f.request('register', { body: { ...credentials, email: 'tester@example.com' } })).json()
  const purchase = { environment: 'SANDBOX', app_user_id: String(other.user.id) }
  await f.webhook(purchase)
  await f.webhook({ ...purchase, id: 'duplicate' })
  const balance = () => f.database.prepare('SELECT credits FROM users WHERE id = ?').get(other.user.id).credits
  assert.equal(balance(), 100)
  await f.webhook({ ...purchase, type: 'CANCELLATION' })
  await f.webhook({ ...purchase, type: 'CANCELLATION', id: 'duplicate-refund' })
  assert.equal(balance(), 0)
  await f.webhook({ environment: 'PRODUCTION' })
  assert.equal(f.balance(), 100)
})

test('authentication, configuration and applicable event validation fail closed', async t => {
  const f = await setup(t)
  assert.equal((await f.webhook({}, f.env, 'Bearer wrong')).status, 401)
  assert.equal((await f.webhook({}, { ...f.env, REVENUECAT_WEBHOOK_SECRET: '' })).status, 503)
  assert.equal((await f.webhook({}, { ...f.env, REVENUECAT_APP_ID: '' })).status, 503)
  for (const invalid of [{ environment: 'bad' }, { app_user_id: '0' }, { app_user_id: '01' },
    { app_user_id: '9007199254740992' }, { transaction_id: '' }, { quantity: 2 }, { app_user_id: '99' }]) {
    assert.equal((await f.webhook(invalid)).status, 400)
  }
  for (const ignored of [{ app_id: 'other' }, { product_id: 'unknown' }, { store: 'APP_STORE' }, { type: 'RENEWAL' }, { type: 'TEST' }]) {
    assert.equal((await f.webhook(ignored)).status, 200)
  }
  assert.equal(f.balance(), 0)
})

test('conflicting ownership or products cannot modify the original purchase or wallets', async t => {
  const f = await setup(t)
  await f.webhook()
  const other = await (await f.request('register', { body: { ...credentials, email: 'other@example.com' } })).json()
  assert.equal((await f.webhook({ app_user_id: String(other.user.id), type: 'CANCELLATION' })).status, 503)
  assert.equal((await f.webhook({ product_id: 'doihaveit_credits_600' })).status, 503)
  assert.equal(f.balance(), 100)
  assert.equal(f.database.prepare('SELECT credits FROM users WHERE id = ?').get(other.user.id).credits, 0)
})

test('database failures roll back both purchase markers and wallet changes; retries recover', async t => {
  const f = await setup(t)
  f.database.exec(`CREATE TRIGGER reject_grant BEFORE UPDATE OF granted_at ON purchases BEGIN SELECT RAISE(ABORT, 'test failure'); END;`)
  assert.equal((await f.webhook()).status, 503)
  assert.equal(f.balance(), 0)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM purchases').get().count, 0)
  f.database.exec('DROP TRIGGER reject_grant;')
  assert.equal((await f.webhook()).status, 200)
  f.database.exec(`CREATE TRIGGER reject_refund BEFORE UPDATE OF refunded_at ON purchases BEGIN SELECT RAISE(ABORT, 'test failure'); END;`)
  assert.equal((await f.webhook({ type: 'CANCELLATION' })).status, 503)
  assert.equal(f.balance(), 100)
  assert.equal(f.database.prepare('SELECT status FROM purchases').get().status, 'granted')
  f.database.exec('DROP TRIGGER reject_refund;')
  await f.webhook({ type: 'CANCELLATION' })
  assert.equal(f.balance(), 0)
})

test('status reports the authenticated wallet and only its own transaction state', async t => {
  const f = await setup(t)
  assert.deepEqual(await (await f.status()).json(), { status: 'processing', credits: 0 })
  await f.webhook()
  assert.deepEqual(await (await f.status()).json(), { status: 'granted', credits: 100 })
  const other = await (await f.request('register', { body: { ...credentials, email: 'other@example.com' } })).json()
  assert.deepEqual(await (await f.status('order1', other.token)).json(), { status: 'processing', credits: 0 })
  assert.equal((await f.status('order1', 'invalid')).status, 401)
  assert.equal((await f.status('')).status, 400)
  await f.webhook({ type: 'CANCELLATION' })
  const response = await f.status()
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await response.json(), { status: 'refunded', credits: 0 })
})
