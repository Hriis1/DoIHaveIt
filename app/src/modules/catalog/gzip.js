import { Inflate } from 'pako'
import { checkCancellation } from './cancellation.js'

// Validate gzip integrity while yielding bounded binary chunks instead of product objects
export async function* decompressGzip(chunks, signal) {
  const inflater = new Inflate({ windowBits: 31, chunkSize: 65536 })
  let output = []
  inflater.onData = chunk => output.push(chunk)
  for await (const chunk of chunks) {
    checkCancellation(signal)
    if (inflater.ended) throw new Error('The catalog archive contains unexpected trailing data.')
    inflater.push(chunk, false)
    if (inflater.err) throw new Error('The catalog archive is damaged or is not a gzip file.')
    for (const bytes of output) {
      checkCancellation(signal)
      yield bytes
    }
    output = []
  }
  if (!inflater.ended) inflater.push(new Uint8Array(), true)
  if (inflater.err || !inflater.ended) throw new Error('The catalog archive is incomplete or damaged.')
  for (const bytes of output) {
    checkCancellation(signal)
    yield bytes
  }
}
