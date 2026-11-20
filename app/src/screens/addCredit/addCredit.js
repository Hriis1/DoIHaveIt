import './addCredit.css'
import html from './addCredit.html?raw'
import { auth } from '../../modules/auth.js'
import { getCreditPacks, purchaseCreditPack, isPurchasing, getPendingPurchase, clearPendingPurchase } from '../../modules/creditPacks.js'
import { getPurchaseStatus } from '../../modules/purchaseApi.js'

export function mountAddCreditScreen(container) {
  container.innerHTML = html
  const screen = container.querySelector('.add-credit-screen')
  const status = screen.querySelector('.credit-packs-status')
  const error = screen.querySelector('.credit-packs-error')
  const retry = screen.querySelector('.credit-packs-retry')
  const packsList = screen.querySelector('.credit-packs')
  const template = screen.querySelector('.credit-pack-template')
  const note = screen.querySelector('.credit-packs-note')
  const check = screen.querySelector('.credit-packs-check')
  const events = new AbortController()
  const buttons = []
  let userId
  let active = true
  let loading = false
  let busy = false

  function setBusy(value) {
    busy = value
    for (const button of buttons) button.disabled = value || isPurchasing() || Boolean(getPendingPurchase(userId))
    check.disabled = value
  }

  function showNote(message) {
    note.textContent = message
    note.hidden = false
  }

  async function isCurrentUser() {
    const current = await auth.getCurrentUser()
    return active && current?.id === userId
  }

  async function confirmPurchase() {
    const transactionId = getPendingPurchase(userId)
    if (!transactionId || busy || !active) return
    setBusy(true)
    check.hidden = error.hidden = true
    showNote('Payment completed. Confirming credits…')
    const deadline = AbortSignal.timeout(60000)
    const signal = AbortSignal.any([events.signal, deadline])
    try {
      while (true) {
        signal.throwIfAborted()
        const result = await getPurchaseStatus(transactionId, { signal })
        signal.throwIfAborted()
        if (!await isCurrentUser()) return
        if (result.status !== 'processing') {
          await auth.updateCredits(userId, result.credits)
          if (!active) return
          clearPendingPurchase(userId, transactionId)
          showNote(result.status === 'granted' ? 'Credits added to your account.' : 'This purchase was refunded.')
          return
        }
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason) }
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 3000)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) { signal.removeEventListener('abort', abort); abort() }
        })
      }
    } catch {
      if (!active) return
      showNote('Your payment was received. Credits are still being confirmed.')
      check.hidden = false
    } finally {
      if (active) setBusy(false)
    }
  }

  async function buyPack(identifier) {
    if (busy || isPurchasing() || getPendingPurchase(userId) || !active) return
    setBusy(true)
    error.hidden = check.hidden = note.hidden = true
    let purchased = false
    try {
      if (!await isCurrentUser()) throw new Error('Your account has changed. Reopen Add credit.')
      const result = await purchaseCreditPack(userId, identifier)
      if (!await isCurrentUser()) return
      if (result.status === 'pending') showNote('Payment is pending. Credits will arrive after payment completes.')
      purchased = result.status === 'purchased'
    } catch (failure) {
      if (!active) return
      error.textContent = failure.message
      error.hidden = false
    } finally {
      if (active) setBusy(false)
    }
    if (purchased && active) void confirmPurchase()
  }

  async function loadPacks() {
    if (!active || loading) return
    loading = true
    status.hidden = false
    error.hidden = retry.hidden = note.hidden = true
    packsList.setAttribute('aria-busy', 'true')
    try {
      const user = await auth.refreshCredits({ signal: events.signal }).catch(() => auth.getCurrentUser())
      if (!active) return
      userId = user?.id
      const packs = await getCreditPacks(user?.id)
      if (!active) return
      const cards = packs.map(pack => {
        const card = template.content.cloneNode(true)
        card.querySelector('.credit-pack-title').textContent = `${pack.credits.toLocaleString()} credits`
        const button = card.querySelector('.credit-pack-price')
        button.textContent = pack.price
        button.setAttribute('aria-label', `Buy ${pack.credits} credits for ${pack.price}`)
        button.addEventListener('click', () => void buyPack(pack.identifier), { signal: events.signal })
        buttons.push(button)
        return card
      })
      packsList.replaceChildren(...cards)
      setBusy(false)
      if (getPendingPurchase(userId)) void confirmPurchase()
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
  check.addEventListener('click', confirmPurchase)
  void loadPacks()
  return () => {
    active = false
    events.abort()
    retry.removeEventListener('click', loadPacks)
    check.removeEventListener('click', confirmPurchase)
    screen.remove()
  }
}
