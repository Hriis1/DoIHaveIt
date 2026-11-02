import { ProductLookupError } from '../errors.js'
import { requestProviderJson } from '../http.js'

export async function callGemini({ model, apiKey, prompt, schema, signal }) {
  const result = await requestProviderJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal,
    data: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema },
    },
  })
  const candidate = result?.candidates?.[0]
  if (candidate?.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) {
    throw new ProductLookupError('AI provider returned an incomplete response.')
  }
  const text = candidate.content.parts.filter(part => !part.thought && typeof part.text === 'string')
    .map(part => part.text).join('')
  return { text }
}
