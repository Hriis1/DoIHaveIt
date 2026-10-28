import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture, options, product } from './catalog-fixture.js'

const tea = (barcode, size, changes = {}) => ({ barcode, brand: "Lagg's", name: 'Linden Flowers Tea', size, ...changes })
const getProducts = database => database.prepare('SELECT id, brand, name, size, catalog_id FROM products ORDER BY id').all().map(row => ({ ...row }))
const getCodes = database => database.prepare('SELECT code, product_id, catalog_id FROM codes ORDER BY code').all().map(row => ({ ...row }))

test('known and missing sizes share one product in either order, including literal null and empty sizes', async t => {
  for (const missing of [null, '', '   ', 'null', ' NULL ']) {
    for (const sizes of [['1.5 g', missing], [missing, '1.5 g']]) {
      const { database, repository, source } = fixture(t)
      await repository.importCatalog('Tea', source(sizes.map((size, index) => tea(`code-${index}`, size))), options())
      const products = getProducts(database)
      assert.equal(products.length, 1)
      assert.equal(products[0].id, 1)
      assert.equal(products[0].size, '1.5 g')
      assert.deepEqual(getCodes(database).map(row => row.product_id), [1, 1])
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    }
  }
})

test('unknown sizes stay null until a known size is imported in a later catalog', async t => {
  const { database, repository, source } = fixture(t)
  await repository.importCatalog('Unknown', source([tea('a', null), tea('b', 'null'), tea('c', '')]), options())
  assert.equal(getProducts(database).length, 1)
  assert.equal(getProducts(database)[0].size, null)
  const firstId = getProducts(database)[0].id
  await repository.importCatalog('Known', source([tea('d', '1.5 g')]), options())
  assert.equal(getProducts(database).length, 1)
  assert.equal(getProducts(database)[0].id, firstId)
  assert.equal(getProducts(database)[0].size, '1.5 g')
  assert.ok(getCodes(database).every(row => row.product_id === firstId))
  assert.deepEqual(getCodes(database).map(row => row.catalog_id), [1, 1, 1, 2])
})

test('missing-size barcodes reuse a sized product from another catalog', async t => {
  const { database, repository, source } = fixture(t)
  await repository.importCatalog('Known', source([tea('a', '1.5 g')]), options())
  await repository.importCatalog('Unknown', source([tea('b', null)]), options())
  assert.equal(getProducts(database).length, 1)
  assert.equal(getProducts(database)[0].catalog_id, 1)
  assert.deepEqual(getCodes(database), [
    { code: 'a', product_id: 1, catalog_id: 1 }, { code: 'b', product_id: 1, catalog_id: 2 },
  ])
})

test('only missing-size rows after the second distinct size are skipped', async t => {
  const { database, repository, source } = fixture(t)
  await repository.importCatalog('Tea', source([
    tea('early-unknown', null), tea('first', '1.5 g'), tea('between', 'null'),
    tea('second', '2 g'), tea('ambiguous', null), tea('repeat-first', '1.5 g'), tea('last-unknown', ''),
  ]), options())
  const products = getProducts(database)
  assert.deepEqual(products.map(row => row.size), ['1.5 g', '2 g'])
  const ids = Object.fromEntries(getCodes(database).map(row => [row.code, row.product_id]))
  assert.equal(ids['early-unknown'], ids.first)
  assert.equal(ids.between, ids.first)
  assert.equal(ids['repeat-first'], ids.first)
  assert.notEqual(ids.second, ids.first)
  assert.equal(ids.ambiguous, undefined)
  assert.equal(ids['last-unknown'], undefined)
  assert.equal(getCodes(database).length, 5)
})

test('multiple sizes from existing catalogs skip new unknown rows and continue importing', async t => {
  const { database, repository, source } = fixture(t)
  await repository.importCatalog('First', source([tea('a', '1.5 g')]), options())
  await repository.importCatalog('Second', source([tea('b', '2 g')]), options())
  await repository.importCatalog('Third', source([tea('ambiguous', 'null'), tea('known', '2 g'), product('other')]), options())
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM codes WHERE code = 'ambiguous'").get().n, 0)
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM codes WHERE code IN ('known', 'other')").get().n, 2)
  assert.equal(await repository.isCatalogInstalled('Third'), true)
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM products WHERE brand = ? AND name = ?").get("Lagg's", 'Linden Flowers Tea').n, 2)
})

test('batch boundaries preserve the same order-dependent size matching', async t => {
  for (const firstSize of [null, '1.5 g']) {
    const { database, repository, source } = fixture(t)
    const records = Array.from({ length: 4999 }, (_, index) => product(`filler-${index}`))
    records.push(tea('a', firstSize), tea('b', firstSize === null ? '1.5 g' : null), tea('c', '2 g'), tea('skip', null))
    await repository.importCatalog('Tea', source(records), options())
    const sizes = database.prepare("SELECT size FROM products WHERE brand = ? ORDER BY size").all("Lagg's").map(row => row.size)
    assert.deepEqual(sizes, ['1.5 g', '2 g'])
    const codes = database.prepare("SELECT code, product_id FROM codes WHERE code IN ('a', 'b', 'c', 'skip') ORDER BY code").all()
    assert.equal(codes.length, 3)
    assert.equal(codes[0].product_id, codes[1].product_id)
    assert.notEqual(codes[0].product_id, codes[2].product_id)
  }
})

test('size upgrades preserve product IDs, local ownership, barcode ownership and collection photos', async t => {
  const { database, repository, source } = fixture(t)
  database.prepare('INSERT INTO products (brand, name) VALUES (?, ?)').run("Lagg's", 'Linden Flowers Tea')
  database.exec(`INSERT INTO codes (code, product_id) VALUES ('manual', 1);
    INSERT INTO collections (name) VALUES ('Tea');
    INSERT INTO items (collection_id, product_id, image) VALUES (1, 1, 'tea.jpg');`)
  await repository.importCatalog('Known', source([tea('new', '1.5 g')]), options())
  assert.deepEqual(getProducts(database), [{ id: 1, brand: "Lagg's", name: 'Linden Flowers Tea', size: '1.5 g', catalog_id: null }])
  assert.equal(database.prepare("SELECT catalog_id FROM codes WHERE code = 'manual'").get().catalog_id, null)
  assert.deepEqual({ ...database.prepare('SELECT product_id, image FROM items').get() }, { product_id: 1, image: 'tea.jpg' })
})

test('brand and name boundaries, exact sizes and installed barcode precedence are unchanged', async t => {
  const { database, repository, source } = fixture(t)
  await repository.importCatalog('First', source([
    tea('a', null), tea('other-brand', '5 g', { brand: 'Other' }), tea('other-name', '5 g', { name: 'Other tea' }),
  ]), options())
  await repository.importCatalog('Second', source([tea('a', '99 g'), tea('b', '1.5 g'), tea('c', '1.50 g')]), options())
  assert.equal(database.prepare("SELECT size FROM products JOIN codes ON codes.product_id = products.id WHERE code = 'a'").get().size, '1.5 g')
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM products WHERE size = '99 g'").get().n, 0)
  assert.equal(getProducts(database).length, 4)
})

test('cancellation or database failure rolls a size upgrade and its new barcode back', async t => {
  for (const cancel of [true, false]) {
    const { database, adapter, repository, snapshot, source } = fixture(t)
    await repository.importCatalog('Unknown', source([tea('old', null)]), options())
    const before = snapshot()
    const controller = new AbortController()
    const execute = adapter.executeSet
    adapter.executeSet = async (statements, transaction) => {
      if (cancel) {
        await execute(statements, transaction)
        assert.equal(getProducts(database)[0].size, '1.5 g')
        controller.abort()
      } else {
        for (const { statement, values } of statements) {
          database.prepare(statement).run(...values)
          if (statement.startsWith('UPDATE main.products')) {
            assert.equal(getProducts(database)[0].size, '1.5 g')
            throw new Error('Simulated size upgrade failure')
          }
        }
      }
    }
    await assert.rejects(() => repository.importCatalog('Known', source([tea('new', '1.5 g')]), options(controller.signal)), cancel ? { name: 'AbortError' } : /upgrade failure/)
    assert.equal(snapshot(), before)
    for (const table of ['catalog_import_rows', 'catalog_import_sizes']) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM temp.${table}`).get().n, 0)
    }
  }
})
