import './styles/global.css'
import { Capacitor } from '@capacitor/core'
import { initializeDatabase } from './database.js'
import { mountCollectionsScreen } from './screens/collections/collections.js'
import { mountCollectionScreen } from './screens/collection/collection.js'

const app = document.querySelector('#app')
const container = document.querySelector('#screen-content')
const appMenu = document.querySelector('.app-menu')
const isNative = Capacitor.isNativePlatform()
const databaseReady = isNative ? initializeDatabase() : Promise.resolve()
const screens = { collections: mountCollectionsScreen, collection: mountCollectionScreen }
let unmountScreen

// Dismiss the shared dropdown when leaving it or selecting an entry
document.addEventListener('pointerdown', event => {
  if (!appMenu.contains(event.target)) appMenu.open = false
})
appMenu.addEventListener('focusout', event => {
  if (!appMenu.contains(event.relatedTarget)) appMenu.open = false
})
appMenu.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !appMenu.open) return
  event.preventDefault()
  appMenu.open = false
  appMenu.querySelector('summary').focus()
})
appMenu.querySelector('button').addEventListener('click', () => {
  appMenu.open = false
  appMenu.querySelector('summary').focus()
})

// Switch screens while retaining the app shell and database connection
export function showScreen(name, parameters = {}) {
  const mountScreen = screens[name]
  if (!mountScreen) throw new Error(`Unknown screen: ${name}`)

  if (unmountScreen) unmountScreen()
  appMenu.open = false
  app.dataset.screen = name
  unmountScreen = mountScreen(container, { ...parameters, isNative, databaseReady, navigate: showScreen })
  window.scrollTo(0, 0)
}

showScreen('collections')
