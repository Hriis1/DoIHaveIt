import './auth.css'
import html from './auth.html?raw'
import { auth } from '../../modules/auth.js'
import { validateCredentials } from '../../modules/authValidation.js'

export function mountAuthScreen(container, { navigate, mode = 'login', message = '', onAuthenticated } = {}) {
  container.innerHTML = html
  const screen = container.querySelector('.auth-screen')
  const registering = mode === 'register'
  const events = new AbortController()
  const request = new AbortController()
  const form = screen.querySelector('.auth-form')
  const fields = screen.querySelector('.auth-fields')
  const email = screen.querySelector('#auth-email')
  const password = screen.querySelector('#auth-password')
  const confirm = screen.querySelector('#auth-confirm-password')
  const error = screen.querySelector('#auth-error')
  const status = screen.querySelector('.auth-status')
  const submit = screen.querySelector('.auth-submit')
  const switchButton = screen.querySelector('.auth-switch')
  const title = registering ? 'Register' : 'Log in'
  let active = true
  let busy = false

  screen.querySelector('#auth-title').textContent = title
  if (registering) screen.querySelector('.auth-description').textContent = 'Create your credit wallet. Your collections stay on this device.'
  screen.querySelector('.auth-confirm').hidden = !registering
  screen.querySelector('.auth-password-help').hidden = !registering
  confirm.disabled = !registering
  confirm.required = registering
  password.autocomplete = registering ? 'new-password' : 'current-password'
  submit.textContent = title
  switchButton.textContent = registering ? 'Already have an account? Log in' : 'Create an account'
  if (message) { error.textContent = message; error.hidden = false }

  switchButton.addEventListener('click', () => {
    if (!busy) navigate(registering ? 'login' : 'register')
  }, { signal: events.signal })

  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (busy || !active) return
    error.hidden = true
    for (const input of [email, password, confirm]) input.removeAttribute('aria-invalid')
    const invalid = validateCredentials({ email: email.value, password: password.value, confirmPassword: confirm.value }, registering)
    if (invalid) {
      error.textContent = invalid.message
      error.hidden = false
      const input = screen.querySelector(`#auth-${invalid.field}`)
      input.setAttribute('aria-invalid', 'true')
      input.focus()
      return
    }
    busy = true
    fields.disabled = true
    switchButton.disabled = true
    status.textContent = registering ? 'Creating your account…' : 'Logging in…'
    try {
      await auth.signIn(mode, { email: email.value.trim().toLowerCase(), password: password.value }, { signal: request.signal })
      if (!active) return
      password.value = ''
      confirm.value = ''
      onAuthenticated()
      navigate('collections')
    } catch (failure) {
      if (active) { error.textContent = failure.message; error.hidden = false }
    } finally {
      if (active) {
        busy = false
        fields.disabled = false
        switchButton.disabled = false
        status.textContent = ''
      }
    }
  }, { signal: events.signal })

  return () => {
    active = false
    events.abort()
    request.abort()
    password.value = ''
    confirm.value = ''
    screen.remove()
  }
}
