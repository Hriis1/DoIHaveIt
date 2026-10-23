import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { decompressGzip } from '../src/modules/catalog/gzip.js'
import { fixture, temporaryDirectory, createSource, product, options } from './catalog-fixture.js'
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
  database.exec(`INSERT INTO products (id, brand, name) VALUES (1, 'User', 'Existing');
    INSERT INTO codes (code, product_id) VALUES ('001', 1);
    INSERT INTO products (id, brand, name) VALUES (100, 'Deleted', 'Deleted'); DELETE FROM products WHERE id = 100;`)
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

test('database insertion failure rolls back both tables and the catalog row', async t => {
  const { database, adapter, repository, snapshot, source } = fixture(t)
  const before = snapshot()
  adapter.executeSet = async statements => {
    database.prepare(statements[0].statement).run(...statements[0].values)
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
  database.exec(source.match(/await database\.execute\(`([\s\S]*?)`\)/)[1])
  database.exec("INSERT INTO products (brand, name) VALUES ('User', 'Existing');")
  database.close()
  const script = `
    import { DatabaseSync } from 'node:sqlite'
    import { createCatalogRepository } from './src/repositories/catalogRepo.js'
    const database = new DatabaseSync(process.argv[1])
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
  const response = await worker.fetch(new Request('https://example.com/catalogs/drinsAndFoodData'), env)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal((await response.arrayBuffer()).byteLength, 2)
  assert.deepEqual(keys, ['data/drinsAndFoodData.sqlite.gz'])
  for (const name of ['a-b', 'a_b', 'a%2Fb', '%00', '%ZZ']) {
    const rejected = await worker.fetch(new Request(`https://example.com/catalogs/${name}`), env)
    assert.equal(rejected.status, 400)
    assert.equal(rejected.headers.get('access-control-allow-origin'), '*')
  }
  assert.equal(keys.length, 1)
})
