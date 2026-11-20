import { Capacitor } from '@capacitor/core'
import { requestAuth } from './authApi.js'
import { getSessionToken, saveSessionToken, deleteSessionToken } from './sessionStorage.js'
import { getCurrentUser, saveCurrentUser, deleteCurrentUser, updateCurrentUserCredits } from '../repositories/userRepo.js'

export function createAuth({ api = requestAuth, tokens = { getSessionToken, saveSessionToken, deleteSessionToken },
  users = { getCurrentUser, saveCurrentUser, deleteCurrentUser, updateCurrentUserCredits }, isNative = Capacitor.isNativePlatform() } = {}) {
  let memoryUser = null
  const creditListeners = new Set()
  const getUser = () => isNative ? users.getCurrentUser() : Promise.resolve(memoryUser)
  const saveUser = async user => {
    if (isNative) await users.saveCurrentUser(user)
    else memoryUser = user
  }

  return {
    getCurrentUser: getUser,
    async refreshCredits({ signal } = {}) {
      const user = await getUser()
      const token = await tokens.getSessionToken()
      signal?.throwIfAborted()
      if (!user || !token) throw new Error('Please log in again to refresh your balance.')
      const result = await api('me', { token, signal })
      signal?.throwIfAborted()
      const current = await getUser()
      if (current?.id !== user.id || result.user.id !== user.id || await tokens.getSessionToken() !== token) return
      signal?.throwIfAborted()
      const updated = { ...current, credits: result.user.credits }
      if (isNative) await users.updateCurrentUserCredits(user.id, updated.credits)
      else memoryUser = updated
      for (const listener of creditListeners) listener(updated)
      return updated
    },
    subscribeCreditBalance(listener) {
      creditListeners.add(listener)
      return () => creditListeners.delete(listener)
    },
    async updateCredits(userId, credits) {
      if (!Number.isSafeInteger(credits) || credits < 0) throw new Error('Invalid credit balance.')
      const user = await getUser()
      if (!user || user.id !== userId) return
      const updated = { ...user, credits }
      if (isNative) await users.updateCurrentUserCredits(userId, credits)
      else memoryUser = updated
      for (const listener of creditListeners) listener(updated)
    },
    async signIn(action, credentials, { signal } = {}) {
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
