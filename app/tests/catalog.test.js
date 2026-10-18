import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { createCatalogRepository } from '../src/repositories/catalogRepo.js'
import { readCatalogBatches } from '../src/modules/catalog/records.js'
import worker from '../../cloudflareWorkers/src/index.js'

const product = (barcode, name = 'Product') => ({ barcode, brand: 'Brand', name, size: null })
const options = signal => ({ signal, onProgress: () => {} })

function fixture() {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON;')
  const source = readFileSync(new URL('../src/database.js', import.meta.url), 'utf8')
  database.exec(source.match(/await database\.execute\(`([\s\S]*?)`\)/)[1])
  const adapter = {
    query: async (sql, values = []) => ({ values: database.prepare(sql).all(...values) }),
    run: async (sql, values = []) => database.prepare(sql).run(...values),
    executeSet: async (statements, transaction) => {
      assert.equal(transaction, false, 'Batches must not commit independently')
      for (const { statement, values } of statements) database.prepare(statement).run(...values)
    },
    beginTransaction: async () => database.exec('BEGIN TRANSACTION;'),
    commitTransaction: async () => database.exec('COMMIT;'),
    rollbackTransaction: async () => database.exec('ROLLBACK;'),
  }
  const repository = createCatalogRepository(operation => operation(adapter))
  const snapshot = () => JSON.stringify(['catalogs', 'products', 'codes', 'items', 'collections'].map(table =>
    database.prepare(`SELECT * FROM ${table} ORDER BY rowid;`).all()))
  return { database, adapter, repository, snapshot }
}

async function* chunks(bytes, size = 13) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size)
}

async function collect(batches) {
  const output = []
  for await (const batch of batches) output.push(...batch)
  return output
}

async function* batches(...records) {
  for (const batch of records) yield batch
}

test('gzip and UTF-8 boundaries, CRLF and a final line without newline', async () => {
  const records = [product('001', 'Кисело мляко'), product('002', 'Café')]
  const archive = gzipSync(records.map(row => JSON.stringify(row)).join('\r\n'))
  assert.deepEqual(await collect(readCatalogBatches(chunks(archive, 1))), records)
})

test('gzip CRC corruption and truncation are rejected', async () => {
  const archive = gzipSync(JSON.stringify(product('001')) + '\n')
  const damaged = Buffer.from(archive)
  damaged[damaged.length - 8] ^= 1
  for (const bytes of [damaged, archive.subarray(0, archive.length - 4), Buffer.from('not gzip')]) {
    await assert.rejects(() => collect(readCatalogBatches(chunks(bytes))))
  }
})

test('malformed records, missing fields, invalid UTF-8 and empty archives fail', async () => {
  for (const text of ['{', '{}', '\n', '', JSON.stringify({ ...product('1'), size: 4 })]) {
    await assert.rejects(() => collect(readCatalogBatches(chunks(gzipSync(text)))))
  }
  await assert.rejects(() => collect(readCatalogBatches(chunks(gzipSync(Buffer.from([0xff, 0x0a]))))))
})

test('existing barcodes are skipped and the first duplicate is retained', async t => {
  const { database, repository } = fixture()
  t.after(() => database.close())
  database.exec("INSERT INTO products (id, brand, name) VALUES (1, 'User', 'Existing'); INSERT INTO codes (code, product_id) VALUES ('001', 1);")
  await repository.importCatalog('Food', batches(
    [product('001'), product('002', 'First'), product('002', 'Second')],
    [product('002', 'Third'), product('003')],
  ), options())
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 3)
  assert.equal(database.prepare("SELECT name FROM products JOIN codes ON products.id = codes.product_id WHERE code = '002'").get().name, 'First')
  assert.equal(database.prepare("SELECT catalog_id FROM codes WHERE code = '001'").get().catalog_id, null)
  assert.equal(await repository.importCatalog('Food', batches([product('004')]), options()), false)
  assert.equal(await repository.isCatalogInstalled('Food'), true)
})

test('a malformed final record rolls back rows already inserted in earlier batches', async t => {
  const { database, repository, snapshot } = fixture()
  t.after(() => database.close())
  const before = snapshot()
  const text = Array.from({ length: 1100 }, (_, index) => JSON.stringify(product(String(index)))).join('\n') + '\n{bad}\n'
  const archive = gzipSync(text)
  await assert.rejects(() => repository.importCatalog('Food', readCatalogBatches(chunks(archive, 100)), options()))
  assert.equal(snapshot(), before)
})

test('cancellation after inserting a batch restores the original database', async t => {
  const { database, adapter, repository, snapshot } = fixture()
  t.after(() => database.close())
  const controller = new AbortController()
  const before = snapshot()
  const insert = adapter.executeSet
  adapter.executeSet = async (...args) => { await insert(...args); controller.abort() }
  await assert.rejects(() => repository.importCatalog('Food', batches([product('001')]), options(controller.signal)), { name: 'AbortError' })
  assert.equal(snapshot(), before)
})

test('database insertion failure rolls back both tables and the catalog row', async t => {
  const { database, adapter, repository, snapshot } = fixture()
  t.after(() => database.close())
  const before = snapshot()
  adapter.executeSet = async statements => {
    database.prepare(statements[0].statement).run(...statements[0].values)
    throw new Error('Simulated disk error')
  }
  await assert.rejects(() => repository.importCatalog('Food', batches([product('001')]), options()), /disk error/)
  assert.equal(snapshot(), before)
})

test('removal preserves collection products, their codes, and externally referenced products', async t => {
  const { database, repository } = fixture()
  t.after(() => database.close())
  await repository.importCatalog('Food', batches([product('001'), product('002'), product('003')]), options())
  database.exec(`
    INSERT INTO collections (name) VALUES ('Kitchen');
    INSERT INTO items (collection_id, product_id) VALUES (1, 1);
    INSERT INTO codes (code, product_id) VALUES ('manual', 3);
  `)
  assert.equal(await repository.removeCatalog('Food', options()), true)
  assert.equal(await repository.isCatalogInstalled('Food'), false)
  assert.deepEqual(database.prepare('SELECT id, catalog_id FROM products ORDER BY id').all().map(row => ({ ...row })), [{ id: 1, catalog_id: null }, { id: 3, catalog_id: null }])
  assert.deepEqual(database.prepare('SELECT code, catalog_id FROM codes ORDER BY code').all().map(row => ({ ...row })), [{ code: '001', catalog_id: null }, { code: 'manual', catalog_id: null }])
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1)
  assert.equal(await repository.removeCatalog('Food', options()), false)
})

test('cancellation during removal restores deleted rows and catalog associations', async t => {
  const { database, adapter, repository, snapshot } = fixture()
  t.after(() => database.close())
  await repository.importCatalog('Food', batches([product('001'), product('002')]), options())
  const before = snapshot()
  const controller = new AbortController()
  const run = adapter.run
  adapter.run = async (...args) => { const result = await run(...args); controller.abort(); return result }
  await assert.rejects(() => repository.removeCatalog('Food', options(controller.signal)), { name: 'AbortError' })
  assert.equal(snapshot(), before)
})

test('worker serves archive bytes with CORS for app WebViews and confines names', async () => {
  const keys = []
  const env = { CATALOGS: { get: async key => {
    keys.push(key)
    return { body: new Uint8Array([31, 139]), size: 2, httpEtag: '"catalog"' }
  } } }
  const response = await worker.fetch(new Request('https://example.com/catalogs/drinsAndFoodData'), env)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal((await response.arrayBuffer()).byteLength, 2)
  assert.deepEqual(keys, ['data/drinsAndFoodData.jsonl.gz'])
  for (const name of ['a-b', 'a_b', 'a%2Fb', '%00', '%ZZ']) {
    const rejected = await worker.fetch(new Request(`https://example.com/catalogs/${name}`), env)
    assert.equal(rejected.status, 400)
    assert.equal(rejected.headers.get('access-control-allow-origin'), '*')
  }
  assert.equal(keys.length, 1)
})
