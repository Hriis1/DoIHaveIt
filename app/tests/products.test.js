import assert from 'node:assert/strict'
import test from 'node:test'
import { createProductRepository } from '../src/repositories/productRepo.js'
import { fixture, options, product } from './catalog-fixture.js'

function productsFixture(t) {
  const { database, adapter } = fixture(t)
  const repository = createProductRepository(operation => operation(adapter))
  const add = (brand, name, size = null, barcodes = []) => {
    const { lastInsertRowid: id } = database.prepare('INSERT INTO products (brand, name, size) VALUES (?, ?, ?)').run(brand, name, size)
    for (const barcode of barcodes) database.prepare('INSERT INTO codes (code, product_id) VALUES (?, ?)').run(barcode, id)
    return Number(id)
  }
  return { database, repository, add }
}

test('looks up barcodes through the injected database and returns product details', async t => {
  const { repository, add } = productsFixture(t)
  const id = add('Brand', 'Product', '500 ml', ['036000291452'])
  const expected = { id, brand: 'Brand', name: 'Product', size: '500 ml', code: '036000291452' }

  assert.deepEqual({ ...await repository.getProductByBarcode('036000291452') }, expected)
  assert.deepEqual({ ...await repository.getProductByBarcode('0036000291452') }, expected)
  const eanId = add('Brand', 'EAN product', null, ['0012345678905'])
  assert.equal((await repository.getProductByBarcode('012345678905')).id, eanId)
  const exactId = add('Brand', 'Exact product', null, ['0036000291452'])
  assert.equal((await repository.getProductByBarcode('0036000291452')).id, exactId)
  assert.equal(await repository.getProductByBarcode('unknown'), null)
  add('Brand', 'Invalid checksum', null, ['0036000291453'])
  assert.equal(await repository.getProductByBarcode('036000291453'), null)
})

test('checks product membership in the requested collection', async t => {
  const { repository, add, database } = productsFixture(t)
  const id = add('Brand', 'Owned product')
  const otherId = add('Brand', 'Other product')
  database.exec(`
    INSERT INTO collections (id, name) VALUES (1, 'First'), (2, 'Second');
    INSERT INTO items (collection_id, product_id) VALUES (1, ${id}), (1, ${id}), (2, ${otherId});
  `)

  assert.equal(await repository.isProductInCollection(id, 1), true)
  assert.equal(await repository.isProductInCollection(id, 2), false)
  assert.equal(await repository.isProductInCollection(otherId, 1), false)
  assert.equal(await repository.isProductInCollection(otherId, 2), true)
  assert.equal(await repository.isProductInCollection(id, 999), false)
  assert.equal(await repository.isProductInCollection(999, 1), false)
})

test('lists all products once with every linked barcode, including products without codes', async t => {
  const { repository, add, database } = productsFixture(t)
  const id = add('Coca Cola', 'Original Taste', '500 ml', ['0012345678901', '123456789012'])
  add('Other', 'No barcode')
  database.exec("INSERT INTO catalogs (name) VALUES ('Drinks'); UPDATE products SET catalog_id = 1 WHERE id = 1;")
  const result = await repository.getProducts()
  assert.equal(result.total, 2)
  assert.deepEqual(result.products[0], { id, brand: 'Coca Cola', name: 'Original Taste', size: '500 ml', barcodes: ['0012345678901', '123456789012'] })
  assert.deepEqual(result.products[1].barcodes, [])
  assert.equal(result.products[1].size, null)
})

test('text word prefixes match across fields, regardless of order or case', async t => {
  const { repository, add } = productsFixture(t)
  const id = add('Coca Cola', 'Original Taste', '500 ml', ['0012345678901'])
  add('Other', 'Original Taste', '250 ml')
  for (const search of ['coca cola', 'original taste 500', 'TASTE COCA', '  500   cola  ', 'coc col', 'orig 500', 'c t 5']) {
    const result = await repository.getProducts({ search })
    assert.deepEqual(result.products.map(product => product.id), [id])
  }
  for (const search of ['cola 250', '0012345678901', 'rig 500', 'oca']) {
    assert.equal((await repository.getProducts({ search })).total, 0)
  }
})

test('barcode mode requires the complete original code and returns all linked codes', async t => {
  const { repository, add } = productsFixture(t)
  add('Brand', 'Product', null, ['0012345678901', '123456789012'])
  for (const search of ['0012345678901', '123456789012', ' 0012345678901 ']) {
    const result = await repository.getProducts({ mode: 'barcode', search })
    assert.equal(result.total, 1)
    assert.deepEqual(result.products[0].barcodes, ['0012345678901', '123456789012'])
  }
  for (const search of ['001234', '012345678901', 'Brand', '12345678901', '%']) {
    assert.equal((await repository.getProducts({ mode: 'barcode', search })).total, 0)
  }
  assert.equal((await repository.getProducts({ mode: 'barcode', search: '' })).total, 1)
})

test('search quotes FTS operators and handles punctuation without SQL or FTS injection', async t => {
  const { repository, add } = productsFixture(t)
  add('Brand', "50%_O'Brien", null, ["' OR 1=1 --"])
  add('Other', 'Plain')
  for (const search of ['50', "O'Brien"]) {
    assert.equal((await repository.getProducts({ search })).total, 1)
  }
  for (const search of ['%', '_', '"', '*', 'OR', 'NOT', 'NEAR', 'brand OR plain', 'name:plain', '(plain) -brand']) {
    assert.equal((await repository.getProducts({ search })).total, 0)
  }
  assert.equal((await repository.getProducts({ mode: 'barcode', search: "' OR 1=1 --" })).total, 1)
  assert.equal((await repository.getProducts({ search: "' OR 1=1 --" })).total, 0)
})

test('sorts by brand, name and size and paginates products in groups of twelve', async t => {
  const { repository, add } = productsFixture(t)
  for (let index = 24; index >= 0; index--) add('Brand', `Product ${String(index).padStart(2, '0')}`)
  const first = await repository.getProducts()
  const second = await repository.getProducts({ page: 2 })
  const last = await repository.getProducts({ page: 999 })
  assert.equal(first.total, 25)
  assert.equal(first.totalPages, 3)
  assert.equal(first.products.length, 12)
  assert.equal(first.products[0].name, 'Product 00')
  assert.equal(second.products[0].name, 'Product 12')
  assert.equal(last.page, 3)
  assert.equal(last.products.length, 1)
  assert.equal(last.products[0].name, 'Product 24')
  assert.equal(new Set([...first.products, ...second.products, ...last.products].map(product => product.id)).size, 25)
  assert.equal((await repository.getProducts({ page: 0 })).page, 1)
  const filtered = await repository.getProducts({ search: '24', page: 3 })
  assert.equal(filtered.page, 1)
  assert.equal(filtered.total, 1)
  assert.equal(filtered.products[0].name, 'Product 24')
  add('alpha', 'Zebra', '2 L')
  add('alpha', 'Apple', '500 ml')
  add('alpha', 'Apple', '250 ml')
  const sorted = await repository.getProducts()
  assert.deepEqual(sorted.products.slice(0, 3).map(({ name, size }) => [name, size]), [['Apple', '250 ml'], ['Apple', '500 ml'], ['Zebra', '2 L']])
})

test('an empty result has one empty page', async t => {
  const { repository } = productsFixture(t)
  assert.deepEqual(await repository.getProducts({ page: 2 }), { products: [], total: 0, page: 1, totalPages: 1 })
})

test('search index follows product edits, deletes and transaction rollbacks', async t => {
  const { repository, add, database } = productsFixture(t)
  const id = add('Oldbrand', 'Oldname', null)
  database.prepare('UPDATE products SET brand = ?, name = ?, size = ? WHERE id = ?').run('Newbrand', 'Newname', '750 ml', id)
  assert.equal((await repository.getProducts({ search: 'old' })).total, 0)
  assert.equal((await repository.getProducts({ search: 'newb newn 750' })).total, 1)

  database.exec('BEGIN;')
  database.prepare('UPDATE products SET size = ? WHERE id = ?').run('900 ml', id)
  add('Temporary', 'Uncommitted')
  database.exec('ROLLBACK;')
  assert.equal((await repository.getProducts({ search: '750' })).total, 1)
  assert.equal((await repository.getProducts({ search: '900' })).total, 0)
  assert.equal((await repository.getProducts({ search: 'temporary' })).total, 0)

  database.prepare('DELETE FROM products WHERE id = ?').run(id)
  assert.equal((await repository.getProducts({ search: 'new' })).total, 0)
  database.exec("INSERT INTO products_search(products_search, rank) VALUES ('integrity-check', 1);")
})

test('search supports Unicode word prefixes and uses the FTS virtual index', async t => {
  const { repository, add, database } = productsFixture(t)
  add('Марка', 'Мляко', '500 мл')
  assert.equal((await repository.getProducts({ search: 'мля МАР 5' })).total, 1)
  const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT p.id FROM products AS p
    WHERE p.id IN (SELECT rowid FROM products_search WHERE products_search MATCH ?);`).all('"мля"*')
  assert.ok(plan.some(row => /VIRTUAL TABLE INDEX.*M/.test(row.detail)))
  assert.ok(!plan.some(row => /SCAN p\b/.test(row.detail)))
})

test('catalog imports, size upgrades and removals keep the search index synchronized', async t => {
  const { database, adapter, repository: catalogs, source } = fixture(t)
  const repository = createProductRepository(operation => operation(adapter))
  await catalogs.importCatalog('First', source([product('001', 'Original'), product('003', 'Disposable')]), options())
  assert.equal((await repository.getProducts({ search: 'orig' })).total, 1)
  await catalogs.importCatalog('Second', source([{ ...product('002', 'Original'), size: '500 ml' }]), options())
  assert.equal((await repository.getProducts({ search: 'orig 500' })).total, 1)
  await catalogs.removeCatalog('First', options())
  assert.equal((await repository.getProducts({ search: 'disp' })).total, 0)
  assert.equal((await repository.getProducts({ search: 'orig 500' })).total, 1)
  await catalogs.removeCatalog('Second', options())
  assert.equal((await repository.getProducts({ search: 'orig' })).total, 1, 'Shared products detached by catalog removal remain searchable')
  database.exec("INSERT INTO products_search(products_search, rank) VALUES ('integrity-check', 1);")
})
