import { ProductLookupError } from '../errors.js'

export async function callDeepSeek({ model, apiKey, prompt, schema, signal }) {
  try {
    const requestSignal = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])])
    requestSignal.throwIfAborted()
    const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: requestSignal,
      body: JSON.stringify({
        model,
        max_tokens: 1000,
        stream: false,
        thinking: { type: 'disabled' },
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        // Messages API ignores output-format settings; supply the schema in the prompt
        messages: [{ role: 'user', content: `${prompt}\nJSON Schema: ${JSON.stringify(schema)}` }],
      }),
    })
    if (response.status === 429) throw new ProductLookupError('AI provider rate limit exceeded. Please try again later.', 503)
    if (!response.ok) throw new ProductLookupError('AI provider could not complete the lookup. Check API access and try again.')

    const result = await response.json()
    if (result.type !== 'message' || result.role !== 'assistant' || result.stop_reason !== 'end_turn' || !Array.isArray(result.content)) {
      throw new ProductLookupError('AI provider returned an incomplete response.')
    }
    const text = result.content.filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text).join('')
    return { text }
  } catch (error) {
    if (error instanceof ProductLookupError) throw error
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new ProductLookupError('Product lookup timed out or was cancelled. Please try again.', 504)
    }
    // Keep provider details and credentials out of public error responses
    throw new ProductLookupError('AI provider could not complete the lookup. Please try again.')
  }
}
