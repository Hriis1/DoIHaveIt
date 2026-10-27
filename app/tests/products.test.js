import assert from 'node:assert/strict'
import test from 'node:test'
import { createProductRepository } from '../src/repositories/productRepo.js'
import { fixture } from './catalog-fixture.js'

function productsFixture(t) {
  const { database, adapter } = fixture(t)
  const repository = createProductRepository(operation => operation(adapter))
  const add = (brand, name, size = null, barcodes = []) => {
    const { lastInsertRowid: id } = database.prepare('INSERT INTO products (name, size) VALUES (?, ?)').run(name, size)
    for (const label of Array.isArray(brand) ? brand : [brand]) {
      database.prepare('INSERT INTO brands (name) VALUES (?) ON CONFLICT DO NOTHING').run(label)
      const { id: brandId } = database.prepare('SELECT id FROM brands WHERE name = ?').get(label)
      database.prepare('INSERT INTO product_brands VALUES (?, ?)').run(id, brandId)
    }
    for (const barcode of barcodes) database.prepare('INSERT INTO codes (code, product_id) VALUES (?, ?)').run(barcode, id)
    return Number(id)
  }
  return { database, repository, add }
}

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

test('text words match independently across fields, regardless of order or ASCII case', async t => {
  const { repository, add } = productsFixture(t)
  const id = add('Coca Cola', 'Original Taste', '500 ml', ['0012345678901'])
  add('Other', 'Original Taste', '250 ml')
  for (const search of ['coca cola', 'original taste 500', 'TASTE COCA', '  500   cola  ', 'rig 500']) {
    const result = await repository.getProducts({ search })
    assert.deepEqual(result.products.map(product => product.id), [id])
  }
  for (const search of ['cola 250', '0012345678901']) {
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

test('search treats wildcard and SQL punctuation literally', async t => {
  const { repository, add } = productsFixture(t)
  add('Brand', "50%_O'Brien", null, ["' OR 1=1 --"])
  add('Other', 'Plain')
  for (const search of ['%', '_', "O'Brien"]) {
    assert.equal((await repository.getProducts({ search })).total, 1)
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

test('multiple brands are displayed and searched without duplicating products or barcodes', async t => {
  const { repository, add } = productsFixture(t)
  const id = add(['zaza', 'Marks & Spencers', 'Marks & Spencer'], 'Five hop lager beer', '330 ml', ['00024655', '00024656'])
  add('Other', 'Five hop lager beer', '330 ml')
  const result = await repository.getProducts()
  assert.equal(result.total, 2)
  assert.equal(result.products[0].id, id)
  assert.equal(result.products[0].brand, 'Marks & Spencer, Marks & Spencers, zaza')
  assert.deepEqual(result.products[0].barcodes, ['00024655', '00024656'])
  for (const search of ['zaza 330', 'marks spencers lager', 'marks zaza']) {
    const matches = await repository.getProducts({ search })
    assert.equal(matches.total, 1)
    assert.equal(matches.products[0].id, id)
    assert.equal(matches.products[0].brand, result.products[0].brand)
  }
  const exact = await repository.getProducts({ mode: 'barcode', search: '00024656' })
  assert.equal(exact.products[0].brand, result.products[0].brand)
  assert.deepEqual(exact.products[0].barcodes, ['00024655', '00024656'])
})

test('products without brands still appear and can be searched by name and size', async t => {
  const { repository, add } = productsFixture(t)
  const id = add([], 'Unbranded drink', '500 ml')
  const result = await repository.getProducts({ search: 'drink 500' })
  assert.equal(result.total, 1)
  assert.equal(result.products[0].id, id)
  assert.equal(result.products[0].brand, '')
})
