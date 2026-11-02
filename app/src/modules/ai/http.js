import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { ProductLookupError } from './errors.js'

const timeoutMessage = 'Product lookup timed out or was cancelled. Please try again.'

export async function requestProviderJson(url, { headers, data, signal }) {
  signal?.throwIfAborted()
  if (!Capacitor.isNativePlatform()) {
    throw new ProductLookupError('Open the Android or iOS app to search with your own API key.')
  }
  let timeout
  let onAbort
  try {
    // Cancel app handling immediately; CapacitorHttp may finish its native request later
    const response = await new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      timeout = setTimeout(() => reject(new ProductLookupError(timeoutMessage)), 30000)
      Promise.resolve().then(() => {
        signal?.throwIfAborted()
        return CapacitorHttp.request({
          url, method: 'POST', headers, data, responseType: 'json',
          connectTimeout: 30000, readTimeout: 30000,
        })
      }).then(resolve, reject)
    })
    signal?.throwIfAborted()
    if (response.status === 429) throw new ProductLookupError('AI provider rate limit exceeded. Please try again later.')
    if (!(response.status >= 200 && response.status < 300)) {
      throw new ProductLookupError('AI provider could not complete the lookup. Check API access and try again.')
    }
    try {
      return typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    } catch {
      throw new ProductLookupError('AI provider returned invalid product data.')
    }
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof ProductLookupError) throw error
    if (error?.name === 'TimeoutError' || /timeout|timed out/i.test(error?.message ?? '')) {
      throw new ProductLookupError(timeoutMessage)
    }
    throw new ProductLookupError('AI provider could not complete the lookup. Please try again.')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}
