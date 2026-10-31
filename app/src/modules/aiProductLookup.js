export async function lookupProductWithAi(barcode, { signal } = {}) {
  let response
  try {
    response = await fetch('https://doihaveit-api.hrishd.workers.dev/products/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode, use_app_key: true, model: 'gemini' }),
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
