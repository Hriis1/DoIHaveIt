import { getSessionToken } from './sessionStorage.js'

export function createPurchaseApi({ request = fetch, getToken = getSessionToken } = {}) {
  return async function getPurchaseStatus(transactionId, { signal } = {}) {
    signal?.throwIfAborted()
    const token = await getToken()
    signal?.throwIfAborted()
    if (!token) throw new Error('Please log in again to check your purchase.')
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await request(`https://doihaveit-api.hrishd.workers.dev/purchases/status?transaction_id=${encodeURIComponent(transactionId)}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
      })
      const body = await response.json()
      if (!response.ok || !['processing', 'granted', 'refunded'].includes(body?.status)
          || !Number.isSafeInteger(body.credits) || body.credits < 0) throw new Error('Invalid purchase status')
      signal?.throwIfAborted()
      return body
    } catch {
      signal?.throwIfAborted()
      throw new Error('Could not confirm your credits. Please check again shortly.')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }
}

export const getPurchaseStatus = createPurchaseApi()
