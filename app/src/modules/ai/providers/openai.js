import { ProductLookupError } from '../errors.js'
import { requestProviderJson } from '../http.js'

export async function callOpenAI({ model, apiKey, prompt, schema, signal }) {
  const result = await requestProviderJson('https://api.openai.com/v1/responses', {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    signal,
    data: {
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
    },
  })
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
}
