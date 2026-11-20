import './addCredit.css'
import html from './addCredit.html?raw'
import { auth } from '../../modules/auth.js'
import { getCreditPacks } from '../../modules/creditPacks.js'

export function mountAddCreditScreen(container) {
  container.innerHTML = html
  const screen = container.querySelector('.add-credit-screen')
  const status = screen.querySelector('.credit-packs-status')
  const error = screen.querySelector('.credit-packs-error')
  const retry = screen.querySelector('.credit-packs-retry')
  const packsList = screen.querySelector('.credit-packs')
  const template = screen.querySelector('.credit-pack-template')
  const note = screen.querySelector('.credit-packs-note')
  let active = true
  let loading = false

  async function loadPacks() {
    if (!active || loading) return
    loading = true
    status.hidden = false
    error.hidden = retry.hidden = note.hidden = true
    packsList.setAttribute('aria-busy', 'true')
    try {
      const user = await auth.getCurrentUser()
      if (!active) return
      const packs = await getCreditPacks(user?.id)
      if (!active) return
      const cards = packs.map(pack => {
        const card = template.content.cloneNode(true)
        card.querySelector('.credit-pack-title').textContent = `${pack.credits.toLocaleString()} credits`
        card.querySelector('.credit-pack-price').textContent = pack.price
        return card
      })
      packsList.replaceChildren(...cards)
      note.hidden = false
    } catch {
      if (!active) return
      error.textContent = 'Could not load credit packs. Please check your connection and try again.'
      error.hidden = retry.hidden = false
    } finally {
      loading = false
      if (active) {
        status.hidden = true
        packsList.setAttribute('aria-busy', 'false')
      }
    }
  }

  retry.addEventListener('click', loadPacks)
  void loadPacks()
  return () => {
    active = false
    retry.removeEventListener('click', loadPacks)
    screen.remove()
  }
}
