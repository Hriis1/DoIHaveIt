import { respond } from '../http.js'
import { supported, supportedWithKey } from '../ai/models.js'
import { lookupProduct } from '../ai/aiProductLookup.js'
import { ProductLookupError } from '../ai/errors.js'

const jsonResponse = (body, status = 200, headers = {}) => respond(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
})

export async function handleProductLookup(request, env) {
  if (request.method === 'OPTIONS') {
    return respond(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' },
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
  if (typeof body.use_app_key !== 'boolean') {
    return jsonResponse({ error: 'use_app_key is required and must be a boolean.' }, 400)
  }
  if (typeof body.model !== 'string' || !body.model) {
    return jsonResponse({ error: 'model is required and must be a non-empty string.' }, 400)
  }

  // Select the allowlist and credential source independently; never fall back between them
  const allowed = body.use_app_key ? supported : supportedWithKey
  if (!allowed.includes(body.model)) return jsonResponse({ error: 'Model is not supported for this API key source.' }, 400)
  const apiKey = body.use_app_key ? env[`${body.model.toUpperCase()}_API_KEY`] : body.api_key
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return body.use_app_key
      ? jsonResponse({ error: 'App API key is not configured for this model.' }, 503)
      : jsonResponse({ error: 'Provide your own API key for the chosen model.' }, 400)
  }

  try {
    const product = await lookupProduct({ barcode: body.barcode.trim(), model: body.model, apiKey: apiKey.trim(), signal: request.signal })
    return product ? jsonResponse(product) : jsonResponse({ error: 'Product not found' }, 404)
  } catch (error) {
    return error instanceof ProductLookupError
      ? jsonResponse({ error: error.message }, error.status)
      : jsonResponse({ error: 'Product lookup failed. Please try again.' }, 502)
  }
}
