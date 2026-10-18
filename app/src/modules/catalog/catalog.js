import { Capacitor } from '@capacitor/core'
import { isCatalogInstalled, importCatalog, removeCatalog } from '../../repositories/catalogRepo.js'
import { downloadArchive, deleteArchive, readArchiveChunks } from './archive.js'
import { readCatalogBatches } from './records.js'
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

  up(options = {}) {
    return this._schedule(async ({ signal, onProgress }) => {
      if (await this.getInstalled()) return false
      onProgress('downloading')
      const path = await downloadArchive(this._name, signal)
      try {
        const batches = readCatalogBatches(readArchiveChunks(path, signal), signal)
        return await importCatalog(this._name, batches, { signal, onProgress })
      } finally {
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
