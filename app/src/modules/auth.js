import { Capacitor } from '@capacitor/core'
import { requestAuth } from './authApi.js'
import { getSessionToken, saveSessionToken, deleteSessionToken } from './sessionStorage.js'
import { getCurrentUser, saveCurrentUser, deleteCurrentUser, updateCurrentUserCredits } from '../repositories/userRepo.js'
import { prepareCreditPacksForDeletion } from './creditPacks.js'

export function createAuth({ api = requestAuth, tokens = { getSessionToken, saveSessionToken, deleteSessionToken },
  users = { getCurrentUser, saveCurrentUser, deleteCurrentUser, updateCurrentUserCredits },
  preparePurchases = prepareCreditPacksForDeletion, isNative = Capacitor.isNativePlatform() } = {}) {
  let memoryUser = null
  let deleting = false
  let deletedUser
  const creditListeners = new Set()
  const getUser = () => deletedUser ? Promise.resolve(null) : isNative ? users.getCurrentUser() : Promise.resolve(memoryUser)
  const saveUser = async user => {
    if (isNative) await users.saveCurrentUser(user)
    else memoryUser = user
  }

  return {
    getCurrentUser: getUser,
    async refreshCredits({ signal } = {}) {
      if (deleting || deletedUser) throw new Error('Account deletion is in progress.')
      const user = await getUser()
      const token = await tokens.getSessionToken()
      signal?.throwIfAborted()
      if (!user || !token) throw new Error('Please log in again to refresh your balance.')
      const result = await api('me', { token, signal })
      signal?.throwIfAborted()
      const current = await getUser()
      if (deleting || deletedUser || current?.id !== user.id || result.user.id !== user.id || await tokens.getSessionToken() !== token) return
      if (deleting || deletedUser) return
      signal?.throwIfAborted()
      const updated = { ...current, credits: result.user.credits }
      if (isNative) await users.updateCurrentUserCredits(user.id, updated.credits)
      else memoryUser = updated
      if (deleting || deletedUser) return
      for (const listener of creditListeners) listener(updated)
      return updated
    },
    subscribeCreditBalance(listener) {
      creditListeners.add(listener)
      return () => creditListeners.delete(listener)
    },
    async updateCredits(userId, credits) {
      if (deleting || deletedUser) return
      if (!Number.isSafeInteger(credits) || credits < 0) throw new Error('Invalid credit balance.')
      const user = await getUser()
      if (deleting || deletedUser || !user || user.id !== userId) return
      const updated = { ...user, credits }
      if (isNative) await users.updateCurrentUserCredits(userId, credits)
      else memoryUser = updated
      if (deleting || deletedUser) return
      for (const listener of creditListeners) listener(updated)
    },
    async signIn(action, credentials, { signal } = {}) {
      if (deleting || deletedUser) throw new Error('Finish account-deletion cleanup before signing in.')
      const result = await api(action, { credentials, signal })
      signal?.throwIfAborted()
      // Never persist a password; only retain the token and the wallet summary
      await tokens.saveSessionToken(result.token)
      try { await saveUser(result.user) } catch {
        await tokens.deleteSessionToken()
        throw new Error('Could not save your account on this device. Please try again.')
      }
      return result.user
    },
    async deleteAccount(password) {
      if (deleting) throw new Error('Account deletion is already in progress.')
      if (typeof password !== 'string' || !password) throw new Error('Enter your password.')
      deleting = true
      let finishPurchases
      let remotelyDeleted = Boolean(deletedUser)
      try {
        const user = deletedUser ?? await getUser()
        if (!user) throw new Error('Please log in again to delete your account.')
        if (!deletedUser) {
          const token = await tokens.getSessionToken()
          if (!token) throw new Error('Please log in again to delete your account.')
          finishPurchases = await preparePurchases(user.id)
          await api('delete', { token, credentials: { password } })
          remotelyDeleted = true
          deletedUser = user
          for (const listener of creditListeners) listener(null)
        }
        // Try both local removals even if one fails; a retry only repeats local cleanup.
        const results = await Promise.allSettled([
          tokens.deleteSessionToken(),
          isNative ? users.deleteCurrentUser() : Promise.resolve().then(() => { memoryUser = null }),
        ])
        if (results.some(result => result.status === 'rejected')) {
          throw new Error('Your account was deleted, but phone cleanup failed. Tap Delete account again to retry cleanup.')
        }
        deletedUser = undefined
      } finally {
        finishPurchases?.(remotelyDeleted)
        deleting = false
      }
    },
    async restoreSession() {
      const token = await tokens.getSessionToken()
      if (!token) return { state: 'login' }
      try {
        const { user } = await api('me', { token })
        await saveUser(user)
        return { state: 'authenticated', user }
      } catch (error) {
        if (error.status === 401) {
          await tokens.deleteSessionToken()
          if (isNative) await users.deleteCurrentUser()
          else memoryUser = null
          return { state: 'login', message: 'Your session has expired. Please log in again.' }
        }
        // Keep cached wallet data and the token when the server cannot be reached
        const user = await getUser()
        if (user) return { state: 'offline', user }
        throw error
      }
    },
  }
}

export const auth = createAuth()
