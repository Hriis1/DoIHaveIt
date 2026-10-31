import assert from 'node:assert/strict'
import test from 'node:test'
import { createProductRepository } from '../src/repositories/productRepo.js'
import { fixture } from './catalog-fixture.js'

const aiProduct = { brand: ' BRAND ', name: ' PRODUCT ', size: ' 500 ML ' }
function productFixture(t) {
  const { database, adapter, snapshot } = fixture(t)
  const repository = createProductRepository(operation => operation(adapter))
  const add = (brand, name, size = null) => Number(database.prepare('INSERT INTO products (brand, name, size) VALUES (?, ?, ?)')
    .run(brand, name, size).lastInsertRowid)
  return { database, adapter, snapshot, repository, add }
}

test('AI products are lowercased, stored without a catalog and linked to the scanned barcode', async t => {
  const { database, repository } = productFixture(t)
  const result = await repository.resolveAiProduct('004062139018352', aiProduct)
  assert.deepEqual({ ...result }, { id: result.id, brand: 'brand', name: 'product', size: '500 ml', code: '004062139018352' })
  assert.equal(database.prepare('SELECT catalog_id FROM products').get().catalog_id, null)
  assert.equal(database.prepare('SELECT catalog_id FROM codes').get().catalog_id, null)
  assert.equal((await repository.getProducts({ search: 'product' })).total, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0)
  const repeated = await repository.resolveAiProduct('004062139018352', aiProduct)
  assert.equal(repeated.id, result.id)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1)
})

test('case-insensitive reuse preserves existing text, catalog association and collection membership', async t => {
  const { database, repository, add } = productFixture(t)
  const id = add('Brand', 'Product', '500 ML')
  database.exec(`INSERT INTO catalogs (id, name) VALUES (1, 'Existing');
    UPDATE products SET catalog_id = 1 WHERE id = ${id};
    INSERT INTO collections (id, name) VALUES (1, 'Collection');
    INSERT INTO items (collection_id, product_id, image) VALUES (1, ${id}, 'saved.jpg');`)
  for (const code of ['first', 'second']) {
    const result = await repository.resolveAiProduct(code, aiProduct)
    assert.equal(result.id, id)
    assert.equal(result.brand, 'Brand')
    assert.equal(result.name, 'Product')
    assert.equal(result.size, '500 ML')
    assert.equal(await repository.isProductInCollection(result.id, 1), true)
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM codes WHERE product_id = ?').get(id).n, 2)
  assert.equal(database.prepare('SELECT catalog_id FROM products WHERE id = ?').get(id).catalog_id, 1)
  assert.equal(database.prepare('SELECT image FROM items').get().image, 'saved.jpg')
})

test('lowercase Unicode products are reused after normalizing AI input', async t => {
  const { repository, add } = productFixture(t)
  const id = add('марка', 'мляко')
  const result = await repository.resolveAiProduct('unicode', { brand: 'МАРКА', name: 'МЛЯКО', size: null })
  assert.equal(result.id, id)
  assert.equal(result.brand, 'марка')
  assert.equal(result.name, 'мляко')
})

test('missing sizes only match null and known sizes do not upgrade unknown sizes', async t => {
  const { database, repository, add } = productFixture(t)
  const sizedId = add('brand', 'product', '500 ml')
  const unknown = await repository.resolveAiProduct('unknown', { ...aiProduct, size: null })
  assert.notEqual(unknown.id, sizedId)
  assert.equal(unknown.size, null)
  assert.equal((await repository.resolveAiProduct('also-unknown', { ...aiProduct, size: null })).id, unknown.id)
  assert.equal((await repository.resolveAiProduct('sized', aiProduct)).id, sizedId)
  const differentSize = await repository.resolveAiProduct('large', { ...aiProduct, size: '1 L' })
  assert.notEqual(differentSize.id, unknown.id)
  assert.notEqual(differentSize.id, sizedId)
  assert.equal(database.prepare('SELECT size FROM products WHERE id = ?').get(unknown.id).size, null)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 3)
})

test('a barcode already linked during lookup keeps its original product and catalog ownership', async t => {
  const { database, repository, add } = productFixture(t)
  const id = add('Existing', 'Owner')
  database.exec(`INSERT INTO catalogs (id, name) VALUES (1, 'Catalog');
    INSERT INTO codes (code, product_id, catalog_id) VALUES ('existing', ${id}, 1);`)
  const result = await repository.resolveAiProduct('existing', aiProduct)
  assert.equal(result.id, id)
  assert.equal(result.name, 'Owner')
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1)
  assert.equal(database.prepare('SELECT catalog_id FROM codes').get().catalog_id, 1)
})

test('an existing UPC equivalent is reused and the actual scanned EAN is linked to it', async t => {
  const { database, repository, add } = productFixture(t)
  const id = add('Existing', 'UPC Product')
  database.prepare('INSERT INTO codes (code, product_id) VALUES (?, ?)').run('036000291452', id)
  const result = await repository.resolveAiProduct('0036000291452', aiProduct)
  assert.equal(result.id, id)
  assert.equal(result.code, '0036000291452')
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM codes WHERE product_id = ?').get(id).n, 2)
})

test('barcode insertion failure rolls back the product and search index', async t => {
  const { adapter, repository, snapshot } = productFixture(t)
  const before = snapshot()
  const run = adapter.run
  adapter.run = async (sql, ...args) => {
    if (sql.startsWith('INSERT INTO codes')) throw new Error('Code insertion failed')
    return run(sql, ...args)
  }
  await assert.rejects(repository.resolveAiProduct("code'quote", aiProduct), /Code insertion failed/)
  assert.equal(snapshot(), before)
  assert.equal((await repository.getProducts({ search: 'product' })).total, 0)
})

test('cancellation while waiting for access or after insertion prevents committed changes', async t => {
  const { database, adapter, snapshot } = productFixture(t)
  let queuedOperation
  const waiting = createProductRepository(operation => new Promise((resolve, reject) => {
    queuedOperation = () => operation(adapter).then(resolve, reject)
  }))
  const controller = new AbortController()
  const pending = waiting.resolveAiProduct('queued', aiProduct, { signal: controller.signal })
  controller.abort()
  queuedOperation()
  await assert.rejects(pending, { name: 'AbortError' })
  const before = snapshot()
  const duringWrite = new AbortController()
  const run = adapter.run
  adapter.run = async (...args) => {
    const result = await run(...args)
    duringWrite.abort()
    return result
  }
  const repository = createProductRepository(operation => operation(adapter))
  await assert.rejects(repository.resolveAiProduct('cancelled', aiProduct, { signal: duringWrite.signal }), { name: 'AbortError' })
  assert.equal(snapshot(), before)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 0)
})
