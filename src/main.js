import './styles/global.css'
import { Capacitor } from '@capacitor/core'
import { initializeDatabase } from './database.js'
import { mountCollectionsScreen } from './screens/collections/collections.js'

const container = document.querySelector('#screen-content')
const isNative = Capacitor.isNativePlatform()
const databaseReady = isNative ? initializeDatabase() : Promise.resolve()
const screens = { collections: mountCollectionsScreen }
let unmountScreen

// Switch screens while retaining the app shell and database connection
export function showScreen(name) {
  const mountScreen = screens[name]
  if (!mountScreen) throw new Error(`Unknown screen: ${name}`)

  if (unmountScreen) unmountScreen()
  unmountScreen = mountScreen(container, { isNative, databaseReady })
}

showScreen('collections')
