import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { after, mock, test } from 'node:test'

const database = new DatabaseSync(':memory:')
after(() => database.close())
const connection = {
  open: async () => {},
  execute: async sql => database.exec(sql),
  query: async (sql, values = []) => ({ values: database.prepare(sql).all(...values) }),
  beginTransaction: async () => database.exec('BEGIN;'),
  commitTransaction: async () => database.exec('COMMIT;'),
  rollbackTransaction: async () => database.exec('ROLLBACK;'),
}
let connections = 0
mock.module('@capacitor-community/sqlite', { namedExports: {
  CapacitorSQLite: {},
  SQLiteConnection: class {
    async checkConnectionsConsistency() {}
    async isConnection() { return { result: false } }
    async createConnection() { connections++; return connection }
  },
} })
const { initializeDatabase, withDatabaseAccess } = await import('../src/database.js')

test('initialization shares its promise and creates catalog columns and indexes', async () => {
  const first = initializeDatabase()
  assert.equal(first, initializeDatabase())
  await first
  assert.equal(connections, 1)
  for (const table of ['products', 'codes']) {
    assert.ok(database.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'catalog_id'))
  }
  const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name)
  for (const name of ['products_catalog_id', 'codes_catalog_id', 'codes_product_id', 'items_product_id']) {
    assert.ok(indexes.includes(name))
  }
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('other repositories wait until a transaction has rolled back', async () => {
  let release
  let started
  const entered = new Promise(resolve => { started = resolve })
  const wait = new Promise(resolve => { release = resolve })
  const transaction = withDatabaseAccess(async () => {
    database.exec("BEGIN; INSERT INTO catalogs (name) VALUES ('Temporary');")
    started()
    await wait
    database.exec('ROLLBACK;')
    throw new Error('cancelled')
  })
  const rejection = assert.rejects(transaction, /cancelled/)
  await entered
  let observed = false
  const otherQuery = withDatabaseAccess(async () => {
    observed = true
    return database.prepare('SELECT COUNT(*) AS n FROM catalogs').get().n
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(observed, false)
  release()
  await rejection
  assert.equal(await otherQuery, 0)
})
