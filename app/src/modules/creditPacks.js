import { Capacitor } from '@capacitor/core'
import { Purchases } from '@revenuecat/purchases-capacitor'

// RevenueCat's public Google Play SDK key is intended to be included in the app.
const googleApiKey = 'goog_cjmQLpsxKdatazyPoluYRuBtbKc'
const packageCredits = { credits_100: 100, credits_600: 600, credits_1300: 1300 }

export function createCreditPacks({ purchases = Purchases, capacitor = Capacitor } = {}) {
  let configured = false
  let currentUserId
  let pending = Promise.resolve()
  let buying = false
  const packages = new Map()
  const confirmations = new Map()

  async function identify(userId) {
    if (capacitor.getPlatform() !== 'android') {
      throw new Error('Credit packs are currently available in the Android app only.')
    }
    if (!userId) throw new Error('Log in to view credit packs.')
    const appUserID = String(userId)

    // Configure once and keep purchases associated with the signed-in wallet.
    if (!configured) {
      await purchases.configure({ apiKey: googleApiKey, appUserID })
      configured = true
      currentUserId = appUserID
    } else if (currentUserId !== appUserID) {
      await purchases.logIn({ appUserID })
      currentUserId = appUserID
    }
  }

  async function load(userId) {
    await identify(userId)
    const offerings = await purchases.getOfferings()
    packages.clear()
    const packs = (offerings.current?.availablePackages ?? [])
      .filter(pack => Object.hasOwn(packageCredits, pack.identifier) && pack.product?.priceString)
      .map(pack => {
        packages.set(pack.identifier, { userId: String(userId), pack })
        return { identifier: pack.identifier, credits: packageCredits[pack.identifier], price: pack.product.priceString }
      })
      .sort((first, second) => first.credits - second.credits)
    if (!packs.length) throw new Error('No credit packs are available right now. Please try again later.')
    return packs
  }

  return {
    isPurchasing: () => buying,
    getPendingPurchase: userId => confirmations.get(String(userId)),
    clearPendingPurchase: (userId, transactionId) => {
      if (confirmations.get(String(userId)) === transactionId) confirmations.delete(String(userId))
    },
    async purchaseCreditPack(userId, identifier) {
      if (buying) throw new Error('A purchase is already in progress.')
      if (confirmations.has(String(userId))) throw new Error('Confirm your previous purchase before buying another pack.')
      buying = true
      const result = pending.then(async () => {
        await identify(userId)
        const selected = packages.get(identifier)
        if (!selected || selected.userId !== String(userId)) throw new Error('Reload the credit packs and try again.')
        try {
          const purchase = await purchases.purchasePackage({ aPackage: selected.pack })
          const transactionId = purchase.transaction?.transactionIdentifier
          if (typeof transactionId !== 'string' || !transactionId) throw new Error('Missing purchase transaction')
          confirmations.set(String(userId), transactionId)
          return { status: 'purchased', transactionId }
        } catch (error) {
          if (String(error?.code) === '1' || error?.userCancelled === true) return { status: 'cancelled' }
          if (String(error?.code) === '20') return { status: 'pending' }
          throw new Error('Could not complete the purchase. If you were charged, your credits will appear after confirmation.')
        }
      })
      pending = result.catch(() => {})
      try { return await result } finally { buying = false }
    },
    getCreditPacks(userId) {
      // Serialize initialization across screen changes and allow retries after failures.
      const result = pending.then(() => load(userId))
      pending = result.catch(() => {})
      return result
    },
  }
}

export const { getCreditPacks, purchaseCreditPack, isPurchasing, getPendingPurchase, clearPendingPurchase } = createCreditPacks()
