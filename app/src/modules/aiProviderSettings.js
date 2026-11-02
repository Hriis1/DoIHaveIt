const settingsKey = 'doihaveit.ai-provider'
const providers = ['gemini', 'deepseek', 'openai']

function isValidSettings(settings) {
  return settings && typeof settings.useAppKey === 'boolean' && providers.includes(settings.provider)
}

export function getAiProviderSettings() {
  const stored = localStorage.getItem(settingsKey)
  let settings
  try {
    settings = JSON.parse(stored)
  } catch {
    // Ignore malformed preferences and restore the default selection
  }
  return isValidSettings(settings)
    ? { useAppKey: settings.useAppKey, provider: settings.provider }
    : { useAppKey: true, provider: 'gemini' }
}

export function saveAiProviderSettings(settings) {
  if (!isValidSettings(settings)) throw new Error('Invalid AI provider settings.')
  // Only the selection belongs here; API keys stay in secure storage
  localStorage.setItem(settingsKey, JSON.stringify({ useAppKey: settings.useAppKey, provider: settings.provider }))
}
