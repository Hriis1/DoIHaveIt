import './account.css'
import html from './account.html?raw'
import { auth } from '../../modules/auth.js'
import { createPopup } from '../../modules/popup.js'

export function mountAccountScreen(container, { navigate }) {
  container.innerHTML = html
  const screen = container.querySelector('.account-screen')
  const status = screen.querySelector('.account-status')
  const error = screen.querySelector('.account-error')
  const deleteButton = screen.querySelector('.account-delete')
  const deleteDialog = screen.querySelector('.account-delete-dialog')
  const deleteForm = screen.querySelector('.account-delete-form')
  const password = screen.querySelector('#account-delete-password')
  const deleteError = screen.querySelector('.account-delete-error')
  const deleteStatus = screen.querySelector('.account-delete-status')
  const close = screen.querySelector('.account-delete-close')
  const cancel = screen.querySelector('.account-delete-cancel')
  const confirm = screen.querySelector('.account-delete-confirm')
  let active = true
  let deleting = false
  const popup = createPopup(deleteDialog, {
    closeButtons: [close, cancel], canClose: () => !deleting,
    onClose: () => { password.value = ''; deleteError.hidden = true },
  })
  const unsubscribe = auth.subscribeCreditBalance(user => {
    if (active && user) screen.querySelector('.account-balance').textContent = user.credits.toLocaleString()
  })
  const addCredit = () => navigate('add-credit')
  const addButton = screen.querySelector('.primary-button')
  addButton.addEventListener('click', addCredit)
  const openDelete = () => {
    password.value = ''
    deleteError.hidden = true
    popup.open()
    password.focus()
  }
  deleteButton.addEventListener('click', openDelete)

  async function deleteAccount(event) {
    event.preventDefault()
    if (deleting || !active) return
    if (!password.value) {
      deleteError.textContent = 'Enter your password.'
      deleteError.hidden = false
      password.focus()
      return
    }
    deleting = true
    deleteError.hidden = true
    deleteStatus.hidden = false
    for (const control of [password, close, cancel, confirm]) control.disabled = true
    try {
      await auth.deleteAccount(password.value)
      password.value = ''
      if (active) navigate('login')
    } catch (failure) {
      if (!active) return
      password.value = ''
      deleteError.textContent = failure.message
      deleteError.hidden = false
    } finally {
      deleting = false
      if (active) {
        deleteStatus.hidden = true
        for (const control of [password, close, cancel, confirm]) control.disabled = false
        if (!deleteError.hidden) password.focus()
      }
    }
  }
  deleteForm.addEventListener('submit', deleteAccount)

  async function loadAccount() {
    try {
      const user = await auth.refreshCredits().catch(() => auth.getCurrentUser())
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
    unsubscribe()
    addButton.removeEventListener('click', addCredit)
    deleteButton.removeEventListener('click', openDelete)
    deleteForm.removeEventListener('submit', deleteAccount)
    password.value = ''
    popup.destroy()
    screen.remove()
  }
}
