import { getAiProviderSettings } from './aiProviderSettings.js'
import { getApiKey } from './apiKeyStorage.js'

export async function lookupProductWithAi(barcode, { signal } = {}) {
  signal?.throwIfAborted()
  let settings
  try {
    settings = getAiProviderSettings()
  } catch {
    throw new Error('Could not read your AI Search settings. Open AI Search from the app menu and try again.')
  }
  const body = { barcode, use_app_key: settings.useAppKey, model: settings.useAppKey ? 'gemini' : settings.provider }
  if (!settings.useAppKey) {
    let apiKey
    try {
      apiKey = await getApiKey(settings.provider)
    } catch {
      signal?.throwIfAborted()
      throw new Error('Could not read your saved API key. Please check your AI Search settings and try again.')
    }
    signal?.throwIfAborted()
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new Error('No API key saved for the selected provider. Configure it in AI Search from the app menu and try again.')
    }
    body.api_key = apiKey.trim()
  }

  let response
  try {
    response = await fetch('https://doihaveit-api.hrishd.workers.dev/products/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') throw error
    throw new Error('Could not search for the product. Please try again.')
  }

  let product
  try {
    product = await response.json()
  } catch {
    throw new Error('Could not read the AI search response. Please try again.')
  }
  if (!response.ok) throw new Error(typeof product?.error === 'string' && product.error.trim()
    ? product.error : 'AI search failed. Please try again.')

  // Normalize only valid product fields before they reach the repository
  const isText = value => typeof value === 'string' && value.trim().length > 0
  if (!product || Array.isArray(product) || !isText(product.brand) || !isText(product.name)
      || !(product.size === null || isText(product.size))) {
    throw new Error('AI search returned invalid product data.')
  }
  return {
    brand: product.brand.trim().toLowerCase(),
    name: product.name.trim().toLowerCase(),
    size: product.size === null ? null : product.size.trim().toLowerCase(),
  }
}
