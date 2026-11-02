import { Capacitor } from '@capacitor/core'
import { SecureStorage, KeychainAccess } from '@aparajita/capacitor-secure-storage'

export function createApiKeyStorage(capacitor = Capacitor, storage = SecureStorage) {
  const memory = new Map()

  function getStorageKey(provider) {
    if (typeof provider !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(provider.trim())) {
      throw new Error('A valid API provider is required.')
    }
    return `doihaveit.api-key.${provider.trim().toLowerCase()}`
  }

  // Never fall back to plaintext storage or expose native errors containing secrets
  async function nativeOperation(operation) {
    try {
      return await operation()
    } catch {
      throw new Error('Could not access secure API key storage. Please try again.')
    }
  }

  return {
    async saveApiKey(provider, apiKey) {
      const key = getStorageKey(provider)
      if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('An API key is required.')
      const value = apiKey.trim()
      if (!capacitor.isNativePlatform()) {
        memory.set(key, value)
        return
      }
      // Disable iCloud sync and device migration for every saved key
      await nativeOperation(() => storage.set(key, value, false, false, KeychainAccess.whenUnlockedThisDeviceOnly))
    },

    async getApiKey(provider) {
      const key = getStorageKey(provider)
      if (!capacitor.isNativePlatform()) return memory.get(key) ?? null
      return nativeOperation(async () => {
        const value = await storage.get(key, false, false)
        if (value !== null && typeof value !== 'string') throw new Error('Invalid stored API key.')
        return value
      })
    },

    async deleteApiKey(provider) {
      const key = getStorageKey(provider)
      if (!capacitor.isNativePlatform()) {
        memory.delete(key)
        return
      }
      await nativeOperation(() => storage.remove(key, false))
    },
  }
}

export const { saveApiKey, getApiKey, deleteApiKey } = createApiKeyStorage()
