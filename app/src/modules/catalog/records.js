import { Inflate } from 'pako'
import { checkCancellation } from './cancellation.js'

const maximumLineLength = 1024 * 1024

function parseRecord(line) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    throw new Error('The catalog contains invalid JSON.')
  }
  if (!record || typeof record !== 'object' ||
      !['barcode', 'brand', 'name'].every(key => typeof record[key] === 'string' && record[key].trim()) ||
      (record.size !== undefined && record.size !== null && typeof record.size !== 'string')) {
    throw new Error('The catalog contains a product with invalid or missing fields.')
  }
  return {
    barcode: record.barcode.trim(), brand: record.brand.trim(), name: record.name.trim(),
    size: typeof record.size === 'string' ? record.size.trim() || null : null,
  }
}

// Pull compressed chunks only when the previous records have been consumed
export async function* readCatalogBatches(chunks, signal) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const inflater = new Inflate({ windowBits: 31, chunkSize: 65536 })
  let output = []
  let pending = ''
  let batch = []
  let count = 0
  inflater.onData = chunk => output.push(chunk)

  function* consume(final = false) {
    for (const chunk of output) pending += decoder.decode(chunk, { stream: true })
    output = []
    if (final) pending += decoder.decode()
    let start = 0
    let end
    while ((end = pending.indexOf('\n', start)) !== -1) {
      if (end - start > maximumLineLength) throw new Error('A catalog record is too large.')
      const line = pending.slice(start, end).replace(/\r$/, '')
      if (!line.trim()) throw new Error('The catalog contains an empty record.')
      yield parseRecord(line)
      start = end + 1
    }
    pending = pending.slice(start)
    if (pending.length > maximumLineLength) throw new Error('A catalog record is too large.')
    if (final && pending) {
      yield parseRecord(pending)
      pending = ''
    }
  }

  for await (const chunk of chunks) {
    checkCancellation(signal)
    if (inflater.ended) throw new Error('The catalog contains unexpected trailing data.')
    inflater.push(chunk, false)
    if (inflater.err) throw new Error('The catalog archive is damaged or is not a gzip file.')
    for (const record of consume()) {
      checkCancellation(signal)
      count++
      batch.push(record)
      if (batch.length === 1000) {
        yield batch
        batch = []
      }
    }
  }
  if (!inflater.ended) inflater.push(new Uint8Array(), true)
  if (inflater.err || !inflater.ended) throw new Error('The catalog archive is incomplete or damaged.')
  for (const record of consume(true)) {
    checkCancellation(signal)
    count++
    batch.push(record)
    if (batch.length === 1000) {
      yield batch
      batch = []
    }
  }
  if (!count) throw new Error('The catalog is empty.')
  if (batch.length) yield batch
}
