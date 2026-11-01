export const supported = ['gemini']
export const supportedWithKey = ['gemini', 'deepseek', 'openai']

export const models = {
  gemini: { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
  deepseek: { provider: 'deepseek', model: 'deepseek-flash' },
  openai: { provider: 'openai', model: 'gpt-6-luna' },
}
