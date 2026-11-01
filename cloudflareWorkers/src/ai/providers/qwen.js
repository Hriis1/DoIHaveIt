import { ProductLookupError } from '../errors.js'

// Qwen's multimodal web search requires SSE; collect only the generated answer
async function readAnswer(response, signal) {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new ProductLookupError('AI provider returned an incomplete response.')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let finishReason
  const readEvent = event => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n')
    if (!data || data === '[DONE]') return
    const result = JSON.parse(data)
    if (result.code) throw new ProductLookupError('AI provider could not complete the lookup. Check API access and try again.')
    const choice = result.output?.choices?.[0]
    if (!choice) return
    if (choice.finish_reason && choice.finish_reason !== 'null') finishReason = choice.finish_reason
    const content = choice.message?.content
    if (Array.isArray(content)) {
      text += content.filter(part => typeof part.text === 'string').map(part => part.text).join('')
    }
  }
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let boundary
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        readEvent(buffer.slice(0, boundary.index))
        buffer = buffer.slice(boundary.index + boundary[0].length)
      }
      if (done) break
    }
    if (buffer.trim()) readEvent(buffer)
    signal.throwIfAborted()
    if (finishReason !== 'stop' || !text) throw new ProductLookupError('AI provider returned an incomplete response.')
    return { text }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function callQwen({ model, apiKey, prompt, schema, signal }) {
  try {
    const requestSignal = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])])
    requestSignal.throwIfAborted()
    const response = await fetch('https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-DashScope-SSE': 'enable' },
      signal: requestSignal,
      body: JSON.stringify({
        model,
        input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
        parameters: {
          incremental_output: true,
          enable_search: true,
          search_options: { search_strategy: 'turbo', forced_search: true },
          response_format: { type: 'json_schema', json_schema: { name: 'product_lookup', strict: true, schema } },
        },
      }),
    })
    if (response.status === 429) throw new ProductLookupError('AI provider rate limit exceeded. Please try again later.', 503)
    if (!response.ok) throw new ProductLookupError('AI provider could not complete the lookup. Check API access and try again.')
    return await readAnswer(response, requestSignal)
  } catch (error) {
    if (error instanceof ProductLookupError) throw error
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new ProductLookupError('Product lookup timed out or was cancelled. Please try again.', 504)
    }
    // Keep provider details and credentials out of public error responses
    throw new ProductLookupError('AI provider could not complete the lookup. Please try again.')
  }
}
