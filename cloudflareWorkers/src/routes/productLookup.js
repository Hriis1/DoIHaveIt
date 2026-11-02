import { respond } from '../http.js'
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
  if (Object.keys(body).some(key => key !== 'barcode')) {
    return jsonResponse({ error: 'Only barcode is allowed for this endpoint.' }, 400)
  }

  // Public lookups always use the Worker's Gemini key
  const apiKey = env.GEMINI_API_KEY
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return jsonResponse({ error: 'App API key is not configured for this model.' }, 503)
  }

  try {
    const product = await lookupProduct({ barcode: body.barcode.trim(), model: 'gemini', apiKey: apiKey.trim(), signal: request.signal })
    return product ? jsonResponse(product) : jsonResponse({ error: 'Product not found' }, 404)
  } catch (error) {
    return error instanceof ProductLookupError
      ? jsonResponse({ error: error.message }, error.status)
      : jsonResponse({ error: 'Product lookup failed. Please try again.' }, 502)
  }
}
