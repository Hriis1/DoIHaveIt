import './style.css'
import { Capacitor } from '@capacitor/core'
import { getCollections, addCollection, deleteCollection } from './database.js'

const list = document.querySelector('#collections-list')
const summary = document.querySelector('#collections-summary')
const emptyState = document.querySelector('#empty-state')
const message = document.querySelector('#screen-message')
const screenError = document.querySelector('#screen-error')
const newButton = document.querySelector('#new-collection')
const addDialog = document.querySelector('#add-dialog')
const addForm = document.querySelector('#add-form')
const nameInput = document.querySelector('#collection-name')
const addError = document.querySelector('#add-error')
const deleteDialog = document.querySelector('#delete-dialog')
const deleteForm = document.querySelector('#delete-form')
const deleteError = document.querySelector('#delete-error')
const template = document.querySelector('#collection-template')
let selectedCollection
let busy = false

function showError(element, text) {
  element.textContent = text
  element.hidden = !text
}

function setBusy(value) {
  busy = value
  document.querySelectorAll('dialog button, dialog input').forEach(control => {
    control.disabled = value
  })
}

function formatCreatedAt(value) {
  // SQLite's default timestamps are UTC
  const date = new Date(value.replace(' ', 'T') + 'Z')
  return Number.isNaN(date.getTime()) ? '' : `Created ${new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  }).format(date)}`
}

async function loadCollections() {
  showError(screenError, '')
  try {
    const collections = await getCollections()
    const cards = collections.map(collection => {
      const card = template.content.cloneNode(true)
      card.querySelector('.collection-name').textContent = collection.name
      card.querySelector('.collection-date').textContent = formatCreatedAt(collection.created_at)
      const deleteButton = card.querySelector('.delete-button')
      deleteButton.setAttribute('aria-label', `Delete ${collection.name}`)
      deleteButton.addEventListener('click', () => {
        selectedCollection = collection
        showError(deleteError, '')
        document.querySelector('#delete-description').textContent =
          `“${collection.name}” will be removed. This cannot be undone.`
        deleteDialog.showModal()
      })
      return card
    })

    list.replaceChildren(...cards)
    emptyState.hidden = collections.length > 0
    summary.textContent = `${collections.length} ${collections.length === 1 ? 'collection' : 'collections'} · Everything in its place`
    message.hidden = true
    newButton.disabled = false
  } catch (error) {
    console.error('Could not load collections:', error)
    message.hidden = true
    showError(screenError, 'Could not load your collections. Close and reopen the app to try again.')
  }
}

// Open the creation sheet and keep failed input available for correction
newButton.addEventListener('click', () => {
  addForm.reset()
  showError(addError, '')
  addDialog.showModal()
  nameInput.focus()
})

addForm.addEventListener('submit', async event => {
  event.preventDefault()
  if (busy) return
  const name = nameInput.value.trim()
  if (!name) {
    showError(addError, 'Enter a collection name.')
    nameInput.focus()
    return
  }

  setBusy(true)
  showError(addError, '')
  try {
    await addCollection(name)
    addDialog.close()
    await loadCollections()
  } catch (error) {
    console.error('Could not create collection:', error)
    showError(addError, /UNIQUE constraint failed: collections\.name/i.test(String(error))
      ? 'A collection with this name already exists.'
      : 'Could not create the collection. Please try again.')
  } finally {
    setBusy(false)
  }
})

// Delete only after confirmation and refresh the list from SQLite
deleteForm.addEventListener('submit', async event => {
  event.preventDefault()
  if (busy || !selectedCollection) return
  setBusy(true)
  showError(deleteError, '')
  try {
    await deleteCollection(selectedCollection.id)
    deleteDialog.close()
    await loadCollections()
    newButton.focus()
  } catch (error) {
    console.error('Could not delete collection:', error)
    showError(deleteError, 'Could not delete the collection. Please try again.')
  } finally {
    setBusy(false)
  }
})

document.querySelectorAll('[data-close]').forEach(button => {
  button.addEventListener('click', () => document.getElementById(button.dataset.close).close())
})

document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('cancel', event => {
    if (busy) event.preventDefault()
  })
})

if (Capacitor.isNativePlatform()) {
  loadCollections()
} else {
  message.textContent = 'Open the app on your phone or emulator to use your saved collections.'
}
