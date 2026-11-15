import assert from 'node:assert/strict'
import test from 'node:test'
import { createProductRepository } from '../src/repositories/productRepo.js'
import { fixture } from './catalog-fixture.js'

test('product options are distinct, sorted, trimmed and filtered by exact brand and name', async t => {
  const { database, adapter } = fixture(t)
  const repository = createProductRepository(operation => operation(adapter))
  const insert = database.prepare('INSERT INTO products (brand, name, size) VALUES (?, ?, ?)')
  for (const row of [
    [' Brand ', ' Product ', ' 330 ML '], ['brand', 'product', '330 ml'],
    ['BRAND', 'PRODUCT', '500 ML'], ['brand', 'second', '1 L'],
    ['brand', 'product', null], ['brand', 'product', '  '],
    ['other', 'product', '2 L'], ['brand extra', 'product', '3 L'],
  ]) insert.run(...row)
  assert.deepEqual(await repository.getProductBrands(), ['brand', 'brand extra', 'other'])
  assert.deepEqual(await repository.getProductNames(' BRAND   '), ['product', 'second'])
  assert.deepEqual(await repository.getProductSizes(' Brand ', ' PRODUCT   '), ['330 ml', '500 ml'])
  assert.deepEqual(await repository.getProductSizes('brand', 'second'), ['1 l'])
  assert.deepEqual(await repository.getProductNames('unknown'), [])
  assert.deepEqual(await repository.getProductSizes('brand', 'unknown'), [])
  assert.deepEqual(await repository.getProductNames("brand' OR 1=1 --"), [])
  assert.deepEqual(await repository.getProductSizes('brand', "product' OR 1=1 --"), [])
})

test('adding a trimmed product reuses existing padded values and preserves their stored text', async t => {
  const { database, adapter } = fixture(t)
  const repository = createProductRepository(operation => operation(adapter))
  const { lastInsertRowid } = database.prepare('INSERT INTO products (brand, name, size) VALUES (?, ?, ?)')
    .run(' Brand  ', ' Product ', ' 330 ML ')
  const result = await repository.resolveProduct('manual-code', { brand: 'brand   ', name: 'product ', size: '330 ml ' })
  assert.equal(result.id, Number(lastInsertRowid))
  assert.equal(result.brand, ' Brand  ')
  assert.equal((await repository.getProductByBarcode('manual-code')).id, result.id)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1)
})
