import './collections.css'
import html from './collections.html?raw'
import { getCollections, addCollection, deleteCollection } from '../../database.js'

export function mountCollectionsScreen(container, { isNative, databaseReady }) {
  container.innerHTML = html
  const screen = container.querySelector('.collections-screen')
  const events = new AbortController()
  let active = true
  const listen = (element, event, handler) => element.addEventListener(event, handler, { signal: events.signal })

  const list = screen.querySelector('#collections-list')
  const summary = screen.querySelector('#collections-summary')
  const emptyState = screen.querySelector('#empty-state')
  const message = screen.querySelector('#screen-message')
  const screenError = screen.querySelector('#screen-error')
  const newButton = screen.querySelector('#new-collection')
  const addDialog = screen.querySelector('#add-dialog')
  const addForm = screen.querySelector('#add-form')
  const nameInput = screen.querySelector('#collection-name')
  const addError = screen.querySelector('#add-error')
  const deleteDialog = screen.querySelector('#delete-dialog')
  const deleteForm = screen.querySelector('#delete-form')
  const deleteError = screen.querySelector('#delete-error')
  const template = screen.querySelector('#collection-template')
  let selectedCollection
  let busy = false

  function showError(element, text) {
    element.textContent = text
    element.hidden = !text
  }

  function setBusy(value) {
    if (!active) return
    busy = value
    screen.querySelectorAll('dialog button, dialog input').forEach(control => {
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
    if (!active) return
    showError(screenError, '')
    try {
      await databaseReady
      if (!active) return
      const collections = await getCollections()
      if (!active) return
      const cards = collections.map(collection => {
        const card = template.content.cloneNode(true)
        card.querySelector('.collection-name').textContent = collection.name
        card.querySelector('.collection-date').textContent = formatCreatedAt(collection.created_at)
        const deleteButton = card.querySelector('.delete-button')
        deleteButton.setAttribute('aria-label', `Delete ${collection.name}`)
        listen(deleteButton, 'click', () => {
          selectedCollection = collection
          showError(deleteError, '')
          screen.querySelector('#delete-description').textContent =
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
      if (!active) return
      console.error('Could not load collections:', error)
      message.hidden = true
      showError(screenError, 'Could not load your collections. Close and reopen the app to try again.')
    }
  }

  // Open the creation sheet and keep failed input available for correction
  listen(newButton, 'click', () => {
    addForm.reset()
    showError(addError, '')
    addDialog.showModal()
    nameInput.focus()
  })

  listen(addForm, 'submit', async event => {
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
      if (!active) return
      addDialog.close()
      await loadCollections()
    } catch (error) {
      if (!active) return
      console.error('Could not create collection:', error)
      showError(addError, /UNIQUE constraint failed: collections\.name/i.test(String(error))
        ? 'A collection with this name already exists.'
        : 'Could not create the collection. Please try again.')
    } finally {
      setBusy(false)
    }
  })

  // Delete only after confirmation and refresh the list from SQLite
  listen(deleteForm, 'submit', async event => {
    event.preventDefault()
    if (busy || !selectedCollection) return
    setBusy(true)
    showError(deleteError, '')
    try {
      await deleteCollection(selectedCollection.id)
      if (!active) return
      deleteDialog.close()
      await loadCollections()
      if (active) newButton.focus()
    } catch (error) {
      if (!active) return
      console.error('Could not delete collection:', error)
      showError(deleteError, 'Could not delete the collection. Please try again.')
    } finally {
      setBusy(false)
    }
  })

  screen.querySelectorAll('[data-close]').forEach(button => {
    listen(button, 'click', () => screen.querySelector(`#${button.dataset.close}`).close())
  })

  screen.querySelectorAll('dialog').forEach(dialog => {
    listen(dialog, 'cancel', event => {
      if (busy) event.preventDefault()
    })
  })

  if (isNative) {
    loadCollections()
  } else {
    message.textContent = 'Open the app on your phone or emulator to use your saved collections.'
  }

  // Release screen listeners and dialogs without closing the shared database
  return () => {
    active = false
    events.abort()
    screen.querySelectorAll('dialog').forEach(dialog => dialog.close())
    screen.remove()
  }
}
