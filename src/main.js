import './style.css'
import { Capacitor } from '@capacitor/core'
import { initializeDatabase } from './database.js'

const status = document.querySelector('#database-status')

// Initialize local storage when running inside the mobile app
if (Capacitor.isNativePlatform()) {
  initializeDatabase()
    .then(() => {
      status.textContent = 'Database ready.'
    })
    .catch((error) => {
      console.error('Database initialization failed:', error)
      status.textContent = 'Could not open the database.'
    })
} else {
  status.textContent = 'Run the Android app to use the local SQLite database.'
}
