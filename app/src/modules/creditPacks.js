import { Capacitor } from '@capacitor/core'
import { Purchases } from '@revenuecat/purchases-capacitor'

// RevenueCat's public Google Play SDK key is intended to be included in the app.
const googleApiKey = 'goog_cjmQLpsxKdatazyPoluYRuBtbKc'
const packageCredits = { credits_100: 100, credits_600: 600, credits_1300: 1300 }

export function createCreditPacks({ purchases = Purchases, capacitor = Capacitor } = {}) {
  let configured = false
  let currentUserId
  let pending = Promise.resolve()

  async function load(userId) {
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

    const offerings = await purchases.getOfferings()
    const packs = (offerings.current?.availablePackages ?? [])
      .filter(pack => Object.hasOwn(packageCredits, pack.identifier) && pack.product?.priceString)
      .map(pack => ({ identifier: pack.identifier, credits: packageCredits[pack.identifier], price: pack.product.priceString }))
      .sort((first, second) => first.credits - second.credits)
    if (!packs.length) throw new Error('No credit packs are available right now. Please try again later.')
    return packs
  }

  return {
    getCreditPacks(userId) {
      // Serialize initialization across screen changes and allow retries after failures.
      const result = pending.then(() => load(userId))
      pending = result.catch(() => {})
      return result
    },
  }
}

export const { getCreditPacks } = createCreditPacks()
