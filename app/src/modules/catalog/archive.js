import { Filesystem, Directory } from '@capacitor/filesystem'
import { checkCancellation } from './cancellation.js'

const folder = 'catalog-downloads'
const fileOptions = path => ({ path, directory: Directory.Cache })
let cacheReady

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

export async function downloadArchive(name, signal) {
  await prepareCatalogCache()
  checkCancellation(signal)
  const path = `${folder}/${name}.jsonl.gz`
  let reader
  try {
    const response = await fetch(`https://doihaveit-api.hrishd.workers.dev/catalogs/${name}`, { signal })
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
        const data = btoa(String.fromCharCode(...value.subarray(offset, offset + 32768)))
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
  const { size } = await Filesystem.stat(fileOptions(path))
  for (let offset = 0; offset < size; offset += 16384) {
    checkCancellation(signal)
    const length = Math.min(16384, size - offset)
    const { data } = await Filesystem.readFile({ ...fileOptions(path), offset, length })
    const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0))
    if (bytes.length !== length) throw new Error('The downloaded catalog archive is incomplete.')
    yield bytes
  }
}
