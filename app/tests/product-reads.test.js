import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { after, beforeEach, mock, test } from 'node:test'

const database = new DatabaseSync(':memory:')
const source = readFileSync(new URL('../src/database.js', import.meta.url), 'utf8')
database.exec('PRAGMA foreign_keys = ON;')
database.exec(source.match(/await database\.execute\(`([\s\S]*?)`\)/)[1])
after(() => database.close())
mock.module('../src/database.js', { namedExports: {
  withDatabaseAccess: operation => operation({
    query: async (sql, values = []) => ({ values: database.prepare(sql).all(...values) }),
  }),
} })
const { getProductByBarcode } = await import('../src/repositories/productRepo.js')
const { getCollectionItems } = await import('../src/repositories/itemRepo.js')

beforeEach(() => {
  database.exec(`
    DELETE FROM items; DELETE FROM codes; DELETE FROM products; DELETE FROM brands; DELETE FROM collections;
    INSERT INTO brands (id, name) VALUES (1, 'zaza'), (2, 'Marks & Spencer');
    INSERT INTO products (id, name, size) VALUES (1, 'Five hop lager beer', '330 ml'), (2, 'Unbranded drink', NULL);
    INSERT INTO product_brands VALUES (1, 1), (1, 2);
    INSERT INTO codes (code, product_id) VALUES ('00024655', 1), ('00024656', 1), ('036000291452', 1), ('999', 2);
    INSERT INTO collections (id, name) VALUES (1, 'Drinks'), (2, 'Other');
    INSERT INTO items (id, collection_id, product_id) VALUES (1, 1, 1), (2, 1, 1), (3, 1, 2), (4, 2, 1);
  `)
})

test('barcode lookup returns every linked brand and preserves UPC/EAN fallback', async () => {
  for (const code of ['00024655', '00024656', '036000291452']) {
    assert.deepEqual({ ...await getProductByBarcode(code) }, {
      brand: 'Marks & Spencer, zaza', name: 'Five hop lager beer', size: '330 ml', code,
    })
  }
  assert.equal((await getProductByBarcode('0036000291452')).code, '036000291452')
  assert.equal(await getProductByBarcode('0002465'), null)
  assert.equal(await getProductByBarcode('not-found'), null)
  assert.equal((await getProductByBarcode('999')).brand, '')
})

test('collection reads preserve item counts and pagination despite multiple brands and barcodes', async () => {
  const result = await getCollectionItems(1, { search: '', page: 1, pageSize: 2 })
  assert.equal(result.total, 3)
  assert.equal(result.totalPages, 2)
  assert.deepEqual(result.items.map(item => item.id), [1, 2])
  for (const item of result.items) {
    assert.equal(item.brand, 'Marks & Spencer, zaza')
    assert.equal(item.name, 'Five hop lager beer')
  }
  const last = await getCollectionItems(1, { search: '', page: 2, pageSize: 2 })
  assert.equal(last.items.length, 1)
  assert.equal(last.items[0].id, 3)
  assert.equal(last.items[0].brand, '')
})

test('collection search matches any linked brand and keeps all brand labels in results', async () => {
  for (const search of ['zaza', 'MARKS', '330', 'lager']) {
    const result = await getCollectionItems(1, { search, page: 1, pageSize: 12 })
    assert.equal(result.total, 2)
    assert.ok(result.items.every(item => item.brand === 'Marks & Spencer, zaza'))
  }
  assert.equal((await getCollectionItems(1, { search: 'unbranded', page: 1, pageSize: 12 })).total, 1)
  assert.equal((await getCollectionItems(1, { search: 'missing', page: 1, pageSize: 12 })).total, 0)
})
