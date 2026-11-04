import { respond } from '../http.js'
import { AuthError } from '../auth/errors.js'
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from '../auth/credentials.js'
import { createAuthRepository } from '../repositories/authRepo.js'

const sessionDuration = 30 * 24 * 60 * 60 * 1000
const sqlDate = date => date.toISOString().slice(0, 19).replace('T', ' ')
const jsonResponse = (body, status = 200, headers = {}) => respond(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
})

async function readCredentials(request) {
  let body
  const reader = request.body?.getReader()
  let length = 0
  const chunks = []
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > 4096) {
          await reader.cancel()
          throw new AuthError('Request body is too large.', 413)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new AuthError('Request body must be valid JSON.', 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['email', 'password'].includes(key))) {
    throw new AuthError('Provide only email and password.', 400)
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (email.length > 254 || /\p{C}/u.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError('A valid email address is required.', 400)
  }
  if (typeof body.password !== 'string' || [...body.password].length < 8 || [...body.password].length > 128
      || /[\s\p{C}]/u.test(body.password)) {
    throw new AuthError('Password must be 8–128 characters with no spaces or other whitespace.', 400)
  }
  return { email, password: body.password }
}

function readSessionToken(request) {
  const match = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)
  if (!match) throw new AuthError('A valid session token is required.', 401)
  return match[1]
}

export async function handleAuth(request, env, action) {
  const method = action === 'me' ? 'GET' : 'POST'
  if (request.method === 'OPTIONS') {
    return respond(null, { status: 204, headers: {
      'Access-Control-Allow-Methods': `${method}, OPTIONS`,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Cache-Control': 'no-store',
    } })
  }
  if (request.method !== method) return jsonResponse({ error: 'Method not allowed' }, 405, { Allow: `${method}, OPTIONS` })

  try {
    if (!env.DB) throw new AuthError('Authentication database is not configured.', 503)
    const repository = createAuthRepository(env.DB)
    if (action === 'register' || action === 'login') {
      // Rate-limit credential attempts before doing expensive password hashing
      if (!env.AUTH_RATE_LIMITER) throw new AuthError('Authentication rate limiter is not configured.', 503)
      const { success } = await env.AUTH_RATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' })
      if (!success) return jsonResponse({ error: 'Too many attempts. Please try again later.' }, 429, { 'Retry-After': '60' })
      const { email, password } = await readCredentials(request)
      const token = createSessionToken()
      const tokenHash = hashSessionToken(token)
      const expiresAt = sqlDate(new Date(Date.now() + sessionDuration))
      if (action === 'register') {
        const user = await repository.registerUser({ email, passwordHash: hashPassword(password), tokenHash, expiresAt })
        return jsonResponse({ user, token }, 201)
      }
      const record = await repository.getUserByEmail(email)
      if (!verifyPassword(password, record?.password_hash ?? null) || !record) {
        throw new AuthError('Email or password is incorrect.', 401)
      }
      await repository.createSession(record.id, tokenHash, expiresAt)
      const user = { id: record.id, email: record.email, credits: record.credits }
      return jsonResponse({ user, token })
    }

    const tokenHash = hashSessionToken(readSessionToken(request))
    if (action === 'logout') {
      // Revoking the same session again is safe when a logout response was lost
      await repository.deleteSession(tokenHash)
      return jsonResponse({ success: true })
    }
    const user = await repository.getSessionUser(tokenHash, sqlDate(new Date()))
    if (!user) throw new AuthError('Your session has expired or is invalid. Please sign in again.', 401)
    return jsonResponse({ user })
  } catch (error) {
    if (error instanceof AuthError) return jsonResponse({ error: error.message }, error.status)
    return jsonResponse({ error: 'Authentication could not be completed. Please try again.' }, 503)
  }
}
