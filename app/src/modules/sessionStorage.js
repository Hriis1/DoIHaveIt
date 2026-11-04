import { Capacitor } from '@capacitor/core'
import { SecureStorage, KeychainAccess } from '@aparajita/capacitor-secure-storage'

export function createSessionStorage(capacitor = Capacitor, storage = SecureStorage) {
  const key = 'doihaveit.auth.session'
  let memory = null
  async function nativeOperation(operation) {
    try { return await operation() } catch {
      throw new Error('Could not access secure session storage. Please try again.')
    }
  }
  return {
    async getSessionToken() {
      const value = capacitor.isNativePlatform()
        ? await nativeOperation(() => storage.get(key, false, false)) : memory
      if (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
        throw new Error('The saved session is invalid. Please sign in again.')
      }
      return value
    },
    async saveSessionToken(token) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid session token.')
      if (!capacitor.isNativePlatform()) { memory = token; return }
      await nativeOperation(() => storage.set(key, token, false, false, KeychainAccess.whenUnlockedThisDeviceOnly))
    },
    async deleteSessionToken() {
      if (!capacitor.isNativePlatform()) { memory = null; return }
      await nativeOperation(() => storage.remove(key, false))
    },
  }
}

export const { getSessionToken, saveSessionToken, deleteSessionToken } = createSessionStorage()
