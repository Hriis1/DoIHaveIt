import { ProductLookupError } from '../errors.js'

export async function callGemini({ model, apiKey, prompt, schema, signal }) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema },
      }),
    })
    if (response.status === 429) throw new ProductLookupError('AI provider rate limit exceeded. Please try again later.', 503)
    if (!response.ok) throw new ProductLookupError('AI provider could not complete the lookup. Check API access and try again.')

    const result = await response.json()
    const candidate = result.candidates?.[0]
    if (candidate?.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) {
      throw new ProductLookupError('AI provider returned an incomplete response.')
    }
    const text = candidate.content.parts.filter(part => !part.thought && typeof part.text === 'string')
      .map(part => part.text).join('')
    const chunks = candidate.groundingMetadata?.groundingChunks
    const grounded = Array.isArray(chunks) && chunks.some(chunk => /^https?:\/\//.test(chunk.web?.uri ?? ''))
    return { text, grounded }
  } catch (error) {
    if (error instanceof ProductLookupError) throw error
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new ProductLookupError('Product lookup timed out or was cancelled. Please try again.', 504)
    }
    // Keep provider details and credentials out of public error responses
    throw new ProductLookupError('AI provider could not complete the lookup. Please try again.')
  }
}
