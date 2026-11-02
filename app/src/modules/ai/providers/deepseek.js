import { ProductLookupError } from '../errors.js'
import { requestProviderJson } from '../http.js'

export async function callDeepSeek({ model, apiKey, prompt, schema, signal }) {
  const result = await requestProviderJson('https://api.deepseek.com/anthropic/v1/messages', {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    signal,
    data: {
      model,
      max_tokens: 1000,
      stream: false,
      thinking: { type: 'disabled' },
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      // Messages API ignores output-format settings; supply the schema in the prompt
      messages: [{ role: 'user', content: `${prompt}\nJSON Schema: ${JSON.stringify(schema)}` }],
    },
  })
  if (result?.type !== 'message' || result.role !== 'assistant' || result.stop_reason !== 'end_turn' || !Array.isArray(result.content)) {
    throw new ProductLookupError('AI provider returned an incomplete response.')
  }
  const text = result.content.filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('')
  return { text }
}
