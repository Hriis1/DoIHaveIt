const baseUrl = 'https://doihaveit-api.hrishd.workers.dev/auth'

export class AuthRequestError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.status = status
  }
}

export function createAuthApi(request = fetch) {
  return async function requestAuth(action, { credentials, token, signal } = {}) {
    signal?.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(), 30000)
    try {
      const response = await request(`${baseUrl}/${action}`, {
        method: action === 'me' ? 'GET' : 'POST',
        headers: { ...(credentials ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(credentials ? { body: JSON.stringify({ email: credentials.email, password: credentials.password }) } : {}),
        signal: controller.signal,
      })
      let result
      try { result = await response.json() } catch {
        throw new AuthRequestError('Could not read the server response. Please try again.', response.status)
      }
      if (!response.ok) throw new AuthRequestError(
        typeof result?.error === 'string' && result.error.trim() ? result.error : 'Authentication failed. Please try again.', response.status
      )
      const user = result?.user
      if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.email !== 'string' || !user.email.trim()
          || !Number.isSafeInteger(user.credits) || user.credits < 0
          || (action !== 'me' && (typeof result.token !== 'string' || !/^[a-f0-9]{64}$/.test(result.token)))) {
        throw new AuthRequestError('The server returned invalid account data. Please try again.')
      }
      signal?.throwIfAborted()
      return { user: { id: user.id, email: user.email, credits: user.credits }, ...(action !== 'me' ? { token: result.token } : {}) }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof AuthRequestError) throw error
      throw new AuthRequestError(controller.signal.aborted
        ? 'The request timed out. Please try again.' : 'Could not connect. Check your connection and try again.')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }
}

export const requestAuth = createAuthApi()
