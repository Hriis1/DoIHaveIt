import { respond } from '../http.js'
import { lookupProduct } from '../ai/aiProductLookup.js'
import { ProductLookupError } from '../ai/errors.js'
import { AuthError } from '../auth/errors.js'
import { readSessionToken } from '../auth/session.js'
import { hashSessionToken } from '../auth/credentials.js'
import { createAuthRepository } from '../repositories/authRepo.js'
import { createCreditRepository } from '../repositories/creditRepo.js'
import { lookUpProductGemini } from '../creditCosts.js'

const jsonResponse = (body, status = 200, headers = {}) => respond(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
})

export async function handleProductLookup(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return respond(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' },
    })
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, { Allow: 'POST, OPTIONS' })

  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Request body must be valid JSON.' }, 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'Request body must be a JSON object.' }, 400)
  }
  if (typeof body.barcode !== 'string' || !body.barcode.trim()) {
    return jsonResponse({ error: 'barcode is required and must be a non-empty string.' }, 400)
  }
  if (Object.keys(body).some(key => key !== 'barcode')) {
    return jsonResponse({ error: 'Only barcode is allowed for this endpoint.' }, 400)
  }

  // Lookups always use the Worker's Gemini key
  const apiKey = env.GEMINI_API_KEY
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return jsonResponse({ error: 'App API key is not configured for this model.' }, 503)
  }

  const task = lookupWithCredits(request, env, body.barcode.trim(), apiKey.trim())
  // Keep the provider outcome and any refund running after the phone disconnects
  ctx?.waitUntil(task)
  return task
}

async function lookupWithCredits(request, env, barcode, apiKey) {
  // Leave time for a refund within waitUntil's 30-second disconnect allowance
  const deadline = AbortSignal.timeout(25000)
  let user
  let credits
  let repository
  try {
    const tokenHash = hashSessionToken(readSessionToken(request))
    if (!env.DB) throw new AuthError('Authentication database is not configured.', 503)
    const authRepository = createAuthRepository(env.DB)
    const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
    user = await authRepository.getSessionUser(tokenHash, now())
    if (!user) throw new AuthError('Your session has expired or is invalid. Please sign in again.', 401)
    repository = createCreditRepository(env.DB)
    const charged = await repository.deductCredits(user.id, tokenHash, lookUpProductGemini)
    if (!charged) {
      const current = await authRepository.getSessionUser(tokenHash, now())
      if (!current) throw new AuthError('Your session has expired or is invalid. Please sign in again.', 401)
      return jsonResponse({ error: 'Not enough credits', code: 'INSUFFICIENT_CREDITS', credits: current.credits }, 402)
    }
    credits = charged.credits
  } catch (error) {
    return error instanceof AuthError
      ? jsonResponse({ error: error.message }, error.status)
      : jsonResponse({ error: 'Could not check or deduct credits. Please try again.' }, 503)
  }

  let product
  try {
    product = await lookupProduct({ barcode, model: 'gemini', apiKey, signal: deadline })
  } catch (error) {
    try {
      const refunded = await repository.refundCredits(user.id, lookUpProductGemini)
      if (!refunded) throw new Error('Wallet missing')
      credits = refunded.credits
    } catch {
      console.error('Product lookup credit refund could not be confirmed', { userId: user.id, cost: lookUpProductGemini })
      return jsonResponse({ error: 'The lookup failed and the credit refund could not be confirmed. Please contact support.' }, 503)
    }
    return error instanceof ProductLookupError
      ? jsonResponse({ error: error.message, credits }, error.status)
      : jsonResponse({ error: 'Product lookup failed. Please try again.', credits }, 502)
  }
  return product
    ? jsonResponse({ ...product, credits })
    : jsonResponse({ error: 'Product not found', credits }, 404)
}
