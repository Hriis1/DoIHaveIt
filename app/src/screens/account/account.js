import './account.css'
import html from './account.html?raw'
import { auth } from '../../modules/auth.js'

export function mountAccountScreen(container) {
  container.innerHTML = html
  const screen = container.querySelector('.account-screen')
  const status = screen.querySelector('.account-status')
  const error = screen.querySelector('.account-error')
  let active = true

  async function loadAccount() {
    try {
      const user = await auth.getCurrentUser()
      if (!active) return
      if (!user) {
        status.textContent = 'No account details are available.'
        return
      }
      screen.querySelector('.account-email').textContent = user.email
      screen.querySelector('.account-balance').textContent = user.credits.toLocaleString()
      screen.querySelector('.account-details').hidden = false
      status.hidden = true
    } catch {
      if (!active) return
      status.hidden = true
      error.textContent = 'Could not load account details.'
      error.hidden = false
    }
  }

  void loadAccount()
  return () => {
    active = false
    screen.remove()
  }
}
