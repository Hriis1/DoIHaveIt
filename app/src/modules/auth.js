import { Capacitor } from '@capacitor/core'
import { requestAuth } from './authApi.js'
import { getSessionToken, saveSessionToken, deleteSessionToken } from './sessionStorage.js'
import { getCurrentUser, saveCurrentUser, deleteCurrentUser } from '../repositories/userRepo.js'

export function createAuth({ api = requestAuth, tokens = { getSessionToken, saveSessionToken, deleteSessionToken },
  users = { getCurrentUser, saveCurrentUser, deleteCurrentUser }, isNative = Capacitor.isNativePlatform() } = {}) {
  let memoryUser = null
  const getUser = () => isNative ? users.getCurrentUser() : Promise.resolve(memoryUser)
  const saveUser = async user => {
    if (isNative) await users.saveCurrentUser(user)
    else memoryUser = user
  }

  return {
    getCurrentUser: getUser,
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
