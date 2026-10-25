import { Filesystem, Directory } from '@capacitor/filesystem'
import { checkCancellation } from './cancellation.js'
import { decompressGzip } from './gzip.js'

const folder = 'catalog-downloads'
const fileOptions = path => ({ path, directory: Directory.Cache })
let cacheReady

function encodeBase64(bytes) {
  const parts = []
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
  }
  return btoa(parts.join(''))
}

export function prepareCatalogCache() {
  if (!cacheReady) {
    cacheReady = (async () => {
      let files
      try {
        const result = await Filesystem.readdir(fileOptions(folder))
        files = result.files
      } catch {
        await Filesystem.mkdir({ ...fileOptions(folder), recursive: true })
        return
      }
      // Only this module owns this directory; discard archives left by terminated imports
      for (const file of files) {
        if (file.type === 'file') await Filesystem.deleteFile(fileOptions(`${folder}/${file.name}`))
      }
    })().catch(error => {
      cacheReady = undefined
      throw error
    })
  }
  return cacheReady
}

export async function deleteArchive(path) {
  try {
    await Filesystem.deleteFile(fileOptions(path))
  } catch (error) {
    // Startup cleanup retries if cache storage was unavailable during completion
    console.warn('Could not remove the temporary catalog archive:', error)
  }
}

export async function downloadArchive(name, signal, compressed = false) {
  await prepareCatalogCache()
  checkCancellation(signal)
  const path = `${folder}/${name}.sqlite${compressed ? '.gz' : ''}`
  let reader
  try {
    const response = await fetch(`https://doihaveit-api.hrishd.workers.dev/catalogs/${name}?compressed=${compressed}`, { signal })
    if (!response.ok) throw new Error(`Catalog download failed (HTTP ${response.status}).`)
    if (!response.body) throw new Error('Streaming downloads are not supported on this device.')
    await Filesystem.writeFile({ ...fileOptions(path), data: '' })
    reader = response.body.getReader()
    while (true) {
      checkCancellation(signal)
      const { done, value } = await reader.read()
      if (done) break
      // Send bounded pieces through Capacitor instead of retaining a whole response in memory
      for (let offset = 0; offset < value.length; offset += 32768) {
        checkCancellation(signal)
        const data = encodeBase64(value.subarray(offset, offset + 32768))
        await Filesystem.appendFile({ ...fileOptions(path), data })
      }
    }
    checkCancellation(signal)
    return path
  } catch (error) {
    await deleteArchive(path)
    throw error
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

export async function* readArchiveChunks(path, signal) {
  const chunkSize = 256 * 1024
  const { size } = await Filesystem.stat(fileOptions(path))
  for (let offset = 0; offset < size; offset += chunkSize) {
    checkCancellation(signal)
    const length = Math.min(chunkSize, size - offset)
    const { data } = await Filesystem.readFile({ ...fileOptions(path), offset, length })
    const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0))
    if (bytes.length !== length) throw new Error('The downloaded catalog archive is incomplete.')
    yield bytes
  }
}

export async function getArchiveSource(path) {
  const { uri } = await Filesystem.getUri(fileOptions(path))
  const url = new URL(uri)
  if (url.protocol !== 'file:') throw new Error('The catalog database path is not supported on this device.')
  return { path, databasePath: decodeURIComponent(url.pathname) }
}

export async function decompressArchive(archive, signal) {
  const path = archive.slice(0, -3)
  let firstChunk = true
  try {
    await Filesystem.writeFile({ ...fileOptions(path), data: '' })
    for await (const bytes of decompressGzip(readArchiveChunks(archive, signal), signal)) {
      checkCancellation(signal)
      if (firstChunk) {
        if (String.fromCharCode(...bytes.subarray(0, 16)) !== 'SQLite format 3\0') {
          throw new Error('The catalog archive does not contain a SQLite database.')
        }
        firstChunk = false
      }
      await Filesystem.appendFile({ ...fileOptions(path), data: encodeBase64(bytes) })
    }
    if (firstChunk) throw new Error('The catalog archive is empty.')
    checkCancellation(signal)
    return await getArchiveSource(path)
  } catch (error) {
    await deleteArchive(path)
    throw error
  }
}
