import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { gzipSync } from 'node:zlib'

const files = new Map([['catalog-downloads/abandoned.jsonl.gz', Buffer.from('old')]])
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
}

mock.module('@capacitor/filesystem', { namedExports: { Filesystem: filesystem, Directory: { Cache: 'CACHE' } } })
mock.module('@capacitor/core', { namedExports: { Capacitor: { isNativePlatform: () => true } } })
let installed = false
mock.module('../src/repositories/catalogRepo.js', { namedExports: {
  isCatalogInstalled: async () => installed,
  importCatalog: async (name, batches, { signal, onProgress }) => {
    onProgress('importing')
    for await (const batch of batches) { signal?.throwIfAborted(); assert.ok(batch.length <= 1000) }
    signal?.throwIfAborted()
    onProgress('finishing')
    installed = true
    return true
  },
  removeCatalog: async () => { installed = false; return true },
} })

const { prepareCatalogCache, downloadArchive, readArchiveChunks, deleteArchive } = await import('../src/modules/catalog/archive.js')
const { Catalog } = await import('../src/modules/catalog/catalog.js')

test('cache cleanup, bounded download writes and bounded archive reads', async () => {
  await prepareCatalogCache()
  assert.equal(files.size, 0)
  const bytes = Buffer.alloc(200000, 3)
  mock.method(globalThis, 'fetch', async () => new Response(bytes))
  const path = await downloadArchive('Food')
  assert.deepEqual(files.get(path), bytes)
  assert.ok(Math.max(...writes) <= 32768)
  const pieces = []
  for await (const chunk of readArchiveChunks(path)) pieces.push(chunk)
  assert.deepEqual(Buffer.concat(pieces), bytes)
  assert.ok(Math.max(...reads) <= 16384)
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
  const archive = gzipSync(JSON.stringify({ barcode: '001', brand: 'Brand', name: 'Food', size: null }) + '\n')
  let downloads = 0
  mock.method(globalThis, 'fetch', async () => { downloads++; return new Response(archive) })
  const catalog = new Catalog('Food')
  const phases = []
  assert.equal(await catalog.up({ onProgress: phase => phases.push(phase) }), true)
  assert.deepEqual(phases, ['preparing', 'downloading', 'importing', 'finishing', 'complete'])
  assert.equal(files.size, 0)
  assert.equal(await catalog.up(), false)
  assert.equal(downloads, 1)
  assert.equal(await catalog.down(), true)
  assert.equal(installed, false)
  mock.restoreAll()
})

test('class cleans downloaded files after a corrupt archive fails', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('broken gzip'))
  await assert.rejects(() => new Catalog('Food').up())
  assert.equal(installed, false)
  assert.equal(files.size, 0)
  mock.restoreAll()
})
