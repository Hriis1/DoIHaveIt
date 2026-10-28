import assert from 'node:assert/strict'
import test from 'node:test'
import { addProduct, fixture, options } from './catalog-fixture.js'

const lager = (barcode, brand, changes = {}) => ({ barcode, brand, name: 'Five hop lager beer', size: '330 ml', ...changes })
const getBrands = database => database.prepare(`
  SELECT b.name FROM brands AS b JOIN product_brands AS pb ON pb.brand_id = b.id ORDER BY b.name;
`).all().map(row => row.name)
const getCodes = database => database.prepare('SELECT code, product_id, catalog_id FROM codes ORDER BY code;').all().map(row => ({ ...row }))

test('splits comma-separated brands and adds overlapping brands to the same product', async t => {
  const { database, repository, source } = fixture(t)
  await repository.importCatalog('First', source([lager('00024655', 'Marks & Spencers, Marks & Spencer')]), options())
  await repository.importCatalog('Second', source([lager('00024656', 'Marks & Spencer, zaza')]), options())
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1)
  assert.deepEqual(getBrands(database), ['Marks & Spencer', 'Marks & Spencers', 'zaza'])
  assert.deepEqual(getCodes(database), [
    { code: '00024655', product_id: 1, catalog_id: 1 },
    { code: '00024656', product_id: 1, catalog_id: 2 },
  ])
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM temp.catalog_import_merges').get().n, 0)
})

test('same-name products with disjoint brands stay separate until an incoming row connects them', async t => {
  const { database, repository, source } = fixture(t)
  await repository.importCatalog('First', source([lager('00024655', 'Marks & Spencers, Marks & Spencer')]), options())
  await repository.importCatalog('Second', source([lager('00024656', 'zaza')]), options())
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 2)
  assert.equal(new Set(getCodes(database).map(row => row.product_id)).size, 2)
  database.exec(`INSERT INTO collections (id, name) VALUES (1, 'Drinks');
    INSERT INTO items (collection_id, product_id, image) VALUES (1, 1, 'first.jpg'), (1, 2, 'second.jpg');`)
  await repository.importCatalog('Bridge', source([lager('bridge', 'Marks & Spencer, zaza')]), options())
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1)
  assert.deepEqual(getBrands(database), ['Marks & Spencer', 'Marks & Spencers', 'zaza'])
  assert.ok(getCodes(database).every(row => row.product_id === 1))
  const items = database.prepare('SELECT product_id, image FROM items ORDER BY id').all()
  assert.deepEqual(items.map(row => ({ ...row })), [{ product_id: 1, image: 'first.jpg' }, { product_id: 1, image: 'second.jpg' }])
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  for (const catalog of ['First', 'Second', 'Bridge']) await repository.removeCatalog(catalog, options())
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM codes').get().n, 3)
})

test('transitive bridges merge within a batch without merging different names or sizes', async t => {
  const { database, repository, source } = fixture(t)
  await repository.importCatalog('Drinks', source([
    lager('a', 'A, B'), lager('b', 'C, D'), lager('c', 'E'),
    lager('bridge1', 'B, C'), lager('bridge2', 'D, E'),
    lager('different-size', 'A', { size: '500 ml' }),
    lager('different-name', 'A', { name: 'Different beer' }),
    lager('no-overlap', 'Other'),
  ]), options())
  const codes = Object.fromEntries(getCodes(database).map(row => [row.code, row.product_id]))
  assert.equal(new Set(['a', 'b', 'c', 'bridge1', 'bridge2'].map(code => codes[code])).size, 1)
  assert.equal(new Set(['a', 'different-size', 'different-name', 'no-overlap'].map(code => codes[code])).size, 4)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 4)
})

test('a bridge in a later batch merges earlier components without fetching product records', async t => {
  const { database, adapter, repository, source } = fixture(t)
  const query = adapter.query
  adapter.query = async (...args) => {
    const result = await query(...args)
    assert.ok(result.values.every(row => !('brand' in row) && !('barcode' in row)))
    return result
  }
  const records = Array.from({ length: 5000 }, (_, index) => lager(`code-${index}`, index % 2 ? 'zaza' : 'Marks & Spencer'))
  records.push(lager('bridge', 'Marks & Spencer, zaza'))
  await repository.importCatalog('Drinks', source(records), options())
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM codes').get().n, 5001)
  assert.deepEqual(getBrands(database), ['Marks & Spencer', 'zaza'])
})

test('brand tokens are trimmed, empty tokens ignored, and duplicate labels linked once', async t => {
  const { database, repository, source } = fixture(t)
  await repository.importCatalog('Drinks', source([lager('a', ' , Marks & Spencer, , zaza, Marks & Spencer , ')]), options())
  assert.deepEqual(getBrands(database), ['Marks & Spencer', 'zaza'])
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM brands').get().n, 2)
  const before = getCodes(database)
  await repository.importCatalog('Duplicate', source([lager('a', 'Unrelated brand')]), options())
  assert.deepEqual(getCodes(database), before)
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM brands WHERE name = 'Unrelated brand'").get().n, 0)
})

test('missing and empty sizes match each other while known sizes remain separate', async t => {
  const { database, repository, source } = fixture(t)
  await repository.importCatalog('Drinks', source([
    lager('a', 'A', { size: null }), lager('b', 'B', { size: '' }),
    lager('bridge', 'A, B', { size: ' ' }), lager('sized', 'A'),
  ]), options())
  const codes = Object.fromEntries(getCodes(database).map(row => [row.code, row.product_id]))
  assert.equal(codes.a, codes.b)
  assert.equal(codes.a, codes.bridge)
  assert.notEqual(codes.a, codes.sized)
})

test('merging into an older catalog product preserves a newer local product ownership and manual barcode', async t => {
  const { database, repository, source } = fixture(t)
  await repository.importCatalog('First', source([lager('first', 'A')]), options())
  const localId = addProduct(database, { brand: 'B', name: 'Five hop lager beer', size: '330 ml' })
  database.prepare('INSERT INTO codes (code, product_id) VALUES (?, ?)').run('manual', localId)
  await repository.importCatalog('Bridge', source([lager('bridge', 'A, B')]), options())
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1)
  assert.equal(database.prepare('SELECT catalog_id FROM products').get().catalog_id, null)
  assert.equal(database.prepare("SELECT catalog_id FROM codes WHERE code = 'manual'").get().catalog_id, null)
  await repository.removeCatalog('First', options())
  await repository.removeCatalog('Bridge', options())
  assert.deepEqual(getCodes(database), [{ code: 'manual', product_id: 1, catalog_id: null }])
  assert.deepEqual(getBrands(database), ['A', 'B'])
})

test('cancellation after merging restores both original products, links, barcodes and collection references', async t => {
  const { database, adapter, repository, snapshot, source } = fixture(t)
  const first = addProduct(database, { brand: 'A', name: 'Five hop lager beer', size: '330 ml' })
  const second = addProduct(database, { brand: 'B', name: 'Five hop lager beer', size: '330 ml' })
  database.prepare('INSERT INTO codes (code, product_id) VALUES (?, ?), (?, ?)').run('a', first, 'b', second)
  database.exec(`INSERT INTO collections (id, name) VALUES (1, 'Drinks');
    INSERT INTO items (collection_id, product_id) VALUES (1, 1), (1, 2);`)
  const before = snapshot()
  const controller = new AbortController()
  const execute = adapter.executeSet
  adapter.executeSet = async (...args) => {
    await execute(...args)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1)
    controller.abort()
  }
  await assert.rejects(() => repository.importCatalog('Bridge', source([lager('bridge', 'A, B, New')]), options(controller.signal)), { name: 'AbortError' })
  assert.equal(snapshot(), before)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM temp.catalog_import_merges').get().n, 0)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('comma-only brands are rejected before publishing any changes', async t => {
  const { repository, snapshot, source } = fixture(t)
  const before = snapshot()
  await assert.rejects(() => repository.importCatalog('Drinks', source([lager('a', ' , , ')]), options()), /invalid or missing/)
  assert.equal(snapshot(), before)
})

test('a database failure partway through a merge restores references and clears temporary targets', async t => {
  const { database, adapter, repository, snapshot, source } = fixture(t)
  addProduct(database, { brand: 'A', name: 'Five hop lager beer', size: '330 ml' })
  addProduct(database, { brand: 'B', name: 'Five hop lager beer', size: '330 ml' })
  database.exec(`INSERT INTO codes (code, product_id) VALUES ('old', 2);
    INSERT INTO collections (id, name) VALUES (1, 'Drinks');
    INSERT INTO items (collection_id, product_id, image) VALUES (1, 2, 'photo.jpg');`)
  const before = snapshot()
  adapter.executeSet = async (statements, transaction) => {
    assert.equal(transaction, false)
    for (const { statement, values } of statements) {
      database.prepare(statement).run(...values)
      if (statement.startsWith('UPDATE main.items')) {
        assert.equal(database.prepare('SELECT product_id FROM items').get().product_id, 1)
        assert.equal(database.prepare("SELECT product_id FROM codes WHERE code = 'old'").get().product_id, 1)
        assert.ok(database.prepare('SELECT COUNT(*) AS n FROM temp.catalog_import_merges').get().n > 0)
        throw new Error('Simulated merge failure')
      }
    }
  }
  await assert.rejects(() => repository.importCatalog('Bridge', source([lager('bridge', 'A, B, New')]), options()), /merge failure/)
  assert.equal(snapshot(), before)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM temp.catalog_import_merges').get().n, 0)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})
