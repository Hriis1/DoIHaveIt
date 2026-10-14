import './styles/global.css'
import { Capacitor } from '@capacitor/core'
import { initializeDatabase } from './database.js'
import { mountCollectionsScreen } from './screens/collections/collections.js'
import { mountCollectionScreen } from './screens/collection/collection.js'

const app = document.querySelector('#app')
const container = document.querySelector('#screen-content')
const isNative = Capacitor.isNativePlatform()
const databaseReady = isNative ? initializeDatabase() : Promise.resolve()
const screens = { collections: mountCollectionsScreen, collection: mountCollectionScreen }
let unmountScreen

// Switch screens while retaining the app shell and database connection
export function showScreen(name, parameters = {}) {
  const mountScreen = screens[name]
  if (!mountScreen) throw new Error(`Unknown screen: ${name}`)

  if (unmountScreen) unmountScreen()
  app.dataset.screen = name
  unmountScreen = mountScreen(container, { ...parameters, isNative, databaseReady, navigate: showScreen })
  window.scrollTo(0, 0)
}

showScreen('collections')
