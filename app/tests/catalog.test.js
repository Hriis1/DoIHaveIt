import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { decompressGzip } from '../src/modules/catalog/gzip.js'
import { fixture, temporaryDirectory, createSource, product, options, addProduct } from './catalog-fixture.js'
import worker from '../../cloudflareWorkers/src/index.js'

async function* chunks(bytes, size = 13) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size)
}

async function collect(chunks) {
  const output = []
  for await (const chunk of chunks) output.push(chunk)
  return Buffer.concat(output)
}

test('gzip preserves binary bytes across compressed chunk boundaries', async () => {
  const bytes = Buffer.from(Array.from({ length: 100000 }, (_, index) => index % 256))
  assert.deepEqual(await collect(decompressGzip(chunks(gzipSync(bytes), 1))), bytes)
})

test('gzip CRC corruption, truncation, non-gzip and trailing data are rejected', async () => {
  const archive = gzipSync('SQLite format 3\0')
  const damaged = Buffer.from(archive)
  damaged[damaged.length - 8] ^= 1
  for (const bytes of [damaged, archive.subarray(0, archive.length - 4), Buffer.from('not gzip'), Buffer.concat([archive, Buffer.from('junk')])]) {
    await assert.rejects(() => collect(decompressGzip(chunks(bytes))))
  }
})

test('SQL merge skips existing barcodes, respects product ID history and leaves the source unchanged', async t => {
  const { database, repository, source } = fixture(t)
  addProduct(database, { id: 1, brand: 'User', name: 'Existing' })
  addProduct(database, { id: 100, brand: 'Deleted', name: 'Deleted' })
  database.exec(`INSERT INTO codes (code, product_id) VALUES ('001', 1); DELETE FROM products WHERE id = 100;`)
  const path = source([product('001'), product('002', 'Кисело мляко'), { ...product('003'), size: '1 L' }])
  const before = readFileSync(path)
  assert.equal(await repository.importCatalog('Food', path, options()), true)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 3)
  const saved = database.prepare("SELECT * FROM products WHERE id = 102").get()
  assert.equal(saved.name, 'Кисело мляко')
  assert.equal(database.prepare('SELECT size FROM products WHERE id = 103').get().size, '1 L')
  assert.equal(database.prepare('SELECT name, catalog_id FROM products WHERE id = 1').get().name, 'Existing')
  assert.equal(database.prepare("SELECT catalog_id FROM codes WHERE code = '001'").get().catalog_id, null)
  assert.equal(await repository.importCatalog('Food', path, options()), false)
  assert.equal(await repository.isCatalogInstalled('Food'), true)
  assert.deepEqual(readFileSync(path), before)
  assert.equal(database.prepare('PRAGMA database_list').all().some(row => row.name === 'catalog_source'), false)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('new barcodes reuse existing products after trimming and preserve catalog ownership', async t => {
  const { database, repository, source } = fixture(t)
  database.exec("INSERT INTO catalogs (name) VALUES ('Existing');")
  addProduct(database, { id: 10, brand: 'monster', name: 'classic' })
  addProduct(database, { id: 20, brand: 'monster', name: 'classic', size: '500 ml', catalog_id: 1 })
  database.exec("INSERT INTO codes (code, product_id, catalog_id) VALUES ('old-null', 10, NULL), ('old-sized', 20, 1);")
  const before = database.prepare('SELECT * FROM products ORDER BY id;').all()
  await repository.importCatalog('Drinks', source([
    { barcode: 'new-null', brand: ' monster ', name: ' classic ', size: null },
    { barcode: 'new-sized', brand: 'monster', name: 'classic', size: ' 500 ml ' },
    { barcode: 'new-empty', brand: 'monster', name: 'classic', size: ' ' },
  ]), options())
  assert.deepEqual(database.prepare('SELECT * FROM products ORDER BY id;').all(), before)
  const codes = database.prepare('SELECT code, product_id, catalog_id FROM codes ORDER BY code;').all()
  assert.deepEqual(codes.map(row => ({ ...row })), [
    { code: 'new-empty', product_id: 10, catalog_id: 2 },
    { code: 'new-null', product_id: 10, catalog_id: 2 },
    { code: 'new-sized', product_id: 20, catalog_id: 2 },
    { code: 'old-null', product_id: 10, catalog_id: null },
    { code: 'old-sized', product_id: 20, catalog_id: 1 },
  ])
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check;').all(), [])
})

test('matching products in a batch share an identity while exact differences stay separate', async t => {
  const { database, repository, source } = fixture(t)
  const records = [
    { barcode: 'null-a', brand: 'monster', name: 'classic', size: null },
    { barcode: 'null-b', brand: ' monster ', name: ' classic ', size: '' },
    { barcode: 'sized-a', brand: 'monster', name: 'classic', size: '500 ml' },
    { barcode: 'sized-b', brand: 'monster', name: 'classic', size: ' 500 ml ' },
    { barcode: 'smaller', brand: 'monster', name: 'classic', size: '250 ml' },
    { barcode: 'size-spelling', brand: 'monster', name: 'classic', size: '500ml' },
    { barcode: 'brand-case', brand: 'Monster', name: 'classic', size: '500 ml' },
    { barcode: 'name-case', brand: 'monster', name: 'Classic', size: '500 ml' },
  ]
  await repository.importCatalog('Drinks', source(records), options())
  const ids = Object.fromEntries(database.prepare('SELECT code, product_id FROM codes;').all().map(row => [row.code, row.product_id]))
  assert.equal(ids['null-a'], ids['null-b'])
  assert.equal(ids['sized-a'], ids['sized-b'])
  const distinct = ['null-a', 'sized-a', 'smaller', 'size-spelling', 'brand-case', 'name-case']
  assert.equal(new Set(distinct.map(code => ids[code])).size, 6)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products;').get().n, 6)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM codes;').get().n, records.length)
})

test('matching products across import batches share one product', async t => {
  const { database, repository, source } = fixture(t)
  const records = Array.from({ length: 5002 }, (_, index) => product(String(index), 'Shared product'))
  await repository.importCatalog('Drinks', source(records), options())
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products;').get().n, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM codes;').get().n, 5002)
  assert.equal(database.prepare('SELECT COUNT(DISTINCT product_id) AS n FROM codes;').get().n, 1)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check;').all(), [])
})

test('an existing barcode keeps its product when another barcode creates the incoming identity', async t => {
  const { database, repository, source } = fixture(t)
  addProduct(database, { brand: 'User', name: 'Existing' })
  database.exec("INSERT INTO codes (code, product_id) VALUES ('001', 1);")
  await repository.importCatalog('Drinks', source([product('001', 'Shared'), product('002', 'Shared')]), options())
  assert.equal(database.prepare("SELECT product_id FROM codes WHERE code = '001';").get().product_id, 1)
  assert.equal(database.prepare("SELECT catalog_id FROM codes WHERE code = '001';").get().catalog_id, null)
  assert.notEqual(database.prepare("SELECT product_id FROM codes WHERE code = '002';").get().product_id, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products;').get().n, 2)
})

test('sparse source IDs work without sending product records through JavaScript', async t => {
  const { database, adapter, repository, source } = fixture(t)
  const query = adapter.query
  adapter.query = async (...args) => {
    const result = await query(...args)
    for (const row of result.values) assert.ok(!('brand' in row) && !('barcode' in row))
    return result
  }
  await repository.importCatalog('Food', source([{ ...product('001'), source_id: 2 }, { ...product('002'), source_id: 9000000000 }]), options())
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 2)
})

test('an invalid record in a later batch rolls back earlier batches', async t => {
  const { adapter, repository, snapshot, source } = fixture(t)
  const before = snapshot()
  let inserted = false
  const insert = adapter.executeSet
  adapter.executeSet = async (...args) => { await insert(...args); inserted = true }
  const path = source([...Array.from({ length: 5000 }, (_, index) => product(String(index))), product('bad', '')])
  await assert.rejects(() => repository.importCatalog('Food', path, options()), /invalid or missing/)
  assert.equal(inserted, true)
  assert.equal(snapshot(), before)
})

test('empty catalogs, missing unique barcodes, damaged files and unsupported schemas are rejected', async t => {
  const { repository, snapshot, source } = fixture(t)
  const folder = temporaryDirectory(t)
  const damaged = join(folder, 'damaged.sqlite')
  writeFileSync(damaged, 'broken database')
  const wrong = join(folder, 'wrong.sqlite')
  const wrongDatabase = new DatabaseSync(wrong)
  wrongDatabase.exec('CREATE TABLE wrong (id INTEGER);')
  wrongDatabase.close()
  const before = snapshot()
  for (const path of [source([]), createSource(folder, [product('001')], 'nonunique.sqlite', false), damaged, wrong]) {
    await assert.rejects(() => repository.importCatalog('Food', path, options()))
    assert.equal(snapshot(), before)
  }
})

test('cancellation after inserting a batch restores the original database', async t => {
  const { adapter, repository, snapshot, source } = fixture(t)
  const controller = new AbortController()
  const before = snapshot()
  const insert = adapter.executeSet
  adapter.executeSet = async (...args) => { await insert(...args); controller.abort() }
  await assert.rejects(() => repository.importCatalog('Food', source([product('001')]), options(controller.signal)), { name: 'AbortError' })
  assert.equal(snapshot(), before)
})

test('cancellation rolls back new aliases of existing products as well as new products', async t => {
  const { database, adapter, repository, snapshot, source } = fixture(t)
  addProduct(database, { brand: 'Brand', name: 'Shared' })
  database.exec("INSERT INTO codes (code, product_id) VALUES ('old', 1);")
  const before = snapshot()
  const controller = new AbortController()
  const insert = adapter.executeSet
  adapter.executeSet = async (...args) => {
    await insert(...args)
    assert.equal(database.prepare("SELECT product_id FROM codes WHERE code = 'alias';").get().product_id, 1)
    controller.abort()
  }
  await assert.rejects(() => repository.importCatalog('Drinks', source([
    product('alias', 'Shared'), product('new-product'),
  ]), options(controller.signal)), { name: 'AbortError' })
  assert.equal(snapshot(), before)
})

test('database insertion failure rolls back both tables and the catalog row', async t => {
  const { database, adapter, repository, snapshot, source } = fixture(t)
  const before = snapshot()
  adapter.executeSet = async statements => {
    for (const { statement, values } of statements.slice(0, 3)) database.prepare(statement).run(...values)
    throw new Error('Simulated disk error')
  }
  await assert.rejects(() => repository.importCatalog('Food', source([product('001')]), options()), /disk error/)
  assert.equal(snapshot(), before)
})

test('removal preserves collection products, their codes, and externally referenced products', async t => {
  const { database, repository, source } = fixture(t)
  await repository.importCatalog('Food', source([product('001'), product('002'), product('003')]), options())
  database.exec(`INSERT INTO collections (name) VALUES ('Kitchen');
    INSERT INTO items (collection_id, product_id) VALUES (1, 1);
    INSERT INTO codes (code, product_id) VALUES ('manual', 3);`)
  assert.equal(await repository.removeCatalog('Food', options()), true)
  assert.equal(await repository.isCatalogInstalled('Food'), false)
  assert.deepEqual(database.prepare('SELECT id, catalog_id FROM products ORDER BY id').all().map(row => ({ ...row })), [{ id: 1, catalog_id: null }, { id: 3, catalog_id: null }])
  assert.deepEqual(database.prepare('SELECT code, catalog_id FROM codes ORDER BY code').all().map(row => ({ ...row })), [{ code: '001', catalog_id: null }, { code: 'manual', catalog_id: null }])
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1)
  assert.equal(await repository.removeCatalog('Food', options()), false)
})

test('removing either catalog preserves a product still referenced by another catalog', async t => {
  const { database, repository, source } = fixture(t)
  await repository.importCatalog('First', source([product('first', 'Shared')]), options())
  const secondSource = source([product('second', 'Shared')])
  await repository.importCatalog('Second', secondSource, options())
  const owner = database.prepare('SELECT id, catalog_id FROM products;').get()
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products;').get().n, 1)
  assert.equal(database.prepare("SELECT product_id FROM codes WHERE code = 'second';").get().product_id, owner.id)

  await repository.removeCatalog('Second', options())
  assert.deepEqual(database.prepare('SELECT id, catalog_id FROM products;').get(), owner)
  assert.equal(database.prepare("SELECT product_id FROM codes WHERE code = 'first';").get().product_id, owner.id)
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM codes WHERE code = 'second';").get().n, 0)

  await repository.importCatalog('Second', secondSource, options())
  await repository.removeCatalog('First', options())
  assert.equal(database.prepare('SELECT id, catalog_id FROM products;').get().id, owner.id)
  assert.equal(database.prepare('SELECT catalog_id FROM products;').get().catalog_id, null)
  assert.equal(database.prepare("SELECT product_id FROM codes WHERE code = 'second';").get().product_id, owner.id)
  assert.equal(await repository.isCatalogInstalled('Second'), true)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check;').all(), [])
})

test('removing catalogs retains collection products and all of their imported barcode aliases', async t => {
  const { database, repository, source } = fixture(t)
  addProduct(database, { brand: 'Brand', name: 'Shared' })
  database.exec(`INSERT INTO collections (name) VALUES ('Drinks');
    INSERT INTO items (collection_id, product_id) VALUES (1, 1);`)
  await repository.importCatalog('First', source([product('first', 'Shared')]), options())
  await repository.importCatalog('Second', source([product('second', 'Shared')]), options())
  await repository.removeCatalog('First', options())
  await repository.removeCatalog('Second', options())
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products;').get().n, 1)
  assert.equal(database.prepare('SELECT product_id FROM items;').get().product_id, 1)
  const codes = database.prepare('SELECT code, product_id, catalog_id FROM codes ORDER BY code;').all()
  assert.deepEqual(codes.map(row => ({ ...row })), [
    { code: 'first', product_id: 1, catalog_id: null }, { code: 'second', product_id: 1, catalog_id: null },
  ])
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check;').all(), [])
})

test('cancellation during removal restores deleted rows and catalog associations', async t => {
  const { adapter, repository, snapshot, source } = fixture(t)
  await repository.importCatalog('Food', source([product('001'), product('002')]), options())
  const before = snapshot()
  const controller = new AbortController()
  const run = adapter.run
  adapter.run = async (...args) => { const result = await run(...args); controller.abort(); return result }
  await assert.rejects(() => repository.removeCatalog('Food', options(controller.signal)), { name: 'AbortError' })
  assert.equal(snapshot(), before)
})

test('process termination before commit leaves no catalog rows after SQLite recovery', t => {
  const folder = temporaryDirectory(t)
  const targetPath = join(folder, 'target.sqlite')
  const sourcePath = createSource(folder, Array.from({ length: 5000 }, (_, index) => product(String(index))))
  const database = new DatabaseSync(targetPath)
  const source = readFileSync(new URL('../src/database.js', import.meta.url), 'utf8')
  const schema = source.match(/await database\.execute\(`([\s\S]*?)`\)/)[1]
  database.exec(schema)
  addProduct(database, { brand: 'User', name: 'Existing' })
  database.close()
  const script = `
    import { DatabaseSync } from 'node:sqlite'
    import { createCatalogRepository } from './src/repositories/catalogRepo.js'
    const database = new DatabaseSync(process.argv[1])
    database.exec(${JSON.stringify(schema)})
    database.exec('PRAGMA journal_mode = DELETE; PRAGMA cache_size = 10; PRAGMA synchronous = FULL;')
    const adapter = {
      query: async (sql, values = []) => ({ values: database.prepare(sql).all(...values) }),
      run: async (sql, values = []) => database.prepare(sql).run(...values),
      executeSet: async statements => {
        for (const { statement, values } of statements) database.prepare(statement).run(...values)
        process.exit(7)
      },
      beginTransaction: async () => database.exec('BEGIN'),
      commitTransaction: async () => database.exec('COMMIT'),
      rollbackTransaction: async () => database.exec('ROLLBACK'),
    }
    await createCatalogRepository(operation => operation(adapter)).importCatalog('Food', process.argv[2], { onProgress: () => {} })
  `
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script, targetPath, sourcePath], {
    cwd: new URL('..', import.meta.url), stdio: 'pipe',
  }), error => error.status === 7)
  assert.ok(existsSync(targetPath + '-journal'), 'Termination must leave an actual rollback journal to recover')
  const recovered = new DatabaseSync(targetPath)
  try {
    assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM products').get().n, 1)
    assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM codes').get().n, 0)
    assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM catalogs').get().n, 0)
    assert.equal(recovered.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { recovered.close() }
})

test('worker serves SQLite archive bytes with CORS and confines names', async () => {
  const keys = []
  const env = { CATALOGS: { get: async key => {
    keys.push(key)
    return { body: new Uint8Array([31, 139]), size: 2, httpEtag: '"catalog"' }
  } } }
  for (const [query, extension, type] of [
    ['', '.sqlite', 'application/vnd.sqlite3'],
    ['?compressed=false', '.sqlite', 'application/vnd.sqlite3'],
    ['?compressed=true', '.sqlite.gz', 'application/gzip'],
  ]) {
    const response = await worker.fetch(new Request(`https://example.com/catalogs/drinsAndFoodData${query}`), env)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(response.headers.get('content-type'), type)
    assert.equal((await response.arrayBuffer()).byteLength, 2)
    assert.equal(keys.at(-1), `data/drinsAndFoodData${extension}`)
  }
  for (const name of ['a-b', 'a_b', 'a%2Fb', '%00', '%ZZ']) {
    const rejected = await worker.fetch(new Request(`https://example.com/catalogs/${name}`), env)
    assert.equal(rejected.status, 400)
    assert.equal(rejected.headers.get('access-control-allow-origin'), '*')
  }
  assert.equal(keys.length, 3)
})
