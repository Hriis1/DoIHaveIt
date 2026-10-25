import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { gzipSync } from 'node:zlib'

const files = new Map([['catalog-downloads/abandoned.sqlite.gz', Buffer.from('old')], ['catalog-downloads/abandoned.sqlite', Buffer.from('old')]])
const writes = []
const reads = []
const filesystem = {
  readdir: async () => ({ files: [...files.keys()].map(path => ({ name: path.split('/').at(-1), type: 'file' })) }),
  mkdir: async () => {},
  deleteFile: async ({ path }) => { files.delete(path) },
  writeFile: async ({ path, data }) => { files.set(path, Buffer.from(data, 'base64')) },
  appendFile: async ({ path, data }) => {
    const bytes = Buffer.from(data, 'base64')
    writes.push(bytes.length)
    files.set(path, Buffer.concat([files.get(path), bytes]))
  },
  stat: async ({ path }) => ({ size: files.get(path).length }),
  readFile: async ({ path, offset, length }) => {
    reads.push(length)
    return { data: files.get(path).subarray(offset, offset + length).toString('base64') }
  },
  getUri: async ({ path }) => ({ uri: `file:///app%20cache/${path}` }),
}

mock.module('@capacitor/filesystem', { namedExports: { Filesystem: filesystem, Directory: { Cache: 'CACHE' } } })
mock.module('@capacitor/core', { namedExports: { Capacitor: { isNativePlatform: () => true } } })
let installed = false
mock.module('../src/repositories/catalogRepo.js', { namedExports: {
  isCatalogInstalled: async () => installed,
  importCatalog: async (name, path, { signal, onProgress }) => {
    assert.equal(path, `/app cache/catalog-downloads/${name}.sqlite`)
    assert.equal(files.get(`catalog-downloads/${name}.sqlite`).subarray(0, 16).toString(), 'SQLite format 3\0')
    onProgress('checking')
    onProgress('importing')
    signal?.throwIfAborted()
    onProgress('finishing')
    installed = true
    return true
  },
  removeCatalog: async () => { installed = false; return true },
} })

const { prepareCatalogCache, downloadArchive, readArchiveChunks, deleteArchive, decompressArchive } = await import('../src/modules/catalog/archive.js')
const { Catalog } = await import('../src/modules/catalog/catalog.js')

test('cache cleanup, bounded download writes and bounded archive reads', async () => {
  await prepareCatalogCache()
  assert.equal(files.size, 0)
  const bytes = Buffer.alloc(700000, 3)
  mock.method(globalThis, 'fetch', async () => new Response(bytes))
  const path = await downloadArchive('Food')
  assert.deepEqual(files.get(path), bytes)
  assert.ok(Math.max(...writes) <= 32768)
  const pieces = []
  for await (const chunk of readArchiveChunks(path)) pieces.push(chunk)
  assert.deepEqual(Buffer.concat(pieces), bytes)
  assert.ok(Math.max(...reads) <= 256 * 1024)
  await deleteArchive(path)
  assert.equal(files.size, 0)
  mock.restoreAll()
})

test('cancelling download aborts the stream and removes partial files', async () => {
  const controller = new AbortController()
  mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(100000)))
  const append = filesystem.appendFile
  filesystem.appendFile = async parameters => { await append(parameters); controller.abort() }
  try {
    await assert.rejects(() => downloadArchive('Food', controller.signal), { name: 'AbortError' })
    assert.equal(files.size, 0)
  } finally {
    filesystem.appendFile = append
    mock.restoreAll()
  }
})

test('class reports phases, skips repeat installs and cleans up after import', async () => {
  const bytes = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(200000, 5)])
  const archive = gzipSync(bytes)
  let downloads = 0
  mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).searchParams.get('compressed'), 'true')
    downloads++
    return new Response(archive)
  })
  const catalog = new Catalog('Food')
  const phases = []
  assert.equal(await catalog.up({ compressed: true, onProgress: phase => phases.push(phase) }), true)
  assert.deepEqual(phases, ['preparing', 'downloading', 'decompressing', 'checking', 'importing', 'finishing', 'complete'])
  assert.equal(files.size, 0)
  assert.equal(await catalog.up(), false)
  assert.equal(downloads, 1)
  assert.equal(await catalog.down(), true)
  assert.equal(installed, false)
  mock.restoreAll()
})

test('class imports uncompressed SQLite by default or explicitly without decompression', async () => {
  const bytes = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(200000, 5)])
  mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).searchParams.get('compressed'), 'false')
    return new Response(bytes)
  })
  for (const options of [{}, { compressed: false }]) {
    const catalog = new Catalog('Food')
    const phases = []
    assert.equal(await catalog.up({ ...options, onProgress: phase => phases.push(phase) }), true)
    assert.deepEqual(phases, ['preparing', 'downloading', 'checking', 'importing', 'finishing', 'complete'])
    assert.equal(files.size, 0)
    await catalog.down()
  }
  mock.restoreAll()
})

test('class cleans downloaded files after a corrupt archive fails', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('broken gzip'))
  await assert.rejects(() => new Catalog('Food').up({ compressed: true }))
  assert.equal(installed, false)
  assert.equal(files.size, 0)
  mock.restoreAll()
})

test('decompression preserves binary bytes in bounded writes and returns a decoded native path', async () => {
  const bytes = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(1300000, 8)])
  const path = 'catalog-downloads/Food.sqlite.gz'
  files.set(path, gzipSync(bytes))
  writes.length = 0
  const source = await decompressArchive(path)
  assert.deepEqual(files.get(source.path), bytes)
  assert.equal(source.databasePath, '/app cache/catalog-downloads/Food.sqlite')
  assert.ok(Math.max(...writes) <= 512 * 1024)
  await deleteArchive(source.path)
  await deleteArchive(path)
})

test('cancelling decompression removes the incomplete SQLite file and download', async () => {
  const controller = new AbortController()
  const archive = gzipSync(Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(200000)]))
  mock.method(globalThis, 'fetch', async () => new Response(archive))
  const append = filesystem.appendFile
  filesystem.appendFile = async parameters => {
    await append(parameters)
    if (parameters.path.endsWith('.sqlite')) controller.abort()
  }
  try {
    await assert.rejects(() => new Catalog('Food').up({ compressed: true, signal: controller.signal }), { name: 'AbortError' })
    assert.equal(files.size, 0)
    assert.equal(installed, false)
  } finally {
    filesystem.appendFile = append
    mock.restoreAll()
  }
})

test('a gzip containing JSON instead of SQLite is rejected and cleaned up', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(gzipSync('{"barcode":"001"}')))
  await assert.rejects(() => new Catalog('Food').up({ compressed: true }), /SQLite database/)
  assert.equal(files.size, 0)
  assert.equal(installed, false)
  mock.restoreAll()
})
