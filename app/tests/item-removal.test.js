import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../src/repositories/itemRepo.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replaceAll('export async function', 'async function')

test('removal is scoped to one collection item and preserves products, barcodes and other collections', async t => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  database.exec(`
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE codes (code TEXT, product_id INTEGER REFERENCES products(id));
    CREATE TABLE items (id INTEGER PRIMARY KEY, collection_id INTEGER, product_id INTEGER REFERENCES products(id), image TEXT);
    INSERT INTO products VALUES (1, 'Product');
    INSERT INTO codes VALUES ('123', 1);
    INSERT INTO items VALUES (7, 3, 1, 'item-photos/first.jpg'), (8, 4, 1, 'item-photos/second.jpg');
  `)
  let failDelete = false
  const context = { withDatabaseAccess: operation => operation({
    query: async (sql, values) => ({ values: database.prepare(sql).all(...values) }),
    run: async (sql, values) => {
      if (failDelete) throw new Error('Write failed')
      return database.prepare(sql).run(...values)
    },
  }) }
  runInNewContext(source + '\nthis.remove = removeCollectionItem', context)
  assert.equal(await context.remove(4, 7), null)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2)
  failDelete = true
  await assert.rejects(context.remove(3, 7), /Write failed/)
  assert.equal(database.prepare('SELECT image FROM items WHERE id = 7').get().image, 'item-photos/first.jpg')
  failDelete = false
  assert.equal(await context.remove(3, 7), 'item-photos/first.jpg')
  assert.equal(await context.remove(3, 7), null)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM codes').get().n, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1)
  assert.equal(database.prepare('SELECT image FROM items WHERE id = 8').get().image, 'item-photos/second.jpg')
})
