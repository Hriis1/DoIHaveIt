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
const { initializeDatabase, withDatabaseAccess, withAttachedDatabase } = await import('../src/database.js')

test('initialization shares its promise and creates catalog columns and indexes', async () => {
  const first = initializeDatabase()
  assert.equal(first, initializeDatabase())
  await first
  assert.equal(connections, 1)
  for (const table of ['products', 'codes']) {
    assert.ok(database.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'catalog_id'))
  }
  const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name)
  for (const name of ['products_catalog_id', 'products_name_size', 'product_brands_brand_id', 'codes_catalog_id', 'codes_product_id', 'items_product_id']) {
    assert.ok(indexes.includes(name))
  }
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('products support multiple brands and same-name candidates while enforcing valid brand links', async () => {
  await withDatabaseAccess(async () => {
    database.exec('BEGIN;')
    try {
      database.exec("INSERT INTO brands (id, name) VALUES (1, 'monster'), (2, 'other brand');")
      const insert = database.prepare('INSERT INTO products (name, size) VALUES (?, ?);')
      for (const size of [null, null, '500 ml', '500 ml']) insert.run('classic', size)
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products;').get().n, 4)
      database.exec('INSERT INTO product_brands VALUES (1, 1), (1, 2), (2, 2);')
      assert.throws(() => database.exec('INSERT INTO product_brands VALUES (1, 1);'), /UNIQUE constraint failed/)
      assert.throws(() => database.exec('INSERT INTO product_brands VALUES (99, 1);'), /FOREIGN KEY constraint failed/)
      assert.throws(() => database.exec('INSERT INTO product_brands VALUES (1, 99);'), /FOREIGN KEY constraint failed/)
      assert.throws(() => database.exec("INSERT INTO brands (name) VALUES ('monster');"), /UNIQUE constraint failed/)
      database.exec('DELETE FROM products WHERE id = 1;')
      assert.deepEqual(database.prepare('SELECT product_id, brand_id FROM product_brands;').all().map(row => ({ ...row })), [{ product_id: 2, brand_id: 2 }])
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM brands;').get().n, 2)
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    } finally {
      database.exec('ROLLBACK;')
    }
  })
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

test('a detach failure releases the source connection without reporting a committed import as failed', async () => {
  const calls = []
  const warning = mock.method(console, 'warn', () => {})
  const attachedConnection = {
    run: async (sql, values, transaction) => {
      assert.equal(transaction, false)
      calls.push([sql, values])
      if (sql.startsWith('DETACH')) throw new Error('Simulated detach failure')
    },
    close: async () => calls.push(['closed']),
  }
  try {
    assert.equal(await withAttachedDatabase(attachedConnection, "/cache/catalog's.sqlite", async () => true), true)
    assert.deepEqual(calls[0], ['ATTACH DATABASE ? AS catalog_source;', ["/cache/catalog's.sqlite"]])
    assert.deepEqual(calls.at(-1), ['closed'])
    await withDatabaseAccess(async () => {})
    assert.equal(connections, 2, 'The next operation must reopen the connection')
  } finally { warning.mock.restore() }
})
