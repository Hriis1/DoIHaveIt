import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { respond } from '../http.js'
import { readSessionToken } from '../auth/session.js'
import { hashSessionToken } from '../auth/credentials.js'
import { AuthError } from '../auth/errors.js'
import { createAuthRepository } from '../repositories/authRepo.js'
import { createPurchaseRepository } from '../repositories/purchaseRepo.js'

const productCredits = { doihaveit_credits_100: 100, doihaveit_credits_600: 600, doihaveit_credits_1300: 1300 }
const json = (body, status = 200, headers = {}) => respond(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
})
const isText = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value

async function readEvent(request) {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Invalid body')
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 65536) { await reader.cancel(); throw new Error('Body too large') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes)).event
}

export async function handleRevenueCat(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' })
  if (!env.DB || !env.REVENUECAT_WEBHOOK_SECRET || !env.REVENUECAT_APP_ID) {
    return json({ error: 'Purchases are not configured.' }, 503)
  }
  const expected = Buffer.from(`Bearer ${env.REVENUECAT_WEBHOOK_SECRET}`)
  const supplied = Buffer.from(request.headers.get('Authorization') ?? '')
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return json({ error: 'Unauthorized' }, 401)
  }
  let event
  try { event = await readEvent(request) } catch { return json({ error: 'Invalid webhook body.' }, 400) }
  if (!event || typeof event !== 'object' || !isText(event.type)) return json({ error: 'Invalid webhook event.' }, 400)
  if (event.type === 'TEST') return json({ success: true })
  if (event.app_id !== env.REVENUECAT_APP_ID || event.store !== 'PLAY_STORE'
      || !['NON_RENEWING_PURCHASE', 'CANCELLATION'].includes(event.type)
      || !Object.hasOwn(productCredits, event.product_id ?? '')) return json({ success: true })
  if (!['PRODUCTION', 'SANDBOX'].includes(event.environment) || !isText(event.transaction_id)
      || typeof event.app_user_id !== 'string' || !/^[1-9][0-9]*$/.test(event.app_user_id)
      || !Number.isSafeInteger(Number(event.app_user_id))
      || (event.quantity !== undefined && event.quantity !== 1)) {
    return json({ error: 'Invalid purchase event.' }, 400)
  }
  const userId = Number(event.app_user_id)
  const allowed = (env.REVENUECAT_TEST_USER_IDS ?? '').split(',').map(value => value.trim())
  const allowGrant = event.environment === 'PRODUCTION' || allowed.includes(event.app_user_id)
  if (!allowGrant && event.type === 'NON_RENEWING_PURCHASE') return json({ success: true })
  try {
    const repository = createPurchaseRepository(env.DB)
    if (!await repository.getUser(userId)) return json({ error: 'Purchase account not found.' }, 400)
    await repository.processPurchase({ userId, store: event.store, environment: event.environment,
      transactionId: event.transaction_id, productId: event.product_id, credits: productCredits[event.product_id],
      refunded: event.type === 'CANCELLATION', allowGrant })
    return json({ success: true })
  } catch {
    console.error('Purchase webhook processing failed', { transactionId: event.transaction_id, userId, type: event.type })
    return json({ error: 'Purchase processing failed. Please retry.' }, 503)
  }
}

export async function handlePurchaseStatus(request, env) {
  if (request.method === 'OPTIONS') return respond(null, { status: 204, headers: {
    'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization',
  } })
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, OPTIONS' })
  try {
    if (!env.DB) return json({ error: 'Purchases are not configured.' }, 503)
    const tokenHash = hashSessionToken(readSessionToken(request))
    const user = await createAuthRepository(env.DB).getSessionUser(tokenHash, new Date().toISOString().slice(0, 19).replace('T', ' '))
    if (!user) throw new AuthError('Please log in again.', 401)
    const transactionId = new URL(request.url).searchParams.get('transaction_id')
    if (!isText(transactionId)) return json({ error: 'A transaction ID is required.' }, 400)
    const record = await createPurchaseRepository(env.DB).getStatus(user.id, transactionId)
    if (!record) return json({ error: 'Purchase account not found.' }, 401)
    return json({ status: record.status, credits: record.credits })
  } catch (error) {
    return error instanceof AuthError ? json({ error: error.message }, error.status)
      : json({ error: 'Could not check purchase status.' }, 503)
  }
}
