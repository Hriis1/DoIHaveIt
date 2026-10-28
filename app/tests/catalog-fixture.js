import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCatalogRepository } from '../src/repositories/catalogRepo.js'

export const product = (barcode, name = `Product ${barcode}`) => ({ barcode, brand: 'Brand', name, size: null })
export const options = signal => ({ signal, onProgress: () => {} })

export function addProduct(database, { id = null, brand, name, size = null, catalog_id = null }) {
  const result = database.prepare('INSERT INTO products (id, name, size, catalog_id) VALUES (?, ?, ?, ?)').run(id, name, size, catalog_id)
  const productId = Number(result.lastInsertRowid)
  for (const label of [...new Set(brand.split(',').map(value => value.trim()).filter(Boolean))]) {
    database.prepare('INSERT INTO brands (name) VALUES (?) ON CONFLICT DO NOTHING').run(label)
    const { id: brandId } = database.prepare('SELECT id FROM brands WHERE name = ?').get(label)
    database.prepare('INSERT INTO product_brands VALUES (?, ?)').run(productId, brandId)
  }
  return productId
}

export function temporaryDirectory(t) {
  const root = resolve(tmpdir())
  const folder = mkdtempSync(join(root, 'doihaveit-catalog-'))
  t.after(() => {
    assert.ok(resolve(folder).startsWith(root + sep))
    rmSync(folder, { recursive: true, force: true })
  })
  return folder
}

export function createSource(folder, records, name = 'source.sqlite', unique = true) {
  const path = join(folder, name)
  const source = new DatabaseSync(path)
  try {
    source.exec(`CREATE TABLE catalog_products (
      source_id INTEGER PRIMARY KEY, barcode TEXT ${unique ? 'UNIQUE' : ''}, brand TEXT, name TEXT, size TEXT
    ); BEGIN;`)
    const insert = source.prepare('INSERT INTO catalog_products VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING;')
    for (const record of records) insert.run(record.source_id ?? null, record.barcode, record.brand, record.name, record.size)
    source.exec('COMMIT;')
  } finally {
    source.close()
  }
  return path
}

export function fixture(t) {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON;')
  const source = readFileSync(new URL('../src/database.js', import.meta.url), 'utf8')
  database.exec(source.match(/await database\.execute\(`([\s\S]*?)`\)/)[1])
  t.after(() => database.close())
  const folder = temporaryDirectory(t)
  const adapter = {
    query: async (sql, values = []) => ({ values: database.prepare(sql).all(...values) }),
    run: async (sql, values = [], transaction) => {
      assert.equal(transaction, false)
      return database.prepare(sql).run(...values)
    },
    executeSet: async (statements, transaction) => {
      assert.equal(transaction, false, 'Batches must not commit independently')
      for (const { statement, values } of statements) database.prepare(statement).run(...values)
    },
    beginTransaction: async () => database.exec('BEGIN TRANSACTION;'),
    commitTransaction: async () => database.exec('COMMIT;'),
    rollbackTransaction: async () => database.exec('ROLLBACK;'),
    close: async () => database.close(),
  }
  const repository = createCatalogRepository(operation => operation(adapter))
  const snapshot = () => JSON.stringify(['catalogs', 'brands', 'products', 'product_brands', 'codes', 'items', 'collections'].map(table =>
    database.prepare(`SELECT * FROM ${table} ORDER BY rowid;`).all()))
  let sequence = 0
  return { database, adapter, repository, snapshot, source: records => createSource(folder, records, `source ${++sequence}'s.sqlite`) }
}
