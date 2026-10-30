import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { fixture } from './catalog-fixture.js'

let adapter
mock.module('../src/database.js', { namedExports: {
  withDatabaseAccess: operation => operation(adapter),
} })
const { addCollectionItem } = await import('../src/repositories/itemRepo.js')

test('adds a photo-backed item to only the requested collection and rejects duplicates', async t => {
  const { database } = fixture(t)
  adapter = {
    run: async (sql, parameters) => ({ changes: database.prepare(sql).run(...parameters) }),
  }
  database.exec(`INSERT INTO collections (id, name) VALUES (1, 'First'), (2, 'Second');
    INSERT INTO products (id, brand, name) VALUES (1, 'Brand', 'Product');`)
  const image = "item-photos/photo's.jpg"
  await addCollectionItem(1, 1, image)
  assert.deepEqual({ ...database.prepare('SELECT collection_id, product_id, image FROM items').get() }, {
    collection_id: 1, product_id: 1, image,
  })
  await assert.rejects(addCollectionItem(1, 1, 'other.jpg'), /already in this collection/)
  await addCollectionItem(2, 1, 'other.jpg')
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2)
  await assert.rejects(addCollectionItem(1, 1, null), /Photo required/)
  await assert.rejects(addCollectionItem(999, 1, 'missing.jpg'), /FOREIGN KEY/)
})
