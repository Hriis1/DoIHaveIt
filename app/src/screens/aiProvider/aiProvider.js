import './aiProvider.css'
import html from './aiProvider.html?raw'
import { getApiKey, saveApiKey, deleteApiKey } from '../../modules/apiKeyStorage.js'
import { getAiProviderSettings, saveAiProviderSettings } from '../../modules/aiProviderSettings.js'

export function mountAiProviderScreen(container, { isNative } = {}) {
  container.innerHTML = html
  const screen = container.querySelector('.ai-provider-screen')
  const events = new AbortController()
  const listen = (element, event, handler) => element.addEventListener(event, handler, { signal: events.signal })
  const form = screen.querySelector('.ai-provider-form')
  const fields = screen.querySelector('.ai-provider-fields')
  const modes = [...screen.querySelectorAll('[name="ai-key-source"]')]
  const own = screen.querySelector('.ai-provider-own')
  const provider = screen.querySelector('#ai-provider')
  const input = screen.querySelector('#ai-api-key')
  const visibility = screen.querySelector('.ai-key-visibility')
  const remove = screen.querySelector('.ai-key-remove')
  const status = screen.querySelector('.ai-key-status')
  const message = screen.querySelector('.ai-provider-message')
  const error = screen.querySelector('.ai-provider-error')
  let active = true
  let busy = false
  let hasKey = false
  let settings = { useAppKey: true, provider: 'gemini' }

  function showError(text) {
    error.textContent = text
    error.hidden = false
  }

  function clearInput() {
    input.value = ''
    input.type = 'password'
    visibility.setAttribute('aria-label', 'Show API key')
    visibility.setAttribute('aria-pressed', 'false')
    visibility.querySelector('use').setAttribute('href', '#icon-eye')
  }

  function renderSelection() {
    for (const mode of modes) mode.checked = mode.value === (settings.useAppKey ? 'app' : 'own')
    provider.value = settings.provider
    own.hidden = settings.useAppKey
  }

  function renderKeyStatus() {
    status.textContent = hasKey ? 'A key is saved for this provider.' : 'No key saved for this provider.'
    input.placeholder = hasKey ? 'Paste a replacement key' : 'Paste your API key'
    remove.disabled = !hasKey
  }

  async function loadKeyStatus() {
    clearInput()
    if (settings.useAppKey) return
    busy = true
    fields.disabled = true
    status.textContent = 'Checking saved key…'
    try {
      // Check for a saved key without putting the existing secret in the input
      hasKey = (await getApiKey(settings.provider)) !== null
      if (active) renderKeyStatus()
    } catch {
      if (active) {
        hasKey = false
        status.textContent = 'Could not check the saved key.'
        remove.disabled = true
        showError('Could not read the saved API key. Reopen this screen to try again.')
      }
    } finally {
      if (active) fields.disabled = false
      busy = false
    }
  }

  function changeSelection() {
    if (busy || !active) return
    const next = { useAppKey: modes.find(mode => mode.checked).value === 'app', provider: provider.value }
    error.hidden = true
    message.textContent = ''
    try {
      saveAiProviderSettings(next)
      settings = next
      renderSelection()
      void loadKeyStatus()
    } catch {
      renderSelection()
      showError('Could not save your provider selection. Please try again.')
    }
  }

  // Lock the form during native writes to prevent duplicate or mismatched operations
  async function updateKey(deleting) {
    if (busy || !active || settings.useAppKey || (deleting && !hasKey)) return
    error.hidden = true
    message.textContent = ''
    if (!deleting && !input.value.trim()) {
      showError('An API key is required.')
      input.focus()
      return
    }
    busy = true
    fields.disabled = true
    message.textContent = deleting ? 'Removing key…' : 'Saving key…'
    try {
      if (deleting) await deleteApiKey(settings.provider)
      else await saveApiKey(settings.provider, input.value.trim())
      if (!active) return
      hasKey = !deleting
      clearInput()
      renderKeyStatus()
      message.textContent = deleting ? 'API key removed.' : 'API key saved.'
    } catch {
      if (!active) return
      message.textContent = ''
      showError(deleting ? 'Could not remove the API key. Please try again.' : 'Could not save the API key. Please try again.')
    } finally {
      if (active) fields.disabled = false
      busy = false
    }
  }

  for (const mode of modes) listen(mode, 'change', changeSelection)
  listen(provider, 'change', changeSelection)
  listen(visibility, 'click', () => {
    const visible = input.type === 'password'
    input.type = visible ? 'text' : 'password'
    visibility.setAttribute('aria-label', visible ? 'Hide API key' : 'Show API key')
    visibility.setAttribute('aria-pressed', String(visible))
    visibility.querySelector('use').setAttribute('href', visible ? '#icon-eye-off' : '#icon-eye')
  })
  listen(form, 'submit', event => { event.preventDefault(); void updateKey(false) })
  listen(remove, 'click', () => { void updateKey(true) })

  screen.querySelector('.ai-provider-browser').hidden = Boolean(isNative)
  try {
    settings = getAiProviderSettings()
  } catch {
    showError('Could not read your provider selection. Please choose it again.')
  }
  renderSelection()
  void loadKeyStatus()

  return () => {
    active = false
    events.abort()
    clearInput()
    screen.remove()
  }
}
