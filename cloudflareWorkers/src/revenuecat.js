import { AuthError } from './auth/errors.js'

// RevenueCat queues deletion; repeat DELETE until absence is confirmed.
export async function deleteRevenueCatCustomer(userId, apiKey, { request = fetch,
  signal = AbortSignal.timeout(15000), pause = () => new Promise(resolve => setTimeout(resolve, 500)) } = {}) {
  if (!apiKey) throw new AuthError('Account deletion is not configured.', 503)
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      signal.throwIfAborted()
      const response = await request(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(String(userId))}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` }, signal,
      })
      await response.body?.cancel()
      if (response.status === 404) return
      if (response.status !== 200) break
      await pause()
    }
  } catch {
    // Never expose upstream response bodies or the secret API key.
  }
  throw new AuthError('Could not confirm purchase-account cleanup. Your account has not been deleted. Please try again.', 503)
}
