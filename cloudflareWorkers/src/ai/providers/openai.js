import { ProductLookupError } from '../errors.js'

export async function callOpenAI({ model, apiKey, prompt, schema, signal }) {
  try {
    const requestSignal = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])])
    requestSignal.throwIfAborted()
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: requestSignal,
      body: JSON.stringify({
        model,
        input: prompt,
        stream: false,
        store: false,
        reasoning: { effort: 'none' },
        max_output_tokens: 1000,
        max_tool_calls: 3,
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        text: { format: { type: 'json_schema', name: 'product_lookup', strict: true, schema } },
      }),
    })
    // Temporary diagnostics for upstream failures; redact credentials before logging
    if (!response.ok) {
      const body = await response.text()
      const redacted = body.replaceAll(apiKey, '[REDACTED]').replace(/sk-[A-Za-z0-9_.*-]+/g, '[REDACTED]')
      console.error('OpenAI lookup upstream error', {
        status: response.status,
        requestId: response.headers.get('x-request-id'),
        model,
        body: redacted.slice(0, 4000),
      })
    }
    if (response.status === 429) throw new ProductLookupError('AI provider rate limit exceeded. Please try again later.', 503)
    if (!response.ok) throw new ProductLookupError('AI provider could not complete the lookup. Check API access and try again.')

    const result = await response.json()
    if (result?.status !== 'completed' || result.error || !Array.isArray(result.output)) {
      throw new ProductLookupError('AI provider returned an incomplete response.')
    }
    // Read answer messages only; tool and reasoning items are separate output entries
    const messages = result.output.filter(item => item?.type === 'message' && item.role === 'assistant')
    if (!messages.length || messages.some(message => message.status !== 'completed' || !Array.isArray(message.content)
        || message.content.some(part => part?.type === 'refusal'))) {
      throw new ProductLookupError('AI provider returned an incomplete response.')
    }
    const text = messages.flatMap(message => message.content)
      .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
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
