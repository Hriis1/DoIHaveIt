import './collection.css'
import html from './collection.html?raw'
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { getCollectionItems } from '../../repositories/itemRepo.js'
import { getProductByBarcode } from '../../repositories/productRepo.js'
import { createScanner } from '../../modules/scan/scan.js'

const pageSize = 12

export function mountCollectionScreen(container, { collection, isNative, databaseReady, navigate }) {
  container.innerHTML = html
  const screen = container.querySelector('.collection-screen')
  const events = new AbortController()
  const listen = (element, event, handler) => element.addEventListener(event, handler, { signal: events.signal })
  const title = screen.querySelector('#collection-title')
  const count = screen.querySelector('.gallery-count')
  const search = screen.querySelector('#item-search')
  const grid = screen.querySelector('.item-gallery')
  const template = screen.querySelector('.item-template')
  const message = screen.querySelector('.gallery-message')
  const error = screen.querySelector('.gallery-error')
  const empty = screen.querySelector('.gallery-empty')
  const previous = screen.querySelector('.gallery-previous')
  const next = screen.querySelector('.gallery-next')
  const pageLabel = screen.querySelector('.gallery-page')
  const range = screen.querySelector('.gallery-range')
  const scanResultDialog = screen.querySelector('.scan-result-dialog')
  const scanResultTitle = screen.querySelector('#scan-result-title')
  let active = true
  let request = 0
  let scanRequest = 0
  let page = 1
  let collectionTotal
  const scanner = createScanner({
    onScan: value => {
      if (!active) return
      search.value = value
      void showScanResult(value)
    },
    onError: message => {
      if (!active) return
      error.textContent = message
      error.hidden = false
    },
  })

  title.textContent = collection.name
  listen(screen.querySelector('.collection-back'), 'click', () => navigate('collections'))
  listen(screen.querySelector('.scan-result-close'), 'click', () => scanResultDialog.close())

  async function showScanResult(barcode) {
    const currentScan = ++scanRequest
    scanResultTitle.textContent = 'Looking up product…'
    scanResultDialog.showModal()
    try {
      await databaseReady
      if (!active || currentScan !== scanRequest) return
      const product = await getProductByBarcode(barcode)
      if (!active || currentScan !== scanRequest) return
      scanResultTitle.textContent = product ? 'Product found' : 'Product not found'
    } catch (lookupError) {
      if (!active || currentScan !== scanRequest) return
      console.error('Could not look up scanned product:', lookupError)
      scanResultTitle.textContent = 'Could not look up product. Please try again.'
    }
  }

  async function showImage(item, picture, placeholder, currentRequest) {
    try {
      let source = item.product_image
      // User photos are paths relative to the app's persistent data directory
      if (item.item_image !== null) {
        const { uri } = await Filesystem.getUri({ directory: Directory.Data, path: item.item_image })
        source = Capacitor.convertFileSrc(uri)
      }
      if (!active || currentRequest !== request || !source) return

      const image = document.createElement('img')
      image.alt = ''
      image.decoding = 'async'
      listen(image, 'load', () => { placeholder.hidden = true })
      listen(image, 'error', () => {
        image.remove()
        placeholder.hidden = false
      })
      picture.append(image)
      image.src = source
    } catch (imageError) {
      // Keep the placeholder when a stored photo cannot be resolved
      console.error('Could not load item image:', imageError)
    }
  }

  async function loadItems() {
    const currentRequest = ++request
    const query = search.value.trim()
    grid.setAttribute('aria-busy', 'true')
    previous.disabled = true
    next.disabled = true
    error.hidden = true

    try {
      await databaseReady
      if (!active) return
      const result = await getCollectionItems(collection.id, { search: query, page, pageSize })
      if (!active || currentRequest !== request) return

      page = result.page
      if (!query) collectionTotal = result.total
      const total = collectionTotal ?? result.total
      count.textContent = `${total} ${total === 1 ? 'item' : 'items'}`
      const cards = result.items.map(item => {
        const card = template.content.cloneNode(true)
        const label = `${item.brand}: ${item.name}${item.size === null ? '' : `(${item.size})`}`
        const figure = card.querySelector('figure')
        figure.setAttribute('aria-label', label)
        const caption = card.querySelector('.item-label')
        caption.textContent = label
        caption.title = label
        showImage(item, card.querySelector('.item-image'), card.querySelector('.image-placeholder'), currentRequest)
        return card
      })
      grid.replaceChildren(...cards)
      message.hidden = true
      empty.hidden = result.total > 0
      empty.querySelector('h2').textContent = query ? 'No matching items' : 'Your collection is empty'
      empty.querySelector('p').textContent = query ? 'Try another brand or product name.' : 'Items you add will appear here.'
      pageLabel.textContent = `${page} / ${result.totalPages}`
      range.textContent = result.total
        ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, result.total)} of ${result.total} items`
        : '0 items'
      previous.disabled = page === 1
      next.disabled = page === result.totalPages
    } catch (loadError) {
      if (!active || currentRequest !== request) return
      console.error('Could not load collection items:', loadError)
      grid.replaceChildren()
      empty.hidden = true
      message.hidden = true
      pageLabel.textContent = ''
      range.textContent = ''
      error.textContent = 'Could not load these items. Go back to Collections and try again.'
      error.hidden = false
    } finally {
      if (active && currentRequest === request) grid.setAttribute('aria-busy', 'false')
    }
  }

  listen(search, 'input', () => { page = 1; loadItems() })
  listen(screen.querySelector('.gallery-scan'), 'click', () => {
    error.hidden = true
    scanner.open()
  })
  listen(previous, 'click', () => { page--; loadItems() })
  listen(next, 'click', () => { page++; loadItems() })

  if (isNative) {
    loadItems()
  } else {
    message.textContent = 'Open the app on your phone or emulator to use your saved items.'
    grid.setAttribute('aria-busy', 'false')
  }

  return () => {
    active = false
    events.abort()
    void scanner.destroy()
    scanResultDialog.close()
    screen.remove()
  }
}
