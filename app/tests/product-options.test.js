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

test('each product option query returns at most 100 sorted distinct values', async t => {
  const { database, adapter } = fixture(t)
  const repository = createProductRepository(operation => operation(adapter))
  const insert = database.prepare('INSERT INTO products (brand, name, size) VALUES (?, ?, ?)')
  for (let index = 119; index >= 0; index--) {
    const value = String(index).padStart(3, '0')
    insert.run(`brand ${value}`, 'name', null)
    insert.run('brand 000', `name ${value}`, null)
    insert.run('brand 000', 'name 000', `size ${value} `)
    insert.run('brand 000', 'name 000', `size ${value}`)
  }
  const brands = await repository.getProductBrands()
  const names = await repository.getProductNames('brand 000')
  const sizes = await repository.getProductSizes('brand 000', 'name 000')
  for (const values of [brands, names, sizes]) assert.equal(values.length, 100)
  assert.equal(brands[0], 'brand 000')
  assert.equal(brands.at(-1), 'brand 099')
  assert.equal(names[0], 'name')
  assert.equal(names.at(-1), 'name 098')
  assert.equal(sizes[0], 'size 000')
  assert.equal(sizes.at(-1), 'size 099')
})
