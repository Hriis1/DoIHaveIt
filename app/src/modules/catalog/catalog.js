import { Capacitor } from '@capacitor/core'
import { isCatalogInstalled, importCatalog, removeCatalog } from '../../repositories/catalogRepo.js'
import { downloadArchive, deleteArchive, decompressArchive, getArchiveSource } from './archive.js'
import { checkCancellation } from './cancellation.js'

let operationQueue = Promise.resolve()

export class Catalog {
  constructor(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9]+$/.test(name)) throw new Error('Invalid catalog name.')
    this._name = name
  }

  getInstalled() {
    return isCatalogInstalled(this._name)
  }

  up({ compressed = false, ...options } = {}) {
    return this._schedule(async ({ signal, onProgress }) => {
      if (await this.getInstalled()) return false
      onProgress('downloading')
      const path = await downloadArchive(this._name, signal, compressed)
      let source
      try {
        if (compressed) {
          onProgress('decompressing')
          source = await decompressArchive(path, signal)
        } else {
          source = await getArchiveSource(path)
        }
        return await importCatalog(this._name, source.databasePath, { signal, onProgress })
      } finally {
        if (source && source.path !== path) await deleteArchive(source.path)
        await deleteArchive(path)
      }
    }, options)
  }

  down(options = {}) {
    return this._schedule(settings => removeCatalog(this._name, settings), options)
  }

  _schedule(operation, { signal, onProgress = () => {} }) {
    const report = phase => {
      try { onProgress(phase) } catch (error) { console.warn('Catalog status listener failed:', error) }
    }
    const result = operationQueue.then(async () => {
      if (!Capacitor.isNativePlatform()) throw new Error('Catalogs are available in the Android and iOS app.')
      checkCancellation(signal)
      report('preparing')
      const cancelled = () => report('cancelling')
      signal?.addEventListener('abort', cancelled, { once: true })
      try {
        const changed = await operation({ signal, onProgress: report })
        report('complete')
        return changed
      } finally {
        signal?.removeEventListener('abort', cancelled)
      }
    })
    operationQueue = result.catch(() => {})
    return result
  }
}
